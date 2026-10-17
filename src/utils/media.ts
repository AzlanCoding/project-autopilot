import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Uncomment to keep memory low on a small server: no libvips operation cache (~50MB), one image processed at a time
// sharp.cache(false);
// sharp.concurrency(1);

/** Images this size or larger (full HD, either orientation) are downscaled before being sent to the model. */
const FULL_HD = { long: 1920, short: 1080 };
/** Downscaled images fit inside this box. */
const MODEL_IMAGE_MAX_SIDE = 1280;
/** WhatsApp stickers are 512x512 webp. */
const STICKER_SIZE = 512;

export interface ModelImage {
  /** `data:` URL for an `input_image` content part. */
  dataUrl: string,
  /** The media moves (GIF, animated sticker, video), only the first frame is included. */
  animated: boolean,
  width: number,
  height: number,
  downscaled: boolean,
}

/** Runs ffmpeg on `input` (written to a temp file) and returns the output file's contents. */
async function ffmpeg(input: Buffer, inputExt: string, outputExt: string, args: string[]): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sofia-media-'));
  try {
    const inFile = path.join(dir, `in.${inputExt}`);
    const outFile = path.join(dir, `out.${outputExt}`);
    await fs.writeFile(inFile, input);
    // One thread keeps ffmpeg's peak memory around 75MB (it scales with the thread count)
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-i', inFile, '-threads', '1', ...args, outFile], { timeout: 60000 });
    return await fs.readFile(outFile);
  }
  catch (e: any) {
    if (e?.code == 'ENOENT') {
      throw Error('ffmpeg is not installed, it is needed for videos and GIFs.');
    }
    throw e;
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const isVideo = (mime: string) => mime.startsWith('video/');

/** Extracts the first frame of a video (e.g. a WhatsApp GIF, which is an mp4) as a PNG. */
export function videoFirstFrame(video: Buffer): Promise<Buffer> {
  return ffmpeg(video, 'mp4', 'png', ['-frames:v', '1']);
}

/** Whether an image (GIF, webp, png...) or video has more than one frame. */
export async function isAnimated(buffer: Buffer, mime: string): Promise<boolean> {
  if (isVideo(mime)) {
    return true;
  }
  const { pages } = await sharp(buffer).metadata();
  return (pages ?? 1) > 1;
}

/**
 * Prepares an image, sticker, GIF or video for the vision model: the first frame only, downscaled to fit inside
 * 1280x1280 if it is full HD or larger, as PNG (keeps sticker transparency) or JPEG.
 */
export async function toModelImage(buffer: Buffer, mime: string): Promise<ModelImage> {
  const animated = await isAnimated(buffer, mime);
  const frame = isVideo(mime) ? await videoFirstFrame(buffer) : buffer;
  let img = sharp(frame); // sharp only reads the first frame unless `animated: true` is set
  const { width = 0, height = 0, hasAlpha } = await img.metadata();
  const downscaled = Math.max(width, height) >= FULL_HD.long || Math.min(width, height) >= FULL_HD.short;
  if (downscaled) {
    img = img.resize(MODEL_IMAGE_MAX_SIDE, MODEL_IMAGE_MAX_SIDE, { fit: 'inside' });
  }
  const out = hasAlpha ? await img.png().toBuffer({ resolveWithObject: true }) : await img.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  return {
    dataUrl: `data:image/${hasAlpha ? 'png' : 'jpeg'};base64,${out.data.toString('base64')}`,
    animated,
    width: out.info.width,
    height: out.info.height,
    downscaled,
  };
}

/** Converts an image (png, jpeg, webp, GIF, animated or not) into a 512x512 WhatsApp sticker webp. */
export async function toStickerWebp(buffer: Buffer): Promise<{ webp: Buffer, animated: boolean }> {
  const animated = await isAnimated(buffer, 'image/*');
  const webp = await sharp(buffer, { animated })
    .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: animated ? 60 : 80, effort: 4 })
    .toBuffer();
  return { webp, animated };
}

/** Converts a GIF (or other video) into an mp4 that WhatsApp plays as a GIF (`gifPlayback`). */
export function toGifMp4(buffer: Buffer, mime: string): Promise<Buffer> {
  const ext = mime == 'image/gif' ? 'gif' : mime.split('/')[1] || 'mp4';
  return ffmpeg(buffer, ext, 'mp4', [
    '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
    // H.264 needs even dimensions, and WhatsApp GIFs don't need to be bigger than 720p
    '-vf', "scale='min(720,iw)':-2:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
  ]);
}
