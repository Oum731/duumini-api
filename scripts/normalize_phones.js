// scripts/normalize_phones.js
// Backfill des numéros de téléphone déjà en base vers la forme canonique
// partagée (src/utils/phone.js).
//
// Par défaut : DRY-RUN uniquement (aucune écriture), affiche un rapport par
// table (nombre de lignes qui changeraient + exemples avant/après).
//
// Pour exécuter le vrai UPDATE : node scripts/normalize_phones.js --confirm
// (à ne lancer qu'après confirmation explicite de l'utilisateur, en rappelant
// le nom de la base cible — voir DB_NAME dans .env).

require("dotenv").config();
const { getPool } = require("../src/lib/db");
const { normalizePhone } = require("../src/utils/phone");

const CONFIRM = process.argv.includes("--confirm");
const SAMPLE_SIZE = 5;

function safeParseJSON(maybe) {
  if (!maybe) return null;
  if (typeof maybe === "object") return maybe;
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}

async function processSimpleTable(pool, { table, idCol, phoneCol, defaultCountry }) {
  const [rows] = await pool.query(
    `SELECT ${idCol} AS id, ${phoneCol} AS phone FROM ${table} WHERE ${phoneCol} IS NOT NULL AND ${phoneCol} <> ''`
  );

  const changes = [];
  const unparsable = [];

  for (const row of rows) {
    const before = row.phone;
    const after = normalizePhone(before, defaultCountry);
    if (!after) {
      unparsable.push({ id: row.id, before });
      continue;
    }
    if (after !== before) {
      changes.push({ id: row.id, before, after });
    }
  }

  return { table, total: rows.length, changes, unparsable };
}

async function processOrdersContact(pool, { defaultCountry }) {
  const [rows] = await pool.query(`SELECT id, contact FROM orders WHERE contact IS NOT NULL AND contact <> ''`);

  const changes = [];
  const unparsable = [];

  for (const row of rows) {
    const contact = safeParseJSON(row.contact);
    if (!contact || !contact.phone) continue;

    const before = contact.phone;
    const after = normalizePhone(before, defaultCountry);
    if (!after) {
      unparsable.push({ id: row.id, before });
      continue;
    }
    if (after !== before) {
      changes.push({ id: row.id, before, after, contact });
    }
  }

  return { table: "orders.contact", total: rows.length, changes, unparsable };
}

function printReport(result) {
  console.log(`\n=== ${result.table} ===`);
  console.log(`Lignes avec téléphone : ${result.total}`);
  console.log(`Changements requis    : ${result.changes.length}`);
  console.log(`Non parsables (ignorées) : ${result.unparsable.length}`);

  if (result.changes.length) {
    console.log(`Exemples avant/après (max ${SAMPLE_SIZE}) :`);
    for (const c of result.changes.slice(0, SAMPLE_SIZE)) {
      console.log(`  #${c.id}: "${c.before}" -> "${c.after}"`);
    }
  }
  if (result.unparsable.length) {
    console.log(`Exemples non parsables (max ${SAMPLE_SIZE}) :`);
    for (const c of result.unparsable.slice(0, SAMPLE_SIZE)) {
      console.log(`  #${c.id}: "${c.before}"`);
    }
  }
}

async function applySimpleTable(pool, { table, idCol, phoneCol }, changes) {
  let updated = 0;
  let skipped = 0;

  for (const c of changes) {
    try {
      await pool.query(`UPDATE ${table} SET ${phoneCol} = ? WHERE ${idCol} = ?`, [c.after, c.id]);
      updated++;
    } catch (e) {
      if (e && e.code === "ER_DUP_ENTRY") {
        console.warn(`  [skip] ${table}#${c.id}: collision unicité ("${c.before}" -> "${c.after}")`);
        skipped++;
      } else {
        throw e;
      }
    }
  }

  return { updated, skipped };
}

async function applyOrdersContact(pool, changes) {
  let updated = 0;

  for (const c of changes) {
    const nextContact = { ...c.contact, phone: c.after };
    await pool.query(`UPDATE orders SET contact = ? WHERE id = ?`, [JSON.stringify(nextContact), c.id]);
    updated++;
  }

  return { updated, skipped: 0 };
}

async function main() {
  const pool = getPool();

  console.log(`[normalize_phones] DB cible: ${process.env.DB_NAME || "(inconnue)"}`);
  console.log(`[normalize_phones] Mode: ${CONFIRM ? "EXECUTION (--confirm)" : "DRY-RUN (aucune écriture)"}`);

  const results = [];

  results.push(await processSimpleTable(pool, { table: "users", idCol: "id", phoneCol: "phone", defaultCountry: "MA" }));
  results.push(await processSimpleTable(pool, { table: "affiliates", idCol: "id", phoneCol: "phone", defaultCountry: "MA" }));
  results.push(
    await processSimpleTable(pool, {
      table: "vendor_applications",
      idCol: "id",
      phoneCol: "contact_phone",
      defaultCountry: "MA",
    })
  );
  results.push(await processOrdersContact(pool, { defaultCountry: "MA" }));

  for (const r of results) printReport(r);

  const totalChanges = results.reduce((n, r) => n + r.changes.length, 0);
  console.log(`\n=== TOTAL ===`);
  console.log(`Lignes à modifier (toutes tables) : ${totalChanges}`);

  if (!CONFIRM) {
    console.log(`\nDry-run terminé. Aucune écriture effectuée.`);
    console.log(`Pour appliquer réellement : node scripts/normalize_phones.js --confirm`);
    await pool.end();
    return;
  }

  console.log(`\n[normalize_phones] Application des changements sur ${process.env.DB_NAME}...`);

  const usersResult = results.find((r) => r.table === "users");
  const affiliatesResult = results.find((r) => r.table === "affiliates");
  const vendorResult = results.find((r) => r.table === "vendor_applications");
  const ordersResult = results.find((r) => r.table === "orders.contact");

  const usersOut = await applySimpleTable(pool, { table: "users", idCol: "id", phoneCol: "phone" }, usersResult.changes);
  console.log(`users: ${usersOut.updated} mis à jour, ${usersOut.skipped} ignorés (collision)`);

  const affiliatesOut = await applySimpleTable(
    pool,
    { table: "affiliates", idCol: "id", phoneCol: "phone" },
    affiliatesResult.changes
  );
  console.log(`affiliates: ${affiliatesOut.updated} mis à jour, ${affiliatesOut.skipped} ignorés (collision)`);

  const vendorOut = await applySimpleTable(
    pool,
    { table: "vendor_applications", idCol: "id", phoneCol: "contact_phone" },
    vendorResult.changes
  );
  console.log(`vendor_applications: ${vendorOut.updated} mis à jour, ${vendorOut.skipped} ignorés (collision)`);

  const ordersOut = await applyOrdersContact(pool, ordersResult.changes);
  console.log(`orders.contact: ${ordersOut.updated} mis à jour`);

  await pool.end();
  console.log(`\n[normalize_phones] Terminé.`);
}

main().catch((e) => {
  console.error("[normalize_phones] FAILED:", e.message || e);
  process.exit(1);
});
