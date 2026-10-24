import { Readable } from 'stream';
import { z } from 'zod';
import { ExtendedDynamicStructuredTool } from '../utils/tool';
import { fetchPublic } from '../utils/safeFetch';
import { googleFileLink } from '../utils/googleUrls';
import { GDG_SHARED_DRIVE_ID } from '../config/googleWorkspace';
import { GoogleWorkspace } from './googleWorkspace';

/**
 * Plain files in Drive (Markdown, HTML, CSV, JSON, code...) edited the way coding agents edit code: read a window of
 * numbered lines, change it with exact find-and-replace edits (each must match once), and refuse to edit a file that
 * changed since it was read. And `fetch_url` for the raw text of a public link, cut off at a limit.
 */

/** Lines shown by a read when no limit is given, and the most text returned at once. */
const READ_LINES = 400;
const READ_MAX_CHARS = 40000;
/** Text files this big or bigger aren't opened. */
const TEXT_MAX_BYTES = 10 * 1024 * 1024;
/** fetch_url downloads at most this much, and returns this much text at once by default (and at most). */
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_DEFAULT_CHARS = 20000;
const FETCH_MAX_CHARS = 40000;

const TEXT_TYPES: { [ext: string]: string } = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', css: 'text/css',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', svg: 'image/svg+xml',
  yaml: 'application/x-yaml', yml: 'application/x-yaml', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python',
  java: 'text/plain', c: 'text/plain', cpp: 'text/plain', sh: 'text/x-sh', sql: 'text/plain', ics: 'text/calendar',
};

/** The mime type for a new file from its name, e.g. notes.md -> text/markdown (plain text if unknown). */
export function textMimeFor(name: string): string {
  return TEXT_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ''] ?? 'text/plain';
}

/** Whether a mime type (or the file name) is text that can be read and edited as lines. */
export function isTextFile(mime: string | null | undefined, name = ''): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('text/') || /json|xml|javascript|yaml|x-sh|svg|csv|markdown/.test(m)) return true;
  // Drive often stores uploaded text files as application/octet-stream, so go by the extension
  return (!m || m == 'application/octet-stream') && (/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '') in TEXT_TYPES;
}

/** Lines `offset`.. (1-based) with numbers, at most `limit` lines and READ_MAX_CHARS characters, saying what's left. */
export function numberLines(text: string, offset = 1, limit = READ_LINES): string {
  const lines = text.split('\n');
  const start = Math.max(1, offset);
  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  for (let i = start - 1; i < Math.min(lines.length, start - 1 + limit); i++) {
    const line = `${String(i + 1).padStart(5)}  ${lines[i]}`;
    if (chars + line.length > READ_MAX_CHARS && out.length) break;
    out.push(line);
    chars += line.length + 1;
    last = i + 1;
  }
  const more = last < lines.length ? `\n[Lines ${start}-${last} of ${lines.length}. Read more with offset ${last + 1}.]` : `\n[Lines ${start}-${last} of ${lines.length}.]`;
  return (out.join('\n') || '(empty)') + more;
}

/** Lines containing `query` (case-insensitive), with numbers, at most 100. */
export function searchLines(text: string, query: string): string {
  const q = query.toLowerCase();
  const hits = text.split('\n').map((line, i) => ({ line, n: i + 1 })).filter(l => l.line.toLowerCase().includes(q));
  if (hits.length == 0) return `No lines contain "${query}".`;
  return hits.slice(0, 100).map(h => `${String(h.n).padStart(5)}  ${h.line.length > 300 ? `${h.line.slice(0, 300)}...` : h.line}`).join('\n') + (hits.length > 100 ? `\n[${hits.length - 100} more matches]` : '');
}

export interface TextEdit { old: string, new: string, replace_all?: boolean }

/**
 * Applies exact find-and-replace edits in order. Each `old` must appear exactly once (unless replace_all), so an edit
 * can't land in the wrong place; otherwise nothing is changed and the error says why.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): { text: string, replaced: number } {
  let result = text;
  let replaced = 0;
  edits.forEach((e, i) => {
    const label = edits.length > 1 ? `Edit ${i + 1}: ` : '';
    if (!e.old) throw Error(`${label}old is empty. To add text at the end use append, to replace everything use write.`);
    if (e.old == e.new) throw Error(`${label}old and new are the same.`);
    const count = result.split(e.old).length - 1;
    if (count == 0) throw Error(`${label}the text to replace wasn't found. Read the file again and copy it exactly (including spaces and line breaks).`);
    if (count > 1 && !e.replace_all) throw Error(`${label}the text to replace appears ${count} times. Include more of the surrounding text so it's unique, or set replace_all.`);
    result = result.split(e.old).join(e.new);
    replaced += e.replace_all ? count : 1;
  });
  return { text: result, replaced };
}

/** A GitHub file page (github.com/owner/repo/blob/branch/path) to its raw file link. Other links stay as they are. */
export function rawGithubUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.trim());
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url.trim();
}

/** The raw text of a public link, from character `start`, at most `maxChars` characters. */
export async function fetchRawText(url: string, { start = 0, maxChars = FETCH_DEFAULT_CHARS }: { start?: number, maxChars?: number } = {}): Promise<string> {
  const target = rawGithubUrl(url);
  const { buffer, contentType, url: finalUrl } = await fetchPublic(target, { maxBytes: FETCH_MAX_BYTES });
  if (!isTextFile(contentType, new URL(finalUrl).pathname) && !/^\s*[[{<#\w]/.test(buffer.subarray(0, 200).toString('utf8'))) {
    throw Error(`${url} isn't a text file (${contentType || 'unknown type'}). For PDFs use read_pdf, for images view_image_url, for web pages web_search/web_extractor.`);
  }
  const text = buffer.toString('utf8');
  const limit = Math.min(Math.max(maxChars, 1000), FETCH_MAX_CHARS);
  const from = Math.max(0, start);
  const part = text.slice(from, from + limit);
  const end = from + part.length;
  const note = end < text.length
    ? `\n\n[Characters ${from}-${end} of ${text.length}. Read more with start ${end}.]`
    : from > 0 ? `\n\n[Characters ${from}-${end} of ${text.length}, the end.]` : '';
  return `${finalUrl} (${contentType || 'text'}, ${text.length} characters)\n\n${part}${note}`;
}

export function createFetchUrlTool(): ExtendedDynamicStructuredTool {
  return new ExtendedDynamicStructuredTool({
    name: 'fetch_url',
    description: `Get the raw text of a public file from a link, exactly as it is: Markdown, code, JSON, CSV, plain text, e.g. a README or spec on GitHub (github.com/.../blob/... links are read as raw files). Long files are cut off at ${FETCH_DEFAULT_CHARS} characters; it says where to continue with start. Not for web pages (use web search) or PDFs (read_pdf).`,
    schema: z.object({
      url: z.string().describe('[Required] The link.'),
      start: z.number().int().min(0).optional().describe('[Optional] Character to start from, to read the rest of a long file.'),
      max_chars: z.number().int().min(1000).max(FETCH_MAX_CHARS).optional().describe(`[Optional] At most this many characters, defaults to ${FETCH_DEFAULT_CHARS}.`),
    }),
    func: async (args) => {
      const { url, start, max_chars } = args as any;
      return fetchRawText(url, { start, maxChars: max_chars });
    }
  }, '{url: string, start?: number, max_chars?: number}');
}

export function createDriveFileTool(ws: GoogleWorkspace): ExtendedDynamicStructuredTool {
  /** File id -> its modifiedTime when Sofia last read or wrote it, to refuse edits on files that changed since. */
  const seen = new Map<string, string>();
  const api = () => ws.api;
  const fields = 'id,name,mimeType,webViewLink,modifiedTime,size,parents';

  const textFile = async (url: string) => {
    const file = await ws.getFile(url);
    if (file.mimeType?.startsWith('application/vnd.google-apps')) {
      throw Error(`"${file.name}" is a Google file, use google_read_file and the docs/sheets/slides tools for it.`);
    }
    if (!isTextFile(file.mimeType, file.name ?? '')) {
      throw Error(`"${file.name}" (${file.mimeType}) isn't a text file. Only text files (Markdown, HTML, CSV, JSON, code...) can be read and edited this way.`);
    }
    return file;
  };
  const download = async (file: Awaited<ReturnType<typeof textFile>>) => (await ws.download(file, TEXT_MAX_BYTES)).toString('utf8');
  const save = async (fileId: string, text: string, mimeType: string) => {
    const f = await ws.call(() => api().drive.files.update({ fileId, media: { mimeType, body: Readable.from(Buffer.from(text, 'utf8')) }, fields, supportsAllDrives: true }), fileId);
    seen.set(fileId, f.modifiedTime ?? '');
    return f;
  };
  /** Refuses to change a file Sofia hasn't read, or that someone changed since she read it. */
  const checkFresh = (file: { id?: string | null, name?: string | null, modifiedTime?: string | null }) => {
    const known = seen.get(file.id!);
    if (known == null) throw Error(`Read "${file.name}" with drive_file read first, so you edit what's really in it.`);
    if (known != file.modifiedTime) throw Error(`"${file.name}" changed since you read it (someone else edited it). Read it again, then redo the edit.`);
  };

  return new ExtendedDynamicStructuredTool({
    name: 'drive_file',
    description: 'Create, read and edit plain files in Google Drive: Markdown, HTML, CSV, JSON, YAML, code, text. read shows numbered lines (long files a window at a time: offset/limit, or search for lines). edit changes the file with exact find-and-replace edits, copy "old" exactly from what you read (it must appear once, include more context or set replace_all). write creates a new file (or replaces a whole file), append adds to the end. Read before editing; an edit is refused if the file changed since you read it. Not for Google Docs/Sheets/Slides (use their tools).',
    schema: z.object({
      action: z.enum(['read', 'edit', 'write', 'append']).describe('[Required]'),
      url: z.string().optional().describe("[read, edit, append; write to replace a file] The file's link or id."),
      offset: z.number().int().min(1).optional().describe('[Optional for read] First line to show, defaults to 1.'),
      limit: z.number().int().min(1).optional().describe(`[Optional for read] Lines to show, defaults to ${READ_LINES}.`),
      search: z.string().optional().describe('[Optional for read] Only show lines containing this.'),
      edits: z.array(z.object({
        old: z.string().describe('Exact text to replace, copied from the file'),
        new: z.string().describe('The replacement'),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      })).optional().describe('[edit] Replacements, applied in order.'),
      name: z.string().optional().describe('[write a new file] The file name with its extension, e.g. "agenda.md".'),
      folder: z.string().optional().describe('[Optional for write] The folder for a new file, defaults to the GDG shared drive or your own Drive.'),
      content: z.string().optional().describe('[write, append] The text.'),
    }),
    func: async (args) => {
      const { action, url, offset, limit, search, edits, name, folder, content } = args as any;
      if (action == 'write' && !url) {
        if (!name || content == null) throw Error('write needs name and content (or url to replace a file).');
        const parent = folder ? (await ws.getFile(folder)).id! : GDG_SHARED_DRIVE_ID ?? 'root';
        const mimeType = textMimeFor(name);
        // mimeType on the file too, so Drive keeps it as a plain file instead of converting it
        const f = await ws.call(() => api().drive.files.create({ requestBody: { name, mimeType, parents: [parent] }, media: { mimeType, body: Readable.from(Buffer.from(content, 'utf8')) }, fields, supportsAllDrives: true }));
        seen.set(f.id!, f.modifiedTime ?? '');
        return `Created "${f.name}" (${mimeType}, ${content.split('\n').length} lines): ${f.webViewLink ?? googleFileLink(f.id!, f.mimeType)}`;
      }
      if (!url) throw Error(`${action} needs the file's link.`);
      const file = await textFile(url);
      const id = file.id!;
      switch (action) {
        case 'read': {
          const text = await download(file);
          seen.set(id, file.modifiedTime ?? '');
          const header = `"${file.name}" (${file.mimeType}, ${text.length} characters) ${file.webViewLink ?? ''}\n\n`;
          return header + (search ? searchLines(text, search) : numberLines(text, offset, limit));
        }
        case 'edit': {
          if (!edits?.length) throw Error('edit needs edits: [{old, new}].');
          checkFresh(file);
          const { text, replaced } = applyTextEdits(await download(file), edits);
          await save(id, text, file.mimeType!);
          return `Edited "${file.name}": ${replaced} replacement${replaced == 1 ? '' : 's'}.`;
        }
        case 'write': {
          if (content == null) throw Error('write needs content.');
          checkFresh(file);
          await save(id, content, file.mimeType!);
          return `Replaced the content of "${file.name}" (${content.split('\n').length} lines).`;
        }
        case 'append': {
          if (!content) throw Error('append needs content.');
          checkFresh(file);
          const text = await download(file);
          await save(id, text + (text && !text.endsWith('\n') ? '\n' : '') + content, file.mimeType!);
          return `Added ${content.split('\n').length} line${content.split('\n').length == 1 ? '' : 's'} to "${file.name}".`;
        }
      }
      throw Error(`Unknown action ${action}.`);
    }
  }, '{action: "read" | "edit" | "write" | "append", url?: string, offset?: number, limit?: number, search?: string, edits?: {old, new, replace_all?}[], name?: string, folder?: string, content?: string}');
}
