// src/scripts/syncFromOldDb.js
// Usage: node src/scripts/syncFromOldDb.js [--dry-run]
//
// Copie les données de l'ANCIENNE base (Render/Hostinger, encore active)
// vers la NOUVELLE base (duuminic_besoin sur Nindohost, celle utilisée par
// cette API via .env / DB_*). Ne touche jamais la structure des tables :
// seulement des lectures sur l'ancienne base et des écritures (INSERT ...
// ON DUPLICATE KEY UPDATE) sur la nouvelle, en conservant les `id`
// d'origine pour ne pas casser les clés étrangères (orders.user_id,
// product.shop_id, etc.).
//
// Connexion à l'ancienne base via des variables d'environnement séparées
// (à ajouter dans .env, jamais commitées) :
//   OLD_DB_HOST, OLD_DB_PORT (défaut 3306), OLD_DB_USER, OLD_DB_PASSWORD,
//   OLD_DB_NAME, OLD_DB_SSL (optionnel, "1" pour activer)
//
// Idempotent : relancer ce script ne duplique rien (UPDATE sur les lignes
// déjà présentes, basé sur `id`). Respecte l'ordre des tables pour les
// clés étrangères (users avant shops avant products avant orders, etc.).
// Les tables absentes d'un des deux côtés sont ignorées (avec un message).
// Les colonnes absentes d'un des deux côtés sont ignorées individuellement
// (avec un message), sauf renommages connus (ex: password_hash -> password).

require("dotenv").config();
const mysql = require("mysql2/promise");
const { getPool } = require("../lib/db");

const DRY_RUN = process.argv.includes("--dry-run");

function getOldPool() {
  const required = ["OLD_DB_HOST", "OLD_DB_USER", "OLD_DB_PASSWORD", "OLD_DB_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Variables manquantes pour l'ancienne base : ${missing.join(", ")}. ` +
        "Ajoute-les dans .env (OLD_DB_HOST, OLD_DB_PORT, OLD_DB_USER, OLD_DB_PASSWORD, OLD_DB_NAME).",
    );
  }
  return mysql.createPool({
    host: process.env.OLD_DB_HOST,
    port: process.env.OLD_DB_PORT ? Number(process.env.OLD_DB_PORT) : 3306,
    user: process.env.OLD_DB_USER,
    password: process.env.OLD_DB_PASSWORD,
    database: process.env.OLD_DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    timezone: "Z",
    charset: "utf8mb4",
    ssl: process.env.OLD_DB_SSL ? { rejectUnauthorized: true } : undefined,
  });
}

// Ordre important pour les clés étrangères. Toute table commune non listée
// ici est traitée après, par ordre alphabétique.
const TABLE_ORDER = [
  "users",
  "companies",
  "commercial_profiles",
  "country_config",
  "service_zones",
  "delivery_zones",
  "warehouses",
  "categories",
  "sub_categories",
  "shops",
  "products",
  "product_images",
  "product_variants",
  "suppliers",
  "supplier_products",
  "supplier_deliveries",
  "supplier_delivery_items",
  "vendor_applications",
  "livreur_profiles",
  "courier_trips",
  "orders",
  "order_items",
  "reviews",
  "operations",
  "expense_categories",
  "expenses",
  "subscriptions",
];

// Renommages connus entre l'ancien schéma et l'actuel (voir
// renamePasswordHashColumn.js / migrateUserProfileFields.js). Clé = table,
// valeur = { ancienneColonne: nouvelleColonne }.
const COLUMN_RENAMES = {
  users: {
    password_hash: "password",
    avatar_url: "avatar",
  },
};

// Transformations de valeur après renommage (ex: gender ENUM male/female ->
// sexe ENUM M/F).
const VALUE_TRANSFORMS = {
  users: {
    gender: (v) => {
      if (v == null) return { column: "sexe", value: null };
      const s = String(v).toLowerCase();
      if (s === "male" || s === "m") return { column: "sexe", value: "M" };
      if (s === "female" || s === "f") return { column: "sexe", value: "F" };
      return { column: "sexe", value: null };
    },
  },
};

async function getColumns(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_KEY FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return rows;
}

async function getTables(pool) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
  );
  return new Set(rows.map((r) => r.TABLE_NAME));
}

function orderTables(common) {
  const ordered = TABLE_ORDER.filter((t) => common.has(t));
  const rest = [...common].filter((t) => !TABLE_ORDER.includes(t)).sort();
  return [...ordered, ...rest];
}

async function syncTable(oldPool, newPool, table) {
  const oldCols = await getColumns(oldPool, table);
  const newCols = await getColumns(newPool, table);
  const newColNames = new Set(newCols.map((c) => c.COLUMN_NAME));
  const hasId = newCols.some((c) => c.COLUMN_NAME === "id");

  if (!hasId) {
    console.log(`[syncFromOldDb] \`${table}\` ignorée (pas de colonne id, pas de clé fiable pour l'UPSERT)`);
    return { table, rows: 0, skipped: true };
  }

  const renames = COLUMN_RENAMES[table] || {};
  const transforms = VALUE_TRANSFORMS[table] || {};

  // Colonnes finales (côté nouvelle base) qu'on va alimenter.
  const destColumns = [];
  // Pour chaque colonne destination, comment la lire côté ancienne base :
  // soit une colonne source directe, soit une transformation de valeur.
  const sourceSpecs = [];

  for (const { COLUMN_NAME: oldCol } of oldCols) {
    if (transforms[oldCol]) {
      const probe = transforms[oldCol](null);
      if (newColNames.has(probe.column)) {
        destColumns.push(probe.column);
        sourceSpecs.push({ type: "transform", oldCol, fn: transforms[oldCol] });
      }
      continue;
    }
    const destCol = renames[oldCol] || oldCol;
    if (newColNames.has(destCol)) {
      destColumns.push(destCol);
      sourceSpecs.push({ type: "direct", oldCol });
    }
  }

  if (!destColumns.includes("id")) {
    console.log(`[syncFromOldDb] \`${table}\` ignorée (colonne id non mappable)`);
    return { table, rows: 0, skipped: true };
  }

  const ignoredOldCols = oldCols
    .map((c) => c.COLUMN_NAME)
    .filter((c) => !sourceSpecs.some((s) => s.oldCol === c));
  if (ignoredOldCols.length) {
    console.log(`[syncFromOldDb] \`${table}\` colonnes ignorées (absentes côté nouvelle base) : ${ignoredOldCols.join(", ")}`);
  }

  const selectCols = sourceSpecs.map((s) => s.oldCol);
  const [rows] = await oldPool.query(
    `SELECT ${selectCols.map((c) => `\`${c}\``).join(", ")} FROM \`${table}\``,
  );

  if (!rows.length) {
    console.log(`[syncFromOldDb] \`${table}\` : 0 ligne côté ancienne base, rien à faire`);
    return { table, rows: 0, skipped: false };
  }

  const updateCols = destColumns.filter((c) => c !== "id");
  const placeholders = `(${destColumns.map(() => "?").join(", ")})`;
  const sql = `
    INSERT INTO \`${table}\` (${destColumns.map((c) => `\`${c}\``).join(", ")})
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE ${updateCols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ") || "id = id"}
  `;

  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    for (const row of chunk) {
      const values = sourceSpecs.map((spec) => {
        if (spec.type === "transform") {
          return spec.fn(row[spec.oldCol]).value;
        }
        return row[spec.oldCol];
      });
      if (DRY_RUN) continue;
      await newPool.query(sql, values);
      written += 1;
    }
    if (!DRY_RUN) {
      console.log(`[syncFromOldDb] \`${table}\` : ${Math.min(i + CHUNK, rows.length)}/${rows.length} lignes synchronisées`);
    }
  }

  return { table, rows: DRY_RUN ? rows.length : written, skipped: false };
}

async function main() {
  if (DRY_RUN) {
    console.log("[syncFromOldDb] mode --dry-run : aucune écriture ne sera faite");
  }

  const oldPool = getOldPool();
  const newPool = getPool();

  const [oldTables, newTables] = await Promise.all([getTables(oldPool), getTables(newPool)]);
  const common = new Set([...oldTables].filter((t) => newTables.has(t)));

  const onlyOld = [...oldTables].filter((t) => !newTables.has(t));
  if (onlyOld.length) {
    console.log(`[syncFromOldDb] tables présentes uniquement dans l'ancienne base (ignorées) : ${onlyOld.join(", ")}`);
  }

  const order = orderTables(common);
  console.log(`[syncFromOldDb] tables à synchroniser (${order.length}) : ${order.join(", ")}`);

  const results = [];
  for (const table of order) {
    try {
      const r = await syncTable(oldPool, newPool, table);
      results.push(r);
    } catch (e) {
      console.error(`[syncFromOldDb] \`${table}\` FAILED: ${e.message || e}`);
      results.push({ table, rows: 0, skipped: true, error: e.message || String(e) });
    }
  }

  console.log("\n========== RÉSUMÉ ==========");
  for (const r of results) {
    const mark = r.error ? "❌" : r.skipped ? "⏭️ " : "✅";
    console.log(`${mark} ${r.table} : ${r.rows} ligne(s)${r.error ? ` (${r.error})` : ""}`);
  }

  await oldPool.end();
  await newPool.end();
  console.log("\n[syncFromOldDb] done" + (DRY_RUN ? " (dry-run, rien n'a été écrit)" : ""));
}

main().catch((e) => {
  console.error("[syncFromOldDb] FAILED:", e.message || e);
  process.exit(1);
});
