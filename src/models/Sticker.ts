import {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  DataTypes,
  Sequelize,
  ModelStatic
} from 'sequelize';

export type StickerKind = 'sticker' | 'gif';
export type StickerStatus = 'pending' | 'approved' | 'rejected';

/** A sticker (webp) or GIF (mp4) Sofia can send. Files live in `assets/stickers/`, descriptions are embedded in Milvus. */
export class Sticker extends Model<InferAttributes<Sticker>, InferCreationAttributes<Sticker>> {
  /** Short id shown to Sofia, e.g. `stk_1a2b3c4d`. */
  declare id: string;
  declare kind: StickerKind;
  declare mime: string;
  declare file: string;
  /** SHA-256 of the file (base64), to skip duplicates. */
  declare sha256: string;
  declare animated: boolean;
  declare description: string;
  /** Received stickers are pending until approved in the web UI, uploads are approved. Sofia only uses approved ones. */
  declare status: StickerStatus;
  declare source: 'upload' | 'received';
  /** Who sent a received sticker (WhatsApp jid). */
  declare received_from: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static register(sequelize: Sequelize): ModelStatic<Sticker> {
    Sticker.init(
      {
        id: { type: DataTypes.STRING(32), primaryKey: true },
        kind: { type: DataTypes.STRING(16), allowNull: false },
        mime: { type: DataTypes.STRING(64), allowNull: false },
        file: { type: DataTypes.STRING, allowNull: false },
        sha256: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        animated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
        source: { type: DataTypes.STRING(16), allowNull: false },
        received_from: { type: DataTypes.STRING, allowNull: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      {
        sequelize,
        tableName: 'StickerStore',
      }
    );
    return Sticker;
  }
}
