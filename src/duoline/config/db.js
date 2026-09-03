const { Sequelize } = require("sequelize");
const { env } = require("./env");

// Connexion MySQL isolée (Sequelize) — indépendante du pool mysql2/Prisma
// de duumini-api, pointe sur la base dédiée DuoLine.
const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: "mysql",
  logging: false,
  dialectOptions: { connectTimeout: 20000 },
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  // L'hébergement mutualisé de la base (Hostinger) a occasionnellement des
  // ETIMEDOUT transitoires juste après un redémarrage du service — on
  // réessaie automatiquement au lieu de faire échouer la requête.
  retry: { max: 3, match: [/ETIMEDOUT/, /ECONNREFUSED/, /ECONNRESET/, /PROTOCOL_CONNECTION_LOST/] },
});

module.exports = { sequelize };
