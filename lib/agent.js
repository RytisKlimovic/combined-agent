"use strict";

/**
 * agent.js — the agent loop (tool use).
 *
 * The model picks its own actions: read the page or a document, search a
 * knowledge base, write into a form field. We execute, hand the result back to
 * the model, and repeat until it produces a final answer.
 *
 * The protocol is PROMPT-based JSON rather than native function calling, so it
 * does not depend on how the model server is configured. To use a tool the
 * model returns exactly ONE JSON object; when it has an answer it returns
 * plain text.
 *
 * Model-agnostic: the network and the tools are injected through `callModel`
 * and `tools`, so the whole loop is tested without a server (see
 * tests/agent.test.mjs).
 */

/** The tool description handed to the model. */
function toolsSpec(tools) {
  return tools
    .map((t) => {
      const args = t.args ? ` Arguments: ${t.args}.` : " No arguments needed.";
      return `- ${t.name}: ${t.description}${args}`;
    })
    .join("\n");
}

/** The agent system prompt: persona + tools + protocol. */
export function buildAgentSystem(tools, { persona = "" } = {}) {
  return (
    (persona ? persona + "\n\n" : "") +
    "You have tools with which you can obtain information and perform actions yourself. " +
    "Use them ONLY when needed — if you can answer from what you already know, answer straight away.\n\n" +
    "Available tools:\n" +
    toolsSpec(tools) +
    "\n\nPROTOCOL:\n" +
    "- To use a tool, reply with ONE JSON object and NOTHING else: " +
    '{"tool": "tool_name", "args": { ... }}. No other text before or after it.\n' +
    "- Once you have the tool result, carry on: either call another tool, or give the final answer.\n" +
    "- When you have the final answer, write it in PLAIN text (no JSON, no tool).\n" +
    "- Actions (for example writing into a field) are confirmed by a human — you only propose them.\n" +
    "- Do not guess and do not invent data: if a tool returned nothing, say so."
  );
}

/**
 * Extracts a tool call from the model's text.
 * @returns {{tool: string, args: object}|null}
 */
export function parseToolCall(text) {
  let s = String(text ?? "").trim();
  if (!s) return null;

  // The model sometimes wraps it in ```json ... ```
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (s[0] !== "{") return null;

  // Take the first balanced {…} block (anything after it is ignored).
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  let obj;
  try {
    obj = JSON.parse(s.slice(0, end));
  } catch {
    return null;
  }
  if (!obj || typeof obj.tool !== "string") return null;
  return { tool: obj.tool, args: obj.args && typeof obj.args === "object" ? obj.args : {} };
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + "\n…[truncated]" : s || "");

/**
 * Runs the agent loop.
 *
 * @param {object} o
 * @param {Array<{role,text,image?}>} o.history — a neutral conversation (user/assistant)
 * @param {Array<{name,description,args?,run:(args,ctx)=>Promise<string>}>} o.tools
 * @param {(o:{messages,system,signal,onToken})=>Promise<string>} o.callModel
 * @param {(step:{tool,args,status:'start'|'done'|'error',result?,error?})=>void} [o.onStep]
 * @param {(delta:string, full:string)=>void} [o.onAnswerToken] — streams the FINAL answer only
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxSteps=6]
 * @param {string} [o.persona]
 * @param {number} [o.maxResultChars=8000]
 * @returns {Promise<{text:string, steps:number, stopped:boolean}>}
 */
export async function runAgent({
  history,
  tools,
  callModel,
  onStep,
  onAnswerToken,
  signal,
  maxSteps = 6,
  persona = "",
  maxResultChars = 8000,
}) {
  const system = buildAgentSystem(tools, { persona });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const work = history.map((m) => ({ ...m }));
  let steps = 0;

  for (let iter = 0; iter < maxSteps; iter++) {
    if (signal?.aborted) return { text: "", steps, stopped: true };

    // Only reveal the stream if this is the FINAL answer (it does not start
    // with JSON).
    let mode = "unknown";
    const onToken = (delta, full) => {
      if (mode === "unknown") {
        const t = full.trimStart();
        if (!t) return;
        mode = t[0] === "{" || t.startsWith("```") ? "tool" : "answer";
      }
      if (mode === "answer") onAnswerToken?.(delta, full);
    };

    let full;
    try {
      full = await callModel({ messages: work, system, signal, onToken });
    } catch (err) {
      if (err?.name === "AbortError") return { text: "", steps, stopped: true };
      throw err;
    }

    const call = parseToolCall(full);
    if (!call) {
      return { text: full, steps, stopped: false }; // the final answer
    }

    // The model's turn (the tool call) stays in the conversation so the
    // context is not lost.
    work.push({ role: "assistant", text: full });

    const tool = byName.get(call.tool);
    if (!tool) {
      work.push({
        role: "user",
        text: `[System note] Unknown tool "${call.tool}". Available: ${tools
          .map((t) => t.name)
          .join(", ")}. Try again, or answer in text.`,
      });
      continue;
    }

    steps++;
    onStep?.({ tool: call.tool, args: call.args, status: "start" });
    let result;
    try {
      result = await tool.run(call.args || {}, { signal });
      onStep?.({ tool: call.tool, args: call.args, status: "done", result });
    } catch (err) {
      if (err?.name === "AbortError") return { text: "", steps, stopped: true };
      const message = err?.message || String(err);
      onStep?.({ tool: call.tool, args: call.args, status: "error", error: message });
      // A tool failure does NOT break the loop — tell the model and let it decide.
      work.push({ role: "user", text: `[Tool "${call.tool}" error] ${message}` });
      continue;
    }

    work.push({
      role: "user",
      text: `[Tool "${call.tool}" result]\n${truncate(String(result ?? "").trim() || "(empty)", maxResultChars)}`,
    });
  }

  // The budget is spent — ask one last time for a TEXT answer with no tools.
  if (signal?.aborted) return { text: "", steps, stopped: true };
  try {
    const full = await callModel({
      messages: [
        ...work,
        { role: "user", text: "[System note] The action limit has been reached. Answer in text from what you already have." },
      ],
      system,
      signal,
      onToken: (delta, fullText) => onAnswerToken?.(delta, fullText),
    });
    const call = parseToolCall(full);
    return { text: call ? "Could not finish within the allowed number of actions." : full, steps, stopped: false };
  } catch (err) {
    if (err?.name === "AbortError") return { text: "", steps, stopped: true };
    throw err;
  }
}
