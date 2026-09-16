/**
 * vllm-client.js — OpenAI-compatible client for the model server.
 * Called ONLY from the service worker (for CORS and host_permissions reasons).
 */

/** Strips a trailing slash so `${endpoint}/v1/...` does not double up. */
function normalizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/\/+$/, '');
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function readError(res) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* body already read, or the request was aborted */
  }
  // The full body never goes into the message — it may echo the prompt, and
  // the prompt may contain PHI.
  const short = detail.slice(0, 200);
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  // The URL is essential: without it a 405/404 cannot be diagnosed — there is
  // no way to tell which server and which path was actually hit (a common
  // proxy/configuration mistake).
  const where = res.url ? `\nURL: ${res.url}` : '';
  return new Error(`Model server error: ${status}${short ? ` — ${short}` : ''}${where}`);
}

/**
 * Non-streaming generation.
 * @returns {Promise<string>} the generated text
 */
export async function generate({
  endpoint,
  model,
  apiKey,
  messages,
  maxTokens,
  temperature = 0.2,
  signal,
}) {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });

  if (!res.ok) throw await readError(res);

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('The model server returned an unexpected response shape (no choices[0].message.content).');
  }
  return text;
}

/**
 * Streaming generation. Calls onDelta(chunk) for every chunk.
 * @returns {Promise<string>} the full accumulated text
 */
export async function generateStream({
  endpoint,
  model,
  apiKey,
  messages,
  maxTokens,
  temperature = 0.2,
  signal,
  onDelta,
}) {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) throw await readError(res);
  if (!res.body) throw new Error('The model server returned no streaming body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; keep the incomplete tail in
      // the buffer.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // incomplete or corrupted chunk — skip it
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta?.(delta);
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return full;
}

/**
 * Connection check for the settings UI. Returns no patient data of any kind.
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
export async function testConnection({ endpoint, apiKey, signal }) {
  try {
    const res = await fetch(`${normalizeEndpoint(endpoint)}/v1/models`, {
      method: 'GET',
      headers: buildHeaders(apiKey),
      signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    const data = await res.json();
    const models = (data?.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
