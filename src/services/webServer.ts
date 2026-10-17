import express, { NextFunction, Request, Response } from 'express';
import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import { Logger } from 'pino';
import type { Server } from 'http';
import type Store from './store';
import { Sticker, StickerKind, StickerStatus } from '../models/Sticker';
import type { User } from '../models/User';

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

const userJSON = (u: User) => ({ id: u.id, name: u.name, description: u.description, whatsapp_jid: u.whatsapp_jid });

/**
 * The WhatsApp jid stored for a user, from a phone number with country code ("+65 9123 4567", "6591234567") or a jid.
 * The bot looks users up by their phone number jid (`<digits>@s.whatsapp.net`). Throws if it isn't valid.
 */
export function toWhatsappJid(input: string): string {
  const value = input.trim();
  if (value.includes('@')) {
    if (!/^\d{6,15}@s\.whatsapp\.net$/.test(value)) {
      throw Error(`"${value}" isn't a phone number jid like 6591234567@s.whatsapp.net`);
    }
    return value;
  }
  const digits = value.replace(/[\s+()-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw Error(`"${value}" isn't a phone number with country code, e.g. +65 9123 4567`);
  }
  return `${digits}@s.whatsapp.net`;
}

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
 * Web UI for managing Sofia's stickers, GIFs and users (`src/static/webui.html`). Listens on localhost only, reach it
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

  app.get('/', (_req, res) => res.sendFile(path.resolve('src/static/webui.html')));

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

  // Users (UserStore): who Sofia knows and can chat with in DMs
  const userFields = (body: any, partial: boolean) => {
    const out: { name?: string, description?: string, whatsapp_jid?: string } = {};
    if (typeof body?.name == 'string' && body.name.trim()) out.name = body.name.trim();
    else if (!partial) throw Error('A name is required');
    if (typeof body?.description == 'string') out.description = body.description.trim();
    else if (!partial) out.description = '';
    if (typeof body?.whatsapp_jid == 'string' && body.whatsapp_jid.trim()) out.whatsapp_jid = toWhatsappJid(body.whatsapp_jid);
    else if (!partial) throw Error('A phone number is required');
    return out;
  };
  /** Runs a user change, turning bad input and duplicate numbers into 400/409 instead of 500. */
  const userChange = (fn: (req: Request, res: Response) => Promise<unknown>) => route(async (req, res) => {
    try {
      await fn(req, res);
    }
    catch (e: any) {
      if (e?.name == 'SequelizeUniqueConstraintError') {
        res.status(409).json({ error: 'Another user already has that phone number' });
      }
      else if (e instanceof Error && !e.name.startsWith('Sequelize')) {
        res.status(400).json({ error: e.message });
      }
      else {
        throw e;
      }
    }
  });

  app.get('/api/users', route(async (_req, res) => {
    res.json((await db.user.findAll()).map(userJSON).sort((a, b) => a.name.localeCompare(b.name)));
  }));

  app.post('/api/users', express.json(), userChange(async (req, res) => {
    res.status(201).json(userJSON(await db.user.create(userFields(req.body, false) as any)));
  }));

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.patch('/api/users/:id', express.json(), userChange(async (req, res) => {
    const updated = UUID.test(String(req.params.id)) ? await db.user.update(String(req.params.id), userFields(req.body, true)) : null;
    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(userJSON(updated));
  }));

  app.delete('/api/users/:id', route(async (req, res) => {
    if (!UUID.test(String(req.params.id)) || !await db.user.findById(String(req.params.id))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await db.user.destroy(String(req.params.id));
    res.status(204).end();
  }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err, 'Web UI request failed');
    res.status(500).json({ error: err?.message || 'Something went wrong' });
  });

  // `||` would turn WEBUI_PORT=0 (any free port, used by the tests) into 3000
  const port = process.env.WEBUI_PORT?.trim() ? Number(process.env.WEBUI_PORT) : 3000;
  const host = process.env.WEBUI_HOST || '127.0.0.1';
  return app.listen(port, host, () => {
    console.log(`[${new Date().toISOString()}] Sticker web UI on http://${host}:${port}`);
    logger.info(`Sticker web UI listening on ${host}:${port}`);
  });
}
