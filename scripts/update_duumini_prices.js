// api/scripts/update_duumini_prices.js
const { getPool } = require("../src/lib/db");

const DUUMINI_PERCENT = 20; // 🔁 à adapter

async function main() {
  const pool = getPool();

  console.log("➡️ Ajout des colonnes si besoin…");
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS price_vendor INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS duumini_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS duumini_fee INT NOT NULL DEFAULT 0
  `);

  console.log("➡️ Copie de price -> price_vendor (si vide) …");
  await pool.query(
    `UPDATE products
     SET price_vendor = price
     WHERE price_vendor = 0 OR price_vendor IS NULL`
  );

  console.log("➡️ Mise à jour du pourcentage Duumini…");
  await pool.query(
    `UPDATE products
     SET duumini_percent = ?`,
    [DUUMINI_PERCENT]
  );

  console.log("➡️ Calcul de la commission Duumini et du nouveau prix client…");
  await pool.query(`
    UPDATE products
    SET
      duumini_fee = ROUND(price_vendor * duumini_percent / 100),
      price       = price_vendor + duumini_fee
  `);

  console.log("✅ Terminé !");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur script update_duumini_prices:", err);
  process.exit(1);
});
