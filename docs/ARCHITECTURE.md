# Architecture

Notes on why the code is shaped the way it is. The README covers what the thing
does; this covers the decisions, including the ones that were wrong first time
round.

## The two halves, and why they share a worker

The extension grew from two separate tools: a side-panel assistant that answers
questions about the current tab, and a form-drafting assistant that lives inside
an EHR page. They were merged because they kept needing each other — an answer
in the chat wanted to go into a form field, and a form field wanted context from
a document open in another tab.

They now share one service worker, and that is the whole architecture:

```
              ┌──────────────────────────────────────────┐
              │            service worker                │
              │  the ONLY code that touches the network  │
              │                                          │
              │  vllm-client   asr-client   metrics       │
              └───────┬───────────────────────┬──────────┘
                port  │                       │  port / messages
                      │                       │
      ┌───────────────▼───────┐   ┌───────────▼─────────────────┐
      │     side panel        │   │      content script         │
      │  chat, history, form  │   │  DOM, overlay, dictation    │
      │  view, settings       │   │  (runs in the host page)    │
      └───────────────────────┘   └─────────────────────────────┘
```

Three consequences, all of them the point:

1. **The host page's CSP and CORS never come up.** Fetches and WebSockets happen
   in the extension's own context. A hospital EHR with a strict `connect-src`
   would otherwise break dictation and never say why.
2. **Endpoint addresses do not leak into the page.** The content script knows
   there is a model somewhere; it does not know where.
3. **Metrics have one writer.** `sanitize()` and the IndexedDB buffer live in
   the worker, which means there is exactly one code path into storage — and the
   store is in the *extension's* origin rather than the page's.

## Where patient data is allowed to be

This is the constraint everything else bends around.

| Location | Patient data? |
| --- | --- |
| The review overlay in the page | Yes — briefly. Cleared on close. |
| Prompts in flight to the model | Yes. Not logged (`DEBUG` ships `false`). |
| `chrome.storage` | Never. Settings, an API key, and an install pseudonym. |
| Conversation history (IndexedDB) | Yes, but **never** for clinical pages. |
| `storage.session` restore | Same rule as history. |
| The metrics database | Structurally impossible. See below. |

`isClinicalUrl()` in [`lib/settings.js`](../lib/settings.js) is the single
predicate behind rows 4 and 5, which is why it has [a test file of its
own](../tests/clinical-url.test.mjs): a wrong `false` is a PHI leak to disk. Note
that it matches hostnames exactly rather than by substring — `localhost.evil.com`
must not read as clinical.

The metrics guarantee is worth spelling out because it is unusual. The schema
admits only numbers, booleans and fixed `Set` enums; there is no free-text field
in it at all. `sanitize()` iterates the **schema**, not the payload, so an
unknown key cannot get through even in principle. `fieldKey` is not a string but
a `Set` built from `Object.keys(FIELD_MAP)` — code identifiers, not data. The
test hands it a whole realistic context object and asserts none of it survives.

## The configurable endpoint

The model server, the model name, the API key and the ASR endpoint are set in
the side panel and stored in `chrome.storage.local`. Everything else in
`DEFAULTS` stays fixed. That split is the interesting part:

```js
export const CONFIGURABLE = Object.freeze(['vllmEndpoint', 'model', 'apiKey', 'asrEndpoint']);
```

`getSettings()` reads only those keys on top of `DEFAULTS`, so a stray storage
entry cannot disable streaming, raise the token budget or — the one that
matters — replace `systemPromptOverride`. The safety guards in
`lib/prompt-templates.js` are only guards while the system prompt is not a
user-editable string, and a test asserts it is not on the list.

Two consequences ripple outwards from making the endpoint a variable:

**URL joining stopped being string concatenation.** `${base}/v1/chat/completions`
is right for vLLM and wrong for at least three providers people will actually
use: Mistral and Groq hand out a root that already ends in `/v1`, and Google's
OpenAI compatibility layer sits at `/v1beta/openai/` with no `/v1` segment at
all. `chatCompletionsUrl()` in [`llm.js`](../llm.js) therefore respects what was
pasted — a URL naming the operation is used verbatim, a URL ending in a version
segment gets only the operation appended, anything else is a server root.
[`tests/endpoint-url.test.mjs`](../tests/endpoint-url.test.mjs) pins every shape.

**A failed pre-flight stopped meaning "server down".** The panel used to require
`/models` to return 200 before it would send anything. Several providers do not
implement `/models`, so that check would have rejected working servers. Now only
a transport failure or an explicit 401/403 blocks sending — everything else is
treated as "the server answered", and the real request surfaces its own error,
which carries far better detail than a pre-flight ever could. `testConnection()`
returns `reachable` and `ok` as separate answers for exactly this reason.

There is also a plain honesty problem that code cannot solve. The original
deployment ran the model inside the hospital network; that was the point.
Pointing the extension at a hosted provider sends page content — patient data,
in a clinical deployment — to a third party. `isLocalEndpoint()` drives a
warning in the Settings pane whenever the endpoint is not loopback. It warns
rather than blocks: a deliberate choice belongs to the user, an accidental one
does not.

## The one file that knows about the EHR

[`content/field-map.js`](../content/field-map.js) holds every selector in the
project. Everything else is host-agnostic. That boundary is what makes the
generalised version of this repository possible at all: swapping the selector
map is the only change needed to point it at a different system.

Two maps live there:

- `FIELD_MAP` — the curated fields the assistant may draft, each with its prompt
  template and a token budget. Small, deliberate, and reviewed.
- `CONTEXT_SELECTORS` — where patient data is *read from* for the prompt.
  Deliberately does **not** include name, surname or national ID (GDPR data
  minimisation): a draft does not need them. Date of birth is read only to
  derive an age, and is deleted from the context immediately afterwards.

### Why every field lists several selectors

Server-rendered forms (ASP.NET MVC, JSF, Rails) derive the DOM `id` from the
model binding path. That derivation is not stable:

```
name="Note.ObjectiveStatus"
  visit note        -> id="Note_ObjectiveStatus"
  discharge summary -> id="Note_ObjectiveStatus_"   <-- trailing underscore
```

The cause is a validation wrapper: the wrapper takes the base `id` and the real
control gets a suffix. Validation comes and goes between forms and releases, so
`id` cannot be relied on. The `[name=]` binding path is stable and identical
across forms, so it goes first and `#id` variants are fallbacks only.

Both demo forms reproduce this on purpose, and the test asserts that the plain
`#id` genuinely does not exist in one of them.

### The static map is not enough

The curated map covers the fields worth *generating*. But dictation has to work
on forms nobody has mapped yet — including forms from an older system with no
`<label for>` at all, where field names are codes like `EP48` and the human
label sits in a `title` attribute or the neighbouring `<td>`.

[`content/form-scan.js`](../content/form-scan.js) therefore discovers every
free-text field dynamically, deriving a label from `label[for]`, an ancestor
`<label>`, `title` / `aria-label` / `placeholder`, the adjacent table cell, or —
last resort — the binding path itself.

Two details that turned out to matter:

- **Labels must be unique.** The model routes dictated text *by label*, so two
  fields both labelled "Description" would send text to an arbitrary one. Where
  labels collide they are qualified with the parent segment of the binding path
  ("Diagnoses — Description"), and if they still collide a number is appended.
- **The side panel and dictation must see the same list.** The panel used to
  show `FIELD_MAP` only — two fields, where dictation saw sixteen. Both now read
  the scan.

## The agent loop

[`lib/agent.js`](../lib/agent.js) implements tool use over a **prompt-based JSON
protocol** rather than native function calling. To use a tool the model returns
exactly one JSON object; when it has an answer it returns plain text.

That choice costs some robustness and buys two things. It works against any
OpenAI-compatible server regardless of whether native tool calling is enabled in
that particular deployment. And because the network and the tools are injected
as `callModel` and `tools`, the entire loop — parsing, step ordering, the
iteration budget, tool failures, cancellation — is tested against fakes with no
server at all.

Two behaviours are load-bearing:

- **Streaming is revealed only for the final answer.** The loop watches the
  first non-whitespace character: `{` or a fence means a tool call, and those
  tokens are swallowed. Otherwise it is the answer and tokens reach the UI. Users
  should never watch raw JSON scroll past.
- **A tool failure does not break the loop.** The error is handed back to the
  model as a message and it decides what to do. An unknown tool name likewise
  gets a correction rather than an exception.

`fill_fields` takes an **array** of fields for a reason. It used to take one, and
each call opened the same overlay separately, so only the last proposal was ever
visible. It now routes through the same multi-field review as global dictation.

## Prompt design

Every mapped field has its own template in
[`lib/prompt-templates.js`](../lib/prompt-templates.js). Three structural rules
came out of things going wrong.

**Recency is a tool.** Templates carry concrete formatting demands ("cover the
onset and course", "1-2 paragraphs"). Those demands *beat* a vague ban on
inventing facts earlier in the prompt. So the guard blocks go at the **end**, and
they explicitly revoke what came before:

> Therefore the PRECEDING instructions about length and form … DO NOT APPLY —
> do not follow them.

**Guards are appended centrally.** `buildMessages()` attaches either the
no-source block or the clinician-draft block. An individual template cannot
forget to include one, and a test asserts every template is covered.

**They are mutually exclusive.** If the clinician typed something into the field,
that text *is* the data, and a block saying "no clinical data was supplied"
would directly contradict it. The draft block also has to suppress the
"No additional context available." line for the same reason. A test iterates
every template and asserts the two blocks never co-occur.

The draft block inverts the task. With text already in the field the job is no
longer writing but editing, so the block states that the clinician's text is the
primary source, forbids adding detail they did not state (no duration, no
severity, no site refinement, no "denies associated symptoms"), and forbids
claiming that data is missing.

## Documents

The browser cannot read several things a user will nonetheless ask about, so
there are three paths, all landing in the same place — a context block attached
to the conversation.

**PDFs.** Chrome's built-in viewer cannot be script-injected, so the file is
fetched and parsed with a bundled pdf.js. `pdftext.js` splits load / extract /
render deliberately: a scanned PDF needs both the (empty) text layer, to notice
it *is* a scan, and its pages as images, and re-fetching would download the file
twice.

**Scans.** `isScanned()` is a text-density heuristic — under 100 characters per
page. Deliberately low, because scans still carry a few dozen characters of
headers and stamps. Transcription then runs page by page rather than all at
once: that gives progress, bounds the context, and lets a cancellation keep the
pages already done. A page that fails is marked and the document continues.

**Office and cloud files.** OOXML is a ZIP of XML, so `lib/zip.js` (a ~90-line
reader on top of `DecompressionStream`) and `lib/office.js` (regex, because a
service worker has no `DOMParser`) handle it with no dependencies. Google Docs
and Office for the web paint into a canvas and have no readable DOM at all, so
`lib/cloud.js` derives an export URL and the worker fetches the real file with
the user's own session.

That last one has a trap worth naming: when not signed in, Google and SharePoint
return **200 with a sign-in page**. Without an explicit HTML content-type check
the user would receive a "document" whose contents read "Sign in".

## Things that were wrong first

Kept here because the reasoning is more useful than the fix.

**A unit test that tested the wrong layer.** The recording strip stayed visible
after dictation. `els.rec.hidden = true` was correct and a JS test passed — but
the author's `.rec { display: flex }` beat the browser's default
`[hidden] { display: none }`, so the attribute did nothing. The fix is one CSS
rule; the lesson is that the test now extracts the real CSS and asserts the
**computed** `display`.

**A metric that was almost always a lie.** `editedPct` used to count *changed*
words. A one-word substitution is two diff events (delete + add), so
"temperature 36.9 degrees" → "temperature 37.2 degrees" scored 67 % instead of
33 %. Refining a number is the single most common edit, so the headline quality
metric was inflated nearly twofold on the most common case. Counting *unchanged*
words fixes it and lands naturally in 0-100 with no clamping.

Worse, past the diff's token limit the diff degenerates to "everything replaced",
so every longer draft reported 100 %. That now returns `null` — explicitly "not
measured", to be skipped in analysis rather than averaged in as a 100.

**A row limit that dropped data silently.** 200 rows per sheet meant a user saw
three of their entries and the model answered about two. Budgets are now in
characters, and a truncation is announced in the prompt *and* the UI.

**Serial startup that felt slow.** Dictation used to bring up the WebSocket
first and the microphone only after the server acknowledged, so the user waited
for the sum of two ~1-second operations. They now start in parallel via
`Promise.allSettled`, and the original reason for the ordering — never lighting
the recording indicator while audio goes nowhere — is preserved by tearing both
down if either fails.

**Highlights that highlighted everything.** The dictation corrector adds a
capital letter and punctuation to nearly every word, so a word-level diff marked
the entire text as changed. `correctionDiff()` treats case and *surrounding*
punctuation as insignificant and drops to character precision for real changes —
while keeping *internal* punctuation significant, so `369` → `36.9` still shows.
