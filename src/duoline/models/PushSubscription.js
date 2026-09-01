const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const { User } = require("./User");

const PushSubscription = sequelize.define(
  "PushSubscription",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    endpoint: { type: DataTypes.STRING(600), allowNull: false, unique: true },
    p256dh: { type: DataTypes.STRING, allowNull: false },
    auth: { type: DataTypes.STRING, allowNull: false },
  },
  { tableName: "push_subscriptions", timestamps: true }
);

PushSubscription.belongsTo(User, { foreignKey: "userId" });
User.hasMany(PushSubscription, { foreignKey: "userId" });

module.exports = { PushSubscription };
