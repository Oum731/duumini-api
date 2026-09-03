const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    // Le nom que CE compte a choisi d'afficher pour son/sa partenaire — ne
    // change rien pour l'autre personne, purement local à ce compte.
    partnerNickname: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "users", timestamps: true }
);

module.exports = { User };
