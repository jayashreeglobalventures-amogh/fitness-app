// A minimal client for the OmniRoute AI gateway (OpenAI-compatible /v1/chat/completions). OmniRoute holds the
// provider keys (NVIDIA, Groq, ...) and falls back between them; the app only knows one URL and one key.
// Uses the built-in fetch: no SDK, no extra dependency.
//
//   OMNIROUTE_API_KEY      the app's OmniRoute key (empty = no AI through OmniRoute)
//   OMNIROUTE_BASE_URL     default http://omniroute-app:20128/v1 (the gateway on the shared edge network)

export interface OmniRouteConfig { apiKey: string; baseUrl: string; fetch?: typeof fetch }

/** A failure that may succeed later (rate limit, overload, network, timeout) or not (bad key, bad request). */
export class OmniRouteError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status: number | null = null) { super(message); }
}

export function omniRouteConfig(env: NodeJS.ProcessEnv = process.env): OmniRouteConfig | null {
  const apiKey = env.OMNIROUTE_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: (env.OMNIROUTE_BASE_URL?.trim() || 'http://omniroute-app:20128/v1').replace(/\/+$/, '') };
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface JsonRequest {
  model: string;
  system: string;
  user: string | ContentPart[];
  schema: { name: string; schema: object };
  maxTokens: number;
  timeoutMs: number;
}

/** One chat completion that must answer with a JSON object. Returns the parsed object and the model that answered. */
export async function chatJson(cfg: OmniRouteConfig, req: JsonRequest): Promise<{ json: Record<string, unknown>; model: string }> {
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } },
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    throw new OmniRouteError(timedOut ? 'The AI gateway timed out.' : 'Could not reach the AI gateway.', true);
  }
  if (!res.ok) {
    const s = res.status;
    // 401/403: the app's key is wrong; 400/404/422: the request or model name is wrong. Retrying won't help.
    const retryable = s === 408 || s === 409 || s === 429 || s >= 500;
    throw new OmniRouteError(s === 401 || s === 403 ? 'The AI gateway refused the API key.' : `The AI gateway answered ${s}.`, retryable, s);
  }
  let body: { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
  try { body = await res.json(); } catch { throw new OmniRouteError('The AI gateway sent an unreadable answer.', true); }
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length') throw new OmniRouteError('The AI answer was cut short.', true);
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  // Some models wrap JSON in prose or a code fence: take the outermost object.
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let json: unknown;
  try { json = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null; } catch { json = null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new OmniRouteError('The AI answer could not be parsed.', true);
  return { json: json as Record<string, unknown>, model: typeof body.model === 'string' ? body.model : req.model };
}
