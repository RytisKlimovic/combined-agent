# Scribe Agent

A Chrome MV3 extension that puts an LLM of your choosing next to whatever is on
screen: it captures the current tab, reads documents the browser cannot read
itself, and drafts clinical form text that a human then reviews before anything
is written. Any OpenAI-compatible endpoint works — a local server by default, or
a hosted provider, configured in the side panel.

It was built as an internal tool for clinical documentation. This repository is
a generalised version: the institution, the host EHR, the internal hostnames and
the real form snapshots are gone, replaced by two synthetic demo forms and
localhost defaults. Everything else — the architecture, the safety design and
the test suite — is the original.

**Nothing is ever written into a form without an explicit human confirmation,
and the form is never submitted automatically.**

---

## What it does

**Ask about the current tab.** A side-panel chat that captures a screenshot plus
the page text, then keeps the conversation going about the same capture.
Context-aware suggestion chips adapt to what is on screen (a table, a stack
trace, a clinical form, an image).

**Read documents the browser cannot.** PDFs (text layer, or page-by-page vision
OCR when the PDF turns out to be a scan), `.docx` / `.xlsx` / `.pptx` parsed from
their raw OOXML, and Google Docs / Sheets / Slides and SharePoint files fetched
with the user's own session because those render into a canvas and have no
readable DOM.

**Dictate into a form.** Streaming speech-to-text over a WebSocket. Either into
one field, or the whole form at once: the clinician speaks naming the fields
("complaints… on examination…") and the model *routes* the text — it creates
nothing. A word-level diff shows exactly what changed before anything is
inserted.

**Draft a field from context.** Each mapped field has its own prompt template
fed from the surrounding form: vitals, investigation results, prior notes, and
whatever the clinician has already typed into the field itself.

**An agent loop.** Prompt-based JSON tool calling (no dependence on native
function calling) so the model can read a linked document, list the form fields
and propose text for several of them at once — every action confirmed by a human
through the same review overlay.

**Privacy-preserving usage metrics.** Structurally incapable of carrying patient
text; see below.

---

## Try it

```bash
git clone <this repo>
cd scribe-agent
npm install          # jsdom, for the tests
npm test
```

To load the extension:

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   directory.
2. Click the toolbar icon (or `Ctrl+Shift+L`) to open the side panel, then open
   **Settings ⚙** and point **Model server** at an endpoint (see below). Press
   **Test connection**.
3. Open `demo/visit-note.html` or `demo/discharge-summary.html` from disk, or
   serve them on localhost. Every value in them is fabricated.
4. The **Form** tab lists the fields it found; each mapped field also grows an
   "AI draft" button in the page itself.

### Choosing an endpoint

Paste either the server root — `/v1/chat/completions` is appended — or the full
chat-completions URL when a provider puts it somewhere else. Both are handled by
`chatCompletionsUrl()` in [llm.js](llm.js), which is why providers that disagree
about their API root all work.

| Endpoint to paste | What it is |
| --- | --- |
| `http://localhost:8000` | vLLM, or llama.cpp's `llama-server` |
| `http://localhost:11434/v1` | Ollama |
| `http://localhost:1234/v1` | LM Studio |
| `https://api.groq.com/openai/v1` | Groq |
| `https://openrouter.ai/api/v1` | OpenRouter (it has `:free` model variants) |
| `https://api.mistral.ai/v1` | Mistral |
| `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Google AI Studio — note it has no `/v1` segment, hence the full path |

The hosted ones all have a free tier at the time of writing, but the tiers, the
limits and the model names change often — check the provider. Set **Model** to
the name that provider uses, and paste its key into **API key**; a local server
needs no key.

**Vision matters.** Screenshots and scanned PDFs need a multimodal model. The
form-drafting half — field drafts, dictation routing, document text — works with
a text-only model, so a text-only free tier is still worth trying.

**A hosted endpoint means the page content leaves your machine**, which is the
opposite of what the original deployment needed. The Settings pane says so
whenever the endpoint is not `localhost`; see
[isLocalEndpoint](lib/settings.js). Fine for the demo forms, which are
fabricated. Not fine for real patient data.

Dictation additionally needs a speech-to-text server (default
`http://localhost:8001`, also configurable) speaking the contract documented at
the top of [`lib/asr-client.js`](lib/asr-client.js). Without it, everything
except dictation still works.

Defaults live in one place, [`lib/settings.js`](lib/settings.js); the overrides
live in `chrome.storage.local`. Nothing else in the codebase hard-codes a
host.

---

## How it is put together

```
background.js          service worker — the ONLY code that touches the network
llm.js                 request building + SSE streaming, provider-agnostic
context.js             page/selection/form-value extraction via executeScript
pdftext.js             PDF text layer + page-to-image rendering (bundled pdf.js)
sidepanel.{html,js}    the whole UI: chat, history, form view, settings
db.js                  conversation history (IndexedDB)
md.js                  a tiny Markdown renderer, and Markdown -> plain text

content/
  field-map.js         THE EHR-specific file: selectors, context sources, limits
  form-scan.js         dynamic free-text field discovery + risk classification
  content-script.js    DOM handling, the review overlay, writing into fields
  dictation.js         one dictation session (mic -> worker -> ASR)
  audio-capture.js     Float32 -> PCM int16 LE @16kHz -> base64
  text-diff.js         word- and character-level LCS diffs
  open-in-tab*.js      make host popups open as tabs, so the side panel works

lib/
  settings.js          endpoint defaults + stored overrides, clinical-URL test
  prompt-templates.js  one prompt per field + the routing prompt + the guards
  vllm-client.js       OpenAI-compatible client (streaming and not)
  asr-client.js        the speech-to-text WebSocket client
  agent.js             the tool-use loop, model-agnostic and fully testable
  ocr.js               page-by-page vision transcription of scans
  office.js            .docx/.xlsx/.pptx -> text
  zip.js               a minimal ZIP reader (OOXML is a ZIP of XML)
  cloud.js             Google/SharePoint export URL derivation
  metrics.js           the metrics schema and the sanitiser
  metrics-store.js     the metrics buffer (a SEPARATE IndexedDB database)

demo/                  two synthetic EHR forms; every value is fabricated
tests/                 21 suites, run with `npm test`
```

Two rules shape the layout:

- **All network traffic lives in the service worker.** The content script and
  the side panel talk to it over ports and messages. That keeps the host page's
  CSP and CORS out of the picture, and keeps endpoint addresses out of the page.
- **One file knows about the host EHR.** [`content/field-map.js`](content/field-map.js)
  holds every selector. Everything else is host-agnostic, which is why the
  extension keeps working on forms it has never seen (see `form-scan.js`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the decisions behind this —
including the ones that were wrong the first time.

---

## The safety design

This is the part of the project worth reading. Four mechanisms, each answering a
failure that actually happened during use.

### 1. The model is not allowed to invent clinical content

Pressing "AI draft" on an empty form used to produce a plausible paragraph about
abdominal pain that nobody had mentioned. The cause was not a bad model: the
prompt said *"write flowing prose, 1-2 paragraphs"*, there was no data, and the
model filled the void with the most typical presentation it knew.

The fix is structural. `hasClinicalSource()` decides whether the context
contains anything a draft could be built from — and patient-header data (age,
sex, diagnosis, admission time) explicitly does **not** count. When there is no
source, a block is appended at the end of the prompt that *revokes the
template's own formatting demands* and asks for nothing but a `[TO CONFIRM]`
scaffold. Appended centrally in `buildMessages()`, so no individual template can
forget it. Twenty-odd assertions in [`tests/no-source.test.mjs`](tests/no-source.test.mjs)
hold it in place.

### 2. Some fields are never generated, by decision

Allergies, medications and doses, diagnoses, measured results, procedures
performed and newborn examination findings are absent from `FIELD_MAP`
on purpose. The reasons are written out in full in the file, next to the
omission, so that adding one is a deliberate act rather than an oversight.

Global dictation still *reaches* those fields — the clinician may well want to
dictate an allergy — but `form-scan.js` classifies them as safety-critical, the
review overlay marks them red, and they are left **unchecked by default**.

The classifier is a small piece of linguistics: `non-pharmacological treatment`
must not be critical while `pharmacological treatment` must be, and in radiology
an *investigation description* is the clinician's main narrative while
*investigation results* are numbers that must be transcribed exactly. Marking the
narrative critical would devalue every warning on the screen.

### 3. Nothing changes silently

When a field is corrected by voice the model returns the **full new text**, not a
patch. Shown as-is, a number altered somewhere else in the paragraph would be
invisible. So `text-diff.js` computes a word-level LCS diff and the overlay
renders it with `<del>`/`<ins>`.

The dictation post-processor adds a capital letter and punctuation to nearly
every word, which made a plain word diff mark the whole text as changed and
rendered the highlights useless. `correctionDiff()` therefore treats
case-and-surrounding-punctuation changes as insignificant and highlights real
changes at **character** precision — while keeping *internal* punctuation
significant, because `369` → `36.9` is exactly the kind of change that must not
be hidden.

### 4. Telemetry that cannot leak

Metrics are the only component that accumulates and (optionally) transmits
anything. Everywhere else patient text merely passes through. So the privacy
guarantee is not a convention here, it is enforced by the type system of the
schema:

```js
'draft.inserted': {
  fieldKey: FIELD,  // a Set derived from the FIELD_MAP keys
  msOpen: NUM, chars: NUM,
  editedPct: NUM, editedWords: NUM, totalWords: NUM,
  todoMarkers: NUM, regens: NUM,
},
```

Only numbers, booleans and fixed `Set` enums. **There is no free-text field
anywhere in the schema**, so patient text has nowhere to go even by accident;
`sanitize()` iterates over the schema rather than over the payload, so unknown
keys cannot get in at all. [`tests/metrics.test.mjs`](tests/metrics.test.mjs)
passes an entire realistic context object in and asserts that nothing survives.

Two further details worth the trouble:

- `editedPct` — how much of a draft the clinician rewrote — is the only
  objective measure of draft quality, and it is computed via **unchanged** words.
  Counting changed tokens would score a one-word substitution as 67 % rather
  than 33 %, because a substitution is two diff events. Refining a number is the
  most common edit there is, so that bias would have inflated the headline
  metric on almost every record.
- When the text is too long to diff, `editedPct` is `null`, not `0` and not
  `100`. Past its limit the diff degenerates to "everything replaced", which
  would have reported 100 % rewriting on every longer draft.

Beyond that: pages that may hold patient data are recognised by
`isClinicalUrl()` and excluded from both on-disk history and session restore;
the draft is cleared out of the DOM when the overlay closes; a `DEBUG` flag in
the worker gates all prompt logging and ships as `false`; and metrics live in a
**separate** IndexedDB database from the conversation history, so that "clear
the metrics" is a verifiable statement rather than a promise.

---

## Notable implementation details

A few problems whose solutions were not obvious.

**`[name=]` before `#id`.** Server-rendered EHR forms derive the DOM `id` from
the model binding path, and that derivation is not stable: wrap a field for
validation and the wrapper takes the base `id` while the control gains a
trailing underscore. Validation appears and disappears between forms and
releases. So every field in `FIELD_MAP` lists the stable `[name=]` binding path
first and keeps `#id` variants as fallbacks. Both demo forms exercise this, and
[`tests/dom.test.mjs`](tests/dom.test.mjs) asserts the two forms really do
derive different ids from the same `name`.

**`ScriptProcessorNode`, deprecated, on purpose.** `AudioWorklet` needs
`addModule(chrome.runtime.getURL(...))`, which is checked against the *page's*
CSP. On a host application with a strict CSP the worklet fails silently and
dictation stops working with no visible cause. The deprecated node needs no
external file, has no CSP surface, and 16 kHz mono is well within its
capabilities.

**React-safe writing.** React replaces the `value` setter and does not see a
direct assignment, so the native prototype setter is called explicitly before
`input`/`change`/`blur` are dispatched. The test reproduces React's own
`_valueTracker` from its source and asserts the tracker is left **stale** —
which is precisely what makes React fire `onChange`.

**Excel dates are numbers.** A spreadsheet cell contains `45678` and a *style*
saying to display it as a date. Without conversion the model receives `45678`
and answers about it with a straight face — more dangerous than a dropped row,
because it looks plausible. `office.js` reads `styles.xml`, and is careful that
a format code like `0.00 "mln"` is not mistaken for a date because of the
letter `m`.

**Character budgets, not row limits.** A 200-rows-per-sheet cap used to drop
rows silently — the user saw three entries, the model answered about two. The
budget is now in characters, and when something genuinely does not fit, both the
prompt and the UI say so out loud instead of noting it in a footnote.

**The side panel does not work in popup windows.** Host applications like to
open forms in `window.open` popups, where Chrome's side panel is unavailable. A
`MAIN`-world content script wraps `window.open` at `document_start` and
redirects *large* popups (a whole form) to tabs, leaving small helpers like date
pickers alone. The isolated world reads the user's preference from
`chrome.storage` and passes it across on a `documentElement` attribute, because
the `MAIN` world cannot read storage itself.

**The dictation session metric is written on disconnect**, not on "stop": users
close the overlay or the tab, and then "stop" never arrives. Abandoned sessions
are the interesting ones.

---

## Tests

```bash
npm test
```

Twenty-one suites, no framework — each is a standalone script that prints
`N pass, M fail` and exits non-zero. They run in separate processes because
several install a global `document` (jsdom) or a global `fetch` stub.
[`tests/run-all.mjs`](tests/run-all.mjs) discovers them by glob, so a new file is
picked up by existing.

The interesting ones:

| Suite | What it pins down |
| --- | --- |
| `metrics` | that PHI cannot reach the metrics, and that `editedPct` never lies |
| `no-source` | that the model refuses to invent clinical content |
| `global-dictation` | field discovery, risk classification, and that no dictated text is ever lost |
| `overlay-css` | the **computed** `display` of the real overlay CSS, not just the JS |
| `dom` | selector resilience, and React's `_valueTracker` reproduced from source |
| `audio` | the Float32 → int16 → base64 chain, bit for bit, including clipping |
| `stream-json` | JSON reassembled from SSE fragments cut mid-character |
| `office` | that 1200 rows survive, and that Excel dates are not numbers |
| `endpoint-url` | every provider's API-root shape, joined correctly |

`overlay-css` exists because of a bug worth remembering: the recording strip
stayed visible after dictation finished. The JavaScript was correct —
`els.rec.hidden = true` — but the author's `.rec { display: flex }` beat the
browser's `[hidden] { display: none }`, so the attribute had no effect at all.
A unit test of the JS passed. The test now extracts the real CSS from
`content-script.js` and asserts the computed `display`.

---

## Deliberate limitations

- **Only four things are configurable.** The endpoints, the model and the API
  key, because those are what a new machine needs. Not the temperature, the
  token budgets or the system prompt: those were tuned against the safety tests
  in this repository, and a UI control over them would be a UI control over
  whether the guards hold. `CONFIGURABLE` in
  [lib/settings.js](lib/settings.js) is the whole list, and a test asserts the
  system prompt is not on it.
- **Prompts are English.** The output language is one exported constant
  (`OUTPUT_LANGUAGE` in `lib/prompt-templates.js`); the chat's reply language is
  a separate user setting. In the original deployment both were Lithuanian,
  including a Lithuanian-language ASR model.
- **Watch mode is hidden.** The code works and is tested; the tab is `hidden` in
  the UI because it did not earn its place for clinical use.
- **The SharePoint download path is best-effort.** It is tenant-specific and
  does not work on OneDrive personal, so the failure path tells the user to drop
  the file in by hand rather than quietly answering from a screenshot of a
  canvas.

---

## License

MIT — see [LICENSE](LICENSE).

The demo forms contain no real patient data, and no data of any kind from the
original deployment is included in this repository.
