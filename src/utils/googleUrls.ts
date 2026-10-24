export type GoogleFileKind = 'document' | 'spreadsheet' | 'presentation' | 'folder' | 'file' | 'unknown';

export interface GoogleFileRef {
  id: string,
  /** From the link, the file's mime type decides in the end (a Drive link can point at anything). */
  kind: GoogleFileKind,
  /** Sheets tab (`#gid=` or `?gid=`) */
  gid?: number,
  /** Docs tab (`?tab=t.xxxx`) */
  tabId?: string,
  /** Slides slide (`#slide=id.xxxx`) */
  slideId?: string,
}

const KINDS: { [path: string]: GoogleFileKind } = { document: 'document', spreadsheets: 'spreadsheet', presentation: 'presentation' };

/**
 * Finds the file id in a Google Docs, Sheets, Slides or Drive link (or takes a bare id), e.g.
 * `https://docs.google.com/spreadsheets/d/<id>/edit#gid=123`, `https://drive.google.com/file/d/<id>/view`,
 * `https://drive.google.com/drive/folders/<id>` or `https://drive.google.com/open?id=<id>`.
 */
export function parseGoogleUrl(input: string): GoogleFileRef {
  const text = input.trim().replace(/^<|>$/g, '');
  if (/^[\w-]{20,}$/.test(text)) {
    return { id: text, kind: 'unknown' };
  }
  let url: URL;
  try {
    url = new URL(text);
  }
  catch {
    throw Error(`"${input}" isn't a Google Docs, Sheets, Slides or Drive link or file id.`);
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) {
    throw Error(`"${input}" isn't a Google link (docs.google.com or drive.google.com).`);
  }
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const gid = url.searchParams.get('gid') ?? hashParams.get('gid');
  const tabId = url.searchParams.get('tab') ?? undefined;
  const slideId = hashParams.get('slide')?.replace(/^id\./, '') ?? undefined;
  const extras = { ...(gid != null && /^\d+$/.test(gid) ? { gid: Number(gid) } : {}), ...(tabId ? { tabId } : {}), ...(slideId ? { slideId } : {}) };

  const doc = /\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(url.pathname);
  if (doc) {
    return { id: doc[2], kind: KINDS[doc[1]], ...extras };
  }
  const folder = /\/folders\/([\w-]+)/.exec(url.pathname);
  if (folder) {
    return { id: folder[1], kind: 'folder' };
  }
  const file = /\/file\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(url.pathname);
  if (file) {
    return { id: file[1], kind: 'file' };
  }
  const id = url.searchParams.get('id');
  if (id && /^[\w-]+$/.test(id)) {
    return { id, kind: 'unknown', ...extras };
  }
  throw Error(`Couldn't find a file id in "${input}". Send the link from the address bar or the Share button.`);
}

/** The usual link to open a file in its editor. */
export function googleFileLink(id: string, mimeType?: string | null): string {
  switch (mimeType) {
    case 'application/vnd.google-apps.document': return `https://docs.google.com/document/d/${id}/edit`;
    case 'application/vnd.google-apps.spreadsheet': return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case 'application/vnd.google-apps.presentation': return `https://docs.google.com/presentation/d/${id}/edit`;
    case 'application/vnd.google-apps.folder': return `https://drive.google.com/drive/folders/${id}`;
    default: return `https://drive.google.com/file/d/${id}/view`;
  }
}
