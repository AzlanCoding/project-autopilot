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

export class Assessment extends Model<
  InferAttributes<Assessment>,
  InferCreationAttributes<Assessment>
> {
  declare id: CreationOptional<number>;
  declare subject: string;
  declare title: string;
  declare description?: string | null;
  declare date: number;

  static register(sequelize: Sequelize): ModelStatic<Assessment> {
    Assessment.init(
      {
        id: {
          type: DataTypes.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        subject: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        date: { type: DataTypes.BIGINT, allowNull: false },
      },
      {
        sequelize,
        tableName: 'AssessmentStore',
        timestamps: false,
      }
    );
    return Assessment;
  }
}
