const cron = require("node-cron");
const { upsertReport } = require("../services/salesReports");

const CURRENCIES = ["MAD"];

async function generateReport(period_type, currency = "MAD", anchorDate = new Date()) {
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

function startSalesReportsCron() {
  console.log("[salesReportsCron] starting...");

  cron.schedule("5 0 * * *", async () => {
    try {
      await generateAll("DAILY", new Date());
    } catch {}
  });

  cron.schedule("10 0 * * 1", async () => {
    try {
      await generateAll("WEEKLY", new Date());
    } catch {}
  });

  cron.schedule("15 0 1 * *", async () => {
    try {
      await generateAll("MONTHLY", new Date());
    } catch {}
  });

  cron.schedule("20 0 1 1 *", async () => {
    try {
      await generateAll("YEARLY", new Date());
    } catch {}
  });

  console.log("[salesReportsCron] started");
}

module.exports = { startSalesReportsCron };