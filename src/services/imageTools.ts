import sharp from 'sharp';
import { z } from 'zod';
import { ExtendedDynamicStructuredTool, ToolImageResult } from '../utils/tool';
import { toModelImage } from '../utils/media';
import { fetchPublic } from '../utils/safeFetch';
import { isDriveId, toGoogleLink } from '../utils/googleUrls';
import { IMAGE_MODEL, IMAGE_MODEL_PRO, MODELSTUDIO_BASE_URL } from '../config/modelStudio';
import type { ChatMedia } from './ai';
import type { ExtractedImages } from './fileTools';
import type { GoogleWorkspace } from './googleWorkspace';

/**
 * Image generation and editing with Qwen-Image 3.0 (Model Studio, OpenAI-compatible /images/generations), and Material
 * Symbols icons rendered as PNGs. Results go in the same cache as `extract_images` (img_1...), so they can be viewed with
 * view_media, sent with send_file, and inserted into Slides and Docs.
 */

/** Sizes for `aspect` (Qwen-Image needs 512*512 to 2048*2048 pixels in total). 16:9 matches Google Slides. */
export const ASPECT_SIZES: { [aspect: string]: string } = {
  '1:1': '1328x1328', '16:9': '1664x936', '9:16': '936x1664', '4:3': '1472x1104', '3:4': '1104x1472',
};

export interface ImageOptions {
  pro?: boolean,
  aspect?: string,
  count?: number,
  avoid?: string,
  /** Input images for editing, as data URLs or public URLs (1-3). */
  images?: string[],
}

/** Calls Qwen-Image and downloads the results (its links only last 24 hours). Throws Model Studio's error message. */
export async function qwenImage(prompt: string, options: ImageOptions = {}, fetchImpl: typeof fetch = fetch): Promise<Buffer[]> {
  const body: any = {
    model: options.pro ? IMAGE_MODEL_PRO : IMAGE_MODEL,
    prompt,
    n: Math.min(Math.max(options.count ?? 1, 1), 4),
    prompt_extend: true,
    watermark: false,
    ...(options.aspect ? { size: ASPECT_SIZES[options.aspect] ?? options.aspect } : {}),
    ...(options.avoid ? { negative_prompt: options.avoid } : {}),
    ...(options.images?.length ? { image: options.images } : {}),
  };
  const res = await fetchImpl(`${MODELSTUDIO_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.ALIBABA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null) as any;
  if (!res.ok || !json?.data?.length) {
    throw Error(`Image ${options.images?.length ? 'editing' : 'generation'} failed${res.ok ? '' : ` (HTTP ${res.status})`}: ${json?.error?.message ?? json?.message ?? 'no image returned'}`);
  }
  return Promise.all(json.data.map(async (d: any) => {
    const image = await fetchImpl(d.url, { signal: AbortSignal.timeout(60000) });
    if (!image.ok) throw Error(`Couldn't download the generated image (HTTP ${image.status}).`);
    return Buffer.from(await image.arrayBuffer());
  }));
}

// ---------- Material Symbols ----------

const ICON_STYLES = { outlined: 'materialsymbolsoutlined', rounded: 'materialsymbolsrounded', sharp: 'materialsymbolssharp' } as const;
let iconIndex: Promise<{ name: string, tags: string[], categories: string[] }[]> | undefined;

/** Google Fonts' list of Material Symbols with their tags, loaded once. */
function loadIcons(fetchImpl: typeof fetch = fetch) {
  iconIndex ??= (async () => {
    const res = await fetchImpl('https://fonts.google.com/metadata/icons?incomplete=1&key=material_symbols', { signal: AbortSignal.timeout(30000) });
    // The response starts with )]}' to stop it being run as a script
    const data = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ''));
    const byName = new Map<string, { name: string, tags: string[], categories: string[] }>();
    for (const icon of data.icons ?? []) {
      const known = byName.get(icon.name);
      byName.set(icon.name, { name: icon.name, tags: [...new Set([...(known?.tags ?? []), ...(icon.tags ?? [])])], categories: [...new Set([...(known?.categories ?? []), ...(icon.categories ?? [])])] });
    }
    return [...byName.values()];
  })().catch(e => { iconIndex = undefined; throw e; });
  return iconIndex;
}

/** Icon names matching `query`, best first: exact name, name containing it, then tags. */
export async function searchIcons(query: string, max = 15, fetchImpl?: typeof fetch): Promise<string[]> {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const scored = (await loadIcons(fetchImpl)).map(icon => {
    const name = icon.name.replace(/_/g, ' ');
    let score = 0;
    for (const w of words) {
      if (icon.name == w || name == w) score += 10;
      else if (name.split(' ').includes(w)) score += 6;
      else if (name.includes(w)) score += 3;
      if (icon.tags.some(t => t.toLowerCase() == w)) score += 2;
      else if (icon.tags.some(t => t.toLowerCase().includes(w))) score += 1;
    }
    return { name: icon.name, score };
  }).filter(i => i.score > 0).sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, max).map(i => i.name);
}

/** A Material Symbol as a PNG in `color` (hex), `size` pixels square. */
export async function renderIcon(name: string, { color = '#1A73E8', size = 256, style = 'outlined', filled = false }: { color?: string, size?: number, style?: keyof typeof ICON_STYLES, filled?: boolean } = {}, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const icon = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z0-9_]+$/.test(icon)) throw Error(`"${name}" isn't an icon name, find one with search_icons.`);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error(`"${color}" isn't a colour like #1A73E8.`);
  const res = await fetchImpl(`https://fonts.gstatic.com/s/i/short-term/release/${ICON_STYLES[style] ?? ICON_STYLES.outlined}/${icon}/${filled ? 'fill1' : 'default'}/48px.svg`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Error(`There's no icon called "${icon}"${filled ? ' (filled)' : ''}. Find one with search_icons.`);
  const svg = (await res.text()).replace('<svg ', `<svg fill="${color}" `);
  return sharp(Buffer.from(svg), { density: Math.ceil((size / 48) * 72) }).resize(size, size).png().toBuffer();
}

// ---------- Tools ----------

export interface ImageToolOptions {
  extracted: ExtractedImages,
  workspace?: GoogleWorkspace,
  getChatMedia?: (mediaId: string) => Promise<ChatMedia>,
  /** Called with each generated or edited image's count, e.g. to log costs. */
  onImages?: (count: number, model: string) => void,
}

export function createImageTools({ extracted, workspace, getChatMedia, onImages }: ImageToolOptions): ExtendedDynamicStructuredTool[] {
  /** An image to edit as a data URL: img_N, a WhatsApp media_id, a Drive image link, or a public link. */
  const toDataUrl = async (source: string): Promise<string> => {
    const s = source.trim();
    let buffer: Buffer, mime: string;
    if (/^img_\d+$/.test(s)) {
      ({ buffer, mime } = extracted.get(s));
    }
    else {
      const google = (/^https?:\/\//.test(s) || isDriveId(s)) && workspace ? await toGoogleLink(s) : null;
      if (google) {
        const file = await workspace!.getFile(google);
        if (!file.mimeType?.startsWith('image/')) throw Error(`"${file.name}" isn't an image.`);
        buffer = await workspace!.download(file, 10 * 1024 * 1024);
        mime = file.mimeType;
      }
      else if (/^https?:\/\//.test(s)) {
        ({ buffer, contentType: mime } = await fetchPublic(s, { maxBytes: 10 * 1024 * 1024 }));
      }
      else {
        if (!getChatMedia) throw Error(`"${s}" isn't an image id or link.`);
        const media = await getChatMedia(s);
        if (media.kind != 'image' && media.kind != 'sticker') throw Error(`${s} is a ${media.kind}, not an image.`);
        ({ buffer, mime } = media);
      }
    }
    return `data:${mime || 'image/png'};base64,${buffer.toString('base64')}`;
  };

  const show = async (buffers: Buffer[], label: string, what: string): Promise<ToolImageResult> => {
    const ids = buffers.map((b, i) => extracted.add(b, 'image/png', `${label}${buffers.length > 1 ? ` (${i + 1})` : ''}`));
    const sizes = await Promise.all(buffers.map(async b => { const m = await sharp(b).metadata(); return `${m.width}x${m.height}`; }));
    return {
      text: `${what} ${ids.map((id, i) => `${id} (${sizes[i]})`).join(', ')}. ${ids[0]} is attached in the next message${ids.length > 1 ? ', see the others with view_media' : ''}. Insert it with slides_edit/docs_edit insert_image (image "${ids[0]}"), send it with send_file, or change it with edit_image.`,
      image: await toModelImage(buffers[0], 'image/png'),
    };
  };

  const aspect = z.enum(['16:9', '1:1', '4:3', '3:4', '9:16']).optional().describe('[Optional] Shape: 16:9 fills a slide, 1:1 for icons/posters/WhatsApp. Defaults to what fits the prompt.');
  const quality = z.enum(['standard', 'pro']).optional().describe('[Optional] "pro" (qwen-image-3.0-pro) is slower but better at text and detail; use it for infographics with text or when standard falls short. Defaults to standard.');

  const generate = new ExtendedDynamicStructuredTool({
    name: 'generate_image',
    description: 'Create an image with Qwen-Image 3.0 from a description: illustrations, posters, backgrounds, simple infographics or photos for slides, docs or chats. Describe the subject, style, colours (e.g. Google Blue #4285F4) and any short text it should show (keep text short, it can misspell). You see the result. Each image costs money, so make one, check it, and edit_image it rather than generating many.',
    schema: z.object({
      prompt: z.string().min(1).describe('[Required] What the image should show, the style, colours and any exact text in quotes.'),
      aspect, quality,
      count: z.number().int().min(1).max(4).optional().describe('[Optional] Variations to make, 1-4. Defaults to 1.'),
      avoid: z.string().optional().describe('[Optional] What it must not show, e.g. "blurry, extra text, watermark".'),
    }),
    func: async (args) => {
      const { prompt, aspect, quality, count = 1, avoid } = args as any;
      const buffers = await qwenImage(prompt, { pro: quality == 'pro', aspect, count, avoid });
      onImages?.(buffers.length, quality == 'pro' ? IMAGE_MODEL_PRO : IMAGE_MODEL);
      return show(buffers, `generated: ${prompt.slice(0, 60)}`, `Generated`);
    }
  }, '{prompt: string, aspect?: "16:9" | "1:1" | "4:3" | "3:4" | "9:16", quality?: "standard" | "pro", count?: number, avoid?: string}');

  const edit = new ExtendedDynamicStructuredTool({
    name: 'edit_image',
    description: 'Change an image with Qwen-Image 3.0 using an instruction, e.g. "make the background Google Blue", "add the text \'RAG Workshop\' at the top", "remove the person on the left", or combine up to 3 images. The images can be img_N ids (generated, icons, extracted), WhatsApp image media_ids, Drive image links or public links. You see the result.',
    schema: z.object({
      images: z.array(z.string()).min(1).max(3).describe('[Required] 1-3 images to edit or combine.'),
      instruction: z.string().min(1).describe('[Required] What to change.'),
      aspect, quality,
    }),
    func: async (args) => {
      const { images, instruction, aspect, quality } = args as any;
      const buffers = await qwenImage(instruction, { pro: quality == 'pro', aspect, images: await Promise.all(images.map(toDataUrl)) });
      onImages?.(buffers.length, quality == 'pro' ? IMAGE_MODEL_PRO : IMAGE_MODEL);
      return show(buffers, `edited: ${instruction.slice(0, 60)}`, 'Edited, the new image is');
    }
  }, '{images: string[], instruction: string, aspect?: string, quality?: "standard" | "pro"}');

  const search = new ExtendedDynamicStructuredTool({
    name: 'search_icons',
    description: 'Find Material Symbols icon names (Google\'s icon set, e.g. for slides) by meaning, e.g. "database", "search document", "rocket launch". Then make one with material_icon.',
    schema: z.object({ query: z.string().min(1).describe('[Required] What the icon should show.') }),
    func: async (args) => {
      const names = await searchIcons((args as any).query);
      return names.length ? `Icons: ${names.join(', ')}` : 'No icons found, try other words.';
    }
  }, '{query: string}');

  const icon = new ExtendedDynamicStructuredTool({
    name: 'material_icon',
    description: 'Make a Material Symbols icon as a PNG in a colour and size, e.g. to add to slides. Returns an img_N id to insert with slides_edit/docs_edit insert_image (image "img_N"). GDG colours: Blue #4285F4, Red #EA4335, Yellow #F9AB00, Green #34A853, dark grey #202124.',
    schema: z.object({
      name: z.string().describe('[Required] The icon name from search_icons, e.g. "rocket_launch".'),
      color: z.string().optional().describe('[Optional] Hex colour, defaults to #1A73E8.'),
      size: z.number().int().min(24).max(1024).optional().describe('[Optional] Pixels, defaults to 256 (set the size on the slide when inserting).'),
      style: z.enum(['outlined', 'rounded', 'sharp']).optional().describe('[Optional] Defaults to outlined.'),
      filled: z.boolean().optional().describe('[Optional] Filled instead of outline.'),
    }),
    func: async (args) => {
      const { name, color, size, style, filled } = args as any;
      const id = extracted.add(await renderIcon(name, { color, size, style, filled }), 'image/png', `icon ${name}`);
      return `Made icon "${name}" as ${id}. Insert it with insert_image (image "${id}") and a small width/height (e.g. 48-96pt).`;
    }
  }, '{name: string, color?: string, size?: number, style?: "outlined" | "rounded" | "sharp", filled?: boolean}');

  return [generate, edit, search, icon];
}
