import { normalizeCdrPlanTariff } from "./cdrPlanTariff.js";
import { costUsageProfile, roundMoney } from "./costEngine.js";
import {
  assessHouseholdEligibility,
  assessPlanApplicability,
  comparisonDate,
} from "./planApplicability.js";
import type {
  EnergyPlanDetail,
  RankedPlanCost,
  RawConsumption,
  RawDer,
  RawServicePoints,
} from "./types.js";
import {
  getHouseholdServicePoint,
  getJurisdictionTimeZone,
  normalizeUsageProfile,
} from "./usageProfile.js";

export interface EstimateInput {
  usage: RawConsumption;
  servicePoints: RawServicePoints;
  plans: EnergyPlanDetail[];
  der?: RawDer;
  /** Inject for deterministic expiry checks; defaults to the current time. */
  asOf?: Date | string;
}

/** Costs every candidate against the same household profile and returns costable, uncostable, and inapplicable plans. */
export function estimatePlanCosts(input: EstimateInput): RankedPlanCost[] {
  const servicePoint = getHouseholdServicePoint(input.servicePoints);
  const profile = normalizeUsageProfile(input.usage, servicePoint);
  const localTimeZone = getJurisdictionTimeZone(servicePoint);
  const asOf = input.asOf instanceof Date ? input.asOf : comparisonDate(input.asOf);
  if (!Number.isFinite(asOf.valueOf())) throw new Error("Invalid comparison date");

  return input.plans
    .map((plan): RankedPlanCost => {
      const planName = plan.displayName || plan.planId;
      const retailerName = plan.brandName?.trim() || "Unknown retailer";
      let eligibility;
      try {
        eligibility = assessHouseholdEligibility(
          plan,
          input.der,
          servicePoint.service_point_id,
        );
      } catch (error) {
        eligibility = { status: "UNKNOWN" as const, notes: [errorMessage(error)] };
      }
      let applicability;
      try {
        applicability = assessPlanApplicability(plan, servicePoint, asOf);
      } catch (error) {
        return {
          planId: plan.planId,
          planName,
          retailerName,
          applicable: false,
          eligibilityStatus: eligibility.status,
          ...(eligibility.notes.length > 0 ? { eligibilityNotes: eligibility.notes } : {}),
          annualCostAud: null,
          notes: [errorMessage(error)],
        };
      }
      const notes = [...applicability.notes];
      if (!applicability.applicable) {
        return {
          planId: plan.planId,
          planName,
          retailerName,
          applicable: false,
          eligibilityStatus: eligibility.status,
          ...(eligibility.notes.length > 0 ? { eligibilityNotes: eligibility.notes } : {}),
          annualCostAud: null,
          notes,
        };
      }

      try {
        notes.push(...comparisonNotes(plan));
        const tariff = normalizeCdrPlanTariff(plan, profile, localTimeZone);
        const observed = costUsageProfile(profile, tariff);
        const annualization = 365 / profile.days.length;
        return {
          planId: plan.planId,
          planName,
          retailerName,
          applicable: true,
          eligibilityStatus: eligibility.status,
          ...(eligibility.notes.length > 0 ? { eligibilityNotes: eligibility.notes } : {}),
          annualCostAud: roundMoney(observed.totalCostAud * annualization),
          breakdown: {
            usageCost: roundMoney(observed.usageCostAud * annualization),
            controlledLoadCost: roundMoney(observed.controlledLoadCostAud * annualization),
            supplyCost: roundMoney(observed.supplyCostAud * annualization),
            solarCredit: roundMoney(observed.solarCreditAud * annualization),
          },
          ...(notes.length > 0 ? { notes } : {}),
        };
      } catch (error) {
        return {
          planId: plan.planId,
          planName,
          retailerName,
          applicable: true,
          eligibilityStatus: eligibility.status,
          ...(eligibility.notes.length > 0 ? { eligibilityNotes: eligibility.notes } : {}),
          annualCostAud: null,
          notes: [errorMessage(error), ...notes],
        };
      }
    })
    .sort(compareRankedPlans);
}

/** Surfaces exclusions from numeric costing that a household still needs to verify before switching. */
function comparisonNotes(plan: EnergyPlanDetail): string[] {
  const notes: string[] = [];
  if (
    (plan.electricityContract.fees?.length ?? 0) > 0 ||
    (plan.electricityContract.discounts?.length ?? 0) > 0 ||
    (plan.electricityContract.incentives?.length ?? 0) > 0
  ) {
    notes.push("Conditional fees, discounts and incentives are excluded from the comparable tariff cost");
  }
  return notes;
}

/** Orders safe numeric estimates first, then explicit costing exclusions, then inapplicable plans. */
function compareRankedPlans(left: RankedPlanCost, right: RankedPlanCost): number {
  // Grouping keeps a zero-like failed estimate from ever outranking a genuinely costed plan.
  const group = (plan: RankedPlanCost) => {
    if (!plan.applicable) return 2;
    return typeof plan.annualCostAud === "number" ? 0 : 1;
  };
  const groupDifference = group(left) - group(right);
  if (groupDifference !== 0) return groupDifference;
  if (typeof left.annualCostAud === "number" && typeof right.annualCostAud === "number") {
    const costDifference = left.annualCostAud - right.annualCostAud;
    if (costDifference !== 0) return costDifference;
  }
  return left.planName.localeCompare(right.planName) || left.planId.localeCompare(right.planId);
}

/** Converts unknown adapter failures into a stable note attached to the affected plan. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown plan costing error";
}
