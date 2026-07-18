import {
  normalizeTiers,
  parseNonNegativePrice,
  parsePrice,
  type NormalizedRate,
  type NormalizedTariff,
  type NormalizedTariffPeriod,
} from "./costEngine.js";
import { normalizeMonthDay, normalizeWindow } from "./tariffClock.js";
import type { RawAccounts, RawElectricityContract, SnakeRate } from "./types.js";
import { validateIsoDate, type UsageProfile } from "./usageProfile.js";

export type AccountPlan = NonNullable<RawAccounts["accounts"][number]["plans"]>[number];
type TariffPeriod = NonNullable<RawElectricityContract["tariff_period"]>[number];

/** Finds the single account tariff covering the supplied usage so the baseline is not built from the wrong plan. */
export function getCurrentElectricityPlan(
  accounts: RawAccounts,
  servicePointId: string,
  profile: UsageProfile,
): AccountPlan {
  const usageStart = profile.days[0]!.date;
  const usageEnd = profile.days.at(-1)!.date;
  const electricityPlans = accounts.accounts
    .flatMap((account) => account.plans ?? [])
    .filter(
      (plan) =>
        plan.service_point_ids?.includes(servicePointId) && plan.plan_detail?.fuel_type === "ELECTRICITY",
    );

  for (const plan of electricityPlans) {
    if (plan.plan_overview?.start_date) validateIsoDate(plan.plan_overview.start_date);
    if (plan.plan_overview?.end_date) validateIsoDate(plan.plan_overview.end_date);
  }
  const plans = electricityPlans.filter(
    (plan) =>
      (!plan.plan_overview?.start_date || plan.plan_overview.start_date <= usageEnd) &&
      (!plan.plan_overview?.end_date || plan.plan_overview.end_date >= usageEnd),
  );
  if (plans.length !== 1) throw new Error(`Expected one current electricity plan, found ${plans.length}`);

  const plan = plans[0]!;
  if (plan.plan_overview?.start_date && usageStart < plan.plan_overview.start_date) {
    throw new Error("Usage starts before the current plan");
  }
  if (plan.plan_overview?.end_date && usageEnd > plan.plan_overview.end_date) {
    throw new Error("Usage ends after the current plan");
  }
  return plan;
}

/** Adapts the current plan's snake_case contract to the shared tariff model used for all comparisons. */
export function normalizeCurrentPlanTariff(plan: AccountPlan, localTimeZone: string): NormalizedTariff {
  const contract = plan.plan_detail?.electricity_contract;
  const rawPeriods = contract?.tariff_period ?? [];
  if (rawPeriods.length === 0) throw new Error("The current plan has no tariff periods");

  const periods = rawPeriods.map((period, index) => normalizePeriod(period, index));
  const feedInRates = normalizeFeedIn(contract);
  return {
    // Although the source labels this tariff AEST, invoice quantities only reconcile when the fixed-AEST
    // interval rows are converted to Victorian wall time. This evidence-backed exception is explicit here;
    // fetched CDR plans honor their declared AEST/LOCAL clock in their own adapter.
    clockBasis: "LOCAL",
    localTimeZone,
    periods,
    feedInRates,
  };
}

/** Converts one current-plan season and its flat or time-of-use prices into a costable period. */
function normalizePeriod(period: TariffPeriod, index: number): NormalizedTariffPeriod {
  const label = `current tariff period ${index + 1}`;
  const base = {
    id: `current-period-${index}`,
    startMonthDay: normalizeMonthDay(period.start_date, "START"),
    endMonthDay: normalizeMonthDay(period.end_date, "END"),
    dailySupplyCharge: parseNonNegativePrice(period.daily_supply_charge, `${label} daily supply charge`),
  };

  if (period.rate_block_u_type === "singleRate") {
    const rates = period.single_rate?.rates ?? [];
    validateMeasureUnits(rates, label);
    const normalized = normalizeTiers(
      rates.map((rate) => ({ unitPrice: rate.unit_price, volume: rate.volume })),
      period.single_rate?.period,
      `${label} usage rate`,
    );
    return {
      ...base,
      usageRates: [{ id: `${base.id}-single`, category: "SINGLE", ...normalized }],
    };
  }

  if (period.rate_block_u_type === "timeOfUseRates") {
    const timeOfUseRates = period.time_of_use_rates ?? [];
    if (timeOfUseRates.length === 0) throw new Error(`${label} has no time-of-use rates`);
    return {
      ...base,
      usageRates: timeOfUseRates.map((rate, rateIndex): NormalizedRate => {
        validateMeasureUnits(rate.rates, `${label} ${rate.type}`);
        const normalized = normalizeTiers(
          rate.rates.map((price) => ({ unitPrice: price.unit_price, volume: price.volume })),
          rate.period,
          `${label} ${rate.type}`,
        );
        if (rate.time_of_use.length === 0) throw new Error(`${label} ${rate.type} has no time windows`);
        return {
          id: `${base.id}-tou-${rateIndex}`,
          category: rate.type,
          ...normalized,
          windows: rate.time_of_use.map((window) =>
            normalizeWindow(window.days, window.start_time, window.end_time, `${label} ${rate.type}`),
          ),
        };
      }),
    };
  }
  throw new Error(`Unsupported current pricing structure: ${period.rate_block_u_type ?? "missing"}`);
}

/** Selects the one kWh feed-in tariff and normalizes signed source prices into positive credit rates. */
function normalizeFeedIn(contract: RawElectricityContract | undefined): NormalizedRate[] {
  const kwhTariffs = (contract?.solar_feed_in_tariff ?? [])
    .map((tariff) => ({
      tariff,
      rates: (tariff.single_tariff?.rates ?? []).filter(
        (rate) => !rate.measure_unit || rate.measure_unit.toUpperCase() === "KWH",
      ),
    }))
    .filter(({ rates }) => rates.length > 0);
  if (kwhTariffs.length !== 1) throw new Error(`Expected one KWH solar feed-in tariff, found ${kwhTariffs.length}`);

  const { tariff, rates } = kwhTariffs[0]!;
  const normalized = normalizeTiers(
    rates.map((rate) => ({
      unitPrice: String(Math.abs(parsePrice(rate.unit_price, "solar feed-in rate"))),
      volume: rate.volume,
    })),
    tariff.single_tariff?.period,
    "solar feed-in tariff",
  );
  return [{ id: "current-feed-in", category: "FEED_IN", ...normalized }];
}

/** Rejects non-energy rates before they can be mistaken for per-kWh charges. */
function validateMeasureUnits(rates: SnakeRate[], label: string): void {
  const invalid = rates.find((rate) => rate.measure_unit && rate.measure_unit.toUpperCase() !== "KWH");
  if (invalid) throw new Error(`${label} has unsupported measure unit ${invalid.measure_unit}`);
}
