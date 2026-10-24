import { z } from 'zod';
import { ExtendedDynamicStructuredTool, ToolImageResult } from '../utils/tool';
import { toModelImage } from '../utils/media';
import { readPdfText } from '../utils/pdf';
import { fetchPublic } from '../utils/safeFetch';
import { GoogleWorkspace, MIME } from './googleWorkspace';
import { searchImages } from './imageSearch';
import { capText, sheetTabs, slidesText } from './workspaceFormat';

const url = (what = 'file') => z.string().describe(`[Required] The ${what}'s link (or file id), e.g. https://docs.google.com/document/d/<id>/edit`);

/** Images are viewed up to this size, GIFs show their first frame. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Downloads an image from a public URL and shows it to the model. */
export async function viewImageUrl(link: string): Promise<ToolImageResult> {
  const { buffer, contentType } = await fetchPublic(link, { maxBytes: IMAGE_MAX_BYTES });
  if (!contentType.startsWith('image/') && !/\.(png|jpe?g|gif|webp)(\?|$)/i.test(link)) {
    throw Error(`${link} isn't an image (${contentType || 'unknown type'}). Use a direct link to the image file.`);
  }
  const image = await toModelImage(buffer, contentType || 'image/*').catch(() => {
    throw Error(`${link} couldn't be read as an image.`);
  });
  return {
    text: `The image is attached in the next message (${image.width}x${image.height}${image.animated ? ', animated, you only see the first frame' : ''}, ${contentType || 'image'}).`,
    image,
  };
}

/** Tools for reading Sofia's Google Workspace files, plus image search. Only added when Workspace is signed in. */
export function createWorkspaceReadTools(ws: GoogleWorkspace): ExtendedDynamicStructuredTool[] {
  const readFile = new ExtendedDynamicStructuredTool({
    name: 'google_read_file',
    description: 'Read a Google Doc (as Markdown, every tab), Sheet (its tabs and first rows), Slides deck (each slide\'s text and speaker notes), Drive folder (its files), PDF or image in Drive, or a .docx/.xlsx/.pptx file (through a temporary Google copy). Use the structure tools (`docs_read_structure`, `sheets_read`, `slides_read`) before editing.',
    schema: z.object({
      url: url(),
      tab: z.string().optional().describe('[Optional] Docs only: the tab title or id to read. Defaults to every tab.'),
    }),
    func: async (args): Promise<string | ToolImageResult> => {
      const { url, tab } = args as any;
      const file = await ws.getFile(url);
      if (file.mimeType == MIME.doc && tab) {
        return `${ws.header(file)}\n\n${capText(await ws.readDoc(file.id!, tab), 'Read one tab at a time.')}`;
      }
      const { text } = await ws.readFile({ ...file.ref, id: file.id! });
      if (text != null) {
        return `${ws.header(file)}\n\n${text}`;
      }
      if (file.mimeType == MIME.pdf) {
        const pdf = await readPdfText(await ws.download(file));
        return `${ws.header(file)}\n${pdf.pageCount} pages\n\n${pdf.text}${pdf.scanned ? '\n\n[Little or no text, probably scanned. Use `view_pdf_page` to look at pages.]' : ''}`;
      }
      if (file.mimeType?.startsWith('image/')) {
        const image = await toModelImage(await ws.download(file, IMAGE_MAX_BYTES), file.mimeType);
        return { text: `${ws.header(file)}\nThe image is attached in the next message.`, image };
      }
      return `${ws.header(file)}\n\nThis type of file can't be read, only its details above.`;
    }
  }, '{url: string, tab?: string}');

  const docsStructure = new ExtendedDynamicStructuredTool({
    name: 'docs_read_structure',
    description: "A Google Doc's structure for editing: every paragraph with its style and character range [start-end], every table (numbered from 1) with each cell's text and the index its text starts at (c2@145), and images. Read this before editing tables or using `docs_batch_update`, and again after each edit (indices change).",
    schema: z.object({
      url: url('Doc'),
      tab: z.string().optional().describe('[Optional] The tab title or id. Defaults to the link\'s tab or the first tab.'),
    }),
    func: async (args) => {
      const { url, tab } = args as any;
      const file = await ws.getFile(url);
      if (file.mimeType != MIME.doc) {
        throw Error(`"${file.name}" is a ${file.mimeType}, not a Google Doc.${file.mimeType == MIME.docx ? ' Convert it to a Google Doc first (drive_manage convert).' : ''}`);
      }
      return `${ws.header(file)}\n\n${capText(await ws.readDocStructure(file.id!, tab ?? file.ref.tabId), 'Read one tab at a time.')}`;
    }
  }, '{url: string, tab?: string}');

  const sheetsRead = new ExtendedDynamicStructuredTool({
    name: 'sheets_read',
    description: "Read a Google Sheet's tab as a grid with column letters and row numbers. Merged cells show as <merged> and are listed under the grid. Lists every tab (name, id, size, merged ranges) too.",
    schema: z.object({
      url: url('Sheet'),
      tab: z.string().optional().describe("[Optional] Tab name, id (the gid in the link) or position (1 = first). Defaults to the link's tab or the first tab."),
      range: z.string().optional().describe('[Optional] Cells to read in the tab, e.g. "A1:F30". Defaults to all filled cells.'),
      formulas: z.boolean().optional().describe('[Optional] Also show each formula next to its value.'),
    }),
    func: async (args) => {
      const { url, tab, range, formulas = false } = args as any;
      const file = await ws.getFile(url);
      if (file.mimeType != MIME.sheet) {
        throw Error(`"${file.name}" is a ${file.mimeType}, not a Google Sheet.${file.mimeType == MIME.xlsx ? ' Convert it to a Google Sheet first (drive_manage convert).' : ''}`);
      }
      const spreadsheet = await ws.getSpreadsheet(file.id!);
      const sheet = ws.pickSheet(spreadsheet, tab, file.ref.gid);
      const grid = await ws.readSheetRange(file.id!, sheet, range, formulas);
      return `${ws.header(file)}\n\nTabs:\n${sheetTabs(spreadsheet)}\n\n===== Tab "${sheet.properties?.title}"${range ? ` ${range}` : ''} =====\n${capText(grid, 'Read a smaller range.')}`;
    }
  }, '{url: string, tab?: string, range?: string, formulas?: boolean}');

  const slidesRead = new ExtendedDynamicStructuredTool({
    name: 'slides_read',
    description: 'A Google Slides deck\'s structure for editing: each slide\'s id and layout, and every element on it (id, type, position and size in points, text, table cells, images), plus speaker notes. Read this before `slides_edit` or `slides_batch_update`.',
    schema: z.object({
      url: url('deck'),
      slide: z.number().int().min(1).optional().describe('[Optional] Only this slide (1 = first).'),
    }),
    func: async (args) => {
      const { url, slide } = args as any;
      const file = await ws.getFile(url);
      if (file.mimeType != MIME.slides) {
        throw Error(`"${file.name}" is a ${file.mimeType}, not a Google Slides deck.${file.mimeType == MIME.pptx ? ' Convert it to Google Slides first (drive_manage convert).' : ''}`);
      }
      return `${ws.header(file)}\n\n${capText(slidesText(await ws.getPresentation(file.id!), { detail: true, only: slide }), 'Read one slide at a time.')}`;
    }
  }, '{url: string, slide?: number}');

  const viewSlide = new ExtendedDynamicStructuredTool({
    name: 'google_view_slide',
    description: 'See a slide of a Google Slides deck as an image, e.g. to check how it looks after editing or to find the branding to copy.',
    schema: z.object({
      url: url('deck'),
      slide: z.string().describe('[Required] The slide number (1 = first) or the slide id.'),
    }),
    func: async (args): Promise<ToolImageResult> => {
      const { url, slide } = args as any;
      const file = await ws.getFile(url);
      const { buffer, number } = await ws.slideImage(file.id!, slide);
      return { text: `Slide ${number} of "${file.name}" is attached in the next message.`, image: await toModelImage(buffer, 'image/png') };
    }
  }, '{url: string, slide: string}');

  const viewImage = new ExtendedDynamicStructuredTool({
    name: 'view_image_url',
    description: 'See an image from a public link, e.g. an `image_search` result, to check it fits before inserting it.',
    schema: z.object({ url: z.string().describe('[Required] A direct link to the image (PNG, JPEG, GIF or WebP).') }),
    func: async (args) => viewImageUrl((args as any).url),
  }, '{url: string}');

  const readComments = new ExtendedDynamicStructuredTool({
    name: 'google_read_comments',
    description: 'Read the comments on a Google Doc, Sheet or Slides deck: who wrote them, the text they comment on, and the replies.',
    schema: z.object({
      url: url(),
      include_resolved: z.boolean().optional().describe('[Optional] Also show resolved comments.'),
    }),
    func: async (args) => {
      const { url, include_resolved = false } = args as any;
      const file = await ws.getFile(url);
      return `Comments on "${file.name}":\n\n${await ws.comments(file.id!, include_resolved)}`;
    }
  }, '{url: string, include_resolved?: boolean}');

  const search = new ExtendedDynamicStructuredTool({
    name: 'drive_search',
    description: "Find files in Google Drive by name or contents, across the GDG shared drive, your own Drive and files shared with you. Returns each file's name, type, last change and link.",
    schema: z.object({
      query: z.string().min(1).describe('[Required] Words in the file name or contents.'),
      kind: z.enum(['doc', 'sheet', 'slides', 'folder', 'pdf']).optional().describe('[Optional] Only this type of file.'),
      folder: z.string().optional().describe('[Optional] Only inside this folder (its link or id).'),
    }),
    func: async (args) => {
      const { query, kind, folder } = args as any;
      return ws.search(query, { kind, folderId: folder ? (await ws.getFile(folder)).id! : undefined });
    }
  }, '{query: string, kind?: "doc" | "sheet" | "slides" | "folder" | "pdf", folder?: string}');

  const imageSearch = new ExtendedDynamicStructuredTool({
    name: 'image_search',
    description: 'Search the web for images or GIFs (add "gif" to the query) to put in Slides, Docs or Sheets. Returns titles and direct image links. Look at a result with `view_image_url` before inserting it.',
    schema: z.object({
      query: z.string().min(1).describe('[Required] What the image should show, e.g. "Google Developer Groups logo" or "celebration confetti gif".'),
      count: z.number().int().min(1).max(15).optional().describe('[Optional] Number of results, defaults to 8.'),
    }),
    func: async (args) => {
      const { query, count = 8 } = args as any;
      const results = await searchImages(query, count);
      return results.length ? results.map((r, i) => `${i + 1}. ${r.title || '(no title)'}\n   ${r.url}`).join('\n') : `No images found for "${query}". Try other words.`;
    }
  }, '{query: string, count?: number}');

  const directory = new ExtendedDynamicStructuredTool({
    name: 'directory_search',
    description: "Find people in the nyp-gdg.com Google Workspace directory with their email, to share files with the right person instead of guessing their email. Without a query, lists everyone.",
    schema: z.object({ query: z.string().optional().describe('[Optional] A name or email to search for.') }),
    func: async (args) => ws.directory((args as any).query),
  }, '{query?: string}');

  return [readFile, docsStructure, sheetsRead, slidesRead, viewSlide, viewImage, readComments, search, imageSearch, directory];
}

