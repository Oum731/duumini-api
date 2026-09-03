const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db");
const { User } = require("./User");

const Message = sequelize.define(
  "Message",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.ENUM("text", "image", "video", "audio", "file", "call"),
      allowNull: false,
      defaultValue: "text",
    },
    content: { type: DataTypes.TEXT, allowNull: true }, // texte du message, ou URL du fichier
    fileName: { type: DataTypes.STRING, allowNull: true },
    fileSize: { type: DataTypes.INTEGER, allowNull: true },
    mimeType: { type: DataTypes.STRING, allowNull: true },
    duration: { type: DataTypes.INTEGER, allowNull: true },
    callType: { type: DataTypes.ENUM("audio", "video"), allowNull: true },
    callStatus: { type: DataTypes.ENUM("answered", "missed", "declined"), allowNull: true },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
    editedAt: { type: DataTypes.DATE, allowNull: true }, // message texte modifié après envoi (< 5 min)
    deletedAt: { type: DataTypes.DATE, allowNull: true }, // supprimé par l'expéditeur (contenu effacé, trace gardée)
  },
  { tableName: "messages", timestamps: true }
);

Message.belongsTo(User, { as: "sender", foreignKey: "senderId" });
User.hasMany(Message, { as: "messages", foreignKey: "senderId" });

module.exports = { Message };
