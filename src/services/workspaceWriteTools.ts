import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { z } from 'zod';
import type { docs_v1, drive_v3, sheets_v4, slides_v1 } from 'googleapis';
import { ExtendedDynamicStructuredTool } from '../utils/tool';
import { googleFileLink, isDriveId, toGoogleLink } from '../utils/googleUrls';
import { fetchPublic } from '../utils/safeFetch';
import { GDG_SHARED_DRIVE_ID } from '../config/googleWorkspace';
import type { ChatMedia } from './ai';
import { GoogleWorkspace, MIME, OFFICE_TO_NATIVE } from './googleWorkspace';
import { docTables, docTabs, fileKind, findDocText, findSlide, parseA1Cell } from './workspaceFormat';
import {
  CellEdit, ChipSegment, a1ToGridRange, chipTextToDocsRequests, chipTextToSheetCell, docCellRange, parseChipText, docTableCellRequests, findElement, imageFormula, markdownToDocsRequests, parseRequests, samePlacement,
  sheetFormatRequest, slidePlacement, slideSetTextRequests,
} from './workspaceEdit';

const fileUrl = (what = 'file') => z.string().describe(`[Required] The ${what}'s link (or file id).`);
const cellsSchema = z.array(z.object({
  row: z.number().int().min(1).describe('Row, 1 = first'),
  col: z.number().int().min(1).describe('Column, 1 = first'),
  text: z.string().describe('The new text (empty clears the cell)'),
})).optional();
const grid2d = z.array(z.array(z.string()));

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;
const summary = (replies: any) => {
  const text = JSON.stringify(replies ?? []);
  return text.length > 3000 ? `${text.slice(0, 3000)}...` : text;
};

export interface WriteToolOptions {
  /** Downloads a WhatsApp image by media_id (to insert images people sent). */
  getChatMedia?: (mediaId: string) => Promise<ChatMedia>;
}

/** Tools for changing Sofia's Google Workspace files. Only added when Workspace is signed in. */
export function createWorkspaceWriteTools(ws: GoogleWorkspace, options: WriteToolOptions = {}): ExtendedDynamicStructuredTool[] {
  const api = () => ws.api;

  /** The file, checked to be a native Google file of `mime`. Office files must be converted first. */
  const editable = async (url: string, mime: string, label: string) => {
    const file = await ws.getFile(url);
    if (file.mimeType != mime) {
      if (OFFICE_TO_NATIVE[file.mimeType ?? ''] == mime) {
        throw Error(`"${file.name}" is a ${fileKind(file.mimeType)} file, which can't be edited directly. Convert it with drive_manage (action "convert") to make a ${label} copy next to it, tell them a Google copy was made (the original stays as it is), then edit the copy.`);
      }
      throw Error(`"${file.name}" is a ${fileKind(file.mimeType)}, not a ${label}.`);
    }
    return file;
  };

  /** Uploads an image to Sofia's Drive as a temporary file, returning its id (deleted again by `withPublicImage`). */
  const uploadTemporaryImage = async (buffer: Buffer, mime: string, label: string) => (await ws.call(() => api().drive.files.create({
    requestBody: { name: `[Sofia temporary image] ${label}`.slice(0, 200), parents: ['root'] },
    media: { mimeType: mime, body: Readable.from(buffer) }, fields: 'id',
  }))).id!;

  /** Chip text with every [[file:...]] resolved to its Google link (short links and shortcuts followed). */
  const chipSegments = async (text: string): Promise<ChipSegment[]> => Promise.all(parseChipText(text).map(async s => {
    if (s.type != 'file') return s;
    const file = await ws.getFile(s.link);
    return { type: 'file' as const, link: googleFileLink(file.id!, file.mimeType) };
  }));

  /**
   * Calls `fn` with a public URL for an image: a public link as is; a WhatsApp image (media_id) or Drive image shared as
   * "anyone with the link" only while it's inserted (Docs and Slides copy the image in), then unshared or deleted.
   * Many sites block Google's image fetcher (e.g. Wikimedia), so a public link Google can't retrieve is downloaded and
   * inserted from a temporary Drive copy instead.
   */
  const withPublicImage = async <T>(source: string, fn: (url: string) => Promise<T>): Promise<T> => {
    const s = source.trim();
    const google = /^https?:\/\//.test(s) || isDriveId(s) ? await toGoogleLink(s) : null;
    let fileId: string;
    let uploaded = false;
    let permissionId: string | undefined;
    if (/^https?:\/\//.test(s) && !google) {
      try {
        return await fn(s);
      }
      catch (e: any) {
        if (!/retriev|publicly accessible/i.test(e?.message ?? '')) throw e;
        const { buffer, contentType } = await fetchPublic(s);
        if (!contentType.startsWith('image/')) throw Error(`${s} isn't an image (${contentType || 'unknown type'}).`);
        fileId = await uploadTemporaryImage(buffer, contentType, new URL(s).hostname);
        uploaded = true;
      }
    }
    else if (google) {
      const file = await ws.getFile(google);
      if (!file.mimeType?.startsWith('image/')) {
        throw Error(`"${file.name}" isn't an image.`);
      }
      fileId = file.id!;
    }
    else {
      if (!options.getChatMedia) {
        throw Error(`"${source}" isn't a link, and images from the chat aren't available here.`);
      }
      const media = await options.getChatMedia(s);
      if (media.kind != 'image' && media.kind != 'gif') {
        throw Error(`${source} is a ${media.kind}, not an image.`);
      }
      fileId = await uploadTemporaryImage(media.buffer, media.mime, s);
      uploaded = true;
    }
    try {
      const existing = await ws.call(() => api().drive.permissions.list({ fileId, supportsAllDrives: true, fields: 'permissions(id,type)' }));
      if (!existing.permissions?.some(p => p.type == 'anyone')) {
        permissionId = (await ws.call(() => api().drive.permissions.create({ fileId, supportsAllDrives: true, fields: 'id', requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false } }))).id!;
      }
      try {
        return await fn(`https://lh3.googleusercontent.com/d/${fileId}`);
      }
      catch {
        return await fn(`https://drive.google.com/uc?export=download&id=${fileId}`);
      }
    }
    finally {
      if (uploaded) {
        await api().drive.files.delete({ fileId, supportsAllDrives: true }).catch(() => undefined);
      }
      else if (permissionId) {
        await api().drive.permissions.delete({ fileId, permissionId, supportsAllDrives: true }).catch(() => undefined);
      }
    }
  };

  // ---------- Drive ----------

  const driveManage = new ExtendedDynamicStructuredTool({
    name: 'drive_manage',
    description: 'Create, copy, move, rename, trash or convert files in Google Drive. New files go in the GDG shared drive unless a folder is given. "trash" moves a file to the trash (it can be restored for 30 days): confirm with the person first. "convert" makes a Google Doc/Sheet/Slides copy of a .docx/.xlsx/.pptx file next to it (the original stays), so it can be edited.',
    schema: z.object({
      action: z.enum(['create', 'copy', 'move', 'rename', 'trash', 'convert']).describe('[Required]'),
      url: z.string().optional().describe('[copy, move, rename, trash, convert] The file\'s link or id.'),
      type: z.enum(['doc', 'sheet', 'slides', 'folder']).optional().describe('[create] What to create.'),
      name: z.string().optional().describe('[create, rename; optional for copy and convert] The name.'),
      folder: z.string().optional().describe('[Optional for create, copy, convert; required for move] The folder\'s link or id.'),
      content: z.string().optional().describe('[Optional for create] A Doc\'s content as Markdown, or a Sheet\'s first tab as CSV.'),
    }),
    func: async (args) => {
      const { action, url, type, name, folder, content } = args as any;
      const folderId = folder ? (await ws.getFile(folder)).id! : undefined;
      const done = (f: drive_v3.Schema$File, verb: string) => `${verb} "${f.name}" (${fileKind(f.mimeType)}): ${f.webViewLink ?? googleFileLink(f.id!, f.mimeType)}`;
      const fields = 'id,name,mimeType,webViewLink,parents';
      if (action == 'create') {
        if (!type || !name) throw Error('create needs a type and a name.');
        const parent = folderId ?? GDG_SHARED_DRIVE_ID ?? 'root';
        const mimeType = { doc: MIME.doc, sheet: MIME.sheet, slides: MIME.slides, folder: MIME.folder }[type as 'doc'];
        const media = content && type == 'doc' ? { mimeType: 'text/markdown', body: content }
          : content && type == 'sheet' ? { mimeType: 'text/csv', body: content } : undefined;
        const f = await ws.call(() => api().drive.files.create({ requestBody: { name, mimeType, parents: [parent] }, media, fields, supportsAllDrives: true }));
        // New decks come with one empty title slide, which is easy to miss when adding slides after it
        return done(f, 'Created') + (type == 'slides' ? '\nIt starts with one empty title slide (slide 1): fill it in or delete it.' : '');
      }
      if (!url) throw Error(`${action} needs the file's link.`);
      const file = await ws.getFile(url);
      switch (action) {
        case 'copy': {
          const f = await ws.call(() => api().drive.files.copy({ fileId: file.id!, fields, supportsAllDrives: true, requestBody: { name: name ?? `Copy of ${file.name}`, ...(folderId ? { parents: [folderId] } : {}) } }));
          return done(f, 'Copied it to');
        }
        case 'move': {
          if (!folderId) throw Error('move needs the folder to move it to.');
          const f = await ws.call(() => api().drive.files.update({ fileId: file.id!, addParents: folderId, removeParents: (file.parents ?? []).join(','), fields, supportsAllDrives: true }));
          return done(f, 'Moved');
        }
        case 'rename': {
          if (!name) throw Error('rename needs the new name.');
          const f = await ws.call(() => api().drive.files.update({ fileId: file.id!, requestBody: { name }, fields, supportsAllDrives: true }));
          return done(f, 'Renamed it to');
        }
        case 'trash': {
          await ws.call(() => api().drive.files.update({ fileId: file.id!, requestBody: { trashed: true }, supportsAllDrives: true }));
          return `Moved "${file.name}" to the trash. It can be restored from the trash for 30 days.`;
        }
        case 'convert': {
          const target = OFFICE_TO_NATIVE[file.mimeType ?? ''];
          if (!target) throw Error(`"${file.name}" (${fileKind(file.mimeType)}) isn't an Office file that can be converted.`);
          const f = await ws.call(() => api().drive.files.copy({
            fileId: file.id!, fields, supportsAllDrives: true,
            requestBody: { name: name ?? file.name!.replace(/\.(docx?|xlsx?|pptx?|csv|txt|rtf)$/i, ''), mimeType: target, parents: folderId ? [folderId] : file.parents ?? undefined },
          }));
          return `${done(f, 'Made a Google copy')}\nThe original ${fileKind(file.mimeType)} file is unchanged. Tell them the edits will be in this Google copy.`;
        }
      }
      throw Error(`Unknown action ${action}.`);
    }
  }, '{action: "create" | "copy" | "move" | "rename" | "trash" | "convert", url?: string, type?: "doc" | "sheet" | "slides" | "folder", name?: string, folder?: string, content?: string}');

  const share = new ExtendedDynamicStructuredTool({
    name: 'drive_share',
    description: "See and change who can access a file: list, add or update a person/group/domain (viewer, commenter or editor), remove someone, set link sharing (anyone with the link), or transfer ownership. Look people up with `directory_search` for their email. Confirm with the person before sharing outside nyp-gdg.com, turning on link sharing, removing someone or transferring ownership. Files in a shared drive belong to the drive, so their ownership can't be transferred.",
    schema: z.object({
      action: z.enum(['list', 'add', 'update', 'remove', 'link', 'transfer_ownership']).describe('[Required]'),
      url: fileUrl(),
      email: z.string().optional().describe('[add, update, remove, transfer_ownership] The person\'s or group\'s email (or a domain for type "domain").'),
      type: z.enum(['user', 'group', 'domain']).optional().describe('[Optional for add] Defaults to user.'),
      role: z.enum(['viewer', 'commenter', 'editor', 'off']).optional().describe('[add, update, link] "off" turns link sharing off.'),
      message: z.string().optional().describe('[Optional for add] A note in the notification email.'),
      notify: z.boolean().optional().describe('[Optional for add] Email them about it, defaults to true.'),
    }),
    func: async (args) => {
      const { action, url, email, type = 'user', role, message, notify = true } = args as any;
      const file = await ws.getFile(url);
      const fileId = file.id!;
      const roles: { [r: string]: string } = { viewer: 'reader', commenter: 'commenter', editor: 'writer' };
      const names: { [r: string]: string } = { reader: 'viewer', commenter: 'commenter', writer: 'editor', fileOrganizer: 'content manager', organizer: 'manager', owner: 'owner' };
      const list = async () => (await ws.call(() => api().drive.permissions.list({
        fileId, supportsAllDrives: true, fields: 'permissions(id,type,role,emailAddress,domain,displayName,pendingOwner,permissionDetails(inherited))',
      }))).permissions ?? [];
      const find = async () => {
        const perm = (await list()).find(p => p.emailAddress?.toLowerCase() == String(email).toLowerCase() || p.domain?.toLowerCase() == String(email).toLowerCase());
        if (!perm) throw Error(`${email} doesn't have access to "${file.name}".`);
        return perm;
      };
      switch (action) {
        case 'list': {
          const perms = await list();
          const lines = perms.map(p => {
            const who = p.type == 'anyone' ? 'Anyone with the link' : p.type == 'domain' ? `Everyone at ${p.domain}` : `${p.displayName ?? ''} <${p.emailAddress}>`.trim();
            const inherited = p.permissionDetails?.some(d => d.inherited) ? (file.driveId ? ' (from the shared drive)' : ' (from a parent folder)') : '';
            return `- ${who}: ${names[p.role ?? ''] ?? p.role}${p.pendingOwner ? ' (pending owner)' : ''}${inherited}`;
          });
          return `Access to "${file.name}"${file.driveId ? ' (in a shared drive)' : ''}:\n${lines.join('\n') || '(nobody else)'}`;
        }
        case 'add': {
          if (!email || !role || role == 'off') throw Error('add needs an email (or domain) and a role: viewer, commenter or editor.');
          await ws.call(() => api().drive.permissions.create({
            fileId, supportsAllDrives: true, sendNotificationEmail: type == 'domain' ? false : notify, emailMessage: message,
            requestBody: { type, role: roles[role], ...(type == 'domain' ? { domain: email } : { emailAddress: email }) },
          }), fileId);
          return `Shared "${file.name}" with ${email} as ${role}.`;
        }
        case 'update': {
          if (!email || !role || role == 'off') throw Error('update needs an email and a role: viewer, commenter or editor.');
          const perm = await find();
          await ws.call(() => api().drive.permissions.update({ fileId, permissionId: perm.id!, supportsAllDrives: true, requestBody: { role: roles[role] } }), fileId);
          return `${email} is now a ${role} of "${file.name}".`;
        }
        case 'remove': {
          if (!email) throw Error('remove needs an email.');
          const perm = await find();
          await ws.call(() => api().drive.permissions.delete({ fileId, permissionId: perm.id!, supportsAllDrives: true }), fileId);
          return `Removed ${email}'s access to "${file.name}".`;
        }
        case 'link': {
          if (!role) throw Error('link needs a role: viewer, commenter, editor or off.');
          const anyone = (await list()).find(p => p.type == 'anyone');
          if (role == 'off') {
            if (!anyone) return `Link sharing is already off for "${file.name}".`;
            await ws.call(() => api().drive.permissions.delete({ fileId, permissionId: anyone.id!, supportsAllDrives: true }), fileId);
            return `Turned link sharing off for "${file.name}": only people it's shared with can open it.`;
          }
          if (anyone) {
            await ws.call(() => api().drive.permissions.update({ fileId, permissionId: anyone.id!, supportsAllDrives: true, requestBody: { role: roles[role] } }), fileId);
          }
          else {
            await ws.call(() => api().drive.permissions.create({ fileId, supportsAllDrives: true, requestBody: { type: 'anyone', role: roles[role], allowFileDiscovery: false } }), fileId);
          }
          return `Anyone with the link can now open "${file.name}" as a ${role}: ${file.webViewLink}`;
        }
        case 'transfer_ownership': {
          if (!email) throw Error('transfer_ownership needs the new owner\'s email.');
          if (file.driveId) {
            throw Error(`"${file.name}" is in a shared drive, so it belongs to the drive and has no owner to transfer. Move it to someone's My Drive first if it really needs an owner.`);
          }
          const me = await ws.me();
          if (!file.owners?.some(o => o.emailAddress?.toLowerCase() == me.toLowerCase())) {
            throw Error(`Only the owner can transfer ownership, and "${file.name}" is owned by ${file.owners?.[0]?.displayName ?? 'someone else'}. Ask them to transfer it.`);
          }
          const sameDomain = email.split('@')[1]?.toLowerCase() == me.split('@')[1]?.toLowerCase();
          const existing = (await list()).find(p => p.emailAddress?.toLowerCase() == email.toLowerCase());
          if (sameDomain) {
            if (existing) {
              await ws.call(() => api().drive.permissions.update({ fileId, permissionId: existing.id!, transferOwnership: true, requestBody: { role: 'owner' } }), fileId);
            }
            else {
              await ws.call(() => api().drive.permissions.create({ fileId, transferOwnership: true, requestBody: { type: 'user', role: 'owner', emailAddress: email } }), fileId);
            }
            return `${email} now owns "${file.name}". You (Sofia) are still an editor.`;
          }
          // Outside the organisation, the new owner has to accept (Drive's pending owner flow)
          const permissionId = existing?.id ?? (await ws.call(() => api().drive.permissions.create({ fileId, fields: 'id', requestBody: { type: 'user', role: 'writer', emailAddress: email } }), fileId)).id!;
          await ws.call(() => api().drive.permissions.update({ fileId, permissionId, requestBody: { role: 'writer', pendingOwner: true } }), fileId);
          return `Asked ${email} to become the owner of "${file.name}". They need to accept it in Google Drive (they got an email).`;
        }
      }
      throw Error(`Unknown action ${action}.`);
    }
  }, '{action: "list" | "add" | "update" | "remove" | "link" | "transfer_ownership", url: string, email?: string, type?: "user" | "group" | "domain", role?: "viewer" | "commenter" | "editor" | "off", message?: string, notify?: boolean}');

  // ---------- Docs ----------

  const docsEdit = new ExtendedDynamicStructuredTool({
    name: 'docs_edit',
    description: 'Edit a Google Doc. Read it with `docs_read_structure` first (and again after each edit, the indices change). Actions: insert_inline (text with smart chips inside a paragraph or table cell: [[person:email]], [[date:2026-11-21]] or [[date:2026-11-21T10:00]], [[file:link to a Drive file]]; e.g. after_text "Organiser:" or a table cell), insert_page_break, replace_text (find and replace everywhere), insert_markdown (headings #, bullets -, numbered 1., **bold**, *italic*, [links](url); at the end, after a paragraph containing after_text, or at a paragraph\'s start index), rewrite_markdown (replace the whole tab\'s content, confirm first), delete_range, insert_image, insert_table, table_set_cells, table_rows / table_columns (insert or delete), table_merge. Tables are numbered from 1 as in `docs_read_structure`. For anything else use `docs_batch_update`.',
    schema: z.object({
      url: fileUrl('Doc'),
      action: z.enum(['insert_inline', 'insert_page_break', 'replace_text', 'insert_markdown', 'rewrite_markdown', 'delete_range', 'insert_image', 'insert_table', 'table_set_cells', 'table_rows', 'table_columns', 'table_merge']).describe('[Required]'),
      text: z.string().optional().describe('[insert_inline] Text with chips, e.g. "OIC: [[person:azlan@nyp-gdg.com]], see [[file:https://docs.google.com/...]]".'),
      tab: z.string().optional().describe("[Optional] The tab's title or id, defaults to the link's tab or the first tab."),
      find: z.string().optional().describe('[replace_text] Text to find.'),
      replace: z.string().optional().describe('[replace_text] The replacement (empty removes it).'),
      match_case: z.boolean().optional().describe('[Optional for replace_text] Defaults to false.'),
      markdown: z.string().optional().describe('[insert_markdown, rewrite_markdown] The content.'),
      after_text: z.string().optional().describe('[Optional for insert_markdown, insert_image, insert_table] Insert after the paragraph containing this text. [insert_inline, insert_page_break] Insert right after this text (it can be inside a table cell).'),
      at: z.number().int().optional().describe('[Optional for insert_markdown, insert_image, insert_table] Insert at this index (the start index of a paragraph from docs_read_structure). [insert_inline, insert_page_break] Any index. Defaults to the end.'),
      start: z.number().int().optional().describe('[delete_range] Start index.'),
      end: z.number().int().optional().describe('[delete_range] End index (not included).'),
      image: z.string().optional().describe('[insert_image] A public image link, a Drive image link, or a WhatsApp image media_id.'),
      width_pt: z.number().optional().describe('[Optional for insert_image] Width in points (the page is about 468pt wide), the height keeps the aspect ratio.'),
      table: z.number().int().min(1).optional().describe('[table_*, and insert_image into a cell] Table number, 1 = first.'),
      cells: cellsSchema.describe('[table_set_cells] Cells to set.'),
      row: z.number().int().min(1).optional().describe('[table_rows, table_merge, insert_image into a cell] Row, 1 = first.'),
      column: z.number().int().min(1).optional().describe('[table_columns, table_merge, insert_image into a cell] Column, 1 = first.'),
      operation: z.enum(['insert', 'delete']).optional().describe('[table_rows, table_columns]'),
      count: z.number().int().min(1).optional().describe('[Optional for table_rows, table_columns] How many, defaults to 1.'),
      before: z.boolean().optional().describe('[Optional for inserting rows/columns] Insert before (above/left of) the row/column instead of after.'),
      row_span: z.number().int().min(1).optional().describe('[table_merge] Rows to merge, from row.'),
      column_span: z.number().int().min(1).optional().describe('[table_merge] Columns to merge, from column.'),
      rows: z.number().int().min(1).optional().describe('[insert_table] Rows.'),
      columns: z.number().int().min(1).optional().describe('[insert_table] Columns.'),
      contents: grid2d.optional().describe('[Optional for insert_table] The cells\' text, row by row.'),
    }),
    func: async (args) => {
      const a = args as any;
      const file = await editable(a.url, MIME.doc, 'Google Doc');
      const documentId = file.id!;
      const doc = await ws.getDoc(documentId);
      const tab = ws.pickTab(doc, a.tab ?? file.ref.tabId);
      const tabId = docTabs(doc).length > 1 || tab.id ? tab.id || undefined : undefined;
      const withTab = <T extends object>(o: T) => ({ ...o, ...(tabId ? { tabId } : {}) });
      const batch = (requests: docs_v1.Schema$Request[]) => ws.call(() => api().docs.documents.batchUpdate({ documentId, requestBody: { requests } }), documentId);
      const bodyEnd = tab.body[tab.body.length - 1]?.endIndex ?? 2;
      const paragraphs = tab.body.filter(el => el.paragraph);
      const tables = docTables(tab.body);
      const pickTable = () => {
        const t = tables[(a.table ?? 0) - 1];
        if (!t) throw Error(`There's no table ${a.table}, the tab has ${tables.length} table${tables.length == 1 ? '' : 's'}.`);
        return t;
      };
      /** Where to insert: a paragraph start (`at`), after the paragraph containing `after_text`, or the end. */
      const where = (): { index: number, mode: 'paragraph' | 'end' } => {
        if (a.at != null) {
          if (a.at >= bodyEnd - 1) return { index: bodyEnd, mode: 'end' };
          if (!paragraphs.some(p => p.startIndex == a.at)) {
            throw Error(`${a.at} isn't the start of a paragraph. Use a [start-...] index from docs_read_structure, or after_text.`);
          }
          return { index: a.at, mode: 'paragraph' };
        }
        if (a.after_text) {
          const p = paragraphs.find(el => (el.paragraph?.elements ?? []).map(e => e.textRun?.content ?? '').join('').includes(a.after_text));
          if (!p) throw Error(`No paragraph contains "${a.after_text}".`);
          return p.endIndex! >= bodyEnd ? { index: bodyEnd, mode: 'end' } : { index: p.endIndex!, mode: 'paragraph' };
        }
        return { index: bodyEnd, mode: 'end' };
      };
      const tableStart = (t: { startIndex: number }) => withTab({ index: t.startIndex });
      /** An index inside the text: `at`, right after `after_text`, the end of a table cell's text, or null for the end. */
      const inlineIndex = (): number | null => {
        if (a.at != null) return a.at;
        if (a.after_text) {
          const found = findDocText(tab.body, a.after_text);
          if (!found) throw Error(`"${a.after_text}" wasn't found in tab "${tab.title}".`);
          return found.end;
        }
        if (a.table) {
          const cell = pickTable().table.tableRows?.[(a.row ?? 1) - 1]?.tableCells?.[(a.column ?? 1) - 1];
          if (!cell) throw Error(`Table ${a.table} has no cell at row ${a.row}, column ${a.column}.`);
          return docCellRange(cell).end;
        }
        return null;
      };

      switch (a.action) {
        case 'insert_inline': {
          if (!a.text) throw Error('insert_inline needs text.');
          let index = inlineIndex();
          let segments = await chipSegments(a.text);
          let newParagraph = false;
          if (index == null) {
            // At the end of the document: a new paragraph, unless the last one is empty
            const lastText = (tab.body[tab.body.length - 1]?.paragraph?.elements ?? []).map(e => e.textRun?.content ?? 'x').join('').trim();
            index = bodyEnd - 1;
            newParagraph = true;
            if (lastText) segments = [{ type: 'text', text: '\n' }, ...segments];
          }
          const requests = chipTextToDocsRequests(segments, index, tabId);
          if (newParagraph) {
            // A new paragraph copies the style of the one before (e.g. a list item or heading), so make it normal text
            const length = segments.reduce((n, s) => n + (s.type == 'text' ? s.text.length : 1), 0);
            const range = withTab({ startIndex: index + (segments[0]?.type == 'text' && segments[0].text == '\n' ? 1 : 0), endIndex: index + length + 1 });
            requests.push({ deleteParagraphBullets: { range } }, { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
          }
          await batch(requests);
          const chips = segments.filter(s => s.type != 'text').length;
          return `Inserted the text${chips ? ` with ${chips} smart chip${chips == 1 ? '' : 's'}` : ''} in "${file.name}". ${file.webViewLink}`;
        }
        case 'insert_page_break': {
          const index = inlineIndex();
          await batch([{ insertPageBreak: index == null ? { endOfSegmentLocation: withTab({}) } : { location: withTab({ index }) } }]);
          return `Inserted a page break in "${file.name}".`;
        }
        case 'replace_text': {
          if (!a.find) throw Error('replace_text needs find.');
          const res = await batch([{ replaceAllText: { containsText: { text: a.find, matchCase: !!a.match_case }, replaceText: a.replace ?? '', ...(tabId ? { tabsCriteria: { tabIds: [tabId] } } : {}) } }]);
          const n = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          return n ? `Replaced ${n} occurrence${n == 1 ? '' : 's'} of "${a.find}".` : `"${a.find}" wasn't found, nothing changed.`;
        }
        case 'insert_markdown': {
          if (!a.markdown?.trim()) throw Error('insert_markdown needs markdown.');
          const { index, mode } = where();
          await batch(markdownToDocsRequests(a.markdown, index, mode, tabId));
          return `Inserted the text in "${file.name}" (tab "${tab.title}"). ${file.webViewLink}`;
        }
        case 'rewrite_markdown': {
          if (!a.markdown?.trim()) throw Error('rewrite_markdown needs markdown.');
          const requests: docs_v1.Schema$Request[] = bodyEnd - 1 > 1 ? [{ deleteContentRange: { range: withTab({ startIndex: 1, endIndex: bodyEnd - 1 }) } }] : [];
          await batch([...requests, ...markdownToDocsRequests(a.markdown, 1, 'paragraph', tabId)]);
          return `Rewrote tab "${tab.title}" of "${file.name}". ${file.webViewLink}`;
        }
        case 'delete_range': {
          if (a.start == null || a.end == null || a.end <= a.start) throw Error('delete_range needs start and end (end after start).');
          await batch([{ deleteContentRange: { range: withTab({ startIndex: a.start, endIndex: Math.min(a.end, bodyEnd - 1) }) } }]);
          return `Deleted ${a.start}-${a.end}.`;
        }
        case 'insert_image': {
          if (!a.image) throw Error('insert_image needs image.');
          let location: docs_v1.Schema$Request['insertInlineImage'];
          if (a.table) {
            const t = pickTable();
            const cell = t.table.tableRows?.[(a.row ?? 1) - 1]?.tableCells?.[(a.column ?? 1) - 1];
            if (!cell) throw Error(`Table ${a.table} has no cell at row ${a.row}, column ${a.column}.`);
            location = { location: withTab({ index: cell.content?.[0]?.startIndex ?? cell.startIndex! + 1 }) };
          }
          else {
            const { index, mode } = where();
            location = mode == 'end' ? { endOfSegmentLocation: withTab({}) } : { location: withTab({ index }) };
          }
          await withPublicImage(a.image, uri => batch([{ insertInlineImage: { ...location, uri, ...(a.width_pt ? { objectSize: { width: { magnitude: a.width_pt, unit: 'PT' } } } : {}) } }]));
          return `Inserted the image in "${file.name}". ${file.webViewLink}`;
        }
        case 'insert_table': {
          if (!a.rows || !a.columns) throw Error('insert_table needs rows and columns.');
          const { index, mode } = where();
          await batch([{ insertTable: { rows: a.rows, columns: a.columns, ...(mode == 'end' ? { endOfSegmentLocation: withTab({}) } : { location: withTab({ index }) }) } }]);
          if (a.contents?.length) {
            // The new table is the first one at or after where it was inserted
            const after = docTables(ws.pickTab(await ws.getDoc(documentId), tab.id || undefined).body);
            const created = mode == 'end' ? after[after.length - 1] : after.find(t => t.startIndex >= index);
            const cells: CellEdit[] = a.contents.flatMap((row: string[], r: number) => row.map((text, c) => ({ row: r + 1, col: c + 1, text }))).filter((c: CellEdit) => c.text && c.row <= a.rows && c.col <= a.columns);
            if (created && cells.length) await batch(docTableCellRequests(created.table, cells, tabId));
          }
          return `Inserted a ${a.rows}x${a.columns} table in "${file.name}". ${file.webViewLink}`;
        }
        case 'table_set_cells': {
          if (!a.cells?.length) throw Error('table_set_cells needs cells.');
          await batch(docTableCellRequests(pickTable().table, a.cells, tabId));
          return `Updated ${a.cells.length} cell${a.cells.length == 1 ? '' : 's'} in table ${a.table}.`;
        }
        case 'table_rows':
        case 'table_columns': {
          const t = pickTable();
          const isRow = a.action == 'table_rows';
          const at = (isRow ? a.row : a.column) ?? 1;
          if (!a.operation) throw Error(`${a.action} needs operation: insert or delete.`);
          const location = { tableStartLocation: tableStart(t), rowIndex: isRow ? at - 1 : 0, columnIndex: isRow ? 0 : at - 1 };
          const requests: docs_v1.Schema$Request[] = Array.from({ length: a.count ?? 1 }, () => a.operation == 'insert'
            ? (isRow ? { insertTableRow: { tableCellLocation: location, insertBelow: !a.before } } : { insertTableColumn: { tableCellLocation: location, insertRight: !a.before } })
            : (isRow ? { deleteTableRow: { tableCellLocation: location } } : { deleteTableColumn: { tableCellLocation: location } }));
          await batch(requests);
          return `${a.operation == 'insert' ? 'Inserted' : 'Deleted'} ${a.count ?? 1} ${isRow ? 'row' : 'column'}${(a.count ?? 1) == 1 ? '' : 's'} in table ${a.table}.`;
        }
        case 'table_merge': {
          const t = pickTable();
          await batch([{ mergeTableCells: { tableRange: { tableCellLocation: { tableStartLocation: tableStart(t), rowIndex: (a.row ?? 1) - 1, columnIndex: (a.column ?? 1) - 1 }, rowSpan: a.row_span ?? 1, columnSpan: a.column_span ?? 1 } } }]);
          return `Merged ${a.row_span ?? 1}x${a.column_span ?? 1} cells in table ${a.table}.`;
        }
      }
      throw Error(`Unknown action ${a.action}.`);
    }
  }, '{url: string, action: string, tab?: string, ...see the action\'s fields}');

  // ---------- Sheets ----------

  const sheetsEdit = new ExtendedDynamicStructuredTool({
    name: 'sheets_edit',
    description: 'Edit a Google Sheet. Read it with `sheets_read` first. Actions: write_chips (one cell\'s text with smart chips: [[person:email]] and [[file:link to a Drive file]]; Sheets has no date chips), write (values or formulas into a range), append (rows after the last filled row), clear, add_tab (optionally with values from A1), rename_tab, merge / unmerge (a range), format (bold, colours, number format, alignment...), column_width, freeze (rows at the top), insert_image (an =IMAGE() formula in a cell, the image link must stay public). For anything else use `sheets_batch_update`.',
    schema: z.object({
      url: fileUrl('Sheet'),
      action: z.enum(['write_chips', 'write', 'append', 'clear', 'add_tab', 'rename_tab', 'merge', 'unmerge', 'format', 'column_width', 'freeze', 'insert_image']).describe('[Required]'),
      text: z.string().optional().describe('[write_chips] e.g. "[[person:azlan@nyp-gdg.com]]" or "See [[file:https://docs.google.com/...]] for details".'),
      tab: z.string().optional().describe("[Optional] Tab name, id or position, defaults to the link's tab or the first tab. For add_tab, the new tab's name."),
      range: z.string().optional().describe('[write, clear, merge, unmerge, format, column_width] Cells, e.g. "A1:D10" (write: where the values start, e.g. "B2").'),
      values: grid2d.optional().describe('[write, add_tab] Rows of values; text starting with = is a formula.'),
      rows: grid2d.optional().describe('[append] Rows to add.'),
      new_name: z.string().optional().describe('[rename_tab] The new name.'),
      bold: z.boolean().optional(), italic: z.boolean().optional(), font_size: z.number().optional(),
      text_color: z.string().optional().describe('[format] e.g. #FFFFFF'), background: z.string().optional().describe('[format] e.g. #4285F4'),
      number_format: z.string().optional().describe('[format] e.g. "$#,##0.00" or "0%"'),
      align: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(), wrap: z.boolean().optional(),
      width_px: z.number().int().optional().describe('[column_width] Width in pixels.'),
      frozen_rows: z.number().int().min(0).optional().describe('[freeze] Rows to freeze at the top.'),
      cell: z.string().optional().describe('[insert_image, write_chips] The cell, e.g. "B4".'),
      image: z.string().optional().describe('[insert_image] A public image link.'),
    }),
    func: async (args) => {
      const a = args as any;
      const file = await editable(a.url, MIME.sheet, 'Google Sheet');
      const spreadsheetId = file.id!;
      const spreadsheet = await ws.getSpreadsheet(spreadsheetId);
      const batch = (requests: sheets_v4.Schema$Request[]) => ws.call(() => api().sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }), spreadsheetId);
      const values = api().sheets.spreadsheets.values;
      if (a.action == 'add_tab') {
        if (!a.tab) throw Error('add_tab needs tab (the new tab\'s name).');
        const res = await batch([{ addSheet: { properties: { title: a.tab } } }]);
        const sheetId = res.replies?.[0]?.addSheet?.properties?.sheetId;
        if (a.values?.length) {
          await ws.call(() => values.update({ spreadsheetId, range: `'${a.tab.replace(/'/g, "''")}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: a.values } }));
        }
        return `Added tab "${a.tab}" (id ${sheetId}) to "${file.name}". ${file.webViewLink}#gid=${sheetId}`;
      }
      const sheet = ws.pickSheet(spreadsheet, a.tab, file.ref.gid);
      const title = sheet.properties!.title!;
      const sheetId = sheet.properties!.sheetId!;
      const inTab = (range: string) => `'${title.replace(/'/g, "''")}'!${range}`;
      const needRange = () => { if (!a.range) throw Error(`${a.action} needs range, e.g. "A1:D10".`); return a.range as string; };
      switch (a.action) {
        case 'write_chips': {
          if (!a.cell || !a.text) throw Error('write_chips needs cell and text.');
          const { row, col } = parseA1Cell(a.cell);
          await batch([{ updateCells: { range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 }, rows: [{ values: [chipTextToSheetCell(await chipSegments(a.text))] }], fields: 'userEnteredValue,chipRuns' } } as any]);
          return `Wrote ${a.cell} in "${title}" with smart chips.`;
        }
        case 'write': {
          if (!a.values?.length) throw Error('write needs values.');
          const res = await ws.call(() => values.update({ spreadsheetId, range: inTab(needRange()), valueInputOption: 'USER_ENTERED', requestBody: { values: a.values } }));
          return `Wrote ${res.updatedCells ?? 0} cells in ${res.updatedRange}.`;
        }
        case 'append': {
          if (!a.rows?.length) throw Error('append needs rows.');
          const res = await ws.call(() => values.append({ spreadsheetId, range: inTab('A1'), valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: a.rows } }));
          return `Added ${a.rows.length} row${a.rows.length == 1 ? '' : 's'} at ${res.updates?.updatedRange}.`;
        }
        case 'clear': {
          await ws.call(() => values.clear({ spreadsheetId, range: inTab(needRange()) }));
          return `Cleared ${a.range} in "${title}".`;
        }
        case 'rename_tab': {
          if (!a.new_name) throw Error('rename_tab needs new_name.');
          await batch([{ updateSheetProperties: { properties: { sheetId, title: a.new_name }, fields: 'title' } }]);
          return `Renamed tab "${title}" to "${a.new_name}".`;
        }
        case 'merge':
        case 'unmerge': {
          const range = a1ToGridRange(needRange(), sheetId);
          await batch([a.action == 'merge' ? { mergeCells: { range, mergeType: 'MERGE_ALL' } } : { unmergeCells: { range } }]);
          return `${a.action == 'merge' ? 'Merged' : 'Unmerged'} ${a.range} in "${title}".`;
        }
        case 'format': {
          await batch([sheetFormatRequest(a1ToGridRange(needRange(), sheetId), a)]);
          return `Formatted ${a.range} in "${title}".`;
        }
        case 'column_width': {
          if (!a.width_px) throw Error('column_width needs width_px.');
          const g = a1ToGridRange(needRange(), sheetId);
          await batch([{ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: g.startColumnIndex ?? 0, endIndex: g.endColumnIndex ?? (g.startColumnIndex ?? 0) + 1 }, properties: { pixelSize: a.width_px }, fields: 'pixelSize' } }]);
          return `Set the width of ${a.range} to ${a.width_px}px.`;
        }
        case 'freeze': {
          await batch([{ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: a.frozen_rows ?? 1 } }, fields: 'gridProperties.frozenRowCount' } }]);
          return `Froze the top ${a.frozen_rows ?? 1} row(s) of "${title}".`;
        }
        case 'insert_image': {
          if (!a.cell || !a.image || !/^https?:\/\//.test(a.image) || /google\.com\//.test(a.image)) {
            throw Error('insert_image needs cell and a public image link (Sheets keeps loading it from the link, so private images can\'t be used).');
          }
          await ws.call(() => values.update({ spreadsheetId, range: inTab(a.cell), valueInputOption: 'USER_ENTERED', requestBody: { values: [[imageFormula(a.image)]] } }));
          return `Put the image in ${a.cell} of "${title}".`;
        }
      }
      throw Error(`Unknown action ${a.action}.`);
    }
  }, '{url: string, action: string, tab?: string, range?: string, ...see the action\'s fields}');

  // ---------- Slides ----------

  const slidesEdit = new ExtendedDynamicStructuredTool({
    name: 'slides_edit',
    description: 'Edit a Google Slides deck. Read it with `slides_read` first (for element ids), and check the result with `google_view_slide`. Actions: replace_text (everywhere or on some slides), set_text (a shape, or a table cell with row/column), add_text_box, add_slide (with a layout from the deck, e.g. its branded layouts, and title/body), duplicate_slide, move_slide, delete_slide (confirm first), delete_element, insert_image (public link, Drive image or WhatsApp media_id), copy_image (from a slide of this or another deck to other slides, same place and size, e.g. a logo from the branding guide), insert_table, table_set_cells, table_rows (insert or delete), set_notes (speaker notes). Positions and sizes are in points (a slide is usually 720x405pt). For anything else use `slides_batch_update`.',
    schema: z.object({
      url: fileUrl('deck'),
      action: z.enum(['replace_text', 'set_text', 'add_text_box', 'add_slide', 'duplicate_slide', 'move_slide', 'delete_slide', 'delete_element', 'insert_image', 'copy_image', 'insert_table', 'table_set_cells', 'table_rows', 'set_notes']).describe('[Required]'),
      slide: z.string().optional().describe('[Most actions] The slide number (1 = first) or id.'),
      element_id: z.string().optional().describe('[set_text, delete_element, table_*; optional for copy_image] The element id from slides_read.'),
      find: z.string().optional().describe('[replace_text]'), replace: z.string().optional().describe('[replace_text]'),
      match_case: z.boolean().optional(),
      only_slides: z.array(z.string()).optional().describe('[Optional for replace_text] Only these slides (numbers or ids).'),
      slides: z.array(z.string()).optional().describe('[Optional for delete_slide] Delete several slides at once (numbers or ids), instead of slide.'),
      text: z.string().optional().describe('[set_text, add_text_box, set_notes]'),
      row: z.number().int().min(1).optional().describe('[set_text in a table, table_rows]'),
      column: z.number().int().min(1).optional().describe('[set_text in a table]'),
      layout: z.string().optional().describe("[Optional for add_slide] A layout name from the deck (see slides_read), or one of TITLE, TITLE_AND_BODY, TITLE_ONLY, SECTION_HEADER, TITLE_AND_TWO_COLUMNS, BIG_NUMBER, BLANK."),
      title: z.string().optional().describe('[Optional for add_slide]'), body: z.string().optional().describe('[Optional for add_slide]'),
      position: z.number().int().min(1).optional().describe('[Optional for add_slide, duplicate_slide; required for move_slide] Slide position, 1 = first.'),
      image: z.string().optional().describe('[insert_image]'),
      x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
      from_url: z.string().optional().describe("[Optional for copy_image] The deck to copy from, defaults to this one."),
      from_slide: z.string().optional().describe('[copy_image] The slide to copy from.'),
      to_slides: z.array(z.string()).optional().describe('[copy_image] The slides to copy to (numbers or ids).'),
      rows: z.number().int().min(1).optional().describe('[insert_table]'), columns: z.number().int().min(1).optional().describe('[insert_table]'),
      contents: grid2d.optional().describe('[Optional for insert_table] Cell text, row by row.'),
      cells: cellsSchema.describe('[table_set_cells]'),
      operation: z.enum(['insert', 'delete']).optional().describe('[table_rows]'),
      count: z.number().int().min(1).optional().describe('[Optional for table_rows]'),
      before: z.boolean().optional().describe('[Optional for inserting table rows] Insert above instead of below.'),
    }),
    func: async (args) => {
      const a = args as any;
      const file = await editable(a.url, MIME.slides, 'Google Slides deck');
      const presentationId = file.id!;
      const presentation = await ws.getPresentation(presentationId);
      const batch = (requests: slides_v1.Schema$Request[]) => ws.call(() => api().slides.presentations.batchUpdate({ presentationId, requestBody: { requests } }), presentationId);
      const slideId = (s = a.slide) => { if (!s) throw Error(`${a.action} needs slide.`); return findSlide(presentation, s).slide.objectId!; };
      const page = (s = a.slide) => findSlide(presentation, s).slide;
      const element = () => {
        if (!a.element_id) throw Error(`${a.action} needs element_id (from slides_read).`);
        for (const s of presentation.slides ?? []) {
          const el = findElement(s.pageElements ?? undefined, a.element_id);
          if (el) return el;
        }
        throw Error(`There's no element ${a.element_id} in "${file.name}". Read it again with slides_read.`);
      };
      const hasText = (t?: slides_v1.Schema$TextContent | null) => (t?.textElements ?? []).some(e => e.textRun?.content?.trim());
      const placement = (pageId: string, dw = 300, dh = 200) => slidePlacement(pageId, a.x ?? 40, a.y ?? 80, a.width ?? dw, a.height ?? dh);
      const link = `${file.webViewLink}`;

      switch (a.action) {
        case 'replace_text': {
          if (!a.find) throw Error('replace_text needs find.');
          const pageObjectIds = a.only_slides?.map((s: string) => slideId(s));
          const res = await batch([{ replaceAllText: { containsText: { text: a.find, matchCase: !!a.match_case }, replaceText: a.replace ?? '', ...(pageObjectIds ? { pageObjectIds } : {}) } }]);
          const n = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          return n ? `Replaced ${n} occurrence${n == 1 ? '' : 's'} of "${a.find}".` : `"${a.find}" wasn't found, nothing changed.`;
        }
        case 'set_text': {
          const el = element();
          if (el.table) {
            if (!a.row || !a.column) throw Error('set_text in a table needs row and column.');
            const cell = el.table.tableRows?.[a.row - 1]?.tableCells?.[a.column - 1];
            if (!cell) throw Error(`The table has no cell at row ${a.row}, column ${a.column}.`);
            await batch(slideSetTextRequests(el.objectId!, a.text ?? '', hasText(cell.text), { row: a.row, col: a.column }));
          }
          else {
            if (!el.shape) throw Error(`${a.element_id} isn't a text box or shape.`);
            await batch(slideSetTextRequests(el.objectId!, a.text ?? '', hasText(el.shape.text)));
          }
          return `Updated the text of ${a.element_id}.`;
        }
        case 'add_text_box': {
          const id = newId('text');
          await batch([
            { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: placement(slideId(), 400, 60) } },
            ...(a.text ? [{ insertText: { objectId: id, insertionIndex: 0, text: a.text } }] : []),
          ]);
          return `Added text box ${id}. ${link}`;
        }
        case 'add_slide': {
          const id = newId('slide');
          const deckLayout = a.layout ? presentation.layouts?.find(l => [l.layoutProperties?.displayName, l.layoutProperties?.name].some(n => n?.toLowerCase() == a.layout.toLowerCase())) : undefined;
          const predefined = ['TITLE', 'TITLE_AND_BODY', 'TITLE_ONLY', 'SECTION_HEADER', 'SECTION_TITLE_AND_DESCRIPTION', 'TITLE_AND_TWO_COLUMNS', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER', 'CAPTION_ONLY', 'BLANK'];
          if (a.layout && !deckLayout && !predefined.includes(a.layout.toUpperCase())) {
            throw Error(`There's no layout "${a.layout}". Deck layouts: ${(presentation.layouts ?? []).map(l => `"${l.layoutProperties?.displayName}"`).join(', ')}`);
          }
          const slides = presentation.slides ?? [];
          const target = a.position ? Math.min(a.position - 1, slides.length) : slides.length;
          // A slide can only be inserted next to slides using its layout's master (decks like the brand guide have
          // several), so it's created after the last slide with that master, then moved where it should go
          let createAt = target;
          if (deckLayout) {
            const layoutMaster = new Map((presentation.layouts ?? []).map(l => [l.objectId, l.layoutProperties?.masterObjectId]));
            const master = deckLayout.layoutProperties?.masterObjectId;
            const sameMaster = slides.map((s, i) => layoutMaster.get(s.slideProperties?.layoutObjectId ?? '') == master ? i : -1).filter(i => i >= 0);
            if (sameMaster.length && !sameMaster.some(i => i == target - 1 || i == target)) createAt = sameMaster[sameMaster.length - 1] + 1;
            else if (!sameMaster.length) createAt = 0;
          }
          await batch([
            { createSlide: { objectId: id, insertionIndex: createAt, slideLayoutReference: deckLayout ? { layoutId: deckLayout.objectId! } : { predefinedLayout: (a.layout ?? 'TITLE_AND_BODY').toUpperCase() } } },
            ...(createAt != target ? [{ updateSlidesPosition: { slideObjectIds: [id], insertionIndex: target > createAt ? target + 1 : target } }] : []),
          ]);
          // Fill the new slide's placeholders by type, whatever the layout calls them
          const notes: string[] = [];
          if (a.title || a.body) {
            const created = (await ws.getPresentation(presentationId)).slides?.find(s => s.objectId == id);
            const placeholder = (types: string[]) => created?.pageElements?.find(e => types.includes(e.shape?.placeholder?.type ?? ''));
            const requests: slides_v1.Schema$Request[] = [];
            const title = placeholder(['TITLE', 'CENTERED_TITLE']);
            const body = placeholder(['BODY', 'SUBTITLE']);
            if (a.title && title) requests.push({ insertText: { objectId: title.objectId!, insertionIndex: 0, text: a.title } });
            if (a.body && body) requests.push({ insertText: { objectId: body.objectId!, insertionIndex: 0, text: a.body } });
            if (a.title && !title) notes.push('title');
            if (a.body && !body) notes.push('body');
            if (requests.length) await batch(requests);
          }
          const missing = notes.length ? ` This layout has no ${notes.join(' or ')} placeholder, so that text wasn't added: add it with add_text_box (check the layout's design with google_view_slide first).` : '';
          return `Added slide ${id}.${missing} ${link}`;
        }
        case 'duplicate_slide': {
          const res = await batch([{ duplicateObject: { objectId: slideId() } }]);
          const copy = res.replies?.[0]?.duplicateObject?.objectId;
          if (copy && a.position) await batch([{ updateSlidesPosition: { slideObjectIds: [copy], insertionIndex: a.position - 1 } }]);
          return `Duplicated slide ${a.slide} as ${copy}. ${link}`;
        }
        case 'move_slide': {
          if (!a.position) throw Error('move_slide needs position.');
          await batch([{ updateSlidesPosition: { slideObjectIds: [slideId()], insertionIndex: a.position - 1 } }]);
          return `Moved slide ${a.slide} to position ${a.position}.`;
        }
        case 'delete_slide': {
          // Several at once in one request (ids are looked up first, so numbers don't shift while deleting)
          const ids: string[] = (a.slides?.length ? a.slides : [a.slide]).map((s: string) => slideId(s));
          await batch(ids.map(objectId => ({ deleteObject: { objectId } })));
          return `Deleted ${ids.length} slide${ids.length == 1 ? '' : 's'}.`;
        }
        case 'delete_element': {
          await batch([{ deleteObject: { objectId: element().objectId! } }]);
          return `Deleted ${a.element_id}.`;
        }
        case 'insert_image': {
          if (!a.image) throw Error('insert_image needs image.');
          const id = newId('image');
          const pageId = slideId();
          const props: slides_v1.Schema$PageElementProperties = a.width || a.height
            ? placement(pageId)
            : { pageObjectId: pageId, ...(a.x != null || a.y != null ? { transform: { scaleX: 1, scaleY: 1, translateX: a.x ?? 0, translateY: a.y ?? 0, unit: 'PT' } } : {}) };
          await withPublicImage(a.image, url => batch([{ createImage: { objectId: id, url, elementProperties: props } }]));
          return `Inserted image ${id} on slide ${a.slide}. Check it with google_view_slide. ${link}`;
        }
        case 'copy_image': {
          if (!a.from_slide || !a.to_slides?.length) throw Error('copy_image needs from_slide and to_slides.');
          const source = a.from_url ? await ws.getPresentation((await ws.getFile(a.from_url)).id!) : presentation;
          const from = findSlide(source, a.from_slide).slide;
          const images = a.element_id
            ? [findElement(from.pageElements ?? undefined, a.element_id)].filter(Boolean) as slides_v1.Schema$PageElement[]
            : (from.pageElements ?? []).filter(e => e.image);
          if (images.length == 0 || images.some(i => !i.image?.contentUrl)) {
            throw Error(a.element_id ? `${a.element_id} isn't an image on that slide.` : 'That slide has no images to copy.');
          }
          // contentUrl is a temporary link (30 minutes, as Sofia) that createImage can copy from
          const requests: slides_v1.Schema$Request[] = a.to_slides.flatMap((s: string) => images.map(img => ({
            createImage: { objectId: newId('image'), url: img.image!.contentUrl!, elementProperties: samePlacement(img, slideId(s)) },
          })));
          await batch(requests);
          return `Copied ${images.length} image${images.length == 1 ? '' : 's'} to ${a.to_slides.length} slide${a.to_slides.length == 1 ? '' : 's'}. Check them with google_view_slide. ${link}`;
        }
        case 'insert_table': {
          if (!a.rows || !a.columns) throw Error('insert_table needs rows and columns.');
          const id = newId('table');
          const requests: slides_v1.Schema$Request[] = [{ createTable: { objectId: id, rows: a.rows, columns: a.columns, elementProperties: placement(slideId(), 640, 40 * a.rows) } }];
          (a.contents ?? []).forEach((row: string[], r: number) => row.forEach((text, c) => {
            if (text && r < a.rows && c < a.columns) requests.push({ insertText: { objectId: id, cellLocation: { rowIndex: r, columnIndex: c }, insertionIndex: 0, text } });
          }));
          await batch(requests);
          return `Inserted table ${id}. ${link}`;
        }
        case 'table_set_cells': {
          const el = element();
          if (!el.table) throw Error(`${a.element_id} isn't a table.`);
          if (!a.cells?.length) throw Error('table_set_cells needs cells.');
          const requests = a.cells.flatMap((c: CellEdit) => {
            const cell = el.table!.tableRows?.[c.row - 1]?.tableCells?.[c.col - 1];
            if (!cell) throw Error(`The table has no cell at row ${c.row}, column ${c.col}.`);
            return slideSetTextRequests(el.objectId!, c.text, hasText(cell.text), { row: c.row, col: c.col });
          });
          await batch(requests);
          return `Updated ${a.cells.length} cell${a.cells.length == 1 ? '' : 's'}.`;
        }
        case 'table_rows': {
          const el = element();
          if (!el.table || !a.operation) throw Error('table_rows needs a table element_id and operation.');
          const cellLocation = { rowIndex: (a.row ?? 1) - 1, columnIndex: 0 };
          await batch(a.operation == 'insert'
            ? [{ insertTableRows: { tableObjectId: el.objectId!, cellLocation, insertBelow: !a.before, number: a.count ?? 1 } }]
            : Array.from({ length: a.count ?? 1 }, () => ({ deleteTableRow: { tableObjectId: el.objectId!, cellLocation } })));
          return `${a.operation == 'insert' ? 'Inserted' : 'Deleted'} ${a.count ?? 1} row(s).`;
        }
        case 'set_notes': {
          const notes = page().slideProperties?.notesPage;
          const id = notes?.notesProperties?.speakerNotesObjectId;
          const shape = notes?.pageElements?.find(e => e.objectId == id);
          if (!id) throw Error("This slide's speaker notes can't be found.");
          await batch(slideSetTextRequests(id, a.text ?? '', hasText(shape?.shape?.text)));
          return `Updated the speaker notes of slide ${a.slide}.`;
        }
      }
      throw Error(`Unknown action ${a.action}.`);
    }
  }, '{url: string, action: string, slide?: string, element_id?: string, ...see the action\'s fields}');

  // ---------- Raw batchUpdate ----------

  const raw = (name: string, label: string, mime: string, docs: string, run: (id: string, requests: object[]) => Promise<any>) => new ExtendedDynamicStructuredTool({
    name,
    description: `Send ${label} API batchUpdate requests directly, for edits the other tools don't cover (${docs}). Read the file's structure first. Requests run in order, all or nothing.`,
    schema: z.object({
      url: fileUrl(label),
      requests_json: z.string().describe('[Required] A JSON array of request objects, e.g. [{"insertText": {...}}].'),
    }),
    func: async (args) => {
      const { url, requests_json } = args as any;
      const file = await editable(url, mime, label);
      const res = await run(file.id!, parseRequests(requests_json));
      return `Done (${(res.replies ?? []).length} replies): ${summary(res.replies)}`;
    }
  }, '{url: string, requests_json: string}');

  const docsBatch = raw('docs_batch_update', 'Google Doc', MIME.doc,
    'e.g. text and paragraph styles, page breaks, headers/footers, named ranges, table cell styles; ranges need tabId in multi-tab Docs; indices shift after each insert, so order edits from the end',
    (documentId, requests) => ws.call(() => api().docs.documents.batchUpdate({ documentId, requestBody: { requests } }), documentId));
  const sheetsBatch = raw('sheets_batch_update', 'Google Sheet', MIME.sheet,
    'e.g. borders, conditional formatting, data validation, charts, sorting, deleting tabs or rows; GridRange uses 0-based indices and the tab id',
    (spreadsheetId, requests) => ws.call(() => api().sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }), spreadsheetId));
  const slidesBatch = raw('slides_batch_update', 'Google Slides deck', MIME.slides,
    'e.g. text styles, shape colours, backgrounds, grouping, table cell styles. Text boxes are createShape with shapeType TEXT_BOX then insertText; delete slides or elements with deleteObject; object ids need 5+ characters; size and transform need a unit (PT or EMU, 12700 per pt)',
    (presentationId, requests) => ws.call(() => api().slides.presentations.batchUpdate({ presentationId, requestBody: { requests } }), presentationId));

  // ---------- Comments ----------

  const comment = new ExtendedDynamicStructuredTool({
    name: 'google_comment',
    description: 'Add a comment to a Google Doc, Sheet or Slides deck, reply to a comment (ids from google_read_comments), or resolve one. In Docs, quote attaches the comment to that text (like highlighting it), and assign_to assigns it to someone. In Sheets and Slides the quote is written into the comment.',
    schema: z.object({
      url: fileUrl(),
      text: z.string().optional().describe('[Required unless only resolving] The comment or reply.'),
      quote: z.string().optional().describe('[Optional] The passage the comment is about.'),
      reply_to: z.string().optional().describe('[Optional] The comment id to reply to.'),
      resolve: z.boolean().optional().describe('[Optional, with reply_to] Resolve the comment.'),
      assign_to: z.string().optional().describe('[Optional, Docs] Email of the person to assign the comment to (a task for them).'),
    }),
    func: async (args) => {
      const { url, text, quote, reply_to, resolve, assign_to } = args as any;
      const file = await ws.getFile(url);
      if (reply_to) {
        await ws.call(() => api().drive.replies.create({
          fileId: file.id!, commentId: reply_to, fields: 'id',
          requestBody: { content: text || (resolve ? 'Resolved.' : ''), ...(resolve ? { action: 'resolve' } : {}) },
        }), file.id!);
        return `${resolve ? 'Resolved' : 'Replied to'} comment ${reply_to} on "${file.name}".`;
      }
      if (!text) throw Error('A new comment needs text.');
      // Docs can attach a comment to a range of text (and assign it), anywhere in any tab
      if (file.mimeType == MIME.doc && (quote || assign_to)) {
        const doc = await ws.getDoc(file.id!);
        for (const tab of docTabs(doc)) {
          const found = quote ? findDocText(tab.body, quote) : { start: 1, end: 2 };
          if (!found) continue;
          const res: any = await ws.call(() => api().docs.documents.batchUpdate({ documentId: file.id!, requestBody: { requests: [{
            insertComment: { range: { startIndex: found.start, endIndex: found.end, ...(tab.id && docTabs(doc).length > 1 ? { tabId: tab.id } : {}) }, content: text, ...(assign_to ? { assigneeEmailAddress: assign_to } : {}) },
          } as any] } }), file.id!);
          const id = res.replies?.[0]?.insertComment?.commentThread?.commentId;
          return `Commented on ${quote ? `"${quote}"` : 'the doc'} in "${file.name}"${assign_to ? `, assigned to ${assign_to}` : ''} (comment ${id}).`;
        }
      }
      const res = await ws.call(() => api().drive.comments.create({ fileId: file.id!, fields: 'id', requestBody: { content: quote ? `On "${quote}": ${text}` : text } }), file.id!);
      return `Commented on "${file.name}" (comment ${res.id}).`;
    }
  }, '{url: string, text?: string, quote?: string, reply_to?: string, resolve?: boolean}');

  return [driveManage, share, docsEdit, sheetsEdit, slidesEdit, docsBatch, sheetsBatch, slidesBatch, comment];
}

