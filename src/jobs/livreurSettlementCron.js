// src/jobs/livreurSettlementCron.js
// Règlement hebdomadaire des commissions livreur : chaque dimanche 17h,
// tout livreur validé qui a un solde de commission impayé (courses
// DELIVERED, commission_status='PENDING') est bloqué — il ne peut plus
// accepter de nouvelles courses tant que l'admin n'a pas marqué son solde
// comme réglé (cf. PATCH /api/courier-trips/:id/commission-status, qui
// débloque automatiquement dès que le solde retombe à 0).

const cron = require("node-cron");
const { getPool } = require("../lib/db");

const CRON_TZ = process.env.CRON_TZ || "Africa/Casablanca";

async function runLivreurSettlementCheck() {
  const pool = getPool();

  const [rows] = await pool.query(
    `SELECT lp.user_id, COALESCE(SUM(ct.commission_amount), 0) AS due
       FROM livreur_profiles lp
       LEFT JOIN courier_trips ct
         ON ct.livreur_user_id = lp.user_id
        AND ct.status = 'DELIVERED'
        AND ct.commission_status = 'PENDING'
      WHERE lp.verification_status = 'VALIDATED'
      GROUP BY lp.user_id
     HAVING due > 0`
  );

  if (!rows.length) {
    console.log("[livreurSettlementCron] aucun livreur en impayé");
    return;
  }

  const userIds = rows.map((r) => r.user_id);
  await pool.query(
    `UPDATE livreur_profiles SET is_blocked = 1 WHERE user_id IN (?)`,
    [userIds]
  );
  console.log(`[livreurSettlementCron] ${userIds.length} livreur(s) bloqué(s) pour commission impayée`);
}

function startLivreurSettlementCron() {
  console.log("[livreurSettlementCron] starting...");
  console.log("[livreurSettlementCron] timezone =", CRON_TZ);

  cron.schedule(
    "0 17 * * 0", // dimanche 17h
    async () => {
      try {
        await runLivreurSettlementCheck();
      } catch (e) {
        console.error("[livreurSettlementCron][WEEKLY]", e?.message || e);
      }
    },
    { timezone: CRON_TZ }
  );

  console.log("[livreurSettlementCron] started");
}

module.exports = { startLivreurSettlementCron, runLivreurSettlementCheck };
