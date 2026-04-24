/**
 * FallbackErrorHandler: Error detection for provider fallback
 *
 * Responsibility:
 * - Determine if an error should trigger fallback to Claude SDK
 * - Provide consistent error classification across Gemini and OpenRouter
 */

import { FALLBACK_ERROR_PATTERNS } from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Check if an error should trigger fallback to Claude SDK
 *
 * Errors that trigger fallback:
 * - 429: Rate limit exceeded
 * - 500/502/503: Server errors
 * - ECONNREFUSED: Connection refused (server down)
 * - ETIMEDOUT: Request timeout
 * - fetch failed: Network failure
 *
 * @param error - Error object to check
 * @returns true if the error should trigger fallback to Claude
 */
export function shouldFallbackToClaude(error: unknown): boolean {
  const message = getErrorMessage(error);

  // Overflow / oversized-prompt errors are unfixable by retrying — routing them
  // to Claude would just burn the fallback path on a request that's structurally
  // too big. Short-circuit.
  if (isContextOverflowError(error)) return false;

  return FALLBACK_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Detect context-window / oversized-prompt errors across providers. Claude
 * emits "prompt is too long" / "context window"; local OpenAI-compatible
 * servers (LM Studio, Ollama, llama.cpp) return different phrasings depending
 * on the loaded runtime. Catching all of them lets callers abort cleanly
 * instead of retry-looping or falling back.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  'prompt is too long',
  'Prompt is too long',
  'context window',
  'context size has been exceeded',
  'context size exceeded',
  'context length',
  'context_length_exceeded',
  'token limit exceeded',
  'exceeds context',
  'maximum context',
  'n_ctx',                     // llama.cpp
  'out of memory',             // OOM on local backend
  'CUDA out of memory',
];

export function isContextOverflowError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some(p => message.includes(p.toLowerCase()));
}

/**
 * Extract error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

/**
 * Check if error is an AbortError (user cancelled)
 *
 * @param error - Error object to check
 * @returns true if this is an abort/cancellation error
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  if (typeof error === 'object' && 'name' in error) {
    return (error as { name: unknown }).name === 'AbortError';
  }

  return false;
}
