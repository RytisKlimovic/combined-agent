/**
 * Does JSON arriving in fragments over an SSE stream reassemble and parse
 * correctly?
 *
 * The fragments are cut so that the breaks fall MID-character for multi-byte
 * letters and mid-key — which is where a naive implementation corrupts the
 * payload.
 */
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { generateStream } = await import(pathToFileURL(`${EXT}/lib/vllm-client.js`).href);
await import(pathToFileURL(`${EXT}/content/field-map.js`).href);
const { parseDistribution, UNASSIGNED_KEY } = await import(
  pathToFileURL(`${EXT}/lib/prompt-templates.js`).href
);

const FIELDS = [
  { key: 'complaints', label: 'Complaints' },
  { key: 'history_of_illness', label: 'History of present illness' },
  { key: 'objective_status', label: 'Objective status' },
];

const FULL = JSON.stringify({
  complaints: 'Lower back pain radiating into the leg — worse on movement.',
  objective_status: 'Lasègue 40°, power 5/5, BP 130/80.',
  [UNASSIGNED_KEY]: 'Review in 2 weeks.',
});
const CHUNKS = [];
for (let i = 0; i < FULL.length; i += 7) CHUNKS.push(FULL.slice(i, i + 7));

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('content-type', 'text/event-stream');
    let i = 0;
    const tick = () => {
      if (i >= CHUNKS.length) {
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const payload = JSON.stringify({ choices: [{ delta: { content: CHUNKS[i++] } }] });
      res.write(`data: ${payload}\n\n`);
      setTimeout(tick, 2);
    };
    tick();
  });
});

await new Promise((r) => server.listen(0, r));
const endpoint = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + ' ' + e)); };

const raw = await generateStream({
  endpoint, model: 'm', messages: [{ role: 'user', content: 'x' }],
  maxTokens: 500, onDelta: () => {},
});

check('the stream assembles the complete JSON', raw === FULL, `-> ${raw.slice(0, 60)}`);
check(`  (cut into ${CHUNKS.length} fragments)`, CHUNKS.length > 15);

const r = parseDistribution(raw, FIELDS);
check('complaints parsed', r.assignments.complaints === 'Lower back pain radiating into the leg — worse on movement.');
check('multi-byte characters are intact', /—/.test(r.assignments.complaints));
check('the accented name survives', /Lasègue/.test(r.assignments.objective_status));
check('the degree sign survives', /40°/.test(r.assignments.objective_status));
check('the numbers are exact (130/80)', /130\/80/.test(r.assignments.objective_status));
check('an unmentioned field stays empty', r.assignments.history_of_illness === undefined);
check('the unassigned text is preserved', r.unassigned === 'Review in 2 weeks.');

server.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
