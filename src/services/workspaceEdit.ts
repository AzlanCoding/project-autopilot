import type { docs_v1, sheets_v4, slides_v1 } from 'googleapis';
import { parseA1Cell } from './workspaceFormat';

/**
 * Builds Docs, Sheets and Slides `batchUpdate` requests for the edits that are easy to get wrong by hand: Docs edits are
 * by character index, and every insert or delete moves the indices after it, so requests touching several places are
 * ordered from the end of the document backwards.
 */

type DocsRequest = docs_v1.Schema$Request;

// ---------- Markdown to Docs ----------

interface Span { start: number, end: number, bold?: boolean, italic?: boolean, link?: string }
interface MdParagraph { text: string, spans: Span[], heading?: number, bullet?: 'BULLET' | 'NUMBERED', level: number }

/** Inline Markdown (`**bold**`, `*italic*` / `_italic_`, `[text](url)`) to plain text and styled spans. */
export function parseInlineMarkdown(input: string): { text: string, spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<!\w)_(?!\s)(.+?)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of input.matchAll(pattern)) {
    text += input.slice(last, m.index);
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4];
    const start = text.length;
    text += inner;
    spans.push(m[1] != null ? { start, end: text.length, bold: true } : m[5] ? { start, end: text.length, link: m[5] } : { start, end: text.length, italic: true });
    last = m.index! + m[0].length;
  }
  text += input.slice(last);
  return { text, spans };
}

/** Block Markdown: headings, `-`/`*` bullets and `1.` numbered items (indent 2 spaces per level), paragraphs. */
export function parseMarkdownBlocks(markdown: string): MdParagraph[] {
  const paragraphs: MdParagraph[] = [];
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim());
    const bullet = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (heading) {
      paragraphs.push({ ...parseInlineMarkdown(heading[2]), heading: heading[1].length, level: 0 });
    }
    else if (bullet) {
      const level = Math.min(8, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2));
      paragraphs.push({ ...parseInlineMarkdown(bullet[3]), bullet: /\d/.test(bullet[2]) ? 'NUMBERED' : 'BULLET', level });
    }
    else {
      paragraphs.push({ ...parseInlineMarkdown(raw.trim()), level: 0 });
    }
  }
  return paragraphs;
}

/**
 * Requests that insert Markdown at `index` in a Doc tab and format it. `mode`:
 * - `paragraph`: `index` is the start of a paragraph, the new paragraphs go before it;
 * - `end`: `index` is the end of the body (its last index), the new paragraphs go after the last paragraph.
 * The inserted text is first reset to normal text without bullets or styles, so it doesn't take the style of where it's
 * inserted (e.g. a heading or a list).
 */
export function markdownToDocsRequests(markdown: string, index: number, mode: 'paragraph' | 'end', tabId?: string): DocsRequest[] {
  const paragraphs = parseMarkdownBlocks(markdown);
  if (paragraphs.length == 0) {
    return [];
  }
  // Nested bullets start with tabs, which createParagraphBullets turns into the nesting level (and removes)
  const lines = paragraphs.map(p => '\t'.repeat(p.bullet ? p.level : 0) + p.text);
  const insertAt = mode == 'end' ? index - 1 : index;
  const text = mode == 'end' ? `\n${lines.join('\n')}` : `${lines.join('\n')}\n`;
  const first = insertAt + (mode == 'end' ? 1 : 0);
  const range = (start: number, end: number): docs_v1.Schema$Range => ({ startIndex: start, endIndex: end, ...(tabId ? { tabId } : {}) });
  const location = { index: insertAt, ...(tabId ? { tabId } : {}) };

  const requests: DocsRequest[] = [{ insertText: { location, text } }];
  const whole = range(first, first + lines.join('\n').length + 1);
  requests.push(
    { updateParagraphStyle: { range: whole, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { deleteParagraphBullets: { range: whole } },
    { updateTextStyle: { range: whole, textStyle: { bold: false, italic: false }, fields: 'bold,italic,link' } },
  );

  // Where each paragraph starts, and the bullet groups (consecutive items of the same kind)
  const starts: number[] = [];
  let at = first;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  paragraphs.forEach((p, i) => {
    const textStart = starts[i] + (p.bullet ? p.level : 0);
    if (p.heading) {
      requests.push({ updateParagraphStyle: { range: range(starts[i], starts[i] + lines[i].length + 1), paragraphStyle: { namedStyleType: `HEADING_${Math.min(p.heading, 6)}` }, fields: 'namedStyleType' } });
    }
    for (const s of p.spans) {
      const r = range(textStart + s.start, textStart + s.end);
      if (s.bold) requests.push({ updateTextStyle: { range: r, textStyle: { bold: true }, fields: 'bold' } });
      if (s.italic) requests.push({ updateTextStyle: { range: r, textStyle: { italic: true }, fields: 'italic' } });
      if (s.link) requests.push({ updateTextStyle: { range: r, textStyle: { link: { url: s.link } }, fields: 'link' } });
    }
  });
  const groups: { start: number, end: number, kind: 'BULLET' | 'NUMBERED' }[] = [];
  paragraphs.forEach((p, i) => {
    if (!p.bullet) return;
    const end = starts[i] + lines[i].length + 1;
    const prev = groups[groups.length - 1];
    if (prev && prev.kind == p.bullet && prev.end == starts[i]) prev.end = end;
    else groups.push({ start: starts[i], end, kind: p.bullet });
  });
  // Last, from the end backwards: each one removes its tabs, which moves only the text after it
  for (const g of groups.reverse()) {
    requests.push({ createParagraphBullets: { range: range(g.start, g.end), bulletPreset: g.kind == 'NUMBERED' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE' } });
  }
  return requests;
}

// ---------- Docs tables ----------

/** A table cell's text range: from its first paragraph to before its last newline (empty when start == end). */
export function docCellRange(cell: docs_v1.Schema$TableCell): { start: number, end: number } {
  const content = cell.content ?? [];
  const start = content[0]?.startIndex ?? (cell.startIndex ?? 0) + 1;
  const end = (content[content.length - 1]?.endIndex ?? start + 1) - 1;
  return { start, end };
}

export interface CellEdit { row: number, col: number, text: string }

/** Requests that set the text of Doc table cells (1-based rows and columns), applied from the last cell backwards. */
export function docTableCellRequests(table: docs_v1.Schema$Table, cells: CellEdit[], tabId?: string): DocsRequest[] {
  const targets = cells.map(c => {
    const cell = table.tableRows?.[c.row - 1]?.tableCells?.[c.col - 1];
    if (!cell) {
      throw Error(`The table has no cell at row ${c.row}, column ${c.col} (it has ${table.rows} rows and ${table.columns} columns).`);
    }
    return { ...docCellRange(cell), text: c.text };
  }).sort((a, b) => b.start - a.start);
  const requests: DocsRequest[] = [];
  for (const t of targets) {
    if (t.end > t.start) {
      requests.push({ deleteContentRange: { range: { startIndex: t.start, endIndex: t.end, ...(tabId ? { tabId } : {}) } } });
    }
    if (t.text) {
      requests.push({ insertText: { location: { index: t.start, ...(tabId ? { tabId } : {}) }, text: t.text } });
    }
  }
  return requests;
}

// ---------- Sheets ----------

/** An A1 range in a tab (`B2:D5`, `A1`, `A:C`, `2:4`) as a GridRange. */
export function a1ToGridRange(range: string, sheetId: number): sheets_v4.Schema$GridRange {
  const clean = range.trim().replace(/^.*!/, '').replace(/\$/g, '');
  const [from, to = from] = clean.split(':');
  const part = (ref: string) => {
    if (/^[A-Z]+$/i.test(ref)) return { col: parseA1Cell(`${ref}1`).col };
    if (/^\d+$/.test(ref)) return { row: Number(ref) - 1 };
    return parseA1Cell(ref);
  };
  const a = part(from), b = part(to);
  const grid: sheets_v4.Schema$GridRange = { sheetId };
  if (a.row != null && b.row != null) Object.assign(grid, { startRowIndex: Math.min(a.row, b.row), endRowIndex: Math.max(a.row, b.row) + 1 });
  if (a.col != null && b.col != null) Object.assign(grid, { startColumnIndex: Math.min(a.col, b.col), endColumnIndex: Math.max(a.col, b.col) + 1 });
  return grid;
}

/** `#RRGGBB` to a Sheets/Slides colour. */
export function hexColor(hex: string): sheets_v4.Schema$Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    throw Error(`"${hex}" isn't a colour like #4285F4.`);
  }
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

export interface CellFormat {
  bold?: boolean, italic?: boolean, font_size?: number, text_color?: string, background?: string,
  number_format?: string, align?: 'LEFT' | 'CENTER' | 'RIGHT', wrap?: boolean,
}

/** A repeatCell request applying only the given formatting to a range. */
export function sheetFormatRequest(grid: sheets_v4.Schema$GridRange, f: CellFormat): sheets_v4.Schema$Request {
  const format: sheets_v4.Schema$CellFormat = {};
  const fields: string[] = [];
  const text: sheets_v4.Schema$TextFormat = {};
  if (f.bold != null) { text.bold = f.bold; fields.push('userEnteredFormat.textFormat.bold'); }
  if (f.italic != null) { text.italic = f.italic; fields.push('userEnteredFormat.textFormat.italic'); }
  if (f.font_size != null) { text.fontSize = f.font_size; fields.push('userEnteredFormat.textFormat.fontSize'); }
  if (f.text_color) { text.foregroundColor = hexColor(f.text_color); fields.push('userEnteredFormat.textFormat.foregroundColor'); }
  if (Object.keys(text).length) format.textFormat = text;
  if (f.background) { format.backgroundColor = hexColor(f.background); fields.push('userEnteredFormat.backgroundColor'); }
  if (f.number_format) { format.numberFormat = { type: 'NUMBER', pattern: f.number_format }; fields.push('userEnteredFormat.numberFormat'); }
  if (f.align) { format.horizontalAlignment = f.align; fields.push('userEnteredFormat.horizontalAlignment'); }
  if (f.wrap != null) { format.wrapStrategy = f.wrap ? 'WRAP' : 'OVERFLOW_CELL'; fields.push('userEnteredFormat.wrapStrategy'); }
  if (fields.length == 0) {
    throw Error('Give at least one format: bold, italic, font_size, text_color, background, number_format, align or wrap.');
  }
  return { repeatCell: { range: grid, cell: { userEnteredFormat: format }, fields: fields.join(',') } };
}

/** A formula showing an image in a cell (Sheets has no API to place images over cells). */
export function imageFormula(url: string): string {
  return `=IMAGE("${url.replace(/"/g, '""')}")`;
}

// ---------- Slides ----------

const pt = (magnitude: number): slides_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

/** Element properties placing something on a slide at `x`,`y` with size `width`x`height` (points). */
export function slidePlacement(pageObjectId: string, x: number, y: number, width: number, height: number): slides_v1.Schema$PageElementProperties {
  return {
    pageObjectId,
    size: { width: pt(width), height: pt(height) },
    transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' },
  };
}

/** Copies an element's size and transform onto another slide, so a copied image lands in the same place. */
export function samePlacement(source: slides_v1.Schema$PageElement, pageObjectId: string): slides_v1.Schema$PageElementProperties {
  return { pageObjectId, size: source.size ?? undefined, transform: source.transform ?? undefined };
}

/** Finds an element on a page by id, including inside groups. */
export function findElement(elements: slides_v1.Schema$PageElement[] | undefined, id: string): slides_v1.Schema$PageElement | undefined {
  for (const el of elements ?? []) {
    if (el.objectId == id) return el;
    const inGroup = findElement(el.elementGroup?.children ?? undefined, id);
    if (inGroup) return inGroup;
  }
  return undefined;
}

/** Requests replacing all text of a shape, a table cell (1-based) or speaker notes. */
export function slideSetTextRequests(objectId: string, text: string, hasText: boolean, cell?: { row: number, col: number }): slides_v1.Schema$Request[] {
  const cellLocation = cell ? { rowIndex: cell.row - 1, columnIndex: cell.col - 1 } : undefined;
  const requests: slides_v1.Schema$Request[] = [];
  if (hasText) {
    requests.push({ deleteText: { objectId, ...(cellLocation ? { cellLocation } : {}), textRange: { type: 'ALL' } } });
  }
  if (text) {
    requests.push({ insertText: { objectId, ...(cellLocation ? { cellLocation } : {}), insertionIndex: 0, text } });
  }
  return requests;
}

/** Parses a JSON list of batchUpdate requests from Sofia, with errors she can act on. */
export function parseRequests(json: string): object[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  }
  catch (e: any) {
    throw Error(`requests_json isn't valid JSON: ${e.message}`);
  }
  const requests = Array.isArray(parsed) ? parsed : parsed?.requests;
  if (!Array.isArray(requests) || requests.length == 0 || requests.some(r => !r || typeof r != 'object' || Array.isArray(r))) {
    throw Error('requests_json must be a JSON array of request objects, e.g. [{"insertText": {...}}].');
  }
  return requests;
}
