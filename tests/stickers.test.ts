import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import sharp from 'sharp';
import { StickerService } from '../src/services/stickerService';
import { startWebServer } from '../src/services/webServer';
import { describeContent } from '../src/services/botService';

/** In-memory stand-ins for the Sequelize model and Milvus. */
function fakeStore() {
  const rows: any[] = [];
  const vectors = new Map<string, string>(); // sticker id -> embedded text
  const row = (data: any) => Object.assign({ ...data, createdAt: new Date() }, {
    async update(changes: any) { Object.assign(this, changes); return this; },
    async destroy() { rows.splice(rows.indexOf(this), 1); },
  });
  const Model = {
    findByPk: async (id: string) => rows.find(r => r.id == id) ?? null,
    findOne: async ({ where }: any) => rows.find(r => r.sha256 == where.sha256) ?? null,
    findAll: async ({ where }: any) => rows.filter(r => (!where.status || r.status == where.status) && (!where.id || where.id.includes(r.id))),
    create: async (data: any) => { const r = row(data); rows.push(r); return r; },
  };
  const store: any = {
    db: { models: { StickerStore: Model } },
    getEmbedding: async (text: string) => [text.length],
    milvus: {
      upsert: async ({ data }: any) => { for (const d of data) vectors.set(d.sticker_id, d.embedding); },
      deleteEntities: async ({ expr }: any) => { vectors.delete(expr.match(/"(.*)"/)[1]); },
      // Returns every indexed sticker, newest first
      search: async () => ({ results: [...vectors.keys()].reverse().map(sticker_id => ({ sticker_id })) }),
    },
  };
  return { store, rows, vectors };
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickers-'));
  const { store, rows, vectors } = fakeStore();
  const stickers = new StickerService(store, pino({ level: 'silent' }), dir);
  return { stickers, rows, vectors, dir };
}

const png = (color: string) => sharp({ create: { width: 200, height: 100, channels: 3, background: color } }).png().toBuffer();

test('uploads are converted to 512x512 webp, approved and searchable, duplicates are skipped', async () => {
  const { stickers, vectors, dir } = await setup();
  const { sticker, created } = await stickers.add({ buffer: await png('#f00'), mime: 'image/png', kind: 'sticker', source: 'upload', status: 'approved', description: 'red square, angry' });
  assert.equal(created, true);
  assert.match(sticker.id, /^stk_[0-9a-f]{8}$/);
  assert.deepEqual([sticker.mime, sticker.animated], ['image/webp', false]);
  const meta = await sharp(await fs.readFile(path.join(dir, sticker.file))).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
  assert.ok(vectors.has(sticker.id));

  const again = await stickers.add({ buffer: await png('#f00'), mime: 'image/png', kind: 'sticker', source: 'upload', status: 'approved', description: 'x' });
  assert.deepEqual([again.created, again.sticker.id], [false, sticker.id]);
});

test('received stickers are kept as is and pending until approved, rejected ones leave the search', async () => {
  const { stickers, vectors } = await setup();
  const webp = await sharp(await png('#00f')).webp().toBuffer();
  const { sticker } = await stickers.add({ buffer: webp, mime: 'image/webp', kind: 'sticker', source: 'received', status: 'pending', original: true, description: 'blue', receivedFrom: '6591234567@s.whatsapp.net' });
  assert.equal(sticker.sha256, StickerService.sha256(webp)); // Same hash as WhatsApp's fileSha256, so duplicates are skipped before downloading
  assert.equal(vectors.has(sticker.id), false);
  assert.deepEqual(await stickers.search('blue'), []);

  await stickers.update(sticker, { status: 'approved' });
  assert.deepEqual((await stickers.search('blue')).map(s => s.id), [sticker.id]);
  await stickers.update(sticker, { status: 'rejected' });
  assert.equal(vectors.has(sticker.id), false);
});

test('deleting a sticker removes its file, row and vector', async () => {
  const { stickers, rows, vectors, dir } = await setup();
  const { sticker } = await stickers.add({ buffer: await png('#0f0'), mime: 'image/png', kind: 'sticker', source: 'upload', status: 'approved', description: 'green' });
  await stickers.delete(sticker);
  assert.deepEqual([rows.length, vectors.size, (await fs.readdir(dir)).length], [0, 0, 0]);
});

test('media in the chat history get a media_id and say whether they move', () => {
  assert.equal(describeContent({ imageMessage: { caption: 'my homework' } }, 'ABC'), '<WhatsApp Image media_id=ABC> my homework');
  assert.equal(describeContent({ stickerMessage: { isAnimated: true } }, 'ABC'), '<WhatsApp Sticker media_id=ABC (animated)>');
  assert.equal(describeContent({ stickerMessage: {} }, 'ABC'), '<WhatsApp Sticker media_id=ABC>');
  assert.equal(describeContent({ videoMessage: { gifPlayback: true } }, 'ABC'), '<WhatsApp GIF media_id=ABC (moving)>');
  assert.equal(describeContent({ videoMessage: { caption: 'lol' } }, 'ABC', { videos: true }), '<WhatsApp Video media_id=ABC> lol');
  // Videos are off unless ENABLE_VIDEO=true, they get no media_id so Sofia doesn't try to view them. GIFs still can be.
  assert.equal(describeContent({ videoMessage: { caption: 'lol' } }, 'ABC', { videos: false }), "<WhatsApp Video (can't be viewed)> lol");
  assert.equal(describeContent({ videoMessage: { gifPlayback: true } }, 'ABC', { videos: false }), '<WhatsApp GIF media_id=ABC (moving)>');
  assert.equal(describeContent({ conversation: 'hi' }, 'ABC'), 'hi');
  assert.equal(describeContent({ imageMessage: {} }), '<WhatsApp Image>');
});

test('the web UI needs the password and rejects files that cannot become a sticker', async () => {
  const { stickers } = await setup();
  await stickers.add({ buffer: await png('#f0f'), mime: 'image/png', kind: 'sticker', source: 'upload', status: 'approved', description: 'pink' });
  Object.assign(process.env, { WEBUI_PASSWORD: 'secret', WEBUI_PORT: '0' });
  const server = startWebServer({ stickers } as any, pino({ level: 'silent' }))!;
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = (password: string) => ({ Authorization: `Basic ${Buffer.from(`azlan:${password}`).toString('base64')}` });
  try {
    assert.equal((await fetch(`${base}/api/stickers`)).status, 401);
    assert.equal((await fetch(`${base}/api/stickers`, { headers: auth('wrong') })).status, 401);
    const list = await (await fetch(`${base}/api/stickers?status=approved`, { headers: auth('secret') })).json();
    assert.deepEqual(list.map((s: any) => s.description), ['pink']);
    const bad = await fetch(`${base}/api/stickers?kind=sticker`, { method: 'POST', headers: { ...auth('secret'), 'Content-Type': 'video/mp4' }, body: 'x' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/`, { headers: auth('secret') })).status, 200);
  }
  finally {
    server.close();
  }
});
