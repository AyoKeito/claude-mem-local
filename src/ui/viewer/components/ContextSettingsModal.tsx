import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

// Local provider connection tester — probes /api/settings/test-local-connection
function LocalConnectionTester({ baseUrl, model, apiKey }: { baseUrl: string; model: string; apiKey: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [message, setMessage] = useState<string>('');

  const runTest = useCallback(async () => {
    if (!baseUrl) {
      setStatus('fail');
      setMessage('Set a Base URL first');
      return;
    }
    setStatus('testing');
    setMessage('Connecting…');
    try {
      const resp = await fetch('/api/settings/test-local-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model, apiKey }),
      });
      const data: any = await resp.json();
      if (!data.ok || !data.reachable) {
        setStatus('fail');
        setMessage(`Unreachable: ${data.error || 'no response'}`);
        return;
      }
      const parts: string[] = [];
      parts.push(`${data.modelsCount} model${data.modelsCount === 1 ? '' : 's'} available`);
      if (model) {
        parts.push(data.modelFound ? `model "${model}" found` : `model "${model}" NOT in list`);
      }
      if (data.contextLength) {
        parts.push(`context ${data.contextLength.toLocaleString()} tokens (via ${data.contextSource})`);
      } else if (model) {
        parts.push('context length unknown — server did not report it');
      }
      setStatus(data.modelFound === false ? 'fail' : 'ok');
      setMessage(parts.join(' · '));
    } catch (e: any) {
      setStatus('fail');
      setMessage(`Error: ${e?.message || String(e)}`);
    }
  }, [baseUrl, model, apiKey]);

  const color = status === 'ok' ? 'var(--success, #4caf50)' :
                status === 'fail' ? 'var(--error, #e53935)' :
                status === 'testing' ? 'var(--muted, #888)' : 'var(--muted, #888)';

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={runTest}
        disabled={status === 'testing'}
        style={{ padding: '4px 10px' }}
      >
        {status === 'testing' ? 'Testing…' : 'Test Connection'}
      </button>
      {message && <span style={{ color, fontSize: 12 }}>{message}</span>}
    </div>
  );
}

// Collapsible section component
function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

// Form field with optional tooltip
function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

// Toggle switch component
function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  // Update form state when settings prop changes
  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  // Get context preview based on current form state
  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="header-controls">
            <label className="preview-selector">
              Source:
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              Project:
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="Close (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="Loading"
              description="How many observations to inject"
            >
              <FormField
                label="Observations"
                tooltip="Number of recent observations to include in context (1-200)"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="Sessions"
                tooltip="Number of recent sessions to pull observations from (1-50)"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="Display"
              description="What to show in context tables"
            >
              <div className="display-subsection">
                <span className="subsection-label">Full Observations</span>
                <FormField
                  label="Count"
                  tooltip="How many observations show expanded details (0-20)"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Field"
                  tooltip="Which field to expand for full observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">Narrative</option>
                    <option value="facts">Facts</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token Economics</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="Read cost"
                    description="Tokens to read this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="Work investment"
                    description="Tokens spent creating this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="Savings"
                    description="Total tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title="Advanced"
              description="AI provider and model selection"
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="Choose between Claude (via Agent SDK), Gemini, OpenRouter, or Local (OpenAI-compatible)"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="gemini">Gemini (uses API key)</option>
                  <option value="openrouter">OpenRouter (multi-model)</option>
                  <option value="local">Local (OpenAI-compatible)</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label="Claude Model"
                  tooltip="Claude model used for generating observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">haiku (fastest)</option>
                    <option value="sonnet">sonnet (balanced)</option>
                    <option value="opus">opus (highest quality)</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label="Gemini API Key"
                    tooltip="Your Google AI Studio API key (or set GEMINI_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder="Enter Gemini API key..."
                    />
                  </FormField>
                  <FormField
                    label="Gemini Model"
                    tooltip="Gemini model used for generating observations"
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash-lite'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (10 RPM free)</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash (5 RPM free)</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (5 RPM free)</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label="Rate Limiting"
                      description="Enable for free tier (10-30 RPM). Disable if you have billing set up (1000+ RPM)."
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label="OpenRouter API Key"
                    tooltip="Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder="Enter OpenRouter API key..."
                    />
                  </FormField>
                  <FormField
                    label="OpenRouter Model"
                    tooltip="Model identifier from OpenRouter (e.g., anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-thinking-exp)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label="Site URL (Optional)"
                    tooltip="Your site URL for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label="App Name (Optional)"
                    tooltip="Your app name for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'local' && (
                <>
                  <LocalConnectionTester
                    baseUrl={formState.CLAUDE_MEM_LOCAL_BASE_URL || ''}
                    model={formState.CLAUDE_MEM_LOCAL_MODEL || ''}
                    apiKey={formState.CLAUDE_MEM_LOCAL_API_KEY || ''}
                  />
                  <FormField
                    label="Base URL"
                    tooltip="URL of your local OpenAI-compatible server (e.g. LM Studio, Ollama)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_LOCAL_BASE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_BASE_URL', e.target.value)}
                      placeholder="http://127.0.0.1:1234"
                    />
                  </FormField>
                  <FormField
                    label="Model"
                    tooltip="Model identifier as reported by your local server (e.g. qwen/qwen3-27b)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_LOCAL_MODEL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MODEL', e.target.value)}
                      placeholder="e.g. qwen/qwen3-27b"
                    />
                  </FormField>
                  <FormField
                    label="API Key (Optional)"
                    tooltip="Leave empty if your local server does not require authentication"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_LOCAL_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_API_KEY', e.target.value)}
                      placeholder="Leave empty for no auth"
                    />
                  </FormField>
                  <FormField
                    label="Max Context Tokens"
                    tooltip="'Auto' probes your local server for the loaded model's context length (LM Studio: loaded_context_length; Ollama: model_info.*.context_length) and caches it for 60s. Pick 'Manual' to override with a fixed number, e.g. if your estimator undercounts or your server doesn't report it."
                  >
                    {(() => {
                      const raw = (formState.CLAUDE_MEM_LOCAL_MAX_TOKENS ?? 'auto').toString();
                      const isAuto = raw.trim().toLowerCase() === 'auto' || raw === '';
                      return (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <select
                            value={isAuto ? 'auto' : 'manual'}
                            onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MAX_TOKENS', e.target.value === 'auto' ? 'auto' : '60000')}
                            style={{ flex: '0 0 auto' }}
                          >
                            <option value="auto">Auto (probe server)</option>
                            <option value="manual">Manual</option>
                          </select>
                          {!isAuto && (
                            <input
                              type="number"
                              min="1000"
                              step="1000"
                              value={raw}
                              onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MAX_TOKENS', e.target.value)}
                              placeholder="60000"
                              style={{ flex: 1 }}
                            />
                          )}
                        </div>
                      );
                    })()}
                  </FormField>
                  <FormField
                    label="Max Context Messages"
                    tooltip="Hard cap on conversation turns sent to the local model."
                  >
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={formState.CLAUDE_MEM_LOCAL_MAX_CONTEXT_MESSAGES || '20'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MAX_CONTEXT_MESSAGES', e.target.value)}
                      placeholder="20"
                    />
                  </FormField>
                  <FormField
                    label="Max Parallel Requests"
                    tooltip="Maximum number of in-flight requests claude-mem sends to the local server at once. Match this to your LM Studio / Ollama queue depth (Settings → Serve on Local Network → Parallel request handling). Set higher only if your server is configured to handle more than one request in parallel."
                  >
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={formState.CLAUDE_MEM_LOCAL_MAX_CONCURRENT || '1'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MAX_CONCURRENT', e.target.value)}
                      placeholder="1"
                    />
                  </FormField>
                  <FormField
                    label="Fall Back to Claude on Failure"
                    tooltip="When enabled, if the local server times out, refuses connections, or returns a 5xx error, claude-mem will silently retry the same work with the Claude SDK (Claude subscription / API billing applies). When disabled, local failures fail the session cleanly — no cloud requests, no surprise billing."
                  >
                    <select
                      value={formState.CLAUDE_MEM_LOCAL_FALLBACK_ENABLED || 'false'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_FALLBACK_ENABLED', e.target.value)}
                    >
                      <option value="false">Disabled (local only)</option>
                      <option value="true">Enabled (fall back to Claude)</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Request Timeout (ms)"
                    tooltip="Per-request timeout for calls to the local server. If LM Studio / Ollama hangs on a generation, claude-mem aborts the request after this many milliseconds instead of waiting forever. 300000 (5 min) is a generous default for large models. Range: 5000–3600000."
                  >
                    <input
                      type="number"
                      min="5000"
                      max="3600000"
                      step="1000"
                      value={formState.CLAUDE_MEM_LOCAL_REQUEST_TIMEOUT_MS || '300000'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_REQUEST_TIMEOUT_MS', e.target.value)}
                      placeholder="300000"
                    />
                  </FormField>
                  <FormField
                    label="Enable Thinking Mode"
                    tooltip="Qwen3.x-style reasoning mode. When disabled (recommended for observation extraction), the model skips <think>…</think> scaffolding and emits structured output directly — faster, cheaper, and avoids parser noise. Servers that don't support chat_template_kwargs.enable_thinking will ignore this flag."
                  >
                    <select
                      value={formState.CLAUDE_MEM_LOCAL_ENABLE_THINKING || 'false'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_ENABLE_THINKING', e.target.value)}
                    >
                      <option value="false">Disabled (recommended)</option>
                      <option value="true">Enabled</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Temperature"
                    tooltip="Sampling temperature. Qwen3.6 instruct mode: 0.7. Lower values (0.2–0.4) favor deterministic XML; higher (0.7+) matches vendor defaults."
                  >
                    <input
                      type="number" min="0" max="2" step="0.05"
                      value={formState.CLAUDE_MEM_LOCAL_TEMPERATURE || '0.7'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_TEMPERATURE', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="top_p"
                    tooltip="Nucleus sampling. Qwen3.6 instruct: 0.8. Thinking mode: 0.95."
                  >
                    <input
                      type="number" min="0" max="1" step="0.01"
                      value={formState.CLAUDE_MEM_LOCAL_TOP_P || '0.8'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_TOP_P', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="top_k"
                    tooltip="Top-k sampling. Qwen3.6: 20. Set to -1 to disable."
                  >
                    <input
                      type="number" min="-1" max="1000" step="1"
                      value={formState.CLAUDE_MEM_LOCAL_TOP_K || '20'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_TOP_K', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="min_p"
                    tooltip="Minimum probability cutoff (llama.cpp / LM Studio). Qwen3.6: 0.0."
                  >
                    <input
                      type="number" min="0" max="1" step="0.01"
                      value={formState.CLAUDE_MEM_LOCAL_MIN_P || '0.0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MIN_P', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="presence_penalty"
                    tooltip="Reduces token repetition. Qwen3.6 instruct: 1.5 (0–2 safe; above 1.5 can cause language mixing)."
                  >
                    <input
                      type="number" min="-2" max="2" step="0.1"
                      value={formState.CLAUDE_MEM_LOCAL_PRESENCE_PENALTY || '1.5'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_PRESENCE_PENALTY', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="repetition_penalty"
                    tooltip="llama.cpp / LM Studio repetition penalty. Qwen3.6: 1.0 (off)."
                  >
                    <input
                      type="number" min="0.5" max="2" step="0.05"
                      value={formState.CLAUDE_MEM_LOCAL_REPETITION_PENALTY || '1.0'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_REPETITION_PENALTY', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="Max Output Tokens"
                    tooltip="Maximum tokens the model may generate per call. 4096 is enough for observation extraction; raise for summary passes on long sessions."
                  >
                    <input
                      type="number" min="256" max="100000" step="256"
                      value={formState.CLAUDE_MEM_LOCAL_MAX_OUTPUT_TOKENS || '4096'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_LOCAL_MAX_OUTPUT_TOKENS', e.target.value)}
                    />
                  </FormField>
                </>
              )}

              <FormField
                label="Worker Port"
                tooltip="Port for the background worker service"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || '37777'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label="Include last summary"
                  description="Add previous session's summary to context"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label="Include last message"
                  description="Add previous session's final message"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
