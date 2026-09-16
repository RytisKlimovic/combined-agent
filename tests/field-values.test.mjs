/**
 * fieldValuesInPage tests — collecting chat context out of form fields.
 *
 * Why this was needed: innerText/textContent CANNOT SEE an <input value> or a
 * live <textarea> value. Because of that the model used to answer "it is
 * empty" about a field the clinician had just filled in by hand.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { fieldValuesInPage } = await import(pathToFileURL(`${EXT}/context.js`).href);

let pass = 0,
  fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};

/** fieldValuesInPage runs against a global `document`, exactly as in a page. */
function run(html, prepare) {
  const dom = new JSDOM(html);
  globalThis.document = dom.window.document;
  prepare?.(dom.window.document);
  return fieldValuesInPage(6000);
}

console.log('--- The basic control types ---');
{
  const out = run(`
    <label for="a">Complaints</label><textarea id="a"></textarea>
    <label for="b">Name</label><input id="b" value="Jordan">
    <input type="hidden" name="csrf" value="SECRET">
    <input type="password" value="hunter2">
    <label for="c">Sex</label><select id="c"><option>male</option><option selected>female</option></select>
    <label for="d">I agree</label><input type="checkbox" id="d" checked>
    <div contenteditable="true">Free text</div>
  `, (doc) => {
    doc.getElementById('a').value = 'Headache and leg pain';
  });

  check('a textarea value gets in', out.includes('Headache and leg pain'));
  check('the textarea gets its label', /Complaints: Headache and leg pain/.test(out));
  check('an input value gets in', out.includes('Name: Jordan'));
  check('hidden is skipped', !out.includes('SECRET'));
  check('password is skipped', !out.includes('hunter2'));
  check('a select shows the chosen text', out.includes('Sex: female'));
  check('a ticked checkbox is shown', /I agree: ✓/.test(out));
  check('contenteditable gets in', out.includes('Free text'));
}

console.log('--- Empty values and duplicates ---');
{
  const out = run(`
    <label for="x">Empty</label><input id="x" value="">
    <input type="checkbox" id="y">
    <input name="dup" value="the same value">
    <input name="dup" value="the same value">
  `);
  check('an empty field is not shown', !out.includes('Empty'));
  check('an unticked checkbox is not shown', !out.includes('✓'));
  check('the duplicate drops out', out.split('the same value').length - 1 === 1, out);
}

console.log('--- Table-style form labels (server-rendered EHR style) ---');
{
  const out = run(`
    <table><tr><td>History of present illness:</td><td><textarea id="t"></textarea></td></tr></table>
  `, (doc) => {
    doc.getElementById('t').value = 'Unwell for 3 years';
  });
  check('the label comes from the adjacent cell',
    /History of present illness:?: Unwell for 3 years/.test(out), out);
}

console.log('--- The demo visit-note form ---');
{
  const out = run(readFileSync(`${EXT}/demo/visit-note.html`, 'utf8'), (doc) => {
    const ta = doc.querySelector('textarea');
    if (ta) ta.value = 'HAND-TYPED COMPLAINTS FOR THE TEST';
  });
  check('hand-typed text is found in a real form', out.includes('HAND-TYPED COMPLAINTS FOR THE TEST'),
    out.slice(0, 200));
  check('the result stays within the limit', out.length <= 6000);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
