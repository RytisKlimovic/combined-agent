/**
 * cloud.js — documents that live in the cloud.
 *
 * Google Docs and Excel for the web paint the document into a <canvas>, so
 * collecting the page text is impossible — there is simply nothing in the DOM.
 * In exchange, both platforms expose URLs from which the file can be
 * DOWNLOADED using the session the user is already signed in with. The
 * extension can do that because it holds the <all_urls> permission.
 *
 * Deriving those URLs is pure and testable here; the network lives separately
 * (`fetchDocument`), so tests need neither a server nor a session.
 */

/** The download ceiling. Past it a document is no longer "readable". */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The export URL for a Google Workspace document.
 *
 * The URL is derived FROM THE TAB URL rather than rebuilt from scratch: that
 * preserves the `/u/2/` prefix so the request lands on the same account the
 * user is working in (otherwise, in a multi-account browser, you get a
 * wrong-document error or a sign-in page).
 *
 * @returns {{url: string, kind: 'gdoc'|'gsheet'|'gslides', name: string}|null}
 */
export function googleExportUrl(tabUrl) {
  let u;
  try {
    u = new URL(String(tabUrl ?? ''));
  } catch {
    return null;
  }
  if (u.hostname !== 'docs.google.com') return null;

  // Everything up to and including the document id. Google uses both account
  // prefix layouts: /u/2/document/d/<id> AND /document/u/2/d/<id>.
  const m = /^(.*\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/[^/]+)/.exec(u.pathname);
  if (!m) return null;

  const base = `${u.origin}${m[1]}`;
  switch (m[2]) {
    case 'document':
      // txt rather than docx: Docs text has no table structure worth OOXML for
      // — and txt goes straight into the context with no parsing at all.
      return { url: `${base}/export?format=txt`, kind: 'gdoc', name: 'Google document' };
    case 'spreadsheets':
      // xlsx rather than csv: csv returns ONLY one sheet, and all of them
      // often matter (results + notes + summary).
      return { url: `${base}/export?format=xlsx`, kind: 'gsheet', name: 'Google spreadsheet' };
    default:
      return { url: `${base}/export/pptx`, kind: 'gslides', name: 'Google presentation' };
  }
}

/**
 * An Office document opened from SharePoint / OneDrive for Business.
 *
 * The URL carries `sourcedoc={GUID}`, and SharePoint has a generic download
 * path `_layouts/15/download.aspx?UniqueId=<GUID>`. This is BEST EFFORT: it
 * will not work on some tenants or on OneDrive personal, so the caller must
 * have a fallback (see sidepanel.js — the offer to upload via 📄).
 *
 * @returns {{url: string, name: string}|null}
 */
export function sharepointDownloadUrl(tabUrl) {
  let u;
  try {
    u = new URL(String(tabUrl ?? ''));
  } catch {
    return null;
  }
  if (!/\.sharepoint\.com$/i.test(u.hostname)) return null;

  const raw = u.searchParams.get('sourcedoc');
  if (!raw) return null;

  const guid = decodeURIComponent(raw).replace(/[{}]/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(guid)) return null;

  // The site path: /:w:/r/sites/Clinic/_layouts/... -> /sites/Clinic
  const site = /\/(sites|teams|personal)\/[^/]+/i.exec(u.pathname)?.[0] ?? '';
  const name = decodeURIComponent(u.searchParams.get('file') || '') || 'document';

  return { url: `${u.origin}${site}/_layouts/15/download.aspx?UniqueId=${guid}`, name };
}

/** The file name from Content-Disposition, or failing that from the URL. */
export function fileNameFrom(url, contentDisposition = '') {
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(contentDisposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1];
  if (star || plain) {
    try {
      return decodeURIComponent((star || plain).trim());
    } catch {
      return (star || plain).trim();
    }
  }
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || 'document';
  } catch {
    return 'document';
  }
}

/**
 * Downloads a document using the user's session.
 *
 * The important detail is the HTML check: when not signed in, or without
 * permission, Google and SharePoint return 200 with a sign-in PAGE. Without
 * this check the user would get a "document" whose contents read "Sign in".
 *
 * @returns {Promise<{buffer: ArrayBuffer, name: string, type: string}>}
 */
export async function fetchDocument(url, { signal, expectHtml = false } = {}) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`Could not download the document (HTTP ${res.status}).`);

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!expectHtml && type.includes('text/html')) {
    throw new Error('The server returned a page rather than a document — most likely you need to sign in, or you lack permission.');
  }

  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`The document is too large (${Math.round(length / 1024 / 1024)} MB).`);
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('The document is too large.');
  }

  return { buffer, name: fileNameFrom(url, res.headers.get('content-disposition') || ''), type };
}
