/**
 * LocalAgent: Local OpenAI-compatible observation extraction
 *
 * Alternative to SDKAgent that uses a local OpenAI-compatible API server
 * (LM Studio, Ollama, etc.) for observation extraction.
 *
 * Responsibility:
 * - Call local OpenAI-compatible REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support configurable model selection via local server
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 60000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_MAX_CONCURRENT = 1;
// Keep final payload a bit below the user-declared ceiling: char/4 token estimation
// under-counts for code-heavy content, so the real prompt can exceed the limit and
// crash the local model (e.g. Qwen OOM ~80k). 15% headroom absorbs the error.
const CONTEXT_SAFETY_RATIO = 0.85;
// Default request timeout for local API calls. LM Studio/Ollama generations on
// larger models can take minutes; 300s is generous without being indefinite.
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Process-wide concurrency gate for outbound requests to the local server.
 * Shared across all LocalAgent instances (only one exists per worker, but the
 * semaphore is module-scoped so the limit holds across every session).
 *
 * Why: LM Studio / Ollama have a configurable parallel-request depth. Sending
 * more in-flight requests than the server is configured for causes queueing,
 * timeouts, or OOM on the model host. Cap us at the same number the server
 * is set to (CLAUDE_MEM_LOCAL_MAX_CONCURRENT).
 */
const localRequestWaiters: Array<() => void> = [];
let localRequestsInFlight = 0;

async function acquireLocalSlot(maxConcurrent: number): Promise<void> {
  if (localRequestsInFlight < maxConcurrent) {
    localRequestsInFlight++;
    return;
  }
  await new Promise<void>(resolve => localRequestWaiters.push(resolve));
  localRequestsInFlight++;
}

function releaseLocalSlot(): void {
  localRequestsInFlight--;
  const next = localRequestWaiters.shift();
  if (next) next();
}

/**
 * Cache for auto-detected context window per (baseUrl, model). Local servers
 * don't change loaded context mid-session often; a short TTL keeps the probe
 * cheap without ignoring a model swap the user just made.
 */
interface ContextProbe { tokens: number; source: string; fetchedAt: number; }
const contextProbeCache = new Map<string, ContextProbe>();
const CONTEXT_PROBE_TTL_MS = 60_000;

/**
 * Probe a local OpenAI-compatible server for the loaded model's context window.
 * Tries servers in order: LM Studio native (/api/v0/models), Ollama (/api/show),
 * plain OpenAI (/v1/models). Returns null if nothing reports a usable number.
 */
async function probeLocalContextWindow(
  baseUrl: string,
  model: string,
  apiKey: string
): Promise<ContextProbe | null> {
  const cacheKey = `${baseUrl}|${model}`;
  const cached = contextProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CONTEXT_PROBE_TTL_MS) return cached;

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const tryFetch = async (url: string, init?: RequestInit): Promise<any | null> => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      try {
        const r = await fetch(url, { headers, signal: ctl.signal, ...init });
        if (!r.ok) return null;
        return await r.json();
      } finally { clearTimeout(t); }
    } catch { return null; }
  };

  // 1. LM Studio native — reports loaded_context_length (what the user actually loaded)
  const lmsModel = await tryFetch(`${baseUrl}/api/v0/models/${encodeURIComponent(model)}`);
  const lmsLoaded = lmsModel?.loaded_context_length ?? lmsModel?.max_context_length;
  if (typeof lmsLoaded === 'number' && lmsLoaded > 0) {
    const probe = { tokens: lmsLoaded, source: 'lmstudio', fetchedAt: Date.now() };
    contextProbeCache.set(cacheKey, probe);
    return probe;
  }

  // 2. Ollama — reports model_info.*.context_length
  const ollama = await tryFetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
  });
  const modelInfo = ollama?.model_info;
  if (modelInfo && typeof modelInfo === 'object') {
    const ctxKey = Object.keys(modelInfo).find(k => k.endsWith('.context_length'));
    const ctx = ctxKey ? modelInfo[ctxKey] : undefined;
    if (typeof ctx === 'number' && ctx > 0) {
      const probe = { tokens: ctx, source: 'ollama', fetchedAt: Date.now() };
      contextProbeCache.set(cacheKey, probe);
      return probe;
    }
  }

  // 3. Plain OpenAI — generic /v1/models sometimes exposes context_length
  const openai = await tryFetch(`${baseUrl}/v1/models`);
  const entry = openai?.data?.find?.((m: any) => m?.id === model);
  const oaiCtx = entry?.context_length ?? entry?.max_context_length;
  if (typeof oaiCtx === 'number' && oaiCtx > 0) {
    const probe = { tokens: oaiCtx, source: 'openai', fetchedAt: Date.now() };
    contextProbeCache.set(cacheKey, probe);
    return probe;
  }

  return null;
}

export function clearContextProbeCache(): void {
  contextProbeCache.clear();
}

/**
 * Resolve the effective max-tokens ceiling for a request.
 * - Numeric setting → use as-is.
 * - 'auto' (or empty) → probe the server; fall back to DEFAULT_MAX_ESTIMATED_TOKENS on failure.
 * Returns the raw (pre-safety-ratio) value.
 */
export async function resolveMaxTokens(
  setting: string | undefined,
  baseUrl: string,
  model: string,
  apiKey: string
): Promise<{ value: number; source: 'user' | 'auto-lmstudio' | 'auto-ollama' | 'auto-openai' | 'auto-fallback' }> {
  const normalized = (setting || '').trim().toLowerCase();
  if (normalized && normalized !== 'auto') {
    const n = parseInt(normalized, 10);
    if (!isNaN(n) && n > 0) return { value: n, source: 'user' };
  }
  if (baseUrl && model) {
    const probe = await probeLocalContextWindow(baseUrl, model, apiKey);
    if (probe) return { value: probe.tokens, source: `auto-${probe.source}` as any };
  }
  return { value: DEFAULT_MAX_ESTIMATED_TOKENS, source: 'auto-fallback' };
}

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LocalResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class LocalAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { baseUrl, apiKey, model } = this.getLocalConfig();

    if (!baseUrl) {
      throw new Error('Local model base URL not configured. Set CLAUDE_MEM_LOCAL_BASE_URL in settings.');
    }
    if (!model) {
      // Fail loud and early — otherwise the first fetch returns an opaque 404
      // from the server and the user blames claude-mem. Common footgun when a
      // user switches provider=local but forgets to fill in CLAUDE_MEM_LOCAL_MODEL.
      throw new Error('Local provider selected but CLAUDE_MEM_LOCAL_MODEL is empty. Set it to the model ID your local server reports (e.g. "qwen/qwen3.6-27b").');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `local-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Local`);
    }

    const mode = ModeManager.getInstance().getActiveMode();

    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryLocalMultiTurn(session.conversationHistory, apiKey, model, baseUrl);
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'LocalAgent init failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'LocalAgent init failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, apiKey, model, baseUrl, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'LocalAgent message processing failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'LocalAgent message processing failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'LocalAgent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model
    });
  }

  private prepareMessageMetadata(session: ActiveSession, message: { _persistentId: number; agentId?: string | null; agentType?: string | null }): void {
    session.processingMessageIds.push(message._persistentId);
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  private async handleInitResponse(
    initResponse: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, 'Local', undefined, model
      );
    } else {
      logger.error('SDK', 'Empty LocalAgent init response - session may lack context', {
        sessionId: session.sessionDbId, model
      });
    }
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type?: string; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, baseUrl, worker, mode
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, baseUrl, worker, mode
      );
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    worker: WorkerRef | undefined,
    _mode: ModeConfig
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryLocalMultiTurn(session.conversationHistory, apiKey, model, baseUrl);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      obsResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'Local', lastCwd, model
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    baseUrl: string,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryLocalMultiTurn(session.conversationHistory, apiKey, model, baseUrl);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      summaryResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'Local', lastCwd, model
    );
  }

  private async handleSessionError(error: unknown, session: ActiveSession, worker?: WorkerRef): Promise<never | void> {
    if (isAbortError(error)) {
      logger.warn('SDK', 'LocalAgent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    const fallbackSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const fallbackEnabled = fallbackSettings.CLAUDE_MEM_LOCAL_FALLBACK_ENABLED === 'true';

    if (fallbackEnabled && shouldFallbackToClaude(error) && this.fallbackAgent) {
      logger.warn('SDK', 'Local API failed, falling back to Claude SDK (fallback enabled)', {
        sessionDbId: session.sessionDbId,
        error: error instanceof Error ? error.message : String(error),
        historyLength: session.conversationHistory.length
      });
      await this.fallbackAgent.startSession(session, worker);
      return;
    }

    if (!fallbackEnabled && shouldFallbackToClaude(error)) {
      logger.warn('SDK', 'Local API failed; fallback to Claude is disabled (CLAUDE_MEM_LOCAL_FALLBACK_ENABLED=false) — failing session', {
        sessionDbId: session.sessionDbId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    logger.failure('SDK', 'LocalAgent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private async truncateHistory(history: ConversationMessage[]): Promise<ConversationMessage[]> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_LOCAL_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const { value: MAX_ESTIMATED_TOKENS_RAW, source: tokenSource } = await resolveMaxTokens(
      settings.CLAUDE_MEM_LOCAL_MAX_TOKENS,
      settings.CLAUDE_MEM_LOCAL_BASE_URL || '',
      settings.CLAUDE_MEM_LOCAL_MODEL || '',
      settings.CLAUDE_MEM_LOCAL_API_KEY || ''
    );
    if (tokenSource.startsWith('auto')) {
      logger.debug('SDK', 'Resolved max-tokens for local model', {
        value: MAX_ESTIMATED_TOKENS_RAW,
        source: tokenSource
      });
    }
    // Safety ratio: stay below the user-declared ceiling because char/4 under-counts
    // code-heavy prompts and the local model crashes on overflow rather than erroring.
    const MAX_ESTIMATED_TOKENS = Math.floor(MAX_ESTIMATED_TOKENS_RAW * CONTEXT_SAFETY_RATIO);

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent local model overflow', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          effectiveTokenLimit: MAX_ESTIMATED_TOKENS,
          userTokenLimit: MAX_ESTIMATED_TOKENS_RAW
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    // Edge case: a single oversized message (e.g. pasted file) larger than the
    // whole context budget. Truncate its content from the front so we keep the
    // most recent portion and still make progress instead of sending nothing.
    if (truncated.length === 0 && history.length > 0) {
      const last = history[history.length - 1];
      const charBudget = Math.max(1000, MAX_ESTIMATED_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
      const kept = last.content.length > charBudget
        ? '[… truncated earlier content to fit local model context …]\n' + last.content.slice(last.content.length - charBudget)
        : last.content;
      logger.warn('SDK', 'Single oversized message truncated to fit local context budget', {
        originalChars: last.content.length,
        keptChars: kept.length,
        effectiveTokenLimit: MAX_ESTIMATED_TOKENS
      });
      truncated.push({ ...last, content: kept });
    }

    return truncated;
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    // Sanitize the wire payload without mutating the stored history:
    //  1. Drop failed "<empty_response>" assistant turns — they poison the
    //     context (model learns to emit empty) and inflate token count.
    //  2. Drop leading assistant messages — Qwen/LM Studio's Jinja template
    //     rejects the request with "No user query found in messages" when the
    //     first message isn't a user turn (observed with qwen3.6-27b).
    //  3. Collapse consecutive same-role messages by joining them, so strict
    //     alternation is preserved for templates that require it.
    const mapped: OpenAIMessage[] = [];
    for (const msg of history) {
      const role: OpenAIMessage['role'] = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = (msg.content || '').trim();
      if (!content) continue;
      if (role === 'assistant' && /^<empty_response>\s*$/i.test(content)) continue;
      mapped.push({ role, content: msg.content });
    }
    while (mapped.length && mapped[0].role !== 'user') mapped.shift();
    const alternated: OpenAIMessage[] = [];
    for (const m of mapped) {
      const last = alternated[alternated.length - 1];
      if (last && last.role === m.role) {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        alternated.push({ ...m });
      }
    }
    return alternated;
  }

  private async queryLocalMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    baseUrl: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = await this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying LocalAgent multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxConcurrent = Math.max(1, parseInt(settings.CLAUDE_MEM_LOCAL_MAX_CONCURRENT, 10) || DEFAULT_MAX_CONCURRENT);
    const timeoutMs = Math.max(5_000, parseInt(settings.CLAUDE_MEM_LOCAL_REQUEST_TIMEOUT_MS, 10) || DEFAULT_REQUEST_TIMEOUT_MS);

    // Sampling params (Qwen3.6 instruct defaults baked in via SettingsDefaultsManager).
    const num = (raw: string | undefined, fallback: number): number => {
      const n = parseFloat((raw ?? '').toString());
      return isNaN(n) ? fallback : n;
    };
    const temperature = num(settings.CLAUDE_MEM_LOCAL_TEMPERATURE, 0.7);
    const top_p = num(settings.CLAUDE_MEM_LOCAL_TOP_P, 0.8);
    const top_k = num(settings.CLAUDE_MEM_LOCAL_TOP_K, 20);
    const min_p = num(settings.CLAUDE_MEM_LOCAL_MIN_P, 0.0);
    const presence_penalty = num(settings.CLAUDE_MEM_LOCAL_PRESENCE_PENALTY, 1.5);
    const repetition_penalty = num(settings.CLAUDE_MEM_LOCAL_REPETITION_PENALTY, 1.0);
    const maxOutputTokens = Math.max(256, parseInt(settings.CLAUDE_MEM_LOCAL_MAX_OUTPUT_TOKENS, 10) || 4096);
    const enableThinking = String(settings.CLAUDE_MEM_LOCAL_ENABLE_THINKING || 'false').toLowerCase() === 'true';

    const body: Record<string, any> = {
      model,
      messages,
      temperature,
      top_p,
      max_tokens: maxOutputTokens,
    };
    if (top_k > 0) body.top_k = top_k;
    if (min_p > 0) body.min_p = min_p;
    if (presence_penalty !== 0) body.presence_penalty = presence_penalty;
    if (repetition_penalty !== 1.0) body.repetition_penalty = repetition_penalty;
    // enable_thinking is a Qwen3.x-specific chat_template_kwarg. LM Studio, vLLM,
    // and SGLang all accept it under extra_body; older servers ignore unknown keys.
    body.chat_template_kwargs = { enable_thinking: enableThinking };

    await acquireLocalSlot(maxConcurrent);
    let response: Response;
    let data: LocalResponse;
    const abortCtl = new AbortController();
    const timeoutHandle = setTimeout(() => abortCtl.abort(), timeoutMs);
    try {
      try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortCtl.signal,
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' && abortCtl.signal.aborted) {
          throw new Error(`Local API timed out after ${timeoutMs}ms (CLAUDE_MEM_LOCAL_REQUEST_TIMEOUT_MS)`);
        }
        throw err;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Local API error: ${response.status} - ${errorText}`);
      }

      data = await response.json() as LocalResponse;
    } finally {
      clearTimeout(timeoutHandle);
      releaseLocalSlot();
    }

    if (data.error) {
      throw new Error(`Local API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from local model');
      return { content: '' };
    }

    // Strip Qwen3.x <think>…</think> reasoning blocks. We pass enable_thinking=false
    // but some GGUF variants still emit a leading <think> scaffold; our XML parser
    // works either way, but stripping keeps logs clean and avoids accidental leakage
    // into future history if thinking_preserve ever gets enabled.
    const rawContent = data.choices[0].message.content;
    const content = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/^<think>[\s\S]*$/i, '');
    const tokensUsed = data.usage?.total_tokens;

    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;

      logger.info('SDK', 'Local API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        messagesInContext: truncatedHistory.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected in local model call', {
          totalTokens: tokensUsed
        });
      }
    }

    return { content, tokensUsed };
  }

  private getLocalConfig(): { baseUrl: string; model: string; apiKey: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const baseUrl = settings.CLAUDE_MEM_LOCAL_BASE_URL || '';
    const model = settings.CLAUDE_MEM_LOCAL_MODEL || '';
    const apiKey = settings.CLAUDE_MEM_LOCAL_API_KEY || '';

    return { baseUrl, model, apiKey };
  }
}

export function isLocalAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!settings.CLAUDE_MEM_LOCAL_BASE_URL;
}

export function isLocalSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'local';
}
