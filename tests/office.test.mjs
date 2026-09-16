/**
 * office.js tests — pulling content out of .docx / .xlsx / .pptx.
 *
 * The fixtures are assembled here into real ZIP archives (see makeZip in
 * make-zip.mjs), and the XML is the shape Office actually produces: Word
 * splits a word across several <w:t>, Excel keeps strings in sharedStrings,
 * and non-ASCII letters arrive as entities.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

import { makeZip } from './make-zip.mjs';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { officeText, decodeXml, columnIndex } = await import(
  pathToFileURL(`${EXT}/lib/office.js`).href
);

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

console.log('--- Entities and columns ---');
check('&amp; is decoded', decodeXml('a &amp; b') === 'a & b');
check('a numeric entity -> a letter', decodeXml('&#268;&#101;') === 'Če');
check('a hex entity -> a letter', decodeXml('&#x10C;') === 'Č');
check('A -> 0', columnIndex('A1') === 0);
check('B -> 1', columnIndex('B12') === 1);
check('AA -> 26', columnIndex('AA3') === 26);

console.log('--- .docx ---');
{
  const document = `<?xml version="1.0"?>
    <w:document><w:body>
      <w:p><w:r><w:t>The pati</w:t></w:r><w:r><w:t>ent repo</w:t></w:r><w:r><w:t>rts pain</w:t></w:r></w:p>
      <w:p><w:r><w:t>Diagnos&#105;s:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>M51.8</w:t></w:r></w:p>
      <w:p/>
      <w:p><w:r><w:t>36.9 &#176;C and BP 130/80</w:t></w:r></w:p>
    </w:body></w:document>`;

  const { text, kind } = await officeText(
    makeZip([{ name: 'word/document.xml', data: document }]),
    { name: 'summary.docx' }
  );

  check('the type is recognised', kind === 'docx');
  check('a split word is reassembled', text.includes('The patient reports pain'), text);
  check('an entity became a letter', text.includes('Diagnosis:'), text);
  check('the tab is preserved', /Diagnosis:\tM51\.8/.test(text), JSON.stringify(text));
  check('the numbers are unchanged', text.includes('36.9 °C and BP 130/80'), text);
  check('paragraphs are separated by newlines', text.split('\n').length >= 3, JSON.stringify(text));
}

console.log('--- .xlsx ---');
{
  const shared = `<sst><si><t>Test</t></si><si><t>Result</t></si><si><t>Haemoglobin</t></si></sst>`;
  const workbook = `<workbook><sheets>
      <sheet name="Lab&#032;data" sheetId="1" r:id="rId1"/>
      <sheet name="Notes" sheetId="2" r:id="rId2"/>
    </sheets></workbook>`;
  const rels = `<Relationships>
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
    </Relationships>`;
  const sheet1 = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>128</v></c></row>
      <row r="3"><c r="C3" t="inlineStr"><is><t>third column only</t></is></c></row>
      <row r="4"></row>
    </sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    </sheetData></worksheet>`;

  const { text, note } = await officeText(
    makeZip([
      { name: 'xl/sharedStrings.xml', data: shared },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: rels },
      { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
      { name: 'xl/worksheets/sheet2.xml', data: sheet2 },
    ]),
    { name: 'results.xlsx' }
  );

  check('the sheet name with an entity', text.includes('## Lab data'), text);
  check('the second sheet is there too', text.includes('## Notes'), text);
  check('sharedStrings are resolved', text.includes('Test\tResult'), JSON.stringify(text));
  check('a numeric value is preserved', text.includes('Haemoglobin\t128'), JSON.stringify(text));
  check('empty cells keep the column alignment', /\t\tthird column only/.test(text), JSON.stringify(text));
  check('row numbers lead each line', /^2\tHaemoglobin/m.test(text), JSON.stringify(text));
  // Exactly 3 rows must remain on the sheet: <row r="4"> is empty and drops out.
  const firstSheet = text.split('## Notes')[0].trim().split('\n').slice(1);
  check('the empty row is skipped', firstSheet.length === 3, JSON.stringify(firstSheet));
  check('the sheet order is preserved', text.indexOf('## Lab data') < text.indexOf('## Notes'));
  check('the note says how much made it in', /2 sheets · 4 rows/.test(note), note);
}

console.log('--- .xlsx: a large file is not cut for no reason ---');
{
  // REGRESSION: there used to be a 200-rows-per-sheet limit and rows vanished
  // silently — the user saw 3 of their entries, the model answered about 2.
  const N = 1200;
  const rows = Array.from(
    { length: N },
    (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>Row label</t></is></c><c r="B${i + 1}"><v>${i}</v></c></row>`
  ).join('');

  const zip = [
    { name: 'xl/workbook.xml', data: `<workbook><sheets><sheet name="Ledger" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><autoFilter ref="A1:B${N}"/><sheetData>${rows}</sheetData></worksheet>` },
  ];

  const { text, note } = await officeText(makeZip(zip), { name: 'ledger.xlsx' });

  check('all 1200 rows made it in', (text.match(/Row label/g) || []).length === N, note);
  check('the last row is present', text.includes(`\n${N}\tRow label`), text.slice(-80));
  // The number is formatted per locale (1,200 / 1 200) — compare without separators.
  check('the note shows the real count', note.replace(/[^\d]/g, '').includes('1200'), note);
  check('there is no false truncation claim', !/NOT SHOWN/.test(note), note);
  check('the active filter is called out', /a filter is active/.test(text), text.slice(0, 200));
}

console.log('--- .xlsx: when it genuinely does not fit, say so out loud ---');
{
  const N = 400;
  const long = 'x'.repeat(400);
  const rows = Array.from(
    { length: N },
    (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${long}</t></is></c></row>`
  ).join('');

  const { text, note } = await officeText(
    makeZip([
      { name: 'xl/workbook.xml', data: `<workbook><sheets><sheet name="Huge" r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rows}</sheetData></worksheet>` },
    ]),
    { name: 'huge.xlsx', maxChars: 20000 }
  );

  check('the budget is respected', text.length <= 21000, String(text.length));
  check('the truncation is visible in the text', /NOTE: only the first/.test(text), text.slice(0, 200));
  check('the truncation is visible in the note', /NOT SHOWN/.test(note), note);
}

console.log('--- .xlsx: dates ---');
{
  // In the file dates are NUMBERS; they are only recognisable by their style.
  // Without this the model would see "45678" and answer about it with a
  // straight face.
  const styles = `<styleSheet>
      <numFmts><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="166" formatCode="0.00 &quot;mln&quot;"/></numFmts>
      <cellXfs count="4">
        <xf numFmtId="0"/>
        <xf numFmtId="14"/>
        <xf numFmtId="165"/>
        <xf numFmtId="166"/>
      </cellXfs>
    </styleSheet>`;
  const sheet = `<worksheet><sheetData>
      <row r="1">
        <c r="A1" s="1"><v>45678</v></c>
        <c r="B1" s="2"><v>45678</v></c>
        <c r="C1" s="3"><v>3000</v></c>
        <c r="D1" s="0"><v>45678</v></c>
        <c r="E1" s="1"><v>45678.5</v></c>
      </row>
    </sheetData></worksheet>`;

  const { text } = await officeText(
    makeZip([
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/workbook.xml', data: `<workbook><sheets><sheet name="Dates" r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ]),
    { name: 'dates.xlsx' }
  );

  const cells = text.split('\n').pop().split('\t');
  check('a built-in date format', cells[1] === '2025-01-21', cells.join(' | '));
  check('a custom date format', cells[2] === '2025-01-21', cells.join(' | '));
  check('the "mln" format does NOT become a date', cells[3] === '3000', cells.join(' | '));
  check('with no style a number stays a number', cells[4] === '45678', cells.join(' | '));
  check('a date with a time', cells[5] === '2025-01-21 12:00', cells.join(' | '));
}

console.log('--- .pptx ---');
{
  const slide = (t) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const { text, kind } = await officeText(
    makeZip([
      { name: 'ppt/slides/slide1.xml', data: slide('First slid&#101;') },
      { name: 'ppt/slides/slide2.xml', data: slide('Second slide') },
      { name: 'ppt/slides/slide10.xml', data: slide('Tenth slide') },
    ]),
    { name: 'deck.pptx' }
  );

  check('the type is recognised', kind === 'pptx');
  check('the slides are numbered', text.includes('## Slide 1') && text.includes('## Slide 3'), text);
  check('the content is there', text.includes('First slide') && text.includes('Tenth slide'), text);
  check('slide 10 comes after 2 (numeric order)', text.indexOf('Second') < text.indexOf('Tenth'), text);
}

console.log('--- Errors ---');
{
  let msg = '';
  try {
    await officeText(makeZip([{ name: 'a.txt', data: 'x' }]), { name: 'file.txt' });
  } catch (err) {
    msg = err.message;
  }
  check('an unknown format -> an error', /Unsupported document format/.test(msg), msg);

  const { text } = await officeText(makeZip([{ name: 'something.xml', data: '<a/>' }]), {
    name: 'empty.docx',
  });
  check('an empty docx -> empty text, no crash', text === '', JSON.stringify(text));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
