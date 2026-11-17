// src/scripts/runAllMigrations.js
// Usage: node src/scripts/runAllMigrations.js
//
// Lance, dans l'ordre, tous les scripts de création/migration de tables
// nécessaires pour amener un environnement avec le schéma "historique"
// (import Hostinger incomplet) au niveau attendu par le code actuel.
// Chaque script est idempotent (safe à relancer) ; celui-ci continue même
// si l'un d'eux échoue, et affiche un résumé à la fin.
//
// N'est jamais exécuté automatiquement.

const { spawnSync } = require("child_process");
const path = require("path");

// Ordre important : certaines tables référencent d'autres (FK), certaines
// colonnes sont ajoutées "AFTER" une colonne posée par le script précédent.
const SCRIPTS = [
  "createCompaniesTables.js",
  "createCommercialProfilesTable.js",
  "createServiceZonesTable.js",
  "createCountryConfigTable.js",
  "createWarehousesTables.js",
  "createSupplierDeliveriesTables.js",
  "createSubscriptionsTables.js",
  "createOperationsTable.js",
  "createSubCategoriesTable.js",
  "createProductImagesTable.js",
  "createProductVariantsTable.js",
  "createExpensesTables.js",
  "createSupplierProductsTable.js",
  "createDeliveryZonesTable.js",
  "ensureProductRatingsTable.js",

  "addCountryCodeColumns.js",
  "addProductBrandFields.js",
  "addProductSupplierPriceField.js",
  "addProductPartnerPriceField.js",
  "addProductWarehouseAndUnits.js",
  "addProductIsActiveField.js",
  "addProductVerticalAndPromoFields.js",
  "backfillProductVertical.js",
  "addShopLogoCoverFields.js",
  "addShopType.js",
  "addExpensesWarehouseId.js",

  "renamePasswordHashColumn.js",
  "migrateUserProfileFields.js",
];

const results = [];

for (const script of SCRIPTS) {
  const fullPath = path.join(__dirname, script);
  console.log(`\n========== ${script} ==========`);
  const r = spawnSync(process.execPath, [fullPath], { stdio: "inherit" });
  results.push({ script, ok: r.status === 0 });
}

console.log("\n========== RÉSUMÉ ==========");
for (const { script, ok } of results) {
  console.log(`${ok ? "✅" : "❌"} ${script}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} script(s) en échec - regarde le détail ci-dessus.`);
  process.exit(1);
} else {
  console.log("\nTout est passé ✅");
}
