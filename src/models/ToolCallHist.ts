import {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  DataTypes,
  Sequelize,
  ModelStatic
} from 'sequelize';

export class ToolCallHist extends Model<
  InferAttributes<ToolCallHist>,
  InferCreationAttributes<ToolCallHist>
> {
  declare id: CreationOptional<string>; // Changed type to string for UUID
  declare aftId: string;
  declare whatsapp_chat: string;
  declare data: any;


  static register(sequelize: Sequelize): ModelStatic<ToolCallHist> {
    ToolCallHist.init(
      {
        id: {
          type: DataTypes.UUID, // Using UUID type
          defaultValue: Sequelize.literal('gen_random_uuid()'), // Setting default to generate UUID
          primaryKey: true
        },
        aftId: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true
        },
        whatsapp_chat: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: false
        },
        data: {
          type: DataTypes.JSON,
          allowNull: false,
          unique: false
        }
      },
      {
        sequelize,
        tableName: 'ToolHistStore',
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: ['aftId']
          }
        ]
      }
    );
    return ToolCallHist;
  }
}