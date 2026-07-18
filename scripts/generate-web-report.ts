import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createComparisonReport } from "../src/comparisonReport.js";
import { calculateCurrentPlanCost } from "../src/currentPlanCost.js";
import { estimatePlanCosts } from "../src/estimatePlanCosts.js";
import {
  loadAccounts,
  loadBills,
  loadDer,
  loadRecordedPlans,
  loadServicePoints,
  loadUsage,
} from "../src/loadData.js";

const AS_OF = "2026-07-14";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = loadUsage();
const servicePoints = loadServicePoints();
const der = loadDer();
const current = calculateCurrentPlanCost({
  usage,
  servicePoints,
  accounts: loadAccounts(),
  bills: loadBills(),
});
const plans = estimatePlanCosts({
  usage,
  servicePoints,
  der,
  plans: loadRecordedPlans(),
  asOf: AS_OF,
});
const report = createComparisonReport(current, plans, {
  asOf: AS_OF,
  source: "RECORDED_FIXTURE",
});

await writeFile(
  join(root, "web-ui", "app", "comparison-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(`Generated web comparison report with ${report.counts.total} plans as of ${AS_OF}`);
