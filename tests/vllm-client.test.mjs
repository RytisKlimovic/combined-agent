/**
 * vllm-client.js tests, against a fake OpenAI-compatible server.
 *
 * The SSE events are deliberately split across TCP packets, because that is
 * exactly the case a naive line-splitter gets wrong.
 */
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { generateStream, generate, testConnection } = await import(
  pathToFileURL(`${EXT}/lib/vllm-client.js`).href
);

// --- The fake model server -----------------------------------------------
const CHUNKS = ['The patient ', 'is a 67-year-old ', 'man reporting ', '[TO CONFIRM].'];

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'test-model-8b' }] }));
  }

  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);

    if (!parsed.stream) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: CHUNKS.join('') } }] }));
    }

    res.setHeader('content-type', 'text/event-stream');
    // Each SSE event is deliberately split across two TCP packets, to exercise
    // the buffering.
    let i = 0;
    const tick = () => {
      if (i >= CHUNKS.length) {
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const payload = JSON.stringify({ choices: [{ delta: { content: CHUNKS[i++] } }] });
      const full = `data: ${payload}\n\n`;
      // split in half, so an incomplete fragment sits in the buffer
      res.write(full.slice(0, 12));
      setTimeout(() => { res.write(full.slice(12)); setTimeout(tick, 5); }, 5);
    };
    tick();
  });
});

await new Promise((r) => server.listen(0, r));
const endpoint = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

// --- 1. testConnection ----------------------------------------------------
const conn = await testConnection({ endpoint });
check('testConnection returns the models', conn.ok && conn.models[0] === 'test-model-8b', JSON.stringify(conn));

// --- 2. streaming ---------------------------------------------------------
const deltas = [];
const streamed = await generateStream({
  endpoint, model: 'test-model-8b', messages: [{ role: 'user', content: 'x' }],
  maxTokens: 100, onDelta: (d) => deltas.push(d),
});
check('streaming assembles the full text', streamed === CHUNKS.join(''), `-> "${streamed}"`);
check('streaming surfaces every delta', deltas.length === CHUNKS.length, `-> ${deltas.length}`);
check('an SSE event split across packets is not corrupted', !streamed.includes('data:'), `-> "${streamed}"`);

// --- 3. non-streaming -----------------------------------------------------
const plain = await generate({ endpoint, model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
check('non-streaming works', plain === CHUNKS.join(''));

// --- 4. an endpoint with a trailing slash --------------------------------
const slash = await generate({ endpoint: endpoint + '///', model: 'm', messages: [], maxTokens: 10 });
check('a trailing slash is normalised away', slash === CHUNKS.join(''));

// --- 5. abort -------------------------------------------------------------
const ac = new AbortController();
setTimeout(() => ac.abort(), 8);
try {
  await generateStream({ endpoint, model: 'm', messages: [], maxTokens: 10, signal: ac.signal, onDelta: () => {} });
  check('abort throws AbortError', false, '-> it did not throw');
} catch (e) {
  check('abort throws AbortError', e.name === 'AbortError', `-> ${e.name}`);
}

// --- 6. error handling ----------------------------------------------------
const bad = await testConnection({ endpoint: 'http://127.0.0.1:1/' });
check('an unreachable server returns ok:false', bad.ok === false);

server.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
