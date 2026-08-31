// One way to ask a model a question, whichever model is configured.
//
// Provider-agnostic because the choice is not settled and should not be baked
// into the exporter: the derive pass cares that it gets JSON back, not whose
// JSON it is. Adding a provider means adding one function here.
//
// Nothing here throws. A model that is unreachable, over quota, or returning
// nonsense must degrade the pack, never fail the export — a tutor finishing a
// lesson at 9pm gets their file either way, with an honest note about what is
// missing from it.

export type LlmProvider = 'anthropic' | 'gemini';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

export interface LlmResult {
  ok: boolean;
  text?: string;
  /** Model actually used, for `derived.generator`. */
  model?: string;
  reason?: string;
}

/** Read the environment. Returns null when no key is configured at all. */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const anthropic = env.ANTHROPIC_API_KEY;
  const gemini = env.GEMINI_API_KEY;
  const preferred = (env.DERIVE_PROVIDER || '').toLowerCase();

  if (preferred === 'anthropic' && anthropic) {
    return { provider: 'anthropic', model: env.DERIVE_MODEL || 'claude-sonnet-4-5', apiKey: anthropic };
  }
  if (preferred === 'gemini' && gemini) {
    return { provider: 'gemini', model: env.DERIVE_MODEL || 'gemini-2.5-flash', apiKey: gemini };
  }
  if (anthropic) {
    return { provider: 'anthropic', model: env.DERIVE_MODEL || 'claude-sonnet-4-5', apiKey: anthropic };
  }
  if (gemini) {
    return { provider: 'gemini', model: env.DERIVE_MODEL || 'gemini-2.5-flash', apiKey: gemini };
  }
  return null;
}

/**
 * One turn: a system prompt and a user message, text back.
 *
 * Images are deliberately NOT sent yet. The board frames are the reliable
 * record and a vision pass over them is worth doing — but it multiplies cost
 * and latency, and belongs with the stroke log in Phase 3, where crops can be
 * sent instead of whole frames.
 */
export async function askModel(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<LlmResult> {
  const maxTokens = opts.maxTokens ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) return { ok: false, reason: `anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const body = await res.json() as any;
      const text = (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      return text ? { ok: true, text, model: body.model || cfg.model } : { ok: false, reason: 'anthropic returned no text' };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return { ok: false, reason: `gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = await res.json() as any;
    const text = (body.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text || '').join('');
    return text ? { ok: true, text, model: cfg.model } : { ok: false, reason: 'gemini returned no text' };
  } catch (err) {
    const e = err as Error;
    return { ok: false, reason: e.name === 'AbortError' ? 'model call timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a JSON object out of a model's reply.
 *
 * Models wrap JSON in prose or fences however much you ask them not to, and a
 * pass that fails because of a stray "Here you go:" is a pass that fails for no
 * reason. Falls back to the outermost braces.
 */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* try the next shape */ }
    const first = c.indexOf('{');
    const last = c.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(c.slice(first, last + 1)); } catch { /* give up on this one */ }
    }
  }
  return null;
}
