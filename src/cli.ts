import { pathToFileURL } from "node:url";
import {
  comparablePlans,
  createComparisonReport,
  type ComparisonReport,
} from "./comparisonReport.js";
import { calculateCurrentPlanCost, type CurrentPlanCost } from "./currentPlanCost.js";
import { estimatePlanCosts } from "./estimatePlanCosts.js";
import { fetchPlans, type FetchDiagnostic } from "./fetchPlans.js";
import { comparisonDate } from "./planApplicability.js";
import {
  loadAccounts,
  loadBills,
  loadDer,
  loadRecordedPlans,
  loadRetailers,
  loadServicePoints,
  loadUsage,
} from "./loadData.js";

interface CliOptions {
  mode: "FIXTURE" | "LIVE";
  asOf?: string;
  top: number;
}

/** Runs the complete fixture or live comparison and returns display text without coupling tests to console I/O. */
export async function runCli(args: string[]): Promise<string> {
  const options = parseArgs(args);
  const asOf = options.asOf ? comparisonDate(options.asOf) : undefined;
  const usage = loadUsage();
  const servicePoints = loadServicePoints();
  const der = loadDer();
  const current = calculateCurrentPlanCost({
    usage,
    servicePoints,
    accounts: loadAccounts(),
    bills: loadBills(),
  });
  const diagnostics: FetchDiagnostic[] = [];
  const plans =
    options.mode === "LIVE"
      ? await fetchPlans({
          servicePoints,
          retailers: loadRetailers(),
          diagnostics,
          ...(asOf ? { asOf } : {}),
        })
      : loadRecordedPlans();
  const ranked = estimatePlanCosts({
    usage,
    servicePoints,
    der,
    plans,
    ...(options.asOf ? { asOf: options.asOf } : {}),
  });
  const report = createComparisonReport(current, ranked, {
    asOf: options.asOf ?? new Date().toISOString().slice(0, 10),
    source: options.mode === "LIVE" ? "LIVE" : "RECORDED_FIXTURE",
  });
  return formatComparison(report, options, diagnostics);
}

/** Presents the validated baseline first and only labels a candidate as a saving when its numeric cost is lower. */
export function formatComparison(
  report: ComparisonReport,
  options: { top: number },
  diagnostics: FetchDiagnostic[],
): string {
  const current = report.current;
  const costed = comparablePlans(report);
  const lines = [
    "SolvingZero electricity plan comparison",
    `Source: ${report.source === "LIVE" ? "live retailer APIs" : "recorded plan fixture"}`,
    "",
    `Current plan: ${current.planName} — ${current.retailerName} (${current.distributor})`,
    `Observed ${current.usagePeriod.days} days through ${current.usagePeriod.endDate}: ${aud(current.observedCostAud)}`,
    `Annualized current-plan baseline: ${aud(current.annualCostAud)}`,
    formatBillCheck(current),
    "",
  ];

  if (report.recommendation) {
    const { plan, annualSavingAud } = report.recommendation;
    lines.push(
      `Best alternative to check: ${plan.planName} — ${plan.retailerName} [${plan.planId}] — ${aud(plan.annualCostAud!)}/year`,
      `Potential annual saving: ${aud(annualSavingAud)}`,
    );
    if (plan.eligibilityNotes?.length) lines.push(`Important: ${plan.eligibilityNotes.join(" ")}`);
  } else {
    lines.push("No applicable, costable plan in this comparison is cheaper than the current annualized baseline.");
  }

  lines.push("", `Top ${Math.min(options.top, costed.length)} potentially usable costed plans:`);
  costed.slice(0, options.top).forEach((plan, index) => {
    const saving = current.annualCostAud - plan.annualCostAud;
    const eligibility = plan.eligibilityStatus === "UNKNOWN" ? "; eligibility check required" : "";
    const difference = saving > 0 ? `${aud(saving)} saving` : `${aud(-saving)} more`;
    lines.push(
      `${index + 1}. ${plan.planName} — ${plan.retailerName} [${plan.planId}]: ${aud(plan.annualCostAud)} (${difference}${eligibility})`,
    );
  });
  lines.push(
    "",
    `${report.counts.uncostable} applicable plan(s) were excluded because they could not be costed safely.`,
    `${report.counts.knownIneligible} costed plan(s) were not recommended because household data disproved their eligibility.`,
    "Conditional fees, discounts, incentives and unverified eligibility are not included in numeric costs.",
  );
  if (report.exclusionReasons.length > 0) {
    lines.push("Exclusion reasons:");
    for (const { reason, count } of report.exclusionReasons) lines.push(`- ${count} × ${reason}`);
  }
  if (diagnostics.length > 0) {
    lines.push("", `${diagnostics.length} retailer request diagnostic(s):`);
    diagnostics.forEach((diagnostic) => {
      const context = diagnostic.planId ? ` plan ${diagnostic.planId}` : diagnostic.page ? ` page ${diagnostic.page}` : "";
      lines.push(`- ${diagnostic.retailer} ${diagnostic.stage}${context}: ${diagnostic.message}`);
    });
  }
  return lines.join("\n");
}

/** Parses the deliberately small CLI surface and rejects ambiguous dates or result limits. */
function parseArgs(args: string[]): CliOptions {
  let mode: CliOptions["mode"] = "FIXTURE";
  let asOf: string | undefined;
  let top = 5;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--fixture") mode = "FIXTURE";
    else if (argument === "--live") mode = "LIVE";
    else if (argument === "--as-of") asOf = requiredValue(args, ++index, "--as-of");
    else if (argument === "--top") top = Number(requiredValue(args, ++index, "--top"));
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must use YYYY-MM-DD");
  if (!Number.isInteger(top) || top < 1 || top > 50) throw new Error("--top must be an integer from 1 to 50");
  return { mode, ...(asOf ? { asOf } : {}), top };
}

/** Reads the next command-line token and gives a specific error when an option value is missing. */
function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

/** Formats a numeric estimate as Australian dollars for consistent CLI output. */
function aud(value: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
}

/** Adds an explicit sign to bill-reconciliation differences so direction is clear. */
function signedAud(value: number): string {
  return `${value >= 0 ? "+" : "-"}${aud(Math.abs(value))}`;
}

function formatBillCheck(current: CurrentPlanCost): string {
  const reconciliation = current.billReconciliation;
  if (reconciliation.status !== "PASSED") {
    return `Bill check: ${reconciliation.status.toLowerCase()} — ${reconciliation.message}`;
  }
  return (
    `Bill check: ${aud(reconciliation.calculatedCostAud)} calculated vs ` +
    `${aud(reconciliation.invoicedCostAud)} invoiced (${signedAud(reconciliation.differenceAud)})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then((output) => console.log(output))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
