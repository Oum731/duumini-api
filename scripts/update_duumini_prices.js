// api/scripts/update_duumini_prices.js
// Script de mise à jour des colonnes liées à la commission Duumini
// Nouvelle logique :
//  - products.price = prix normal du produit (prix client final)
//  - duumini_rate   = pourcentage Duumini (0.18, 0.11, ...)
//  - duumini_fee    = montant prélevé par Duumini = ROUND(price * duumini_rate)
//  - price_vendor   = net vendeur = price - duumini_fee

/* ⚠️ Chemin vers getPool adapté à ta structure actuelle */
const { getPool } = require("../src/lib/db");

async function main() {
  const pool = getPool();

  console.log("➡️ Ajout des colonnes de commission si besoin…");
  // On ajoute les colonnes si elles n'existent pas déjà.
  // (MySQL 8+ supporte ADD COLUMN IF NOT EXISTS)
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS duumini_rate DECIMAL(5,4) NULL,
      ADD COLUMN IF NOT EXISTS price_vendor INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS duumini_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS duumini_fee INT NOT NULL DEFAULT 0
  `);

  console.log("➡️ Normalisation du duumini_rate selon sub_category (si NULL ou 0)…");
  // Si le taux n'est pas renseigné, on le déduit de sub_category :
  //  - 'food'  → 0.18
  //  - autres → 0.11
  await pool.query(`
    UPDATE products
    SET duumini_rate = CASE
      WHEN LOWER(TRIM(COALESCE(sub_category, ''))) = 'food' THEN 0.18
      ELSE 0.11
    END
    WHERE duumini_rate IS NULL OR duumini_rate <= 0
  `);

  console.log("➡️ Mise à jour de duumini_percent (en %) depuis duumini_rate…");
  await pool.query(`
    UPDATE products
    SET duumini_percent = ROUND(duumini_rate * 100)
    WHERE duumini_rate IS NOT NULL AND duumini_rate > 0
  `);

  console.log("➡️ Calcul de la commission Duumini (duumini_fee) et du net vendeur (price_vendor)…");
  // Ici on applique la NOUVELLE LOGIQUE :
  //  - price = prix normal du produit (client) → on ne le modifie pas
  //  - duumini_fee   = ROUND(price * duumini_rate)
  //  - price_vendor  = price - duumini_fee
  await pool.query(`
    UPDATE products
    SET
      duumini_fee   = ROUND(price * duumini_rate),
      price_vendor  = price - ROUND(price * duumini_rate)
    WHERE price > 0 AND duumini_rate IS NOT NULL AND duumini_rate > 0
  `);

  console.log("✅ Mise à jour des prix / commissions terminée !");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur script update_duumini_prices:", err);
  process.exit(1);
});
