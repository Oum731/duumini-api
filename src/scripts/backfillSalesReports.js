require("dotenv").config();

const { backfillSalesReports, PERIODS } = require("../services/salesReports");

async function main() {
  const periodArg = String(process.argv[2] || "ALL").toUpperCase();
  const currency = String(process.argv[3] || "MAD").toUpperCase();
  const fromDate = process.argv[4] ? new Date(process.argv[4]) : null;
  const toDate = process.argv[5] ? new Date(process.argv[5]) : new Date();

  const periodTypes =
    periodArg === "ALL" ? PERIODS : PERIODS.includes(periodArg) ? [periodArg] : null;

  if (!periodTypes) {
    throw new Error(
      `period_type invalide. Utilise DAILY, WEEKLY, MONTHLY, YEARLY ou ALL`
    );
  }

  console.log("[backfillSalesReports] start");
  console.log({
    periodTypes,
    currency,
    fromDate: fromDate ? fromDate.toISOString() : null,
    toDate: toDate ? toDate.toISOString() : null,
  });

  for (const period_type of periodTypes) {
    console.log(`[backfillSalesReports] ${period_type}...`);

    const out = await backfillSalesReports({
      period_type,
      currency,
      fromDate,
      toDate,
      onProgress: ({ generated, report }) => {
        console.log(
          `[backfillSalesReports] ${period_type} #${generated} -> ${report.period_start} / ${report.period_end}`
        );
      },
    });

    console.log(`[backfillSalesReports] ${period_type} done`, out);
  }

  console.log("[backfillSalesReports] finished");
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfillSalesReports] error:", e?.message || e);
  process.exit(1);
});