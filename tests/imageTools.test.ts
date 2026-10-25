import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { qwenImage, renderIcon, searchIcons } from '../src/services/imageTools';

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Qwen-Image gets the model, slide size, input images and what to avoid, and the results are downloaded', async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const requests: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    if (String(url).endsWith('/images/generations')) {
      requests.push(JSON.parse(init.body));
      return json({ data: [{ url: 'https://result.example/a.png' }, { url: 'https://result.example/b.png' }] });
    }
    return new Response(Buffer.from(`png from ${url}`));
  }) as any;
  const images = await qwenImage('a RAG pipeline infographic', { pro: true, aspect: '16:9', count: 2, avoid: 'watermark', images: ['data:image/png;base64,AAAA'] }, fakeFetch);
  assert.deepEqual(images.map(b => b.toString()), ['png from https://result.example/a.png', 'png from https://result.example/b.png']);
  assert.deepEqual(requests[0], {
    model: 'qwen-image-3.0-pro', prompt: 'a RAG pipeline infographic', n: 2, prompt_extend: true, watermark: false,
    size: '1664x936', negative_prompt: 'watermark', image: ['data:image/png;base64,AAAA'],
  });
  await qwenImage('x', {}, fakeFetch);
  assert.equal(requests[1].model, 'qwen-image-3.0');
  assert.equal('size' in requests[1], false, 'no aspect: the model picks the size');
  const failing = (async () => json({ error: { message: 'Input image is too large' } }, 400)) as any;
  await assert.rejects(qwenImage('x', { images: ['data:,'] }, failing), /Image editing failed \(HTTP 400\): Input image is too large/);
});

test('icons are found by name and tags, and rendered in the given colour', async () => {
  const metadata = `)]}'\n${JSON.stringify({ icons: [
    { name: 'database', tags: ['storage', 'sql'] }, { name: 'database_search', tags: ['find'] }, { name: 'search', tags: ['find', 'magnifying glass'] },
    { name: 'rocket_launch', tags: ['startup'] }, { name: 'database', tags: ['data'], categories: ['Content'] },
  ] })}`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 48 48" width="48"><rect x="0" y="0" width="48" height="48"/></svg>';
  const fakeFetch = (async (url: string) => String(url).includes('metadata') ? new Response(metadata) : String(url).includes('/nope/') ? new Response('', { status: 404 }) : new Response(svg)) as any;
  assert.deepEqual(await searchIcons('database', 5, fakeFetch), ['database', 'database_search']);
  assert.deepEqual(await searchIcons('find', 5, fakeFetch), ['search', 'database_search']);
  const png = await renderIcon('database', { color: '#34A853', size: 64 }, fakeFetch);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 64);
  assert.deepEqual([...data.subarray(0, 3)], [0x34, 0xA8, 0x53]);
  await assert.rejects(renderIcon('nope', {}, fakeFetch), /no icon called "nope"/);
  await assert.rejects(renderIcon('x', { color: 'green' }, fakeFetch), /isn't a colour/);
});
