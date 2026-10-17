import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import sharp from 'sharp';
import { isAnimated, toGifMp4, toModelImage, toStickerWebp, videoFirstFrame } from '../src/utils/media';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
const solid = (width: number, height: number, color: string, alpha = false) =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : color } }).png().toBuffer();
/** A 2 frame animated GIF: red then blue. */
const animatedGif = async () => sharp([await solid(64, 64, '#ff0000'), await solid(64, 64, '#0000ff')], { join: { animated: true } }).gif().toBuffer();
const pixel = async (dataUrl: string) => {
  const { data } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
};

test('full HD or larger images are downscaled to fit 1280x1280, smaller ones are not', async () => {
  const big = await toModelImage(await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#888' } }).jpeg().toBuffer(), 'image/jpeg');
  assert.deepEqual([big.width, big.height, big.downscaled, big.animated], [1280, 853, true, false]);
  assert.match(big.dataUrl, /^data:image\/jpeg;base64,/);
  const portrait = await toModelImage(await solid(1080, 1920, '#888'), 'image/png');
  assert.deepEqual([portrait.width, portrait.height, portrait.downscaled], [720, 1280, true]);
  const small = await toModelImage(await solid(800, 600, '#888'), 'image/png');
  assert.deepEqual([small.width, small.height, small.downscaled], [800, 600, false]);
});

test('transparent stickers stay PNG so the transparency is kept', async () => {
  const sticker = await toModelImage(await sharp(await solid(512, 512, '', true)).webp().toBuffer(), 'image/webp');
  assert.match(sticker.dataUrl, /^data:image\/png;base64,/);
});

test('animated GIFs are detected and only the first frame is sent', async () => {
  const gif = await animatedGif();
  assert.equal(await isAnimated(gif, 'image/gif'), true);
  assert.equal(await isAnimated(await solid(10, 10, '#000'), 'image/png'), false);
  const image = await toModelImage(gif, 'image/gif');
  assert.equal(image.animated, true);
  const [r, , b] = await pixel(image.dataUrl);
  assert.ok(r > 200 && b < 50, `expected the red first frame, got ${r},${b}`);
});

test('images become 512x512 webp stickers, animated GIFs stay animated', async () => {
  const still = await toStickerWebp(await solid(300, 150, '#00ff00'));
  assert.deepEqual(await sharp(still.webp).metadata().then(m => [m.format, m.width, m.height, still.animated]), ['webp', 512, 512, false]);
  const moving = await toStickerWebp(await animatedGif());
  const meta = await sharp(moving.webp, { animated: true }).metadata();
  assert.deepEqual([meta.format, meta.width, meta.pages, moving.animated], ['webp', 512, 2, true]);
});

test('GIFs become mp4s for WhatsApp, and the first frame of a video can be read', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const mp4 = await toGifMp4(await animatedGif(), 'image/gif');
  assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
  const frame = await videoFirstFrame(mp4);
  const [r, , b] = await pixel(`data:image/png;base64,${frame.toString('base64')}`);
  assert.ok(r > 180 && b < 80, `expected the red first frame, got ${r},${b}`);
  const image = await toModelImage(mp4, 'video/mp4');
  assert.equal(image.animated, true);
});
