const { sequelize } = require("../config/db");
const { User } = require("./User");
const { Message } = require("./Message");
const { PushSubscription } = require("./PushSubscription");

async function initDb() {
  await sequelize.authenticate();
  // Pas de vraies migrations ici (comme en standalone) : sync suffit pour
  // ces 3 tables simples, isolées dans leur propre base.
  await sequelize.sync();
}

module.exports = { sequelize, User, Message, PushSubscription, initDb };
