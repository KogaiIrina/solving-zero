import { reconcileBills, type BillReconciliation } from "./billReconciliation.js";
import { costUsageProfile, roundKwh, roundMoney } from "./costEngine.js";
import { getCurrentElectricityPlan, normalizeCurrentPlanTariff } from "./currentPlanTariff.js";
import type { RawAccounts, RawBilling, RawConsumption, RawServicePoints } from "./types.js";
import {
  getDistributor,
  getCurrentRetailer,
  getHouseholdServicePoint,
  getJurisdictionTimeZone,
  normalizeUsageProfile,
} from "./usageProfile.js";

export interface CurrentPlanCostInput {
  usage: RawConsumption;
  servicePoints: RawServicePoints;
  accounts: RawAccounts;
  bills?: RawBilling;
}

export interface CurrentPlanCost {
  planName: string;
  retailerName: string;
  distributor: string;
  usagePeriod: { startDate: string; endDate: string; days: number };
  usageKwh: { peak: number; offPeak: number; export: number };
  breakdown: {
    peakCostAud: number;
    offPeakCostAud: number;
    supplyCostAud: number;
    solarCreditAud: number;
  };
  observedCostAud: number;
  annualCostAud: number;
  billReconciliation: BillReconciliation;
}

/** Builds the validated current-plan baseline that candidate savings must be measured against. */
export function calculateCurrentPlanCost(input: CurrentPlanCostInput): CurrentPlanCost {
  const servicePoint = getHouseholdServicePoint(input.servicePoints);
  const distributor = getDistributor(servicePoint);
  const profile = normalizeUsageProfile(input.usage, servicePoint);
  const currentPlan = getCurrentElectricityPlan(input.accounts, servicePoint.service_point_id, profile);
  const tariff = normalizeCurrentPlanTariff(currentPlan, getJurisdictionTimeZone(servicePoint));
  const observed = costUsageProfile(profile, tariff);
  const peakKwh = observed.usageKwhByCategory.PEAK ?? 0;
  const offPeakKwh = observed.usageKwhByCategory.OFF_PEAK ?? 0;
  const billReconciliation = reconcileBills(
    input.bills,
    profile,
    tariff,
    servicePoint.service_point_id,
  );

  return {
    planName: currentPlan.plan_overview?.display_name ?? "Current electricity plan",
    retailerName: getCurrentRetailer(servicePoint),
    distributor,
    usagePeriod: {
      startDate: profile.days[0]!.date,
      endDate: profile.days.at(-1)!.date,
      days: profile.days.length,
    },
    usageKwh: {
      peak: roundKwh(peakKwh),
      offPeak: roundKwh(offPeakKwh),
      export: roundKwh(observed.exportKwh),
    },
    breakdown: {
      peakCostAud: roundMoney(observed.usageCostAudByCategory.PEAK ?? 0),
      offPeakCostAud: roundMoney(observed.usageCostAudByCategory.OFF_PEAK ?? 0),
      supplyCostAud: roundMoney(observed.supplyCostAud),
      solarCreditAud: roundMoney(observed.solarCreditAud),
    },
    observedCostAud: roundMoney(observed.totalCostAud),
    annualCostAud: roundMoney((observed.totalCostAud * 365) / profile.days.length),
    billReconciliation,
  };
}
