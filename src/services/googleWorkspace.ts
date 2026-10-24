import * as fs from 'fs';
import { google, docs_v1, drive_v3, people_v1, sheets_v4, slides_v1 } from 'googleapis';
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import type { Logger } from 'pino';
import { WORKSPACE_CLIENT_SECRET_PATH, WORKSPACE_TOKEN_PATH } from '../config/googleWorkspace';
import { GoogleFileRef, parseGoogleUrl } from '../utils/googleUrls';
import { formatDateTime } from '../utils/common';
import { PDF_MAX_BYTES } from '../utils/pdf';
import {
  capText, docStructure, docTabs, docToMarkdown, driveFileLine, fileKind, findSlide, formatComments, gridRangeA1,
  sheetGrid, sheetTabs, slidesText,
} from './workspaceFormat';

export const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  shortcut: 'application/vnd.google-apps.shortcut',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/** Office files and the native Google type they convert to (the Docs/Sheets/Slides APIs only work on native files). */
export const OFFICE_TO_NATIVE: { [mime: string]: string } = {
  [MIME.docx]: MIME.doc, 'application/msword': MIME.doc, 'application/rtf': MIME.doc, 'text/plain': MIME.doc,
  [MIME.xlsx]: MIME.sheet, 'application/vnd.ms-excel': MIME.sheet, 'text/csv': MIME.sheet,
  [MIME.pptx]: MIME.slides, 'application/vnd.ms-powerpoint': MIME.slides,
};

const FILE_FIELDS = 'id,name,mimeType,webViewLink,modifiedTime,size,driveId,parents,trashed,owners(displayName,emailAddress),capabilities(canEdit,canComment,canShare),shortcutDetails(targetId,targetMimeType)';
/** Rows and columns shown per tab when reading a whole spreadsheet. */
const SHEET_PREVIEW = { rows: 40, cols: 26 };

export interface Clients {
  drive: drive_v3.Drive,
  docs: docs_v1.Docs,
  sheets: sheets_v4.Sheets,
  slides: slides_v1.Slides,
  people: people_v1.People,
}

/** Sofia's Google Workspace account. Clients are created on first use from the token saved by `pnpm google-auth`. */
export class GoogleWorkspace {
  private clients?: Clients;

  /** `clients` replaces the real API clients, for tests. */
  constructor(private logger?: Logger, clients?: Clients) {
    this.clients = clients;
  }

  /** An OAuth client signed in as Sofia, saving refreshed tokens so the sign-in keeps working. */
  static authClient(logger?: Logger): OAuth2Client {
    const secret = JSON.parse(fs.readFileSync(WORKSPACE_CLIENT_SECRET_PATH, 'utf8'));
    const { client_id, client_secret, redirect_uris } = secret.installed ?? secret.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    const token = JSON.parse(fs.readFileSync(WORKSPACE_TOKEN_PATH, 'utf8'));
    auth.setCredentials(token);
    auth.on('tokens', tokens => {
      // Google only sends the refresh token the first time, keep it
      const merged = { ...JSON.parse(fs.readFileSync(WORKSPACE_TOKEN_PATH, 'utf8')), ...tokens };
      fs.writeFileSync(WORKSPACE_TOKEN_PATH, JSON.stringify(merged));
      logger?.info('Saved refreshed Google Workspace token');
    });
    return auth;
  }

  get api(): Clients {
    if (!this.clients) {
      // `googleapis` and the API clients resolve two versions of google-auth-library, same class at runtime
      const auth = GoogleWorkspace.authClient(this.logger) as any;
      this.clients = {
        drive: google.drive({ version: 'v3', auth }),
        docs: google.docs({ version: 'v1', auth }),
        sheets: google.sheets({ version: 'v4', auth }),
        slides: google.slides({ version: 'v1', auth }),
        people: google.people({ version: 'v1', auth }),
      };
    }
    return this.clients;
  }

  /** A file's metadata from a link or id, following shortcuts. Errors are rewritten so Sofia knows what to tell people. */
  async getFile(input: string | GoogleFileRef): Promise<drive_v3.Schema$File & { ref: GoogleFileRef }> {
    const ref = typeof input == 'string' ? parseGoogleUrl(input) : input;
    const file = await this.call(() => this.api.drive.files.get({ fileId: ref.id, fields: FILE_FIELDS, supportsAllDrives: true }), ref.id);
    if (file.mimeType == MIME.shortcut && file.shortcutDetails?.targetId) {
      return this.getFile({ ...ref, id: file.shortcutDetails.targetId });
    }
    return { ...file, ref };
  }

  /** Runs an API call, turning Google's errors into ones Sofia can act on. */
  async call<T>(request: () => Promise<{ data: T }>, fileId?: string): Promise<T> {
    try {
      return (await request()).data;
    }
    catch (e: any) {
      const status = e?.code ?? e?.status ?? e?.response?.status;
      const message = e?.errors?.[0]?.message ?? e?.message ?? String(e);
      if (status == 404) {
        throw Error(`I can't find that file${fileId ? ` (${fileId})` : ''}. It may not exist, or it isn't shared with sofia@nyp-gdg.com yet: ask them to share it with that account.`);
      }
      if (status == 403) {
        throw Error(`Google refused: ${message} (sofia@nyp-gdg.com may need edit access, or the Workspace admin settings don't allow this).`);
      }
      throw Error(`Google API error${status ? ` (${status})` : ''}: ${message}`);
    }
  }

  header(file: drive_v3.Schema$File): string {
    const owner = file.owners?.[0] ? `, owner ${file.owners[0].displayName}` : file.driveId ? ', in a shared drive' : '';
    const access = file.capabilities?.canEdit ? 'can edit' : file.capabilities?.canComment ? 'can comment' : 'view only';
    return `"${file.name}" (${fileKind(file.mimeType)}${file.modifiedTime ? `, modified ${formatDateTime(Date.parse(file.modifiedTime))}` : ''}${owner}, you ${access})\n${file.webViewLink ?? ''}`;
  }

  private email?: string;

  /** Sofia's own email address, e.g. for checking she owns a file. */
  async me(): Promise<string> {
    this.email ??= (await this.call(() => this.api.drive.about.get({ fields: 'user(emailAddress)' }))).user?.emailAddress ?? '';
    return this.email;
  }

  // ---------- Docs ----------

  async getDoc(id: string): Promise<docs_v1.Schema$Document> {
    return this.call(() => this.api.docs.documents.get({ documentId: id, includeTabsContent: true }), id);
  }

  /** Picks a tab by id or title (case-insensitive), the first tab if none is given. */
  pickTab(doc: docs_v1.Schema$Document, tab?: string) {
    const tabs = docTabs(doc);
    if (!tab) return tabs[0];
    const found = tabs.find(t => t.id == tab || t.title.toLowerCase() == tab.trim().toLowerCase());
    if (!found) {
      throw Error(`There's no tab "${tab}". Tabs: ${tabs.map(t => `"${t.title}" (${t.id})`).join(', ')}`);
    }
    return found;
  }

  /** A Doc as Markdown, every tab (or one), with tab headings when there are several. */
  async readDoc(id: string, tab?: string): Promise<string> {
    const doc = await this.getDoc(id);
    const tabs = tab ? [this.pickTab(doc, tab)] : docTabs(doc);
    if (tabs.length == 1) {
      return docToMarkdown(tabs[0].body);
    }
    return tabs.map(t => `===== Tab "${t.title}" (id ${t.id}) =====\n\n${docToMarkdown(t.body)}`).join('\n\n');
  }

  async readDocStructure(id: string, tab?: string): Promise<string> {
    const doc = await this.getDoc(id);
    const tabs = docTabs(doc);
    const picked = this.pickTab(doc, tab);
    const tabList = tabs.length > 1 ? `Tabs: ${tabs.map(t => `${'  '.repeat(t.level)}"${t.title}" (id ${t.id})`).join(', ')}\nShowing tab "${picked.title}" (id ${picked.id})\n\n` : '';
    return tabList + docStructure(picked.body, picked.inlineObjects);
  }

  // ---------- Sheets ----------

  async getSpreadsheet(id: string): Promise<sheets_v4.Schema$Spreadsheet> {
    return this.call(() => this.api.sheets.spreadsheets.get({
      spreadsheetId: id,
      fields: 'properties.title,sheets(properties(sheetId,title,index,hidden,sheetType,gridProperties),merges)',
    }), id);
  }

  /** Picks a tab by name, id (gid) or position (1-based), the link's tab, or the first tab. */
  pickSheet(spreadsheet: sheets_v4.Schema$Spreadsheet, tab?: string | number, gid?: number): sheets_v4.Schema$Sheet {
    const sheets = spreadsheet.sheets ?? [];
    let found: sheets_v4.Schema$Sheet | undefined;
    if (tab != null && String(tab).trim()) {
      const t = String(tab).trim();
      found = sheets.find(s => s.properties?.title?.toLowerCase() == t.toLowerCase())
        ?? (/^\d+$/.test(t) ? sheets.find(s => String(s.properties?.sheetId) == t) ?? sheets[Number(t) - 1] : undefined);
      if (!found) {
        throw Error(`There's no tab "${tab}". Tabs: ${sheets.map(s => `"${s.properties?.title}"`).join(', ')}`);
      }
    }
    else if (gid != null) {
      found = sheets.find(s => s.properties?.sheetId == gid);
    }
    return found ?? sheets[0];
  }

  /** A tab's values (or one range of it) as a grid with merged cells marked, optionally with formulas. */
  async readSheetRange(id: string, sheet: sheets_v4.Schema$Sheet, range?: string, formulas = false): Promise<string> {
    const title = sheet.properties?.title ?? '';
    const a1 = `'${title.replace(/'/g, "''")}'${range?.trim() ? `!${range.trim()}` : ''}`;
    const get = (render: string) => this.call(() => this.api.sheets.spreadsheets.values.get({ spreadsheetId: id, range: a1, valueRenderOption: render }), id);
    const [values, formulaValues] = await Promise.all([get('FORMATTED_VALUE'), formulas ? get('FORMULA') : undefined]);
    // The returned range is where the values start, e.g. 'Budget'!B3:F20
    const start = /!\$?([A-Z]+)\$?(\d+)/i.exec(values.range ?? '');
    const startCol = start ? start[1].toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : 0;
    const startRow = start ? Number(start[2]) - 1 : 0;
    return sheetGrid(values.values ?? [], startRow, startCol, sheet.merges ?? [], formulaValues?.values ?? undefined);
  }

  /** A whole spreadsheet: its tabs, then the first rows of each visible tab. */
  async readSpreadsheet(id: string, gid?: number): Promise<string> {
    const spreadsheet = await this.getSpreadsheet(id);
    const first = this.pickSheet(spreadsheet, undefined, gid);
    const sheets = [first, ...(spreadsheet.sheets ?? []).filter(s => s != first && !s.properties?.hidden && (s.properties?.sheetType ?? 'GRID') == 'GRID')];
    const parts = [`Tabs:\n${sheetTabs(spreadsheet)}`];
    for (const sheet of sheets) {
      const preview = `A1:${gridRangeA1({ startRowIndex: SHEET_PREVIEW.rows - 1, endRowIndex: SHEET_PREVIEW.rows, startColumnIndex: SHEET_PREVIEW.cols - 1, endColumnIndex: SHEET_PREVIEW.cols })}`;
      parts.push(`===== Tab "${sheet.properties?.title}" (first ${SHEET_PREVIEW.rows} rows, use sheets_read for more) =====\n${await this.readSheetRange(id, sheet, preview)}`);
    }
    return parts.join('\n\n');
  }

  // ---------- Slides ----------

  async getPresentation(id: string): Promise<slides_v1.Schema$Presentation> {
    return this.call(() => this.api.slides.presentations.get({ presentationId: id }), id);
  }

  /** A slide as a PNG (the slide's thumbnail, large). */
  async slideImage(id: string, slide: string | number): Promise<{ buffer: Buffer, number: number }> {
    const presentation = await this.getPresentation(id);
    const { slide: page, number } = findSlide(presentation, slide);
    const thumbnail = await this.call(() => this.api.slides.presentations.pages.getThumbnail({
      presentationId: id, pageObjectId: page.objectId!, 'thumbnailProperties.thumbnailSize': 'LARGE', 'thumbnailProperties.mimeType': 'PNG',
    }), id);
    const res = await fetch(thumbnail.contentUrl!, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      throw Error(`Couldn't download the slide image (HTTP ${res.status}).`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), number };
  }

  /** Downloads an image link from the APIs (Docs contentUri, Slides contentUrl), signed in as Sofia if it needs it. */
  async fetchContent(url: string): Promise<Buffer> {
    let res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status == 401 || res.status == 403) {
      const { token } = await GoogleWorkspace.authClient(this.logger).getAccessToken();
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    }
    if (!res.ok) {
      throw Error(`Couldn't download the image (HTTP ${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- Drive ----------

  /** Downloads a non-Google file (PDF, image, Office file...). */
  async download(file: drive_v3.Schema$File, maxBytes = PDF_MAX_BYTES): Promise<Buffer> {
    if (Number(file.size ?? 0) >= maxBytes) {
      throw Error(`"${file.name}" is too big (${Math.round(Number(file.size) / 1024 / 1024)} MB, the limit is ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    }
    const data = await this.call(() => this.api.drive.files.get({ fileId: file.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }) as any, file.id!);
    return Buffer.from(data as ArrayBuffer);
  }

  /** Exports a Google file (e.g. a Doc as PDF). Drive only exports files up to 10 MB. */
  async export(file: drive_v3.Schema$File, mimeType: string): Promise<Buffer> {
    const data = await this.call(() => this.api.drive.files.export({ fileId: file.id!, mimeType }, { responseType: 'arraybuffer' }) as any, file.id!);
    return Buffer.from(data as ArrayBuffer);
  }

  /**
   * Runs `fn` on a temporary native Google copy of an Office file (in Sofia's own My Drive), then deletes the copy. The
   * Docs/Sheets/Slides APIs can't read Office files directly.
   */
  async withConvertedCopy<T>(file: drive_v3.Schema$File, fn: (copyId: string) => Promise<T>): Promise<T> {
    const target = OFFICE_TO_NATIVE[file.mimeType ?? ''];
    if (!target) {
      throw Error(`"${file.name}" (${fileKind(file.mimeType)}) can't be converted to a Google file.`);
    }
    const copy = await this.call(() => this.api.drive.files.copy({
      fileId: file.id!, supportsAllDrives: true, fields: 'id',
      requestBody: { name: `[Sofia temporary copy] ${file.name}`, mimeType: target, parents: ['root'] },
    }), file.id!);
    try {
      return await fn(copy.id!);
    }
    finally {
      // Only the temporary copy is deleted, never the original
      await this.api.drive.files.delete({ fileId: copy.id!, supportsAllDrives: true }).catch(e => this.logger?.error(e, `Failed to delete temporary copy ${copy.id}`));
    }
  }

  async listFolder(id: string): Promise<string> {
    const res = await this.call(() => this.api.drive.files.list({
      q: `'${id}' in parents and trashed = false`, fields: 'files(id,name,mimeType,webViewLink,modifiedTime)', pageSize: 200,
      orderBy: 'folder,name', supportsAllDrives: true, includeItemsFromAllDrives: true,
    }), id);
    const files = res.files ?? [];
    return files.length ? files.map(f => driveFileLine(f, formatDateTime)).join('\n') : '(empty folder)';
  }

  /** Files whose name or contents match, across My Drive, shared drives and files shared with Sofia. */
  async search(query: string, { folderId, kind }: { folderId?: string, kind?: string } = {}): Promise<string> {
    const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = [`(name contains '${escaped}' or fullText contains '${escaped}')`, 'trashed = false'];
    if (folderId) q.push(`'${folderId}' in parents`);
    const kindMime: { [k: string]: string } = { doc: MIME.doc, sheet: MIME.sheet, slides: MIME.slides, folder: MIME.folder, pdf: MIME.pdf };
    if (kind && kindMime[kind]) q.push(`mimeType = '${kindMime[kind]}'`);
    const res = await this.call(() => this.api.drive.files.list({
      q: q.join(' and '), fields: 'files(id,name,mimeType,webViewLink,modifiedTime)', pageSize: 25,
      corpora: 'allDrives', supportsAllDrives: true, includeItemsFromAllDrives: true,
    }));
    const files = res.files ?? [];
    return files.length ? files.map(f => driveFileLine(f, formatDateTime)).join('\n') : `No files found for "${query}".`;
  }

  async comments(id: string, includeResolved = false): Promise<string> {
    const comments: drive_v3.Schema$Comment[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call(() => this.api.drive.comments.list({
        fileId: id, pageSize: 100, pageToken, includeDeleted: false,
        fields: 'nextPageToken,comments(id,content,createdTime,resolved,deleted,quotedFileContent,author(displayName,emailAddress),replies(id,content,action,deleted,author(displayName)))',
      }), id);
      comments.push(...(res.comments ?? []).filter(c => !c.deleted));
      pageToken = res.nextPageToken ?? undefined;
    } while (pageToken && comments.length < 500);
    const shown = includeResolved ? comments : comments.filter(c => !c.resolved);
    const hidden = comments.length - shown.length;
    return capText(formatComments(shown, formatDateTime) + (hidden ? `\n\n(${hidden} resolved comment${hidden == 1 ? '' : 's'} not shown)` : ''), 'Too many comments to show at once.');
  }

  // ---------- Directory ----------

  /** People in the organisation's directory: name, email and title, matching `query` (or everyone). */
  async directory(query?: string): Promise<string> {
    const readMask = 'names,emailAddresses,organizations';
    const sources = ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'];
    const people: people_v1.Schema$Person[] = [];
    if (query?.trim()) {
      const res = await this.call(() => this.api.people.people.searchDirectoryPeople({ query: query.trim(), readMask, sources, pageSize: 50 }));
      people.push(...(res.people ?? []));
    }
    else {
      let pageToken: string | undefined;
      do {
        const res = await this.call(() => this.api.people.people.listDirectoryPeople({ readMask, sources, pageSize: 200, pageToken }));
        people.push(...(res.people ?? []));
        pageToken = res.nextPageToken ?? undefined;
      } while (pageToken && people.length < 1000);
    }
    if (people.length == 0) {
      return query ? `Nobody in the directory matches "${query}".` : 'The directory is empty (or directory sharing is off in the Workspace admin settings).';
    }
    return people.map(p => {
      const org = p.organizations?.[0];
      const role = [org?.title, org?.department].filter(Boolean).join(', ');
      return `- ${p.names?.[0]?.displayName ?? '(no name)'} <${p.emailAddresses?.[0]?.value ?? 'no email'}>${role ? ` (${role})` : ''}`;
    }).join('\n');
  }

  /**
   * Reads any file: Docs as Markdown, Sheets as tabs + grids, Slides as text, folders as lists, Office files through a
   * temporary converted copy. PDFs and images are handled by the caller (they need the PDF and vision helpers).
   */
  async readFile(input: string | GoogleFileRef): Promise<{ file: drive_v3.Schema$File & { ref: GoogleFileRef }, text?: string }> {
    const file = await this.getFile(input);
    const hint = 'Read part of it: a tab, a range (sheets_read) or a slide.';
    switch (file.mimeType) {
      case MIME.doc: return { file, text: capText(await this.readDoc(file.id!, file.ref.tabId), hint) };
      case MIME.sheet: return { file, text: capText(await this.readSpreadsheet(file.id!, file.ref.gid), hint) };
      case MIME.slides: return { file, text: capText(slidesText(await this.getPresentation(file.id!)), hint) };
      case MIME.folder: return { file, text: await this.listFolder(file.id!) };
    }
    if (OFFICE_TO_NATIVE[file.mimeType ?? ''] && file.mimeType != 'text/plain' && file.mimeType != 'text/csv') {
      const text = await this.withConvertedCopy(file, async copyId => {
        const native = OFFICE_TO_NATIVE[file.mimeType!];
        if (native == MIME.doc) return this.readDoc(copyId);
        if (native == MIME.sheet) return this.readSpreadsheet(copyId);
        return slidesText(await this.getPresentation(copyId));
      });
      return { file, text: capText(`(Read through a temporary Google copy, the original ${fileKind(file.mimeType)} file is unchanged.)\n\n${text}`, hint) };
    }
    return { file };
  }
}
