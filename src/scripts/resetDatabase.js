// src/scripts/resetDatabase.js
// Usage: node src/scripts/resetDatabase.js --yes-i-am-sure
//
// SUPPRIME TOUTES LES TABLES de la base (DROP TABLE sur tout ce qui existe
// dans INFORMATION_SCHEMA.TABLES pour la base courante). Destructeur et
// irréversible : toutes les données sont perdues.
//
// Décision explicite du user (2026-11-18) : repartir de zéro sur
// Nindohost, abandon définitif de l'import Hostinger. Ce script est
// l'étape 1 ; rebuildDatabaseFromScratch.js (étape 2) recrée ensuite tout
// le schéma vide à partir de zéro.
//
// Garde-fou volontaire : refuse de s'exécuter sans le flag
// --yes-i-am-sure, pour qu'on ne puisse jamais le lancer par erreur en
// copiant juste "node src/scripts/resetDatabase.js".
//
// N'est jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");

async function main() {
  if (!process.argv.includes("--yes-i-am-sure")) {
    console.error(
      "[resetDatabase] Refusé : relance avec --yes-i-am-sure pour confirmer " +
        "la suppression DÉFINITIVE de toutes les tables et données.",
    );
    process.exit(1);
  }

  const pool = getPool();

  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
  );

  if (!tables.length) {
    console.log("[resetDatabase] Aucune table trouvée, rien à supprimer.");
    await pool.end();
    return;
  }

  console.log(`[resetDatabase] ${tables.length} table(s) à supprimer : ${tables.map((t) => t.TABLE_NAME).join(", ")}`);

  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const { TABLE_NAME } of tables) {
    console.log(`[resetDatabase] DROP TABLE \`${TABLE_NAME}\`...`);
    await pool.query(`DROP TABLE \`${TABLE_NAME}\``);
  }
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");

  console.log(`[resetDatabase] ${tables.length} table(s) supprimée(s). Base vide.`);

  await pool.end();
  console.log("[resetDatabase] done");
}

main().catch((e) => {
  console.error("[resetDatabase] FAILED:", e.message || e);
  process.exit(1);
});
