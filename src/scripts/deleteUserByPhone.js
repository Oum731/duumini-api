// src/scripts/deleteUserByPhone.js
//
// Usage :
//   node src/scripts/deleteUserByPhone.js "<téléphone>"             (aperçu, ne supprime rien)
//   node src/scripts/deleteUserByPhone.js "<téléphone>" --force     (supprime réellement)
//
// Supprime un compte de test (et ses données directement liées : boutiques,
// commandes, entreprise possédée, profils commercial/livreur/affilié,
// dépenses...) identifié par son numéro de téléphone.
//
// Sans --force : affiche seulement ce qui serait supprimé (aperçu).
// Avec --force : supprime pour de vrai, dans une transaction (tout ou rien).
//
// Si le compte a des données qu'un script générique ne doit pas supprimer
// sans confirmation explicite (ex: des produits dans une boutique, qui
// seraient orphelins), la suppression échoue avec un message clair plutôt
// que de tout effacer en cascade à l'aveugle.
//
// Jamais exécuté automatiquement.

require("dotenv").config();
const { getPool } = require("../lib/db");
const { normPhone } = require("../utils/phone");

// Lignes qui APPARTIENNENT au compte (supprimées avec lui).
const OWNED = [
  ["shops", "owner_id"],
  ["orders", "user_id"],
  ["company_members", "user_id"],
  ["commercial_profiles", "user_id"],
  ["livreur_profiles", "user_id"],
  ["courier_trips", "requester_user_id"],
  ["courier_trips", "livreur_user_id"],
  ["affiliates", "user_id"],
  ["expenses", "user_id"],
  ["warehouse_managers", "user_id"],
  // ON DELETE CASCADE déjà en base — listées pour l'aperçu uniquement.
  ["user_devices", "user_id"],
  ["product_ratings", "user_id"],
];

// Références "acteur" optionnelles : on vide juste la colonne (NULL),
// la ligne elle-même (commande, opération...) n'appartient pas au compte.
const NULLABLE_REFS = [
  ["orders", "created_by_admin_id"],
  ["orders", "discounted_by_admin_id"],
  ["orders", "commercial_id"],
  ["operations", "responsible_user_id"],
  ["operations", "created_by"],
  ["company_subscriptions", "activated_by"],
  ["company_subscription_events", "performed_by"],
  ["vendor_applications", "reviewed_by"],
  ["supplier_deliveries", "received_by"],
  ["warehouse_managers", "assigned_by"],
  ["stock_movements", "performed_by"],
];

async function tableExists(pool, table) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return row.n > 0;
}

async function countWhere(pool, table, column, userId) {
  if (!(await tableExists(pool, table))) return null;
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ?`,
    [userId],
  );
  return row.n;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const phoneArg = args.find((a) => !a.startsWith("--"));

  if (!phoneArg) {
    console.error('Usage: node src/scripts/deleteUserByPhone.js "<téléphone>" [--force]');
    process.exit(1);
  }

  const phone = normPhone(phoneArg) || phoneArg.trim();
  const pool = getPool();

  const [[user]] = await pool.query(
    "SELECT id, phone, first_name, last_name, role, created_at FROM users WHERE phone = ? LIMIT 1",
    [phone],
  );

  if (!user) {
    console.log(`Aucun utilisateur trouvé pour le numéro "${phone}".`);
    await pool.end();
    return;
  }

  console.log("Utilisateur trouvé :");
  console.log(`  id=${user.id} phone=${user.phone} role=${user.role} nom="${[user.first_name, user.last_name].filter(Boolean).join(" ")}" créé le ${user.created_at}`);
  console.log("");

  // ✅ companies.owner_id : géré à part (nécessite de nettoyer
  // company_members des entreprises possédées avant de les supprimer).
  const [[ownedCompaniesCount]] = (await tableExists(pool, "companies"))
    ? [[{ n: await countWhere(pool, "companies", "owner_id", user.id) }]]
    : [[{ n: null }]];

  console.log("Données liées trouvées :");
  for (const [table, column] of OWNED) {
    const n = await countWhere(pool, table, column, user.id);
    if (n == null) continue;
    if (n > 0) console.log(`  - ${table}.${column} : ${n} ligne(s) (seront supprimées)`);
  }
  if (ownedCompaniesCount.n) {
    console.log(`  - companies.owner_id : ${ownedCompaniesCount.n} entreprise(s) possédée(s) (seront supprimées)`);
  }
  for (const [table, column] of NULLABLE_REFS) {
    const n = await countWhere(pool, table, column, user.id);
    if (n == null) continue;
    if (n > 0) console.log(`  - ${table}.${column} : ${n} ligne(s) (référence vidée, ligne conservée)`);
  }

  if (!force) {
    console.log("");
    console.log("Aperçu seulement — rien n'a été supprimé.");
    console.log('Relance avec --force pour supprimer réellement :');
    console.log(`  node src/scripts/deleteUserByPhone.js "${phoneArg}" --force`);
    await pool.end();
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const [table, column] of NULLABLE_REFS) {
      if (!(await tableExists(conn, table))) continue;
      await conn.query(`UPDATE \`${table}\` SET \`${column}\` = NULL WHERE \`${column}\` = ?`, [user.id]);
    }

    if (await tableExists(conn, "companies")) {
      const [ownedCompanies] = await conn.query("SELECT id FROM companies WHERE owner_id = ?", [user.id]);
      for (const c of ownedCompanies) {
        if (await tableExists(conn, "company_members")) {
          await conn.query("DELETE FROM company_members WHERE company_id = ?", [c.id]);
        }
        if (await tableExists(conn, "shops")) {
          await conn.query("UPDATE shops SET company_id = NULL WHERE company_id = ?", [c.id]);
        }
        await conn.query("DELETE FROM companies WHERE id = ?", [c.id]);
      }
    }

    for (const [table, column] of OWNED) {
      if (!(await tableExists(conn, table))) continue;
      await conn.query(`DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [user.id]);
    }

    await conn.query("DELETE FROM users WHERE id = ?", [user.id]);

    await conn.commit();
    console.log("");
    console.log(`✅ Compte ${phone} (id=${user.id}) et ses données liées supprimés.`);
  } catch (e) {
    await conn.rollback();
    console.error("");
    console.error("❌ Suppression annulée (transaction annulée, rien n'a changé).");
    console.error("Cause probable : une donnée liée non prévue par ce script bloque la suppression");
    console.error("(ex: des produits encore rattachés à une boutique de ce compte).");
    console.error("Détail :", e.message || e);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
