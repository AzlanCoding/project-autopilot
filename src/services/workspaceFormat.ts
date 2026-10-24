import type { docs_v1, drive_v3, sheets_v4, slides_v1 } from 'googleapis';

/**
 * Turns Docs, Sheets, Slides and Drive API responses into text for Sofia. Each has a readable form (Markdown, a grid) and
 * a structure form with the ids and positions that edits need (Docs character indices, Slides element ids).
 */

/** Text returned by a read at once, about 10k tokens. Longer output is cut off with a hint to read part of it. */
export const READ_MAX_CHARS = 40000;

export function capText(text: string, hint: string, max = READ_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[Cut off after ${max} of ${text.length} characters. ${hint}]` : text;
}

const quote = (text: string) => JSON.stringify(text);

// ---------- Docs ----------

type StructuralElement = docs_v1.Schema$StructuralElement;

/** A Doc's tabs in order (child tabs after their parent), each with its body. Docs without tabs have one. */
export function docTabs(doc: docs_v1.Schema$Document): { id: string, title: string, level: number, body: StructuralElement[], inlineObjects: docs_v1.Schema$DocumentTab['inlineObjects'] }[] {
  const tabs: ReturnType<typeof docTabs> = [];
  const walk = (list: docs_v1.Schema$Tab[] | undefined, level: number) => {
    for (const tab of list ?? []) {
      tabs.push({
        id: tab.tabProperties?.tabId ?? '',
        title: tab.tabProperties?.title ?? 'Tab',
        level,
        body: tab.documentTab?.body?.content ?? [],
        inlineObjects: tab.documentTab?.inlineObjects,
      });
      walk(tab.childTabs ?? undefined, level + 1);
    }
  };
  walk(doc.tabs ?? undefined, 0);
  if (tabs.length == 0) {
    tabs.push({ id: '', title: doc.title ?? 'Document', level: 0, body: doc.body?.content ?? [], inlineObjects: doc.inlineObjects });
  }
  return tabs;
}

/** A paragraph's text, with links as Markdown links and images as `[image]`. */
function paragraphText(p: docs_v1.Schema$Paragraph, { links = true, images = true } = {}): string {
  return (p.elements ?? []).map(e => {
    if (e.inlineObjectElement) return images ? '[image]' : '';
    const content = e.textRun?.content ?? '';
    const url = e.textRun?.textStyle?.link?.url;
    return links && url && content.trim() ? `[${content.replace(/\n$/, '')}](${url})${content.endsWith('\n') ? '\n' : ''}` : content;
  }).join('').replace(/\n$/, '');
}

const HEADING_MARKS: { [style: string]: string } = {
  TITLE: '#', SUBTITLE: '##', HEADING_1: '#', HEADING_2: '##', HEADING_3: '###', HEADING_4: '####', HEADING_5: '#####', HEADING_6: '######',
};

function cellText(cell: docs_v1.Schema$TableCell): string {
  return (cell.content ?? []).filter(c => c.paragraph).map(c => paragraphText(c.paragraph!)).filter(t => t.trim()).join(' / ');
}

/** A Doc tab's body as Markdown (headings, lists, links, tables). */
export function docToMarkdown(body: StructuralElement[]): string {
  const lines: string[] = [];
  for (const el of body) {
    if (el.paragraph) {
      const text = paragraphText(el.paragraph);
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? '';
      if (el.paragraph.bullet) {
        lines.push(`${'  '.repeat(el.paragraph.bullet.nestingLevel ?? 0)}- ${text}`);
      }
      else if (HEADING_MARKS[style] && text.trim()) {
        lines.push('', `${HEADING_MARKS[style]} ${text}`, '');
      }
      else {
        lines.push(text);
      }
    }
    else if (el.table) {
      const rows = (el.table.tableRows ?? []).map(r => `| ${(r.tableCells ?? []).map(c => cellText(c).replace(/\|/g, '\\|')).join(' | ')} |`);
      if (rows.length) {
        rows.splice(1, 0, `|${' --- |'.repeat(el.table.columns ?? 1)}`);
      }
      lines.push('', ...rows, '');
    }
    else if (el.tableOfContents) {
      lines.push('[table of contents]');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The tables in a Doc tab's body, in order (tables inside tables aren't counted). */
export function docTables(body: StructuralElement[]): { table: docs_v1.Schema$Table, startIndex: number, endIndex: number }[] {
  return body.filter(el => el.table).map(el => ({ table: el.table!, startIndex: el.startIndex ?? 0, endIndex: el.endIndex ?? 0 }));
}

/**
 * A Doc tab's structure: each paragraph with its style and character range, each table (numbered from 1) with every cell's
 * text and the index where its text starts, and images. This is what `docs_edit` and `docs_batch_update` refer to.
 */
export function docStructure(body: StructuralElement[], inlineObjects?: docs_v1.Schema$DocumentTab['inlineObjects']): string {
  const lines: string[] = [];
  let tableNumber = 0;
  for (const el of body) {
    const range = `[${el.startIndex ?? 0}-${el.endIndex ?? 0}]`;
    if (el.paragraph) {
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
      const kind = el.paragraph.bullet ? `BULLET${el.paragraph.bullet.nestingLevel ? ` level ${el.paragraph.bullet.nestingLevel + 1}` : ''}` : style == 'NORMAL_TEXT' ? 'P' : style;
      // Images are listed on their own lines with their index
      const text = paragraphText(el.paragraph, { links: false, images: false });
      for (const e of el.paragraph.elements ?? []) {
        if (e.inlineObjectElement?.inlineObjectId) {
          const size = inlineObjects?.[e.inlineObjectElement.inlineObjectId]?.inlineObjectProperties?.embeddedObject?.size;
          const dims = size?.width?.magnitude ? ` ${Math.round(size.width.magnitude)}x${Math.round(size.height?.magnitude ?? 0)}pt` : '';
          lines.push(`[${e.startIndex}] IMAGE ${e.inlineObjectElement.inlineObjectId}${dims}`);
        }
      }
      if (text.trim() || !el.paragraph.elements?.some(e => e.inlineObjectElement)) {
        lines.push(`${range} ${kind} ${quote(text)}`);
      }
    }
    else if (el.table) {
      tableNumber++;
      lines.push(`${range} TABLE ${tableNumber} (${el.table.rows} rows x ${el.table.columns} columns)`);
      (el.table.tableRows ?? []).forEach((row, r) => {
        const cells = (row.tableCells ?? []).map((cell, c) => `c${c + 1}@${cell.content?.[0]?.startIndex ?? cell.startIndex} ${quote(cellText(cell))}`);
        lines.push(`  row ${r + 1}: ${cells.join(' | ')}`);
      });
    }
    else if (el.sectionBreak && el.startIndex) {
      lines.push(`${range} SECTION BREAK`);
    }
    else if (el.tableOfContents) {
      lines.push(`${range} TABLE OF CONTENTS`);
    }
  }
  return lines.join('\n');
}

// ---------- Sheets ----------

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

export function a1(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

export function gridRangeA1(r: sheets_v4.Schema$GridRange): string {
  const start = a1(r.startRowIndex ?? 0, r.startColumnIndex ?? 0);
  const end = a1((r.endRowIndex ?? 1) - 1, (r.endColumnIndex ?? 1) - 1);
  return start == end ? start : `${start}:${end}`;
}

/** Parses `B3` (0-based row and column) */
export function parseA1Cell(cell: string): { row: number, col: number } {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(cell.trim());
  if (!m) {
    throw Error(`"${cell}" isn't a cell like B3.`);
  }
  const col = m[1].toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(m[2]) - 1, col };
}

/**
 * A block of cells as a table with column letters and row numbers. `values` start at (`startRow`, `startCol`), 0-based.
 * Cells covered by a merge (other than its top-left cell) show `<merged>`, merged ranges are listed under the table.
 * `formulas` (same shape) adds the formula after the value, e.g. `120 (=SUM(B2:B5))`.
 */
export function sheetGrid(values: any[][], startRow: number, startCol: number, merges: sheets_v4.Schema$GridRange[] = [], formulas?: any[][]): string {
  const rows = values.length;
  const cols = Math.max(0, ...values.map(r => r.length));
  if (rows == 0 || cols == 0) {
    return '(empty)';
  }
  const covered = new Set<string>();
  const inView: string[] = [];
  for (const m of merges) {
    const r0 = m.startRowIndex ?? 0, r1 = m.endRowIndex ?? r0 + 1, c0 = m.startColumnIndex ?? 0, c1 = m.endColumnIndex ?? c0 + 1;
    if (r1 <= startRow || r0 >= startRow + rows || c1 <= startCol || c0 >= startCol + cols) continue;
    inView.push(gridRangeA1(m));
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (r != r0 || c != c0) covered.add(`${r},${c}`);
  }
  const header = `| | ${Array.from({ length: cols }, (_, c) => columnLetter(startCol + c)).join(' | ')} |`;
  const lines = [header, `|---|${'---|'.repeat(cols)}`];
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: cols }, (_, c) => {
      if (covered.has(`${startRow + r},${startCol + c}`)) return '<merged>';
      const value = values[r]?.[c] ?? '';
      const formula = formulas?.[r]?.[c];
      const text = typeof formula == 'string' && formula.startsWith('=') ? `${value} (${formula})` : String(value);
      return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    });
    lines.push(`| ${startRow + r + 1} | ${cells.join(' | ')} |`);
  }
  if (inView.length) {
    lines.push('', `Merged cells: ${inView.join(', ')}`);
  }
  return lines.join('\n');
}

/** A spreadsheet's tabs: name, id (the `gid` in links), size, frozen rows, merges and whether it's hidden. */
export function sheetTabs(spreadsheet: sheets_v4.Schema$Spreadsheet): string {
  return (spreadsheet.sheets ?? []).map((s, i) => {
    const p = s.properties ?? {};
    const grid = p.gridProperties ?? {};
    const extras = [
      grid.frozenRowCount ? `${grid.frozenRowCount} frozen row${grid.frozenRowCount == 1 ? '' : 's'}` : '',
      s.merges?.length ? `${s.merges.length} merged range${s.merges.length == 1 ? '' : 's'}` : '',
      p.hidden ? 'hidden' : '',
      p.sheetType && p.sheetType != 'GRID' ? p.sheetType.toLowerCase() : '',
    ].filter(Boolean);
    return `${i + 1}. ${quote(p.title ?? '')} (id ${p.sheetId}, ${grid.rowCount} rows x ${grid.columnCount} columns${extras.length ? `, ${extras.join(', ')}` : ''})`;
  }).join('\n');
}

// ---------- Slides ----------

const EMU_PER_PT = 12700;
const pt = (emu?: number | null) => Math.round((emu ?? 0) / EMU_PER_PT);

function textOf(text?: slides_v1.Schema$TextContent | null): string {
  return (text?.textElements ?? []).map(t => t.textRun?.content ?? '').join('').replace(/\n+$/, '');
}

/** The text in a Slides table, row by row. */
function tableRows(table: slides_v1.Schema$Table): string[][] {
  return (table.tableRows ?? []).map(r => (r.tableCells ?? []).map(c => textOf(c.text).replace(/\n/g, ' / ')));
}

/** Position and size in points, e.g. `at 40,30 size 640x80pt` (the slide is usually 720x405pt). */
function geometry(el: slides_v1.Schema$PageElement): string {
  const t = el.transform ?? {};
  const unit = t.unit == 'PT' ? EMU_PER_PT : 1;
  const w = (el.size?.width?.magnitude ?? 0) * (el.size?.width?.unit == 'PT' ? EMU_PER_PT : 1) * (t.scaleX ?? 1);
  const h = (el.size?.height?.magnitude ?? 0) * (el.size?.height?.unit == 'PT' ? EMU_PER_PT : 1) * (t.scaleY ?? 1);
  return `at ${pt((t.translateX ?? 0) * unit)},${pt((t.translateY ?? 0) * unit)} size ${pt(w)}x${pt(h)}pt`;
}

function describeElement(el: slides_v1.Schema$PageElement, indent: string): string[] {
  const head = `${indent}- ${el.objectId}`;
  if (el.shape) {
    const placeholder = el.shape.placeholder?.type ? ` placeholder ${el.shape.placeholder.type}` : '';
    const text = textOf(el.shape.text);
    return [`${head} SHAPE ${el.shape.shapeType ?? ''}${placeholder} ${geometry(el)}${text ? `: ${quote(text)}` : ''}`];
  }
  if (el.image) {
    const name = el.title || el.description;
    return [`${head} IMAGE ${geometry(el)}${name ? `: ${quote(name)}` : ''}`];
  }
  if (el.table) {
    const rows = tableRows(el.table).map((cells, r) => `${indent}    row ${r + 1}: ${cells.map(c => quote(c)).join(' | ')}`);
    return [`${head} TABLE ${el.table.rows} rows x ${el.table.columns} columns ${geometry(el)}`, ...rows];
  }
  if (el.elementGroup) {
    return [`${head} GROUP ${geometry(el)}`, ...(el.elementGroup.children ?? []).flatMap(c => describeElement(c, `${indent}  `))];
  }
  if (el.line) return [`${head} LINE ${geometry(el)}`];
  if (el.video) return [`${head} VIDEO ${geometry(el)}`];
  if (el.sheetsChart) return [`${head} CHART ${geometry(el)}`];
  if (el.wordArt) return [`${head} WORD ART ${geometry(el)}: ${quote(el.wordArt.renderedText ?? '')}`];
  return [`${head} ELEMENT ${geometry(el)}`];
}

/** The speaker notes of a slide. */
export function slideNotes(slide: slides_v1.Schema$Page): string {
  const notes = slide.slideProperties?.notesPage;
  const id = notes?.notesProperties?.speakerNotesObjectId;
  const shape = notes?.pageElements?.find(e => e.objectId == id) ?? notes?.pageElements?.find(e => e.shape?.placeholder?.type == 'BODY');
  return textOf(shape?.shape?.text);
}

/** All text on a slide, top to bottom, for the readable form. */
function slideText(elements: slides_v1.Schema$PageElement[]): string[] {
  return elements.flatMap(el => {
    if (el.shape) return textOf(el.shape.text) ? [textOf(el.shape.text)] : [];
    if (el.table) return [tableRows(el.table).map(r => `| ${r.join(' | ')} |`).join('\n')];
    if (el.elementGroup) return slideText(el.elementGroup.children ?? []);
    if (el.image) return ['[image]'];
    return [];
  });
}

/** Slides as text: each slide's text and speaker notes, or with `detail` every element's id, type, position and size. */
export function slidesText(presentation: slides_v1.Schema$Presentation, { detail = false, only }: { detail?: boolean, only?: number } = {}): string {
  const layouts = new Map((presentation.layouts ?? []).map(l => [l.objectId, l.layoutProperties?.displayName ?? l.layoutProperties?.name ?? '']));
  const size = presentation.pageSize;
  const header = detail && size ? `Slide size ${pt(size.width?.magnitude)}x${pt(size.height?.magnitude)}pt\n\n` : '';
  const slides = (presentation.slides ?? []).map((slide, i) => {
    if (only && only != i + 1) return '';
    const layout = layouts.get(slide.slideProperties?.layoutObjectId ?? '');
    const title = `Slide ${i + 1} (id ${slide.objectId}${layout ? `, layout ${quote(layout)}` : ''})`;
    const notes = slideNotes(slide);
    const body = detail
      ? (slide.pageElements ?? []).flatMap(el => describeElement(el, ''))
      : slideText(slide.pageElements ?? []);
    return [title, ...body, ...(notes ? [`Speaker notes: ${notes}`] : [])].join('\n');
  }).filter(Boolean);
  return header + slides.join('\n\n');
}

/** Finds a slide by number (1-based) or object id. */
export function findSlide(presentation: slides_v1.Schema$Presentation, slide: string | number): { slide: slides_v1.Schema$Page, number: number } {
  const slides = presentation.slides ?? [];
  const n = typeof slide == 'number' ? slide : /^\d+$/.test(slide.trim()) ? Number(slide) : NaN;
  const index = Number.isInteger(n) ? n - 1 : slides.findIndex(s => s.objectId == String(slide).trim());
  if (index < 0 || index >= slides.length) {
    throw Error(`There's no slide ${slide}, the deck has ${slides.length} slide${slides.length == 1 ? '' : 's'}.`);
  }
  return { slide: slides[index], number: index + 1 };
}

// ---------- Drive ----------

const KIND_NAMES: { [mime: string]: string } = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.folder': 'Folder',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.shortcut': 'Shortcut',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel (.xlsx)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint (.pptx)',
};

export function fileKind(mimeType?: string | null): string {
  if (!mimeType) return 'File';
  return KIND_NAMES[mimeType] ?? (mimeType.startsWith('image/') ? 'Image' : mimeType.startsWith('video/') ? 'Video' : mimeType);
}

export function driveFileLine(f: drive_v3.Schema$File, formatTime: (ms: number) => string): string {
  const modified = f.modifiedTime ? `, modified ${formatTime(Date.parse(f.modifiedTime))}` : '';
  // A shortcut opens its target, so show what it points to (google_read_file follows it)
  const kind = f.mimeType == 'application/vnd.google-apps.shortcut' && f.shortcutDetails?.targetMimeType
    ? `Shortcut to ${fileKind(f.shortcutDetails.targetMimeType)}` : fileKind(f.mimeType);
  return `- ${quote(f.name ?? '')} (${kind}${modified}) ${f.webViewLink ?? ''}`.trimEnd();
}

// ---------- Comments ----------

export function formatComments(comments: drive_v3.Schema$Comment[], formatTime: (ms: number) => string): string {
  if (comments.length == 0) {
    return 'No comments.';
  }
  return comments.map(c => {
    const when = c.createdTime ? formatTime(Date.parse(c.createdTime)) : '';
    const head = `Comment ${c.id} by ${c.author?.displayName ?? 'someone'} (${when})${c.resolved ? ' [resolved]' : ''}`;
    const quoted = c.quotedFileContent?.value ? `\n  On: ${quote(c.quotedFileContent.value)}` : '';
    const replies = (c.replies ?? []).filter(r => !r.deleted).map(r =>
      `\n  Reply by ${r.author?.displayName ?? 'someone'}${r.action ? ` (${r.action})` : ''}: ${r.content ?? ''}`).join('');
    return `${head}${quoted}\n  ${c.content ?? ''}${replies}`;
  }).join('\n\n');
}
