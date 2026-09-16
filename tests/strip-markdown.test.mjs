/**
 * stripMarkdown tests — text travelling from the conversation into a form field.
 *
 * A form field carries no formatting at all, so no `**`, no bullet dashes and
 * no quote markers may reach it. The words themselves must stay untouched.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { stripMarkdown } = await import(pathToFileURL(`${EXT}/md.js`).href);

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
const eq = (name, got, want) =>
  check(name, got === want, `\n    got:    ${JSON.stringify(got)}\n    wanted: ${JSON.stringify(want)}`);

console.log('--- Stripping the markup ---');
eq('bold', stripMarkdown('**The patient** reports'), 'The patient reports');
eq('italic', stripMarkdown('text *emphasised* onwards'), 'text emphasised onwards');
eq('heading', stripMarkdown('### Conclusion\nUnwell'), 'Conclusion\nUnwell');
eq('blockquote', stripMarkdown('> The patient reports a headache.'), 'The patient reports a headache.');
eq('inline code', stripMarkdown('a value of `36.9` degrees'), 'a value of 36.9 degrees');
eq('link', stripMarkdown('see [the protocol](https://x.example/a)'), 'see the protocol');

console.log('--- Lists ---');
eq('dashes', stripMarkdown('- first\n- second'), 'first\nsecond');
eq('numbered', stripMarkdown('1. first\n2) second'), 'first\nsecond');

console.log('--- Code fence ---');
eq('the whole answer inside a fence', stripMarkdown('```\nThe patient reports\n```'), 'The patient reports');

console.log('--- The content itself is untouched ---');
{
  const src = 'The patient reports a headache and leg pain.';
  eq('a plain sentence is left alone', stripMarkdown(src), src);
  eq('numbers stay exact', stripMarkdown('BP 130/80, T 36.9 °C'), 'BP 130/80, T 36.9 °C');
  eq('L4-L5 notation survives', stripMarkdown('Disc disease at the L4-L5 level'), 'Disc disease at the L4-L5 level');
  eq('a multiplication asterisk does not vanish', stripMarkdown('2 * 3 = 6'), '2 * 3 = 6');
}

console.log('--- Edge cases ---');
eq('empty', stripMarkdown(''), '');
eq('null', stripMarkdown(null), '');
eq('whitespace is trimmed', stripMarkdown('  text  '), 'text');
eq('blank lines are collapsed', stripMarkdown('a\n\n\n\nb'), 'a\n\nb');

console.log('--- A realistic model answer ---');
{
  const answer = [
    'Grammar and style issues in the sentence:',
    '',
    '1. **Agreement:** the word "patient" is used inconsistently.',
    '',
    '**Corrected version:**',
    '',
    '> The patient reports a headache and leg pain.',
  ].join('\n');
  const out = stripMarkdown(answer);
  check('no asterisks remain', !out.includes('**'), out);
  check('no quote marker remains', !/^>/m.test(out), out);
  check('no list numbering remains', !/^1\./m.test(out), out);
  check('the sentence survives', out.includes('The patient reports a headache and leg pain.'), out);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
