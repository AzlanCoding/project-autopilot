import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { ModelStatic } from 'sequelize';
import { Logger } from 'pino';
import type Store from './store';
import { Sticker, StickerKind, StickerStatus } from '../models/Sticker';
import { isAnimated, toGifMp4, toModelImage, toModelVideo, toStickerWebp } from '../utils/media';
import { describeStickerGif } from '../utils/vision';

export const STICKER_DIR = './assets/stickers';
const COLLECTION = 'sticker_vectors';

export interface AddStickerOptions {
  buffer: Buffer,
  mime: string,
  kind: StickerKind,
  source: 'upload' | 'received',
  status: StickerStatus,
  description?: string,
  receivedFrom?: string | null,
  /** The file is already in WhatsApp's format (a received sticker or GIF), skip converting it. */
  original?: boolean,
}

/**
 * Stickers and GIFs Sofia can send. Every sticker has a description written by the vision model (editable in the web UI),
 * approved stickers' descriptions are embedded with text-embedding-v4 into the `sticker_vectors` Milvus collection for
 * `search_sticker_gif`. Pending (received, not yet approved) and rejected stickers are not in Milvus, so Sofia can't use them.
 */
export class StickerService {
  constructor(private store: Store, private logger: Logger, private dir = STICKER_DIR) { }

  private get Model() {
    return this.store.db.models.StickerStore as ModelStatic<Sticker>;
  }

  static sha256(buffer: Buffer) {
    return createHash('sha256').update(buffer).digest('base64');
  }

  async ensureCollection(dim = 2048) {
    const has = await this.store.milvus.hasCollection({ collection_name: COLLECTION });
    if (!has.value) {
      await this.store.milvus.createCollection({
        collection_name: COLLECTION,
        fields: [
          { name: 'sticker_id', data_type: 'VarChar', max_length: 32, is_primary_key: true },
          { name: 'kind', data_type: 'VarChar', max_length: 16 },
          { name: 'embedding', data_type: 'FloatVector', type_params: { dim: String(dim) } },
        ],
        index_params: { field_name: 'embedding', index_name: 'vector_index', metric_type: 'L2', index_type: 'HNSW', params: { M: 16, efConstruction: 200 } },
      });
    }
    await this.store.milvus.loadCollection({ collection_name: COLLECTION });
  }

  findById(id: string) {
    return this.Model.findByPk(id);
  }

  findBySha256(sha256: string) {
    return this.Model.findOne({ where: { sha256 } });
  }

  list(status?: StickerStatus) {
    return this.Model.findAll({ where: status ? { status } : {}, order: [['createdAt', 'DESC']] });
  }

  filePath(sticker: Sticker) {
    return path.join(this.dir, sticker.file);
  }

  readFile(sticker: Sticker) {
    return fs.readFile(this.filePath(sticker));
  }

  /**
   * Saves a sticker or GIF, converting it to WhatsApp's format (512x512 webp sticker, or mp4 GIF) unless `original`.
   * Returns the existing sticker if the same file was saved before. A description is written by the vision model if none
   * is given (if that fails the description is left empty and can be written in the web UI).
   */
  async add(options: AddStickerOptions): Promise<{ sticker: Sticker, created: boolean }> {
    let { buffer, mime } = options;
    let animated: boolean;
    if (options.kind == 'sticker') {
      if (options.original) {
        animated = await isAnimated(buffer, mime);
      }
      else {
        ({ webp: buffer, animated } = await toStickerWebp(buffer));
      }
      mime = 'image/webp';
    }
    else {
      if (!options.original && mime != 'video/mp4') {
        buffer = await toGifMp4(buffer, mime);
      }
      mime = 'video/mp4';
      animated = true;
    }

    const sha256 = StickerService.sha256(buffer);
    const existing = await this.findBySha256(sha256);
    if (existing) {
      return { sticker: existing, created: false };
    }

    const id = `stk_${randomBytes(4).toString('hex')}`;
    const file = `${id}.${options.kind == 'sticker' ? 'webp' : 'mp4'}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), buffer);

    let description = options.description?.trim() || '';
    if (!description) {
      description = await this.describe(buffer, mime, options.kind).catch(e => {
        this.logger.error(e, `Failed to describe sticker ${id}`);
        return '';
      });
    }
    const sticker = await this.Model.create({
      id, kind: options.kind, mime, file, sha256, animated, description,
      status: options.status, source: options.source, received_from: options.receivedFrom ?? null,
    });
    if (sticker.status == 'approved') {
      await this.index(sticker);
    }
    return { sticker, created: true };
  }

  /** Writes a description of a sticker or GIF with the vision model. GIFs are sent as a video (first frame if too big). */
  async describe(buffer: Buffer, mime: string, kind: StickerKind) {
    const video = kind == 'gif' ? await toModelVideo(buffer, mime) : null;
    return describeStickerGif(video ?? await toModelImage(buffer, mime), kind);
  }

  /** Re-writes a sticker's description with the vision model. */
  async redescribe(sticker: Sticker) {
    return this.update(sticker, { description: await this.describe(await this.readFile(sticker), sticker.mime, sticker.kind) });
  }

  /** Updates a sticker's description and/or status, keeping Milvus in sync (only approved stickers are searchable). */
  async update(sticker: Sticker, changes: { description?: string, status?: StickerStatus }) {
    await sticker.update(changes);
    if (sticker.status == 'approved') {
      await this.index(sticker);
    }
    else {
      await this.unindex(sticker.id);
    }
    return sticker;
  }

  async delete(sticker: Sticker) {
    await this.unindex(sticker.id);
    await fs.rm(this.filePath(sticker), { force: true });
    await sticker.destroy();
  }

  private async index(sticker: Sticker) {
    const text = `${sticker.kind == 'gif' ? 'GIF' : 'Sticker'}${sticker.animated ? ' (animated)' : ''}: ${sticker.description}`;
    await this.store.milvus.upsert({
      collection_name: COLLECTION,
      data: [{ sticker_id: sticker.id, kind: sticker.kind, embedding: await this.store.getEmbedding(text) }],
    });
  }

  private async unindex(id: string) {
    await this.store.milvus.deleteEntities({ collection_name: COLLECTION, expr: `sticker_id == "${id}"` });
  }

  /** Finds approved stickers and/or GIFs matching a query, best match first. */
  async search(query: string, kind?: StickerKind, limit = 5): Promise<Sticker[]> {
    const res = await this.store.milvus.search({
      collection_name: COLLECTION,
      vector: await this.store.getEmbedding(query),
      topk: limit,
      params: { anns_field: 'embedding', params: JSON.stringify({ ef: 64 }) },
      expr: kind ? `kind == "${kind}"` : undefined,
      output_fields: ['sticker_id'],
    });
    const ids = (res.results || []).map((r: any) => r.sticker_id as string);
    const stickers = await this.Model.findAll({ where: { id: ids, status: 'approved' } });
    return ids.map(id => stickers.find(s => s.id == id)).filter((s): s is Sticker => !!s);
  }
}
