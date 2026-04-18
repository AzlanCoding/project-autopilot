// Written by Gemma 4 (e4b)
import {
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  DataTypes,
  Sequelize,
  ModelStatic
} from 'sequelize';

export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  declare id: CreationOptional<string>; // Changed type to string for UUID
  declare name: string;
  declare description: string;
  declare whatsapp_jid: string;

  static register(sequelize: Sequelize): ModelStatic<User> {
    User.init(
      {
        id: {
          type: DataTypes.UUID, // Using UUID type
          defaultValue: Sequelize.literal('gen_random_uuid()'), // Setting default to generate UUID
          primaryKey: true,
        },
        name: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false },
        whatsapp_jid: { type: DataTypes.STRING, allowNull: false, unique: true },
      },
      {
        sequelize,
        tableName: 'UserStore', // Changed table name
        timestamps: false,
      }
    );
    return User;
  }
}