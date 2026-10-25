import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/** PDFs this size or larger aren't read (WhatsApp documents can be up to 2 GB). */
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** Text returned by `read_pdf` at once, about 7.5k tokens. */
export const PDF_TEXT_MAX_CHARS = 30000;
/** Rendered pages are sent to the vision model, 110 DPI keeps an A4 page around 900x1300. */
const PAGE_DPI = 110;

/**
 * Runs a poppler tool (`pdftotext`, `pdftoppm`, `pdfimages`, `pdfinfo`) on `pdf` written to a temp file. `run` gets the
 * input path and a temp dir for output files, and returns the result before the dir is removed.
 */
async function withPdf<T>(pdf: Buffer, run: (input: string, dir: string) => Promise<T>): Promise<T> {
  if (pdf.length >= PDF_MAX_BYTES) {
    throw Error(`The PDF is too big to read (${Math.round(pdf.length / 1024 / 1024)} MB, the limit is ${PDF_MAX_BYTES / 1024 / 1024} MB).`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sofia-pdf-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await fs.writeFile(input, pdf);
    return await run(input, dir);
  }
  catch (e: any) {
    if (e?.code == 'ENOENT' && e?.path && !String(e.path).startsWith(dir)) {
      throw Error('poppler-utils is not installed, it is needed for PDFs.');
    }
    throw e;
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const poppler = (tool: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8') =>
  execFileAsync(tool, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: encoding as any });

/** Number of pages. Throws a readable error if the file isn't a PDF or is password protected. */
export function pdfPageCount(pdf: Buffer): Promise<number> {
  return withPdf(pdf, async input => {
    const { stdout } = await poppler('pdfinfo', [input]).catch((e: any) => {
      throw Error(/Incorrect password/i.test(e?.stderr ?? '') ? 'The PDF is password protected.' : "This file couldn't be read as a PDF.");
    });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(String(stdout))?.[1]);
    if (!pages) {
      throw Error("This file couldn't be read as a PDF.");
    }
    return pages;
  });
}

/** The text of pages `first`-`last` (1-based, inclusive), one string per page, keeping the layout of columns and tables. */
export function pdfText(pdf: Buffer, first: number, last: number): Promise<string[]> {
  return withPdf(pdf, async input => {
    const { stdout } = await poppler('pdftotext', ['-layout', '-enc', 'UTF-8', '-f', String(first), '-l', String(last), input, '-']);
    // pdftotext ends every page with a form feed
    return String(stdout).split('\f').slice(0, last - first + 1).map(p => p.replace(/[ \t]+$/gm, '').trim());
  });
}

/** One page rendered as a PNG. */
export function pdfPageImage(pdf: Buffer, page: number): Promise<Buffer> {
  return withPdf(pdf, async (input, dir) => {
    const out = path.join(dir, 'page');
    await poppler('pdftoppm', ['-png', '-r', String(PAGE_DPI), '-f', String(page), '-l', String(page), '-singlefile', input, out]);
    return fs.readFile(`${out}.png`);
  });
}

export interface PdfImage {
  page: number,
  buffer: Buffer,
}

/** Embedded images smaller than this on either side (icons, bullets, lines) are left out. */
const MIN_IMAGE_SIDE = 32;

/** The images embedded in a PDF as PNGs, in page order, at most `max`. Tiny images (icons, lines) are left out. */
export function pdfImages(pdf: Buffer, max = 20): Promise<PdfImage[]> {
  return withPdf(pdf, async (input, dir) => {
    await poppler('pdfimages', ['-png', '-p', input, path.join(dir, 'img')]);
    const files = (await fs.readdir(dir)).filter(f => /^img-\d+-\d+\.png$/.test(f)).sort();
    const images: PdfImage[] = [];
    for (const file of files) {
      const buffer = await fs.readFile(path.join(dir, file));
      // A PNG's width and height are the first fields of its IHDR chunk
      if (buffer.readUInt32BE(16) < MIN_IMAGE_SIDE || buffer.readUInt32BE(20) < MIN_IMAGE_SIDE) {
        continue;
      }
      images.push({ page: Number(file.split('-')[1]), buffer });
      if (images.length >= max) {
        break;
      }
    }
    return images;
  });
}

/** Parses a page selection like `3`, `2-5` or `4-` against the page count. */
export function parsePages(pages: string | undefined, pageCount: number): { first: number, last: number } {
  if (!pages?.trim()) {
    return { first: 1, last: pageCount };
  }
  const match = /^\s*(\d+)\s*(?:(-)\s*(\d+)?)?\s*$/.exec(pages);
  if (!match) {
    throw Error(`Invalid pages "${pages}", use e.g. "3", "2-5" or "4-".`);
  }
  const first = Number(match[1]);
  const last = match[2] ? (match[3] ? Number(match[3]) : pageCount) : first;
  if (first < 1 || first > pageCount || last < first) {
    throw Error(`Pages "${pages}" don't exist, the PDF has ${pageCount} page${pageCount == 1 ? '' : 's'}.`);
  }
  return { first, last: Math.min(last, pageCount) };
}

/**
 * The text of a PDF for Sofia, with page markers, stopping at `PDF_TEXT_MAX_CHARS` with a hint on which pages to read
 * next. `scanned` is true when the pages have (almost) no text, e.g. a scanned document.
 */
export async function readPdfText(pdf: Buffer, pages?: string): Promise<{ text: string, pageCount: number, scanned: boolean }> {
  const pageCount = await pdfPageCount(pdf);
  const { first, last } = parsePages(pages, pageCount);
  const texts = await pdfText(pdf, first, last);
  // Scanned pages come out (almost) empty, a real page has at least a few words
  const scanned = texts.filter(t => t.replace(/\s/g, '').length < 10).length > texts.length / 2;
  let text = '';
  let lastRead = first - 1;
  for (const [i, pageText] of texts.entries()) {
    const part = `--- Page ${first + i} ---\n${pageText || '(no text on this page)'}\n\n`;
    if (text && text.length + part.length > PDF_TEXT_MAX_CHARS) {
      break;
    }
    text += part.length > PDF_TEXT_MAX_CHARS ? `${part.slice(0, PDF_TEXT_MAX_CHARS)}\n[Page cut off]\n\n` : part;
    lastRead = first + i;
  }
  if (lastRead < last) {
    text += `[Stopped after page ${lastRead} of ${pageCount} to keep it short. Read more with pages: "${lastRead + 1}-${last}".]`;
  }
  return { text: text.trim(), pageCount, scanned };
}
