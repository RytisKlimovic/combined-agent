/**
 * agent.js tests — the agent loop, with no server.
 *
 * `callModel` and `tools` are injected, so the whole of the logic (parsing,
 * step ordering, the limit, errors, cancellation) is tested against fakes.
 */
import { pathToFileURL, fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("..", import.meta.url));
const { runAgent, parseToolCall, buildAgentSystem } = await import(
  pathToFileURL(`${EXT}/lib/agent.js`).href
);

let pass = 0,
  fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};

/** A callModel that returns a pre-scripted sequence of replies. */
function scriptedModel(replies) {
  let i = 0;
  const calls = [];
  const fn = async ({ messages, system, onToken }) => {
    calls.push({ messages: messages.map((m) => ({ role: m.role, text: m.text })), system });
    const out = replies[i++] ?? "(exhausted)";
    onToken?.(out, out);
    return out;
  };
  fn.calls = calls;
  return fn;
}

console.log("--- parseToolCall ---");
check("plain JSON", JSON.stringify(parseToolCall('{"tool":"read_page","args":{}}')) === '{"tool":"read_page","args":{}}');
check("wrapped in ```json", parseToolCall('```json\n{"tool":"x","args":{"a":1}}\n```')?.tool === "x");
check("args default to {}", JSON.stringify(parseToolCall('{"tool":"x"}')?.args) === "{}");
check("plain prose -> null", parseToolCall("This is an outpatient consultation.") === null);
check("text not starting with { -> null", parseToolCall("Answer: {something}") === null);
check("malformed JSON -> null", parseToolCall('{"tool": ') === null);
check("no tool field -> null", parseToolCall('{"foo":1}') === null);
check("trailing junk after the object is ignored", parseToolCall('{"tool":"x","args":{}}\ngarbage')?.tool === "x");

console.log("--- The system prompt ---");
{
  const sys = buildAgentSystem([{ name: "read_page", description: "reads the page" }], { persona: "You are an assistant." });
  check("the persona is present", sys.includes("You are an assistant."));
  check("the tool name is present", sys.includes("read_page"));
  check("the protocol is present", /JSON/.test(sys) && /tool/.test(sys));
}

console.log("--- One turn, no tools ---");
{
  const model = scriptedModel(["This is an outpatient consultation."]);
  const r = await runAgent({ history: [{ role: "user", text: "what is this?" }], tools: [], callModel: model });
  check("the final answer is returned", r.text === "This is an outpatient consultation.");
  check("zero steps", r.steps === 0);
  check("the model was called once", model.calls.length === 1);
}

console.log("--- One tool, then an answer ---");
{
  const ran = [];
  const tools = [
    {
      name: "read_document",
      description: "reads a document",
      run: async (args) => {
        ran.push(args);
        return "Document contents: 42";
      },
    },
  ];
  const model = scriptedModel([
    '{"tool":"read_document","args":{"url":"http://x/y.pdf"}}',
    "The document says 42.",
  ]);
  const steps = [];
  const r = await runAgent({
    history: [{ role: "user", text: "what is in the document?" }],
    tools,
    callModel: model,
    onStep: (s) => steps.push(s),
  });

  check("the tool was called with its args", ran.length === 1 && ran[0].url === "http://x/y.pdf");
  check("the final answer", r.text === "The document says 42.");
  check("one step", r.steps === 1);
  check("the step reported start+done",
    steps.filter((s) => s.status === "start").length === 1 && steps.some((s) => s.status === "done"));
  // On the second model call the result must be in the conversation.
  const second = model.calls[1].messages.map((m) => m.text).join("\n");
  check("the result was handed back to the model", second.includes("Document contents: 42"));
}

console.log("--- An unknown tool ---");
{
  const model = scriptedModel(['{"tool":"no_such_tool","args":{}}', "Sorry, I cannot."]);
  const r = await runAgent({ history: [{ role: "user", text: "x" }], tools: [], callModel: model });
  check("an unknown tool does not break the loop", r.text === "Sorry, I cannot.");
  check("the model was told about the error",
    model.calls[1].messages.some((m) => /Unknown tool/.test(m.text)));
}

console.log("--- A tool failure ---");
{
  const tools = [{ name: "boom", description: "falls over", run: async () => { throw new Error("HTTP 500"); } }];
  const model = scriptedModel(['{"tool":"boom","args":{}}', "Could not reach the source."]);
  const steps = [];
  const r = await runAgent({ history: [{ role: "user", text: "x" }], tools, callModel: model, onStep: (s) => steps.push(s) });
  check("the loop continues after a tool failure", r.text === "Could not reach the source.");
  check("the step is marked error", steps.some((s) => s.status === "error"));
  check("the error was passed to the model",
    model.calls[1].messages.some((m) => /error/.test(m.text) && /HTTP 500/.test(m.text)));
}

console.log("--- The iteration limit ---");
{
  // The model always asks for a tool — the loop must stop at maxSteps.
  const model = scriptedModel(
    Array(20).fill('{"tool":"loop","args":{}}').concat(["(unreachable)"])
  );
  const tools = [{ name: "loop", description: "repeats", run: async () => "again" }];
  const r = await runAgent({ history: [{ role: "user", text: "x" }], tools, callModel: model, maxSteps: 3 });
  check("no more steps than the limit", r.steps === 3, `-> ${r.steps}`);
  check("it returns some text (not an infinite loop)", typeof r.text === "string");
}

console.log("--- Streaming the final answer ---");
{
  // In 'answer' mode the tokens must reach onAnswerToken; in 'tool' mode not.
  const model = scriptedModel(['{"tool":"t","args":{}}', "The final text."]);
  const tools = [{ name: "t", description: "t", run: async () => "ok" }];
  let streamed = "";
  await runAgent({
    history: [{ role: "user", text: "x" }],
    tools,
    callModel: model,
    onAnswerToken: (_d, full) => (streamed = full),
  });
  check("only the final answer was streamed", streamed === "The final text.", `-> ${streamed}`);
}

console.log("--- Cancellation ---");
{
  const controller = new AbortController();
  const tools = [
    {
      name: "t",
      description: "t",
      run: async () => {
        controller.abort();
        return "ok";
      },
    },
  ];
  const model = scriptedModel(['{"tool":"t","args":{}}', "(should not be reached)"]);
  const r = await runAgent({
    history: [{ role: "user", text: "x" }],
    tools,
    callModel: model,
    signal: controller.signal,
  });
  check("the cancellation is reported", r.stopped === true);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
