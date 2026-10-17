import express, { NextFunction, Request, Response } from 'express';
import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import { Logger } from 'pino';
import type { Server } from 'http';
import type Store from './store';
import { Sticker, StickerKind, StickerStatus } from '../models/Sticker';

const STATUSES: StickerStatus[] = ['pending', 'approved', 'rejected'];
/** Uploads accepted for each kind. Videos can't be turned into stickers. */
const UPLOAD_TYPES: Record<StickerKind, string[]> = {
  sticker: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  gif: ['image/gif', 'video/mp4', 'video/webm', 'video/quicktime'],
};

const toJSON = (s: Sticker) => ({
  id: s.id, kind: s.kind, mime: s.mime, animated: s.animated, description: s.description,
  status: s.status, source: s.source, receivedFrom: s.received_from, createdAt: s.createdAt,
});

/** HTTP Basic auth against `WEBUI_PASSWORD` (any username). */
function basicAuth(password: string) {
  const expected = Buffer.from(password);
  return (req: Request, res: Response, next: NextFunction) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = scheme == 'Basic' && encoded ? Buffer.from(Buffer.from(encoded, 'base64').toString().replace(/^[^:]*:/, '')) : Buffer.alloc(0);
    if (given.length == expected.length && timingSafeEqual(given, expected)) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Sofia", charset="UTF-8"').status(401).send('Password required');
  };
}

/**
 * Web UI for managing Sofia's stickers and GIFs (`src/static/stickers.html`). Listens on localhost only, reach it
 * through SSH port forwarding (`ssh -L 3000:localhost:3000 ...`). Disabled unless `WEBUI_PASSWORD` is set.
 */
export function startWebServer(db: Store, logger: Logger): Server | undefined {
  const password = process.env.WEBUI_PASSWORD;
  if (!password) {
    logger.warn('WEBUI_PASSWORD is not set, the sticker web UI is disabled');
    console.log('WEBUI_PASSWORD is not set, the sticker web UI is disabled.');
    return;
  }
  const app = express();
  app.use(basicAuth(password));

  const sticker = async (req: Request, res: Response) => {
    const found = await db.stickers.findById(String(req.params.id));
    if (!found) {
      res.status(404).json({ error: 'Sticker not found' });
    }
    return found;
  };
  // Express 5 forwards rejected promises to the error handler
  const route = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  app.get('/', (_req, res) => res.sendFile(path.resolve('src/static/stickers.html')));

  app.get('/api/stickers', route(async (req, res) => {
    const status = STATUSES.find(s => s == req.query.status);
    res.json((await db.stickers.list(status)).map(toJSON));
  }));

  app.get('/api/stickers/:id/file', route(async (req, res) => {
    const found = await sticker(req, res);
    if (found) {
      res.type(found.mime).set('Cache-Control', 'private, max-age=86400').send(await db.stickers.readFile(found));
    }
  }));

  // Upload: the file is the raw request body, `kind` and `description` (optional) are query parameters
  app.post('/api/stickers', express.raw({ type: () => true, limit: '20mb' }), route(async (req, res) => {
    const kind = req.query.kind == 'gif' ? 'gif' : 'sticker';
    const mime = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!UPLOAD_TYPES[kind].includes(mime)) {
      res.status(400).json({ error: `A ${kind} can't be made from ${mime || 'this file'}. Allowed: ${UPLOAD_TYPES[kind].join(', ')}` });
      return;
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const { sticker: added, created } = await db.stickers.add({
      buffer: req.body, mime, kind, source: 'upload', status: 'approved',
      description: typeof req.query.description == 'string' ? req.query.description : undefined,
    });
    res.status(created ? 201 : 200).json({ ...toJSON(added), duplicate: !created });
  }));

  app.patch('/api/stickers/:id', express.json(), route(async (req, res) => {
    const found = await sticker(req, res);
    if (!found) return;
    const { description, status } = req.body ?? {};
    if (status != undefined && !STATUSES.includes(status)) {
      res.status(400).json({ error: `Invalid status ${status}` });
      return;
    }
    await db.stickers.update(found, {
      ...(typeof description == 'string' ? { description: description.trim() } : {}),
      ...(status ? { status } : {}),
    });
    res.json(toJSON(found));
  }));

  app.post('/api/stickers/:id/describe', route(async (req, res) => {
    const found = await sticker(req, res);
    if (found) {
      res.json(toJSON(await db.stickers.redescribe(found)));
    }
  }));

  app.delete('/api/stickers/:id', route(async (req, res) => {
    const found = await sticker(req, res);
    if (found) {
      await db.stickers.delete(found);
      res.status(204).end();
    }
  }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err, 'Web UI request failed');
    res.status(500).json({ error: err?.message || 'Something went wrong' });
  });

  const port = Number(process.env.WEBUI_PORT) || 3000;
  const host = process.env.WEBUI_HOST || '127.0.0.1';
  return app.listen(port, host, () => {
    console.log(`[${new Date().toISOString()}] Sticker web UI on http://${host}:${port}`);
    logger.info(`Sticker web UI listening on ${host}:${port}`);
  });
}
