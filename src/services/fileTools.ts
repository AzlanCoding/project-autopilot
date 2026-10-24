import sharp from 'sharp';
import { z } from 'zod';
import { ExtendedDynamicStructuredTool } from '../utils/tool';
import { parsePages, pdfImages, pdfPageCount, pdfPageImage } from '../utils/pdf';
import { fetchPublic } from '../utils/safeFetch';
import { isDriveId, toGoogleLink } from '../utils/googleUrls';
import { chatContext } from './chatContext';
import type { ChatAdapter, OutgoingFile } from './ai';
import { GoogleWorkspace, MIME } from './googleWorkspace';
import { docTabs } from './workspaceFormat';

/** Images pulled out of files by `extract_images`, kept for a while so they can be viewed or sent. */
export class ExtractedImages {
  private images = new Map<string, { buffer: Buffer, mime: string, label: string, at: number }>();
  private next = 1;
  constructor(private ttlMs = 30 * 60 * 1000, private max = 60) { }

  add(buffer: Buffer, mime: string, label: string): string {
    const id = `img_${this.next++}`;
    this.images.set(id, { buffer, mime, label, at: Date.now() });
    // Oldest first, so the earliest ones go when there are too many
    for (const [key, value] of this.images) {
      if (this.images.size <= this.max && Date.now() - value.at < this.ttlMs) break;
      this.images.delete(key);
    }
    return id;
  }

  get(id: string) {
    const image = this.images.get(id.trim());
    if (!image || Date.now() - image.at > this.ttlMs) {
      throw Error(`${id} isn't available any more (extracted images are kept for 30 minutes). Run extract_images again.`);
    }
    return image;
  }
}

const isExtractedId = (s: string) => /^img_\d+$/.test(s.trim());
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\n]+/g, ' ').trim().slice(0, 120) || 'file';
/** A name for an image made from one page, e.g. "poster page 2.png" from "poster.pdf". */
const pageName = (name: string, page: number) => `${safeName(name).replace(/\.pdf$/i, '')} page ${page}.png`;
const imageExt = (mime: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] ?? 'png');

export interface FileToolOptions {
  adapter: ChatAdapter,
  workspace?: GoogleWorkspace,
  extracted: ExtractedImages,
}

/** `send_file` and `extract_images`: sending files and images to WhatsApp chats. */
export function createFileTools({ adapter, workspace, extracted }: FileToolOptions): ExtendedDynamicStructuredTool[] {
  const needWorkspace = () => {
    if (!workspace) throw Error("Google Drive isn't set up for you yet, so Drive links can't be used.");
    return workspace;
  };

  /** Turns `source` into a file to send: an export, a rendered page or slide, a download, or an extracted image. */
  const resolve = async (source: string, format?: string, page?: number): Promise<OutgoingFile> => {
    const s = source.trim();
    if (isExtractedId(s)) {
      const image = extracted.get(s);
      return { buffer: image.buffer, mime: image.mime, fileName: `${s}.${imageExt(image.mime)}` };
    }
    // Google links, file ids, and links that redirect to one (short links)
    const google = workspace ? await toGoogleLink(s) : null;
    if (google) {
      const ws = needWorkspace();
      const file = await ws.getFile(google);
      const name = safeName(file.name ?? 'file');
      const exportAs = async (mime: string, ext: string) => ({ buffer: await ws.export(file, mime), mime, fileName: `${name}.${ext}` });
      switch (file.mimeType) {
        case MIME.doc:
          return format == 'docx' ? exportAs(MIME.docx, 'docx') : exportAs(MIME.pdf, 'pdf');
        case MIME.sheet:
          return format == 'xlsx' ? exportAs(MIME.xlsx, 'xlsx') : exportAs(MIME.pdf, 'pdf');
        case MIME.slides:
          if (page || format == 'png') {
            const { buffer, number } = await ws.slideImage(file.id!, page ?? 1);
            return { buffer, mime: 'image/png', fileName: `${name} slide ${number}.png` };
          }
          return format == 'pptx' ? exportAs(MIME.pptx, 'pptx') : exportAs(MIME.pdf, 'pdf');
      }
      const buffer = await ws.download(file, 100 * 1024 * 1024);
      if (file.mimeType == MIME.pdf && page) {
        parsePages(String(page), await pdfPageCount(buffer));
        return { buffer: await pdfPageImage(buffer, page), mime: 'image/png', fileName: pageName(name, page) };
      }
      return { buffer, mime: file.mimeType ?? 'application/octet-stream', fileName: name };
    }
    if (/^https?:\/\//.test(s)) {
      const { buffer, contentType, url } = await fetchPublic(s, { maxBytes: 50 * 1024 * 1024 });
      const fileName = safeName(decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file'));
      return { buffer, mime: contentType || 'application/octet-stream', fileName };
    }
    // A WhatsApp media_id
    const media = await adapter.getMedia(s);
    if (media.kind == 'document' && page) {
      parsePages(String(page), await pdfPageCount(media.buffer));
      return { buffer: await pdfPageImage(media.buffer, page), mime: 'image/png', fileName: pageName(media.fileName ?? 'document', page) };
    }
    return { buffer: media.buffer, mime: media.mime, fileName: media.fileName ?? `${s}.${imageExt(media.mime)}` };
  };

  const sendFile = new ExtendedDynamicStructuredTool({
    name: 'send_file',
    description: 'Send a file or image on WhatsApp, to the chat you are replying in or another chat. Sources: a Google Doc/Sheet/Slides link (sent as PDF, or as docx/xlsx/pptx), a slide as an image (page = slide number), a PDF page as an image (page), a Drive file, a WhatsApp media_id (e.g. a PDF someone sent), a public link, or an extracted image (img_1 from extract_images). Images are sent as photos, everything else as documents.',
    schema: z.object({
      source: z.string().describe('[Required] A Google link or file id, WhatsApp media_id, public link, or img_N.'),
      format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'png']).optional().describe('[Optional] For Google files: pdf (default), docx (Docs), xlsx (Sheets), pptx or png (Slides).'),
      page: z.number().int().min(1).optional().describe('[Optional] Send only this slide (Slides) or page (PDF) as an image.'),
      caption: z.string().optional().describe('[Optional] A message with it.'),
      id: z.string().optional().describe('[Optional] User id or group id to send it to, defaults to the chat you are replying in.'),
      end_message: z.boolean().describe('[Required] true if this is the last thing you send in this reply.'),
    }),
    func: async (args) => {
      const { source, format, page, caption, id } = args as any;
      const chatId = id ?? chatContext.getStore()?.chatId;
      if (!chatId) {
        throw Error('You are not replying in a chat right now, give the user id or group id to send it to.');
      }
      const file = await resolve(source, format, page);
      await adapter.sendFile(chatId, { ...file, ...(caption ? { caption } : {}) });
      return `Sent ${file.mime.startsWith('image/') ? 'the image' : `"${file.fileName}"`} (${Math.max(1, Math.round(file.buffer.length / 1024))} KB).`;
    }
  }, '{source: string, format?: "pdf" | "docx" | "xlsx" | "pptx" | "png", page?: number, caption?: string, id?: string, end_message: boolean}');

  const extractImages = new ExtendedDynamicStructuredTool({
    name: 'extract_images',
    description: 'Pull out the images inside a PDF (WhatsApp media_id or Drive link), Google Doc or Slides deck. Each gets an id (img_1, img_2...) to look at with `view_media` or send with `send_file`, kept for 30 minutes.',
    schema: z.object({ source: z.string().describe('[Required] A WhatsApp media_id or a Google link.') }),
    func: async (args) => {
      const s = String((args as any).source).trim();
      const found: { buffer: Buffer, label: string }[] = [];
      const google = /^https?:\/\//.test(s) || isDriveId(s) ? await toGoogleLink(s) : null;
      if (google) {
        const ws = needWorkspace();
        const file = await ws.getFile(google);
        if (file.mimeType == MIME.doc) {
          for (const tab of docTabs(await ws.getDoc(file.id!))) {
            for (const [objectId, obj] of Object.entries(tab.inlineObjects ?? {})) {
              const uri = obj.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
              if (uri) found.push({ buffer: await ws.fetchContent(uri), label: `tab "${tab.title}" (${objectId})` });
            }
          }
        }
        else if (file.mimeType == MIME.slides) {
          const presentation = await ws.getPresentation(file.id!);
          const walk = async (elements: any[] | undefined, slide: number) => {
            for (const el of elements ?? []) {
              if (el.image?.contentUrl) found.push({ buffer: await ws.fetchContent(el.image.contentUrl), label: `slide ${slide} (${el.objectId})` });
              await walk(el.elementGroup?.children, slide);
            }
          };
          for (const [i, slide] of (presentation.slides ?? []).entries()) await walk(slide.pageElements ?? undefined, i + 1);
        }
        else if (file.mimeType == MIME.pdf) {
          for (const img of await pdfImages(await ws.download(file))) found.push({ buffer: img.buffer, label: `page ${img.page}` });
        }
        else {
          throw Error(`Images can only be extracted from PDFs, Google Docs and Slides, not "${file.name}".`);
        }
      }
      else {
        const media = await adapter.getMedia(s);
        if (media.kind != 'document' || !(media.mime == 'application/pdf' || /\.pdf$/i.test(media.fileName ?? ''))) {
          throw Error(`${s} isn't a PDF.`);
        }
        for (const img of await pdfImages(media.buffer)) found.push({ buffer: img.buffer, label: `page ${img.page}` });
      }
      if (found.length == 0) {
        return 'No images found in it.';
      }
      const lines = await Promise.all(found.slice(0, 30).map(async f => {
        const meta = await sharp(f.buffer).metadata().catch(() => null);
        const mime = meta?.format ? `image/${meta.format == 'jpeg' ? 'jpeg' : meta.format}` : 'image/png';
        const id = extracted.add(f.buffer, mime, f.label);
        return `${id}: ${f.label}${meta?.width ? `, ${meta.width}x${meta.height}` : ''}`;
      }));
      return `Found ${found.length} image${found.length == 1 ? '' : 's'}${found.length > 30 ? ' (showing 30)' : ''}:\n${lines.join('\n')}`;
    }
  }, '{source: string}');

  return [sendFile, extractImages];
}

