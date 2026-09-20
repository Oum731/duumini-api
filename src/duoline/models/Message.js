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
    reactions: { type: DataTypes.JSON, allowNull: true }, // { [userId]: "❤️" } — une réaction par personne
    replyToId: { type: DataTypes.INTEGER, allowNull: true }, // message auquel celui-ci répond
    encrypted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // média chiffré côté client (content = JSON d'URLs de morceaux)
  },
  { tableName: "messages", timestamps: true }
);

Message.belongsTo(User, { as: "sender", foreignKey: "senderId" });
User.hasMany(Message, { as: "messages", foreignKey: "senderId" });
// Réponse à un message (façon WhatsApp) — pas de contrainte FK : la colonne
// est ajoutée à la main sur une table existante (voir initDb).
Message.belongsTo(Message, { as: "replyTo", foreignKey: "replyToId", constraints: false });

// Ce que chaque message renvoyé au client embarque : l'expéditeur et un
// résumé du message cité (pour afficher l'aperçu de la réponse).
function messageInclude() {
  return [
    { model: User, as: "sender", attributes: ["id", "name", "avatarUrl"] },
    {
      model: Message,
      as: "replyTo",
      required: false,
      attributes: ["id", "senderId", "type", "content", "fileName", "duration", "encrypted", "deletedAt"],
    },
  ];
}

// Renvoie l'id fourni s'il désigne bien un message existant, sinon null.
async function resolveReplyId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const target = await Message.findByPk(n, { attributes: ["id"] });
  return target ? target.id : null;
}

module.exports = { Message, messageInclude, resolveReplyId };
