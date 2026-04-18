// Transferred from older repo via Bing Chat
import {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  DataTypes,
  Sequelize,
  ModelStatic
} from 'sequelize';

export class Assignment extends Model<
  InferAttributes<Assignment>,
  InferCreationAttributes<Assignment>
> {
  declare id: CreationOptional<number>;
  declare subject: string;
  declare title: string;
  declare description?: string | null;
  declare dueDate: number;

  static register(sequelize: Sequelize): ModelStatic<Assignment> {
    Assignment.init(
      {
        id: {
          type: DataTypes.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        subject: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        dueDate: { type: DataTypes.BIGINT, allowNull: false },
      },
      {
        sequelize,
        tableName: 'AssignmentStore',
        timestamps: false,
      }
    );
    return Assignment;
  }
}
