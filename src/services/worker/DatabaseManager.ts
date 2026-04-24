/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Initialize ChromaSync only if Chroma is enabled (SQLite-only fallback when disabled)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      // Wrap construction so a broken chroma-mcp install (missing binary,
      // bad config) doesn't block the worker from starting. Callers already
      // handle getChromaSync() === null as "SQLite-only mode".
      try {
        this.chromaSync = new ChromaSync('claude-mem');
      } catch (err) {
        logger.warn('DB', 'Chroma init failed — continuing with SQLite-only search. Set CLAUDE_MEM_CHROMA_ENABLED=false to silence this warning.', {}, err as Error);
        this.chromaSync = null;
      }
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    // Provider misconfiguration: catch local+empty-model and local+claude-model-ID
    // at startup instead of letting the first session fail opaquely.
    if (settings.CLAUDE_MEM_PROVIDER === 'local') {
      if (!settings.CLAUDE_MEM_LOCAL_MODEL) {
        logger.warn('DB', 'Provider is "local" but CLAUDE_MEM_LOCAL_MODEL is empty. Sessions will fail until this is set in ~/.claude-mem/settings.json.');
      }
      if (!settings.CLAUDE_MEM_LOCAL_BASE_URL) {
        logger.warn('DB', 'Provider is "local" but CLAUDE_MEM_LOCAL_BASE_URL is empty. Sessions will fail until this is set.');
      }
      if (settings.CLAUDE_MEM_MODEL && /^claude-/i.test(settings.CLAUDE_MEM_MODEL)) {
        logger.info('DB', `Provider is "local" — CLAUDE_MEM_MODEL ("${settings.CLAUDE_MEM_MODEL}") is ignored for observation extraction. Knowledge-agent uses CLAUDE_MEM_LOCAL_MODEL on the local path.`);
      }
    }

    logger.info('DB', 'Database initialized', {
      provider: settings.CLAUDE_MEM_PROVIDER,
      chroma: this.chromaSync ? 'on' : 'off',
    } as any);
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close ChromaSync first (MCP connection lifecycle managed by ChromaMcpManager)
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get ChromaSync instance (returns null if Chroma is disabled)
   */
  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
