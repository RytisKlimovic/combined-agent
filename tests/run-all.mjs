/**
 * run-all.mjs — the test runner.
 *
 * Every `*.test.mjs` file in this directory is a standalone script that prints
 * `N pass, M fail` and exits non-zero on failure. They are run in separate
 * processes on purpose: several of them install a global `document` (jsdom) or
 * a global `fetch` stub, and sharing one process would let that leak between
 * suites.
 *
 * Discovery is by glob rather than a hand-maintained list, so a new test file
 * is picked up by simply existing.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (!files.length) {
  console.error('No *.test.mjs files found.');
  process.exit(1);
}

const failed = [];

for (const file of files) {
  console.log(`\n${'='.repeat(70)}\n${file}\n${'='.repeat(70)}`);
  const res = spawnSync(process.execPath, [file], { cwd: dir, stdio: 'inherit' });
  if (res.status !== 0) failed.push(file);
}

console.log(`\n${'='.repeat(70)}`);
if (failed.length) {
  console.log(`${files.length - failed.length}/${files.length} suites passed. Failed:`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${files.length} suites passed.`);
