import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import pino from 'pino';
import sharp from 'sharp';
import AI from '../src/services/ai';
import { describeContent } from '../src/services/botService';
import { parsePages, pdfImages, pdfPageCount, pdfPageImage, readPdfText } from '../src/utils/pdf';

const hasPoppler = (() => {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  }
  catch {
    return false;
  }
})();
const skip = { skip: !hasPoppler && 'poppler-utils is not installed' };

/**
 * A minimal PDF: one page per entry of `pages` (each a list of text lines, empty for a page without text, like a scan).
 * With `image`, the first page also has a 64x64 image of random pixels (random so it isn't too small to keep).
 */
function makePdf(pages: string[][], { image = false } = {}): Buffer {
  const objects: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => (objects.push(body), objects.length);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let imageObj = 0;
  if (image) {
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919 + (i >> 3) * 104729) % 251;
    imageObj = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from('\nendstream')]));
  }
  const pageIds = pages.map((lines, i) => {
    const text = lines.map((line, j) => `BT /F1 14 Tf 72 ${720 - j * 20} Td (${line}) Tj ET`).join('\n');
    const draw = image && i == 0 ? '\nq 64 0 0 64 72 400 cm /Im1 Do Q' : '';
    const content = add(`<< /Length ${text.length + draw.length} >>\nstream\n${text}${draw}\nendstream`);
    const xobject = image && i == 0 ? ` /XObject << /Im1 ${imageObj} 0 R >>` : '';
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >>${xobject} >> >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    parts.push(obj);
    length += obj.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

test('page selections are parsed against the page count', () => {
  assert.deepEqual(parsePages(undefined, 5), { first: 1, last: 5 });
  assert.deepEqual(parsePages('3', 5), { first: 3, last: 3 });
  assert.deepEqual(parsePages(' 2 - 4 ', 5), { first: 2, last: 4 });
  assert.deepEqual(parsePages('4-', 5), { first: 4, last: 5 });
  assert.deepEqual(parsePages('2-99', 5), { first: 2, last: 5 });
  assert.throws(() => parsePages('6', 5), /don't exist, the PDF has 5 pages/);
  assert.throws(() => parsePages('page two', 5), /Invalid pages/);
});

test('PDF text is read page by page with page markers, and scanned PDFs are recognised', skip, async () => {
  const pdf = makePdf([['DevFest Proposal', 'Budget: 500 SGD'], ['Venue: NYP Block L']]);
  assert.equal(await pdfPageCount(pdf), 2);
  const { text, pageCount, scanned } = await readPdfText(pdf);
  assert.equal(pageCount, 2);
  assert.equal(scanned, false);
  assert.match(text, /^--- Page 1 ---\nDevFest Proposal\nBudget: 500 SGD\n\n--- Page 2 ---\nVenue: NYP Block L$/);
  assert.match((await readPdfText(pdf, '2')).text, /^--- Page 2 ---\nVenue: NYP Block L$/);

  const scan = await readPdfText(makePdf([[], []]));
  assert.equal(scan.scanned, true);
  assert.match(scan.text, /--- Page 1 ---\n\(no text on this page\)/);
});

test('long PDFs stop early and say which pages to read next', skip, async () => {
  const line = 'x'.repeat(80);
  const pdf = makePdf(Array.from({ length: 12 }, () => Array.from({ length: 35 }, () => line))); // ~2.8k characters a page
  const { text } = await readPdfText(pdf);
  assert.ok(text.length <= 30000 + 200);
  assert.match(text, /\[Stopped after page 10 of 12 to keep it short\. Read more with pages: "11-12"\.\]$/);
});

test('a PDF page can be rendered and embedded images extracted', skip, async () => {
  const pdf = makePdf([['With a picture']], { image: true });
  const page = await sharp(await pdfPageImage(pdf, 1)).metadata();
  assert.equal(page.format, 'png');
  assert.ok(page.width! > 800 && page.width! < 1000, `an A4/Letter page at 110 DPI, got ${page.width}`);
  const images = await pdfImages(pdf);
  assert.equal(images.length, 1);
  assert.equal(images[0].page, 1);
  assert.equal((await sharp(images[0].buffer).metadata()).width, 64);
});

test('not a PDF or too big gives a clear error', skip, async () => {
  await assert.rejects(pdfPageCount(Buffer.from('hello')), /couldn't be read as a PDF/);
  await assert.rejects(pdfPageCount(Buffer.alloc(26 * 1024 * 1024)), /too big to read \(26 MB/);
});

test('WhatsApp documents show their name, type and pages', () => {
  assert.equal(describeContent({ documentMessage: { fileName: 'proposal.pdf', mimetype: 'application/pdf', pageCount: 3 } }, 'DOC1'), '<WhatsApp Document media_id=DOC1 "proposal.pdf" (PDF, 3 pages)>');
  assert.equal(describeContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'budget.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', caption: 'pls check' } } } }, 'DOC2'),
    '<WhatsApp Document media_id=DOC2 "budget.xlsx" (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)> pls check');
});

test('read_pdf and view_pdf_page read WhatsApp PDFs, other media is pointed to the right tool', skip, async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const pdf = makePdf([['Logistics checklist']]);
  const media: { [id: string]: any } = {
    DOC1: { buffer: pdf, mime: 'application/pdf', kind: 'document', fileName: 'checklist.pdf' },
    DOC2: { buffer: Buffer.from('x'), mime: 'application/msword', kind: 'document', fileName: 'old.doc' },
    IMG1: { buffer: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808' } }).png().toBuffer(), mime: 'image/png', kind: 'image' },
  };
  const ai = new AI({} as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, sendStickerGif: async () => { }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); }, sendFile: async () => { },
    loadChatById: async () => [], sendPoll: async () => 'unused', getPollResults: async () => null,
    getMedia: async (id: string) => media[id],
  });
  assert.equal(await ai.readPdfTool!.invoke({ source: 'DOC1' }), 'checklist.pdf (1 page)\n\n--- Page 1 ---\nLogistics checklist');
  const page: any = await ai.viewPdfPageTool!.func({ source: 'DOC1', page: 1 });
  assert.match(page.text, /Page 1 of checklist\.pdf is attached/);
  assert.match(page.image.dataUrl, /^data:image\/(png|jpeg);base64,/);
  await assert.rejects(ai.viewPdfPageTool!.func({ source: 'DOC1', page: 2 }) as Promise<unknown>, /has 1 page/);
  await assert.rejects(ai.readPdfTool!.invoke({ source: 'DOC2' }), /"old\.doc" isn't a PDF/);
  await assert.rejects(ai.readPdfTool!.invoke({ source: 'IMG1' }), /is an image, not a PDF\. Use `view_media`/);
  await assert.rejects(ai.viewMediaTool!.invoke({ media_id: 'DOC1' }), /is a document \("checklist\.pdf"\).*`read_pdf`/);
});

test('send_file sends a PDF page as an image or the PDF itself, and extract_images pulls out images to view and send', skip, async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const { chatContext } = await import('../src/services/chatContext');
  const pdf = makePdf([['Poster']], { image: true });
  const sent: { id: string, mime: string, fileName: string, caption?: string }[] = [];
  const ai = new AI({} as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, sendStickerGif: async () => { }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); },
    loadChatById: async () => [], sendPoll: async () => 'unused', getPollResults: async () => null,
    getMedia: async () => ({ buffer: pdf, mime: 'application/pdf', kind: 'document', fileName: 'poster.pdf' }),
    sendFile: async (id: string, f: any) => { sent.push({ id, mime: f.mime, fileName: f.fileName, caption: f.caption }); },
  });
  const tool = (name: string) => ai.tools.find(t => t.name == name)!;
  await chatContext.run({ chatId: 'group1@g.us' }, async () => {
    assert.match(await tool('send_file').invoke({ source: 'DOC1', page: 1, end_message: false }) as string, /^Sent the image/);
    assert.match(await tool('send_file').invoke({ source: 'DOC1', caption: 'the poster', end_message: true }) as string, /^Sent "poster\.pdf"/);
    assert.match(await tool('extract_images').invoke({ source: 'DOC1' }) as string, /^Found 1 image:\nimg_1: page 1, 64x64$/);
    const viewed: any = await ai.viewMediaTool!.func({ media_id: 'img_1' });
    assert.match(viewed.text, /img_1 \(page 1\) is attached/);
    await tool('send_file').invoke({ source: 'img_1', end_message: true });
  });
  assert.deepEqual(sent, [
    { id: 'group1@g.us', mime: 'image/png', fileName: 'poster page 1.png', caption: undefined },
    { id: 'group1@g.us', mime: 'application/pdf', fileName: 'poster.pdf', caption: 'the poster' },
    { id: 'group1@g.us', mime: 'image/png', fileName: 'img_1.png', caption: undefined },
  ]);
  await assert.rejects(tool('send_file').invoke({ source: 'DOC1', end_message: true }), /not replying in a chat/);
  await assert.rejects(ai.viewMediaTool!.func({ media_id: 'img_9' }) as Promise<unknown>, /isn't available any more/);
});
