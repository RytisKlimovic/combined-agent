"use strict";

// Shared LLM layer: builds OpenAI-compatible / Ollama requests and runs them,
// with optional token streaming. Kept UI-agnostic so popup, side panel and the
// background worker can all reuse it.

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "\n…[truncated]" : s || "");

// Steers the model toward short, on-point answers. The single biggest lever
// against rambling, whole-screen descriptions.
export const DEFAULT_SYSTEM =
  "You are a screen assistant embedded in the browser. You get a screenshot of " +
  "the user's tab and, optionally, its page text.\n" +
  "- Answer the question directly and concisely. Match length to the question: " +
  "a simple question gets one or two sentences; only go long when the task truly needs it.\n" +
  "- Do NOT describe the whole screen or restate the context unless that is explicitly what's asked.\n" +
  "- Skip preambles like \"This screen shows…\"; lead with the answer.\n" +
  "- When page text is provided, trust it over reading the image.";

// Header for the typed-in form values. Exported because the panel splits a
// context block on it to resend just this part when only the values changed.
export const FIELDS_LABEL =
  "Current form field values (what is typed in the form RIGHT NOW — " +
  "authoritative; a field not listed here is empty):";

// Turn the extracted page context into a compact text block the model reads
// alongside the screenshot. Skips empty fields so short pages stay cheap.
export function buildContextBlock(ctx, { maxText = 12000, textLabel } = {}) {
  if (!ctx) return "";
  const meta = [];
  if (ctx.url) meta.push(`URL: ${ctx.url}`);
  if (ctx.title) meta.push(`Title: ${ctx.title}`);

  const parts = [];
  if (meta.length) parts.push(meta.join("\n"));
  // When the user selected text, that is almost always the thing they're asking
  // about — make it prominent and tell the model to focus on it.
  if (ctx.selection) {
    parts.push(
      `The user SELECTED this specific text on the page — focus your answer on it:\n"""\n${clip(ctx.selection, 4000)}\n"""`
    );
  }
  if (ctx.text) {
    const label =
      textLabel || (ctx.selection ? "Full visible page text (background context only):" : "Visible page text:");
    parts.push(`${label}\n${clip(ctx.text, maxText)}`);
  }
  // What is actually typed into the form right now. Neither the page text nor
  // the screenshot reliably carries this, so it is stated separately and
  // marked authoritative.
  if (ctx.fields) {
    parts.push(`${FIELDS_LABEL}\n${clip(ctx.fields, 8000)}`);
  }
  if (!parts.length) return "";
  return `[Page context — prefer this text over reading it from the screenshot]\n\n${parts.join("\n\n")}`;
}

// Fold the page context into the user's text so it travels as one turn.
export function composeUserText(prompt, contextBlock) {
  return contextBlock ? `${contextBlock}\n\n[Question]\n${prompt}` : prompt;
}

// A "turn" is neutral: { role: "user"|"assistant", text, image? } where image
// is a data:image/... URL. Convert one to the format the chosen API expects.
function toApiMessage(format, turn) {
  if (format === "ollama") {
    const msg = { role: turn.role, content: turn.text };
    if (turn.image) msg.images = [turn.image.split(",")[1]]; // raw base64, no prefix
    return msg;
  }
  // OpenAI-compatible: image rides in a content-parts array.
  if (turn.image) {
    return {
      role: turn.role,
      content: [
        { type: "text", text: turn.text },
        { type: "image_url", image_url: { url: turn.image } },
      ],
    };
  }
  return { role: turn.role, content: turn.text };
}

// Reply languages the panel offers. The model is told the language by NAME
// rather than by code — a code like "lt" is ambiguous in a prompt, whereas the
// name is not. Adding a language means adding one line here and one <option>
// in sidepanel.html.
export const LANGUAGES = Object.freeze({
  en: "English",
  lt: "Lithuanian",
  de: "German",
  pl: "Polish",
});

export function languageName(code) {
  return LANGUAGES[String(code || "").toLowerCase()] || LANGUAGES.en;
}

// Build a request descriptor for the chosen API from a neutral conversation
// (`messages`: array of turns, oldest first, including the current user turn).
export function buildRequest({
  format,
  base,
  model,
  apikey,
  messages,
  stream = true,
  system = DEFAULT_SYSTEM,
  lang = "en",
}) {
  const headers = { "Content-Type": "application/json" };
  // Pin the reply language so answers match the user's choice even when the
  // page or the question is in another language.
  const langLine = `\n- Always answer in ${languageName(lang)}.`;
  const sysText = system ? system + langLine : "";
  const sys = sysText ? [{ role: "system", content: sysText }] : [];
  const apiMessages = [...sys, ...messages.map((m) => toApiMessage(format, m))];

  if (format === "ollama") {
    return {
      url: `${base}/api/chat`,
      headers,
      body: { model, messages: apiMessages, stream },
      pick: (d) => d?.message?.content,
      // Ollama streams newline-delimited JSON objects.
      parseChunk: (line) => {
        const t = line.trim();
        if (!t) return "";
        try {
          return JSON.parse(t)?.message?.content || "";
        } catch {
          return "";
        }
      },
    };
  }

  // OpenAI-compatible (vLLM, llama.cpp server, LM Studio, etc.)
  if (apikey) headers["Authorization"] = `Bearer ${apikey}`;
  return {
    url: `${base}/v1/chat/completions`,
    headers,
    body: { model, messages: apiMessages, stream },
    pick: (d) => d?.choices?.[0]?.message?.content,
    // OpenAI streams SSE: lines like `data: {json}` / `data: [DONE]`.
    parseChunk: (line) => {
      const t = line.trim();
      if (!t.startsWith("data:")) return "";
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") return "";
      try {
        return JSON.parse(payload)?.choices?.[0]?.delta?.content || "";
      } catch {
        return "";
      }
    },
  };
}

// Run a request. When streaming, `onToken(delta, full)` fires per chunk and the
// full text is returned at the end. When not streaming, `onToken(full)` fires
// once. Throws Error with a readable message on transport/HTTP failure.
export async function runChat(req, { onToken, signal } = {}) {
  let res;
  try {
    res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(
      "Couldn't reach the endpoint.\n" +
        "• Is the server running at the Base URL?\n" +
        "• Ollama: set OLLAMA_ORIGINS=* so it accepts the extension origin.\n" +
        "• Check the port and http/https."
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${detail.slice(0, 400)}`);
  }

  if (!req.body.stream || !res.body) {
    const data = await res.json();
    const text = req.pick(data);
    if (text == null) {
      throw new Error(
        "Got a response but couldn't find the message text.\n" +
          JSON.stringify(data).slice(0, 400)
      );
    }
    onToken?.(text, text);
    return text;
  }

  // Streaming: read newline-delimited chunks, keep a partial line in `buffer`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const flushLine = (line) => {
    const delta = req.parseChunk(line);
    if (delta) {
      full += delta;
      onToken?.(delta, full);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // last item may be an incomplete line
    for (const line of lines) flushLine(line);
  }
  if (buffer) flushLine(buffer);

  if (!full) throw new Error("Stream ended without any content.");
  return full;
}
