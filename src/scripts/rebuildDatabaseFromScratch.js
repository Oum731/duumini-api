// src/scripts/rebuildDatabaseFromScratch.js
// Usage: node src/scripts/rebuildDatabaseFromScratch.js
//
// Recrée TOUT le schéma de la base (toutes les tables, vides) dans le bon
// ordre de dépendances (clés étrangères). À lancer APRÈS
// resetDatabase.js --yes-i-am-sure (ou sur une base déjà vide).
//
// Décision explicite du user (2026-11-18) : repartir de zéro sur
// Nindohost, abandon définitif de l'import Hostinger. Contrairement à
// runAllMigrations.js (qui patchait une base Hostinger déjà existante
// mais incomplète), ce script construit le schéma complet depuis zéro,
// y compris les tables centrales (users/shops/products/categories/orders)
// qui n'avaient jamais eu besoin d'être créées jusqu'ici puisqu'elles
// préexistaient toujours.
//
// Les anciens scripts add*.js / rename*.js / migrate*.js qui patchaient
// une base legacy incomplète (addProductBrandFields.js,
// addShopLogoCoverFields.js, renamePasswordHashColumn.js,
// addCommercialRoleEnum.js...) ne sont PAS dans cette liste : leurs
// colonnes sont déjà incluses directement dans les CREATE TABLE
// ci-dessous. addCommercialRoleEnum.js en particulier ne doit JAMAIS être
// lancé sur ce nouveau schéma : il convertirait users.role (VARCHAR
// volontairement souple) en ENUM strict et viderait silencieusement toute
// valeur de rôle hors liste.
//
// Chaque script reste idempotent (safe à relancer) ; celui-ci continue
// même si l'un d'eux échoue, et affiche un résumé à la fin.
//
// N'est jamais exécuté automatiquement.

const { spawnSync } = require("child_process");
const path = require("path");

const SCRIPTS = [
  // --- Tables indépendantes (aucune FK entrante nécessaire) ---
  "createUsersTable.js",
  "createCategoriesTable.js",
  "createShopCategoriesTable.js",
  "createServiceZonesTable.js",
  "createCountryConfigTable.js",
  "createAppSettingsTable.js",
  "createLocationSuggestionsTable.js",
  "createContentItemsTable.js",
  "createPageCopyTable.js",
  "createSalesReportsTable.js",
  "createSalesSnapshotsTable.js",

  // --- Dépendent de content_items / page_copy ---
  "createContentVersionsTable.js",
  "createPageCopyVersionsTable.js",

  // --- Dépendent de users ---
  "createCompaniesTables.js",
  "createCommercialProfilesTable.js",
  "createVendorApplicationsTable.js",
  "createLivreurProfilesTable.js",
  "createCourierTripsTable.js",
  "createNotificationQueueTable.js",
  "createUserDevicesTable.js",
  "createAffiliatesTable.js",
  "createOperationsTable.js",

  // --- Dépendent de companies / affiliates ---
  "createSubscriptionsTables.js",
  "createAffiliateClicksTable.js",

  // --- Dépendent de users + shop_categories ---
  "createShopsTable.js",

  // --- Dépendent de categories ---
  "createSubCategoriesTable.js",

  // --- Dépendent de shops + categories + sub_categories ---
  "createProductsTable.js",

  // --- Dépendent de products ---
  "createProductImagesTable.js",
  "createProductVariantsTable.js",
  "ensureProductRatingsTable.js",

  // --- Dépendent de users + products (warehouse_stock backfill) ---
  "createWarehousesTables.js",

  // --- Dépendent de shops + warehouses + users + products ---
  "createSupplierDeliveriesTables.js",

  // --- Dépendent de shops ---
  "createSupplierProductsTable.js",
  "createDeliveryZonesTable.js",
  "createExpensesTables.js",

  // --- Dépend de expenses + warehouses ---
  "addExpensesWarehouseId.js",

  // --- Dépend de users ---
  "createOrdersTable.js",

  // --- Dépend de orders + products ---
  "createOrderItemsTable.js",
  "addOrderItemsCostSnapshot.js",
  "addOrderCommercialFields.js",

  // --- Dépendent de affiliates + orders ---
  "createAffiliateCommissionsTable.js",
  "createAffiliateRevenueReportsTable.js",

  // --- Correctifs post-création (no-op sur une base neuve, gardés pour
  //     cohérence - pas de donnée à backfiller juste après un reset) ---
  "addCountryCodeColumns.js",
  "backfillProductVertical.js",
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
  console.log("\nSchéma complet reconstruit, base vide et prête ✅");
}
