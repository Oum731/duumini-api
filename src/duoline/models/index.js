const { sequelize } = require("../config/db");
const { User } = require("./User");
const { Message, messageInclude, resolveReplyId } = require("./Message");
const { PushSubscription } = require("./PushSubscription");

async function initDb() {
  await sequelize.authenticate();
  // Pas de vraies migrations ici (comme en standalone) : sync suffit pour
  // ces 3 tables simples, isolées dans leur propre base.
  await sequelize.sync();

  // sync() ne modifie pas les tables existantes : les colonnes ajoutées après
  // coup sont créées ici si elles manquent.
  const extraColumns = [
    ["encrypted", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["replyToId", "INT NULL"],
  ];
  for (const [name, definition] of extraColumns) {
    const [cols] = await sequelize.query(`SHOW COLUMNS FROM messages LIKE '${name}'`);
    if (!cols.length) await sequelize.query(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
  }
}

module.exports = { sequelize, User, Message, PushSubscription, messageInclude, resolveReplyId, initDb };
