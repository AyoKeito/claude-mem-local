/**
 * KnowledgeAgent - Manages Agent SDK sessions for knowledge corpora
 *
 * Uses the V1 Agent SDK query() API to:
 * 1. Prime a session with a full corpus (all observations loaded into context)
 * 2. Query the primed session with follow-up questions (via session resume)
 * 3. Reprime to create a fresh session (clears accumulated Q&A context)
 *
 * Knowledge agents are Q&A only - all 12 tools are blocked.
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../../shared/paths.js';
import { buildIsolatedEnv } from '../../../shared/EnvManager.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { resolveMaxTokens } from '../LocalAgent.js';

// Import Agent SDK (V1 API — same pattern as SDKAgent.ts)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

// Marker prefix for session IDs created by the local provider path. The Claude
// SDK can't resume these (and shouldn't try), so we fast-path them.
const LOCAL_SESSION_PREFIX = 'local-';

// Knowledge agent is Q&A only — all 12 tools blocked
// Copied from SDKAgent.ts:55-67
const KNOWLEDGE_AGENT_DISALLOWED_TOOLS = [
  'Bash',           // Prevent infinite loops
  'Read',           // No file reading
  'Write',          // No file writing
  'Edit',           // No file editing
  'Grep',           // No code searching
  'Glob',           // No file pattern matching
  'WebFetch',       // No web fetching
  'WebSearch',      // No web searching
  'Task',           // No spawning sub-agents
  'NotebookEdit',   // No notebook editing
  'AskUserQuestion',// No asking questions
  'TodoWrite'       // No todo management
];

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  /**
   * Prime a knowledge agent session by sending the full corpus as context.
   * Creates a new SDK session, feeds it all observations, and stores the session_id.
   *
   * @returns The session_id for future resume queries
   */
  async prime(corpus: CorpusFile): Promise<string> {
    if (this.isLocalProvider()) {
      return this.primeLocal(corpus);
    }

    const renderedCorpus = this.renderer.renderCorpus(corpus);

    const primePrompt = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      renderedCorpus,
      '',
      'Acknowledge what you\'ve received. Summarize the key themes and topics you can answer questions about.'
    ].join('\n');

    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = this.findClaudeExecutable();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());

    const queryResult = query({
      prompt: primePrompt,
      options: {
        model: this.getModelId(),
        cwd: OBSERVER_SESSIONS_DIR,
        disallowedTools: KNOWLEDGE_AGENT_DISALLOWED_TOOLS,
        pathToClaudeCodeExecutable: claudePath,
        env: isolatedEnv
      }
    });

    let sessionId: string | undefined;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'result') {
          logger.info('WORKER', `Knowledge agent primed for corpus "${corpus.name}"`);
        }
      }
    } catch (error) {
      // The SDK may throw after yielding all messages when the Claude process
      // exits with a non-zero code. If we already captured a session_id,
      // treat this as success — the session was created and primed.
      if (sessionId) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!sessionId) {
      throw new Error(`Failed to capture session_id while priming corpus "${corpus.name}"`);
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  /**
   * Query a primed knowledge agent by resuming its session.
   * The agent answers from the corpus context loaded during prime().
   *
   * If the session has expired, auto-reprimes and retries the query.
   */
  async query(corpus: CorpusFile, question: string): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    // Local-provider sessions don't use Claude's resume; answer from a fresh
    // context-loaded call each time. If the user switches providers we
    // transparently reprime on the other side.
    if (corpus.session_id.startsWith(LOCAL_SESSION_PREFIX)) {
      if (this.isLocalProvider()) {
        return this.executeQueryLocal(corpus, question);
      }
      logger.info('WORKER', `Corpus "${corpus.name}" was primed on local; provider is now Claude — repriming on Claude side`);
      await this.prime(corpus);
    } else if (this.isLocalProvider()) {
      logger.info('WORKER', `Corpus "${corpus.name}" was primed on Claude; provider is now local — repriming on local side`);
      await this.prime(corpus);
      const refreshed = this.corpusStore.read(corpus.name);
      if (refreshed?.session_id) return this.executeQueryLocal(refreshed, question);
    }

    try {
      const result = await this.executeQuery(corpus, question);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      if (!this.isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      // Session expired or invalid — auto-reprime and retry
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus);
      // Re-read corpus to get the new session_id written by prime()
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  /**
   * Reprime a corpus — creates a fresh session, clearing prior Q&A context.
   *
   * @returns The new session_id
   */
  async reprime(corpus: CorpusFile): Promise<string> {
    corpus.session_id = null;  // Clear old session
    return this.prime(corpus);
  }

  /**
   * Detect whether an error indicates an expired or invalid session resume.
   * Only these errors trigger auto-reprime; all others are rethrown.
   */
  private isSessionResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session|resume|expired|invalid.*session|not found/i.test(message);
  }

  /**
   * Execute a single query against a primed session via V1 SDK resume.
   */
  private async executeQuery(corpus: CorpusFile, question: string): Promise<QueryResult> {
    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = this.findClaudeExecutable();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());

    const queryResult = query({
      prompt: question,
      options: {
        model: this.getModelId(),
        resume: corpus.session_id!,
        cwd: OBSERVER_SESSIONS_DIR,
        disallowedTools: KNOWLEDGE_AGENT_DISALLOWED_TOOLS,
        pathToClaudeCodeExecutable: claudePath,
        env: isolatedEnv
      }
    });

    let answer = '';
    let newSessionId = corpus.session_id!;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          answer = text;
        }
      }
    } catch (error) {
      // Same as prime() — SDK may throw after all messages are yielded.
      // If we captured an answer, treat as success.
      if (answer) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    return { answer, session_id: newSessionId };
  }

  /**
   * Get model ID from user settings. Provider-aware: when the user has selected
   * the local provider we return CLAUDE_MEM_LOCAL_MODEL; otherwise the Claude
   * default. The Claude SDK path never reads this for local (it takes a
   * separate code path), but we keep it correct so anything else reading the
   * return value gets the right model for the active provider.
   */
  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_PROVIDER === 'local' && settings.CLAUDE_MEM_LOCAL_MODEL) {
      return settings.CLAUDE_MEM_LOCAL_MODEL;
    }
    return settings.CLAUDE_MEM_MODEL;
  }

  private isLocalProvider(): boolean {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_MEM_PROVIDER === 'local'
      && !!settings.CLAUDE_MEM_LOCAL_BASE_URL
      && !!settings.CLAUDE_MEM_LOCAL_MODEL;
  }

  /**
   * Local-provider prime: no subprocess, no SDK. Just mint a session_id; the
   * corpus body is re-injected on every query since local models rebuild
   * context fresh each call. This side-steps the Claude-subprocess dependency
   * and keeps the code path pure HTTP → local OpenAI-compatible server.
   */
  private async primeLocal(corpus: CorpusFile): Promise<string> {
    const sessionId = `${LOCAL_SESSION_PREFIX}${corpus.name}-${randomUUID()}`;
    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);
    logger.info('WORKER', `Knowledge agent primed locally for corpus "${corpus.name}"`, { sessionId } as any);
    return sessionId;
  }

  /**
   * Local-provider query: rebuilds [system=corpus, user=question] each call and
   * hits the local OpenAI-compatible server. Uses the same sampling and
   * timeout settings configured for LocalAgent so observation extraction and
   * knowledge Q&A behave consistently.
   */
  private async executeQueryLocal(corpus: CorpusFile, question: string): Promise<QueryResult> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const baseUrl = (settings.CLAUDE_MEM_LOCAL_BASE_URL || '').replace(/\/+$/, '');
    const model = settings.CLAUDE_MEM_LOCAL_MODEL || '';
    const apiKey = settings.CLAUDE_MEM_LOCAL_API_KEY || '';
    if (!baseUrl || !model) {
      throw new Error('Local provider selected but CLAUDE_MEM_LOCAL_BASE_URL / CLAUDE_MEM_LOCAL_MODEL not configured.');
    }

    const rendered = this.renderer.renderCorpus(corpus);
    const systemContent = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      rendered
    ].join('\n');

    // Resolve context ceiling (AUTO probes the server). If the corpus overruns,
    // the local model will error loudly — better than silent truncation for Q&A,
    // since a half-corpus answer is misleading.
    const { value: maxTokens } = await resolveMaxTokens(
      settings.CLAUDE_MEM_LOCAL_MAX_TOKENS,
      baseUrl, model, apiKey
    );

    const num = (raw: string | undefined, fb: number) => {
      const n = parseFloat((raw ?? '').toString());
      return isNaN(n) ? fb : n;
    };
    const body: Record<string, any> = {
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: question }
      ],
      temperature: num(settings.CLAUDE_MEM_LOCAL_TEMPERATURE, 0.7),
      top_p: num(settings.CLAUDE_MEM_LOCAL_TOP_P, 0.8),
      max_tokens: Math.max(256, parseInt(settings.CLAUDE_MEM_LOCAL_MAX_OUTPUT_TOKENS, 10) || 4096),
    };
    const top_k = num(settings.CLAUDE_MEM_LOCAL_TOP_K, 20);
    if (top_k > 0) body.top_k = top_k;
    const min_p = num(settings.CLAUDE_MEM_LOCAL_MIN_P, 0);
    if (min_p > 0) body.min_p = min_p;
    const pp = num(settings.CLAUDE_MEM_LOCAL_PRESENCE_PENALTY, 1.5);
    if (pp !== 0) body.presence_penalty = pp;
    const rp = num(settings.CLAUDE_MEM_LOCAL_REPETITION_PENALTY, 1.0);
    if (rp !== 1.0) body.repetition_penalty = rp;
    body.chat_template_kwargs = {
      enable_thinking: String(settings.CLAUDE_MEM_LOCAL_ENABLE_THINKING || 'false').toLowerCase() === 'true'
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const timeoutMs = Math.max(5_000, parseInt(settings.CLAUDE_MEM_LOCAL_REQUEST_TIMEOUT_MS, 10) || 300_000);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);

    logger.debug('WORKER', `Knowledge query (local) for corpus "${corpus.name}"`, {
      model, maxTokens, corpusChars: rendered.length, questionChars: question.length
    });

    try {
      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' && ctl.signal.aborted) {
          throw new Error(`Local API timed out after ${timeoutMs}ms while answering knowledge query`);
        }
        throw err;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Local API error: ${resp.status} - ${text}`);
      }
      const data: any = await resp.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      // Strip Qwen3.x <think>…</think> scaffolding if the server didn't honor enable_thinking=false
      const answer = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/^<think>[\s\S]*$/i, '').trim();
      return { answer, session_id: corpus.session_id! };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Find the Claude executable path.
   * Mirrors SDKAgent.findClaudeExecutable() logic.
   */
  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. On Windows, prefer "claude.cmd" via PATH
    if (process.platform === 'win32') {
      try {
        execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return 'claude.cmd';
      } catch {
        // Fall through to generic detection
      }
    }

    // 3. Auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();

      if (claudePath) return claudePath;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('WORKER', 'Claude executable auto-detection failed', {}, error);
      } else {
        logger.debug('WORKER', 'Claude executable auto-detection failed (non-Error thrown)', { thrownValue: String(error) });
      }
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }
}
