/**
 * cloud.js tests — deriving cloud document URLs.
 *
 * There is no network here: the URL logic is what gets tested, because a bug
 * in it means either an empty answer ("document not found") or someone else's
 * document from the wrong signed-in account.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const { googleExportUrl, sharepointDownloadUrl, fileNameFrom } = await import(
  pathToFileURL(`${EXT}/lib/cloud.js`).href
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

console.log('--- Google Docs ---');
{
  const r = googleExportUrl('https://docs.google.com/document/d/1AbC_dEf-123/edit#heading=h.x');
  check('recognised as a document', r?.kind === 'gdoc');
  check('exports to txt', r?.url === 'https://docs.google.com/document/d/1AbC_dEf-123/export?format=txt', r?.url);
}

console.log('--- Google Sheets ---');
{
  const r = googleExportUrl('https://docs.google.com/spreadsheets/d/XYZ789/edit#gid=1554');
  check('recognised as a spreadsheet', r?.kind === 'gsheet');
  check('exports to xlsx (all sheets)', r?.url === 'https://docs.google.com/spreadsheets/d/XYZ789/export?format=xlsx', r?.url);
}

console.log('--- Google Slides ---');
{
  const r = googleExportUrl('https://docs.google.com/presentation/d/PPP111/edit#slide=id.p1');
  check('recognised as a presentation', r?.kind === 'gslides');
  check('exports to pptx', r?.url === 'https://docs.google.com/presentation/d/PPP111/export/pptx', r?.url);
}

console.log('--- Multiple accounts (/u/N/) ---');
{
  const r = googleExportUrl('https://docs.google.com/u/2/document/d/DOC42/edit');
  check('the prefix is preserved', r?.url === 'https://docs.google.com/u/2/document/d/DOC42/export?format=txt', r?.url);

  const r2 = googleExportUrl('https://docs.google.com/spreadsheets/u/1/d/SH7/edit');
  check('the other prefix layout works too', r2?.url === 'https://docs.google.com/spreadsheets/u/1/d/SH7/export?format=xlsx', r2?.url);
}

console.log('--- Not Google ---');
for (const url of [
  'https://www.google.com/search?q=x',
  'https://docs.google.com/forms/d/ABC/viewform',
  'http://localhost:8080/app/visit-note',
  'not-a-url',
  '',
  null,
]) {
  check(String(url || '(empty)'), googleExportUrl(url) === null);
}

console.log('--- SharePoint ---');
{
  const r = sharepointDownloadUrl(
    'https://contoso.sharepoint.com/:w:/r/sites/Cardiology/_layouts/15/Doc.aspx?sourcedoc=%7B7B2E3A10-1111-2222-3333-444455556666%7D&file=Summary.docx&action=default'
  );
  check(
    'a download URL carrying UniqueId',
    r?.url === 'https://contoso.sharepoint.com/sites/Cardiology/_layouts/15/download.aspx?UniqueId=7B2E3A10-1111-2222-3333-444455556666',
    r?.url
  );
  check('the file name comes from the URL', r?.name === 'Summary.docx', r?.name);

  const personal = sharepointDownloadUrl(
    'https://contoso-my.sharepoint.com/:x:/r/personal/jordan_contoso_com/_layouts/15/Doc.aspx?sourcedoc={AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}&file=Results.xlsx'
  );
  check('the OneDrive for Business path',
    /\/personal\/jordan_contoso_com\/_layouts\/15\/download\.aspx\?UniqueId=AAAAAAAA-/.test(personal?.url || ''),
    personal?.url);

  check('no sourcedoc -> null',
    sharepointDownloadUrl('https://contoso.sharepoint.com/sites/Cardiology/Forms/AllItems.aspx') === null);
  check('a bad GUID -> null', sharepointDownloadUrl('https://contoso.sharepoint.com/x?sourcedoc=nonsense') === null);
  check('another host -> null',
    sharepointDownloadUrl('https://sharepoint.com.evil.example/x?sourcedoc={AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}') === null);
}

console.log('--- The file name ---');
{
  check(
    'from Content-Disposition',
    fileNameFrom('https://x.example/get?id=9', 'attachment; filename="Lab report.pdf"') === 'Lab report.pdf'
  );
  check(
    'from filename* (UTF-8)',
    fileNameFrom('https://x.example/get', "attachment; filename*=UTF-8''Kurzbericht%20f%C3%BCr.docx") === 'Kurzbericht für.docx'
  );
  check('from the URL', fileNameFrom('https://x.example/files/summary.xlsx') === 'summary.xlsx');
  check('with nothing to go on -> the fallback', fileNameFrom('https://x.example/') === 'document');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
