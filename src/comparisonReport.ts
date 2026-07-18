import type { CurrentPlanCost } from "./currentPlanCost.js";
import { roundMoney } from "./costEngine.js";
import type { RankedPlanCost } from "./types.js";

export type ComparisonSource = "RECORDED_FIXTURE" | "LIVE";

export interface ComparisonReport {
  asOf: string;
  source: ComparisonSource;
  current: CurrentPlanCost;
  recommendation: { plan: RankedPlanCost; annualSavingAud: number } | null;
  plans: RankedPlanCost[];
  counts: {
    total: number;
    applicable: number;
    costed: number;
    uncostable: number;
    knownIneligible: number;
  };
  exclusionReasons: Array<{ reason: string; count: number }>;
}

/** Creates the single serializable report consumed by both command-line and web presentations. */
export function createComparisonReport(
  current: CurrentPlanCost,
  plans: RankedPlanCost[],
  options: { asOf: string; source: ComparisonSource },
): ComparisonReport {
  const costed = plans.filter(
    (plan): plan is RankedPlanCost & { annualCostAud: number } =>
      plan.applicable && plan.annualCostAud !== null,
  );
  const recommendation = costed.find(
    (plan) =>
      plan.eligibilityStatus !== "INELIGIBLE" &&
      plan.annualCostAud < current.annualCostAud,
  );
  const uncostable = plans.filter((plan) => plan.applicable && plan.annualCostAud === null);

  return {
    asOf: options.asOf,
    source: options.source,
    current,
    recommendation: recommendation
      ? { plan: recommendation, annualSavingAud: roundMoney(current.annualCostAud - recommendation.annualCostAud) }
      : null,
    plans,
    counts: {
      total: plans.length,
      applicable: plans.filter(({ applicable }) => applicable).length,
      costed: costed.length,
      uncostable: uncostable.length,
      knownIneligible: costed.filter(({ eligibilityStatus }) => eligibilityStatus === "INELIGIBLE").length,
    },
    exclusionReasons: countReasons(uncostable),
  };
}

/** Returns costed plans that are not already disproved by household data, preserving cheapest-first order. */
export function comparablePlans(report: ComparisonReport): Array<RankedPlanCost & { annualCostAud: number }> {
  return report.plans.filter(
    (plan): plan is RankedPlanCost & { annualCostAud: number } =>
      plan.applicable &&
      plan.annualCostAud !== null &&
      plan.eligibilityStatus !== "INELIGIBLE",
  );
}

function countReasons(plans: RankedPlanCost[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  plans.forEach((plan) => {
    const reason = plan.notes?.[0] ?? "Unknown costing error";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  });
  return [...counts].map(([reason, count]) => ({ reason, count }));
}
