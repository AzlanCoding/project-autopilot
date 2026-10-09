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
 * A task Sofia scheduled for herself. One-off tasks use `runAt`, recurring tasks use `cronPattern`.
 */
export class ScheduledTask extends Model<
  InferAttributes<ScheduledTask>,
  InferCreationAttributes<ScheduledTask>
> {
  declare id: CreationOptional<string>;
  declare task: string;
  declare recurring: boolean;
  declare runAt: number | null;
  declare cronPattern: string | null;
  declare contextChatId: string | null;
  declare createdAt: number;
  declare lastRunAt: CreationOptional<number | null>;

  static register(sequelize: Sequelize): ModelStatic<ScheduledTask> {
    ScheduledTask.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
        },
        task: { type: DataTypes.TEXT, allowNull: false },
        recurring: { type: DataTypes.BOOLEAN, allowNull: false },
        runAt: { type: DataTypes.BIGINT, allowNull: true },
        cronPattern: { type: DataTypes.STRING, allowNull: true },
        contextChatId: { type: DataTypes.STRING, allowNull: true },
        createdAt: { type: DataTypes.BIGINT, allowNull: false },
        lastRunAt: { type: DataTypes.BIGINT, allowNull: true },
      },
      {
        sequelize,
        tableName: 'ScheduledTaskStore',
        timestamps: false,
      }
    );
    return ScheduledTask;
  }
}
