import {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  DataTypes,
  Sequelize,
  ModelStatic
} from 'sequelize';

/**
 * A WhatsApp poll Sofia sent or saw, kept so votes can be decrypted and counted. Votes are encrypted with the poll's
 * secret, and only name the options by their SHA-256 hash, so both are needed to read them.
 */
export class Poll extends Model<InferAttributes<Poll>, InferCreationAttributes<Poll>> {
  /** The poll message's id, shown to Sofia as `poll_id`. */
  declare id: string;
  /** Chat the poll is in. */
  declare chat: string;
  declare from_me: boolean;
  /** Ids the poll's creator may be known by (phone number and lid jids), tried in order when decrypting votes. */
  declare creator_jids: string[];
  declare question: string;
  declare options: string[];
  declare multiple: boolean;
  /** The poll's message secret (base64), the key votes are encrypted with. */
  declare secret: string;
  declare created_at: CreationOptional<Date>;

  static register(sequelize: Sequelize): ModelStatic<Poll> {
    Poll.init(
      {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        chat: { type: DataTypes.STRING, allowNull: false },
        from_me: { type: DataTypes.BOOLEAN, allowNull: false },
        creator_jids: { type: DataTypes.JSON, allowNull: false },
        question: { type: DataTypes.TEXT, allowNull: false },
        options: { type: DataTypes.JSON, allowNull: false },
        multiple: { type: DataTypes.BOOLEAN, allowNull: false },
        secret: { type: DataTypes.STRING, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      },
      { sequelize, tableName: 'PollStore', timestamps: false }
    );
    return Poll;
  }
}

/** A person's latest vote in a poll (voting again replaces it). An empty `selected` means they took their vote back. */
export class PollVote extends Model<InferAttributes<PollVote>, InferCreationAttributes<PollVote>> {
  declare id: CreationOptional<number>;
  declare poll_id: string;
  /** The voter's jid as WhatsApp gave it (phone number or lid). */
  declare voter: string;
  declare selected: string[];
  declare voted_at: Date;

  static register(sequelize: Sequelize): ModelStatic<PollVote> {
    PollVote.init(
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        poll_id: { type: DataTypes.STRING(64), allowNull: false },
        voter: { type: DataTypes.STRING, allowNull: false },
        selected: { type: DataTypes.JSON, allowNull: false },
        voted_at: { type: DataTypes.DATE, allowNull: false },
      },
      { sequelize, tableName: 'PollVoteStore', timestamps: false, indexes: [{ unique: true, fields: ['poll_id', 'voter'] }] }
    );
    return PollVote;
  }
}
