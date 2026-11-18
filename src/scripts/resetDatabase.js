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
    `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
  );

  if (!tables.length) {
    console.log("[resetDatabase] Aucune table trouvée, rien à supprimer.");
    await pool.end();
    return;
  }

  console.log(`[resetDatabase] ${tables.length} objet(s) à supprimer : ${tables.map((t) => t.TABLE_NAME).join(", ")}`);

  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  const failures = [];
  // Les VIEW doivent être supprimées avec DROP VIEW (DROP TABLE échoue
  // avec "Unknown table"), et une erreur isolée sur un objet ne doit pas
  // arrêter le nettoyage des autres - le script reste idempotent/safe à
  // relancer (IF EXISTS) même après un arrêt partiel précédent.
  for (const { TABLE_NAME, TABLE_TYPE } of tables) {
    const isView = TABLE_TYPE === "VIEW";
    const stmt = isView
      ? `DROP VIEW IF EXISTS \`${TABLE_NAME}\``
      : `DROP TABLE IF EXISTS \`${TABLE_NAME}\``;
    console.log(`[resetDatabase] ${isView ? "DROP VIEW" : "DROP TABLE"} \`${TABLE_NAME}\`...`);
    try {
      await pool.query(stmt);
    } catch (e) {
      console.error(`[resetDatabase] échec sur \`${TABLE_NAME}\`:`, e.message || e);
      failures.push(TABLE_NAME);
    }
  }
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");

  if (failures.length) {
    console.log(`[resetDatabase] ${failures.length} objet(s) n'ont pas pu être supprimés : ${failures.join(", ")}`);
  }
  console.log(`[resetDatabase] ${tables.length - failures.length}/${tables.length} objet(s) supprimé(s).`);

  await pool.end();
  if (failures.length) {
    console.log("[resetDatabase] done (avec échecs - relance le script, DROP ... IF EXISTS est idempotent)");
    process.exitCode = 1;
  } else {
    console.log("[resetDatabase] done");
  }
}

main().catch((e) => {
  console.error("[resetDatabase] FAILED:", e.message || e);
  process.exit(1);
});
