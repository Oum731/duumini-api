const { Sequelize } = require("sequelize");
const { env } = require("./env");

// Connexion MySQL isolée (Sequelize) — indépendante du pool mysql2/Prisma
// de duumini-api, pointe sur la base dédiée DuoLine.
const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: "mysql",
  logging: false,
});

module.exports = { sequelize };
