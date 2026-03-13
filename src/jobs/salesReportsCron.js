const cron = require("node-cron");
const { upsertReport } = require("../services/salesReports");

const CURRENCIES = ["MAD"];
const CRON_TZ = process.env.CRON_TZ || "Africa/Casablanca";

function addDays(date, days) {
  const x = new Date(date);
  x.setDate(x.getDate() + days);
  return x;
}

function addMonths(date, months) {
  const x = new Date(date);
  x.setMonth(x.getMonth() + months);
  return x;
}

function addYears(date, years) {
  const x = new Date(date);
  x.setFullYear(x.getFullYear() + years);
  return x;
}

async function generateReport(
  period_type,
  currency = "MAD",
  anchorDate = new Date()
) {
  try {
    const out = await upsertReport({
      period_type,
      anchorDate,
      currency,
    });

    console.log(
      `[salesReportsCron] ${period_type} ${currency} OK -> ${out.period_start} / ${out.period_end}`
    );

    return out;
  } catch (e) {
    console.error(
      `[salesReportsCron] ${period_type} ${currency} ERROR:`,
      e?.message || e
    );
    throw e;
  }
}

async function generateAll(period_type, anchorDate = new Date()) {
  const results = [];

  for (const currency of CURRENCIES) {
    const out = await generateReport(period_type, currency, anchorDate);
    results.push(out);
  }

  return results;
}

async function warmupReports() {
  try {
    console.log("[salesReportsCron] warmup DAILY...");
    await generateAll("DAILY", addDays(new Date(), -1));
    console.log("[salesReportsCron] warmup DAILY OK");
  } catch (e) {
    console.error("[salesReportsCron] warmup DAILY ERROR:", e?.message || e);
  }

  try {
    console.log("[salesReportsCron] warmup WEEKLY...");
    await generateAll("WEEKLY", addDays(new Date(), -7));
    console.log("[salesReportsCron] warmup WEEKLY OK");
  } catch (e) {
    console.error("[salesReportsCron] warmup WEEKLY ERROR:", e?.message || e);
  }

  try {
    console.log("[salesReportsCron] warmup MONTHLY...");
    await generateAll("MONTHLY", addMonths(new Date(), -1));
    console.log("[salesReportsCron] warmup MONTHLY OK");
  } catch (e) {
    console.error("[salesReportsCron] warmup MONTHLY ERROR:", e?.message || e);
  }

  try {
    console.log("[salesReportsCron] warmup YEARLY...");
    await generateAll("YEARLY", addYears(new Date(), -1));
    console.log("[salesReportsCron] warmup YEARLY OK");
  } catch (e) {
    console.error("[salesReportsCron] warmup YEARLY ERROR:", e?.message || e);
  }
}

function startSalesReportsCron() {
  console.log("[salesReportsCron] starting...");
  console.log("[salesReportsCron] timezone =", CRON_TZ);

  setTimeout(() => {
    warmupReports().catch((e) => {
      console.error("[salesReportsCron] warmup global ERROR:", e?.message || e);
    });
  }, 5000);

  cron.schedule(
    "5 0 * * *",
    async () => {
      try {
        await generateAll("DAILY", addDays(new Date(), -1));
      } catch (e) {
        console.error("[salesReportsCron][DAILY]", e?.message || e);
      }
    },
    { timezone: CRON_TZ }
  );

  cron.schedule(
    "10 0 * * 1",
    async () => {
      try {
        await generateAll("WEEKLY", addDays(new Date(), -7));
      } catch (e) {
        console.error("[salesReportsCron][WEEKLY]", e?.message || e);
      }
    },
    { timezone: CRON_TZ }
  );

  cron.schedule(
    "15 0 1 * *",
    async () => {
      try {
        await generateAll("MONTHLY", addMonths(new Date(), -1));
      } catch (e) {
        console.error("[salesReportsCron][MONTHLY]", e?.message || e);
      }
    },
    { timezone: CRON_TZ }
  );

  cron.schedule(
    "20 0 1 1 *",
    async () => {
      try {
        await generateAll("YEARLY", addYears(new Date(), -1));
      } catch (e) {
        console.error("[salesReportsCron][YEARLY]", e?.message || e);
      }
    },
    { timezone: CRON_TZ }
  );

  console.log("[salesReportsCron] started");
}

module.exports = { startSalesReportsCron };