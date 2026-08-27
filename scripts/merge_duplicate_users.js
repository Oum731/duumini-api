// scripts/merge_duplicate_users.js
// Détecte les comptes users en doublon (même numéro réel après
// normalisation — src/utils/phone.js — mais stocké différemment,
// échappé au backfill normalize_phones.js car en collision avec un
// autre compte déjà là). Regroupe les commandes/notifications sur un
// compte canonique, puis supprime le doublon.
//
// Par défaut : DRY-RUN uniquement (aucune écriture), affiche le plan
// détaillé par groupe (compte gardé, compte supprimé, lignes déplacées).
//
// Pour exécuter réellement : node scripts/merge_duplicate_users.js --confirm
// (uniquement après confirmation explicite de l'utilisateur).

require("dotenv").config();
const { getPool } = require("../src/lib/db");
const { normalizePhone } = require("../src/utils/phone");

const CONFIRM = process.argv.includes("--confirm");

// Tables + colonne référençant users.id, à réassigner lors d'une fusion.
// (audité via information_schema — voir conversation ; toutes vides pour
// les groupes détectés sauf orders/notification_queue, mais on couvre
// large par sécurité pour tout futur doublon détecté par ce script.)
const FK_REFS = [
  ["orders", "user_id"],
  ["orders", "created_by_admin_id"],
  ["orders", "discounted_by_admin_id"],
  ["orders", "commercial_id"],
  ["orders", "affiliate_id"],
  ["affiliates", "user_id"],
  ["commercial_profiles", "user_id"],
  ["livreur_profiles", "user_id"],
  ["company_members", "user_id"],
  ["companies", "owner_id"],
  ["expenses", "user_id"],
  ["notification_queue", "user_id"],
  ["product_ratings", "user_id"],
  ["user_devices", "user_id"],
  ["courier_trips", "livreur_user_id"],
  ["courier_trips", "requester_user_id"],
  ["shops", "owner_id"],
  ["shops", "owner_user_id"],
  ["supplier_orders", "created_by_user_id"],
  ["users", "created_by_admin_id"],
];

// Tables qui donnent à un compte un "rôle" fort — si un membre du groupe
// en possède une ligne, il l'emporte toujours comme canonique, quel que
// soit le nombre de commandes de l'autre (ex: Divine COMMERCIAL/affilié
// vs un vieux compte client homonyme).
const ROLE_TABLES = ["affiliates", "commercial_profiles", "livreur_profiles"];

async function countRefs(pool, userId) {
  const refs = {};
  let total = 0;
  for (const [table, col] of FK_REFS) {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = ?`,
      [userId]
    );
    if (cnt > 0) {
      refs[`${table}.${col}`] = cnt;
      total += cnt;
    }
  }
  let hasRole = false;
  for (const table of ROLE_TABLES) {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE user_id = ?`,
      [userId]
    );
    if (cnt > 0) hasRole = true;
  }
  return { refs, total, hasRole };
}

function pickCanonical(members) {
  // 1) un compte avec un rôle fort (affilié/commercial/livreur) gagne
  //    toujours ;
  // 2) sinon, le plus de références (commandes...) gagne ;
  // 3) sinon, le plus ancien (created_at) gagne.
  const sorted = [...members].sort((a, b) => {
    if (a.hasRole !== b.hasRole) return a.hasRole ? -1 : 1;
    if (a.total !== b.total) return b.total - a.total;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return sorted[0];
}

async function main() {
  const pool = getPool();

  console.log(`[merge_duplicate_users] DB cible: ${process.env.DB_NAME || "(inconnue)"}`);
  console.log(`[merge_duplicate_users] Mode: ${CONFIRM ? "EXECUTION (--confirm)" : "DRY-RUN (aucune écriture)"}`);

  const [rows] = await pool.query(
    `SELECT id, phone, first_name, last_name, role, created_at
       FROM users
      WHERE phone IS NOT NULL AND phone <> ''`
  );

  const groups = new Map();
  const unparsable = [];
  for (const r of rows) {
    const canon = normalizePhone(r.phone, "MA");
    if (!canon) {
      unparsable.push(r);
      continue;
    }
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon).push(r);
  }

  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);

  console.log(`\nComptes avec téléphone : ${rows.length}`);
  console.log(`Groupes en doublon (même numéro réel) : ${dupGroups.length}`);
  console.log(`Comptes concernés : ${dupGroups.reduce((n, [, v]) => n + v.length, 0)}`);
  console.log(`Numéros non parsables (ignorés, non touchés) : ${unparsable.length}`);
  if (unparsable.length) {
    for (const u of unparsable) console.log(`  #${u.id}: "${u.phone}" (${u.first_name || ""} ${u.last_name || ""})`);
  }

  const plan = [];

  for (const [canon, members] of dupGroups) {
    const enriched = [];
    for (const m of members) {
      const { refs, total, hasRole } = await countRefs(pool, m.id);
      enriched.push({ ...m, refs, total, hasRole });
    }
    const keep = pickCanonical(enriched);
    const drop = enriched.filter((m) => m.id !== keep.id);

    console.log(`\n=== ${canon} ===`);
    console.log(`  GARDÉ  #${keep.id} "${keep.first_name || ""} ${keep.last_name || ""}" (phone stocké: "${keep.phone}", role: ${keep.role || "-"}, refs: ${JSON.stringify(keep.refs)})`);
    for (const d of drop) {
      console.log(`  SUPPRIMÉ #${d.id} "${d.first_name || ""} ${d.last_name || ""}" (phone stocké: "${d.phone}", role: ${d.role || "-"}, refs à déplacer: ${JSON.stringify(d.refs)})`);
    }

    plan.push({ canon, keep, drop });
  }

  if (!CONFIRM) {
    console.log(`\nDry-run terminé. Aucune écriture effectuée.`);
    console.log(`Pour appliquer réellement : node scripts/merge_duplicate_users.js --confirm`);
    await pool.end();
    return;
  }

  console.log(`\n[merge_duplicate_users] Application des fusions sur ${process.env.DB_NAME}...`);

  for (const { canon, keep, drop } of plan) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const d of drop) {
        for (const [table, col] of FK_REFS) {
          await conn.query(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [keep.id, d.id]);
        }
        await conn.query(`DELETE FROM users WHERE id = ?`, [d.id]);
      }

      // Le compte gardé récupère la forme canonique complète du numéro
      // (les doublons supprimés libèrent la contrainte unique).
      await conn.query(`UPDATE users SET phone = ? WHERE id = ?`, [canon, keep.id]);

      await conn.commit();
      console.log(`  OK: groupe ${canon} fusionné sur #${keep.id} (${drop.length} compte(s) supprimé(s))`);
    } catch (e) {
      await conn.rollback();
      console.error(`  ÉCHEC groupe ${canon}:`, e.message);
    } finally {
      conn.release();
    }
  }

  await pool.end();
  console.log(`\n[merge_duplicate_users] Terminé.`);
}

main().catch((e) => {
  console.error("[merge_duplicate_users] FAILED:", e.message || e);
  process.exit(1);
});
