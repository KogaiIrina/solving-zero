import {
  normalizeTiers,
  parseNonNegativePrice,
  type NormalizedControlledLoad,
  type NormalizedRate,
  type NormalizedTariff,
  type NormalizedTariffPeriod,
} from "./costEngine.js";
import { monthDayMatches, normalizeMonthDay, normalizeWindow } from "./tariffClock.js";
import type { CdrRate, CdrTariffPeriod, EnergyPlanDetail } from "./types.js";
import type { UsageProfile } from "./usageProfile.js";

/** Adapts a camelCase CDR plan to the shared engine and rejects pricing shapes that cannot be costed safely. */
export function normalizeCdrPlanTariff(
  plan: EnergyPlanDetail,
  profile: UsageProfile,
  localTimeZone: string,
): NormalizedTariff {
  const contract = plan.electricityContract;
  if (
    (contract.demandCharges?.length ?? 0) > 0 ||
    contract.tariffPeriod.some(
      (period) => period.rateBlockUType === "demandCharges" || (period.demandCharges?.length ?? 0) > 0,
    )
  ) {
    throw new Error("Demand-charge plans are not costed because kW demand billing is unsupported");
  }

  const periods = contract.tariffPeriod.map((period, index) => normalizePeriod(plan.planId, period, index));
  if (periods.length === 0) throw new Error("Plan has no tariff periods");
  validateSeasonalCoverage(periods);

  const clock = contract.timeZone?.toUpperCase() ?? "LOCAL";
  if (clock !== "LOCAL" && clock !== "AEST") throw new Error(`Unsupported tariff time zone ${clock}`);
  return {
    clockBasis: clock,
    localTimeZone,
    periods,
    feedInRates: normalizeFeedIn(plan),
    controlledLoad: profile.hasControlledLoad ? normalizeControlledLoad(plan) : undefined,
  };
}

/** Converts one CDR seasonal period, including its supply charge and usage rate structure. */
function normalizePeriod(planId: string, period: CdrTariffPeriod, index: number): NormalizedTariffPeriod {
  const label = `plan ${planId} tariff period ${index + 1}`;
  const id = `${planId}-period-${index}`;
  return {
    id,
    startMonthDay: normalizeMonthDay(period.startDate, "START"),
    endMonthDay: normalizeMonthDay(period.endDate, "END"),
    dailySupplyCharge: parseNonNegativePrice(period.dailySupplyCharge, `${label} daily supply charge`),
    usageRates: normalizeUsageRates(period, id, label),
  };
}

/** Normalizes either a single-rate or time-of-use block while preserving tier and window semantics. */
function normalizeUsageRates(period: CdrTariffPeriod, id: string, label: string): NormalizedRate[] {
  if (period.rateBlockUType === "singleRate") {
    const rates = period.singleRate?.rates ?? [];
    validateMeasureUnits(rates, label);
    const normalized = normalizeTiers(rates, period.singleRate?.period, `${label} usage rate`);
    return [{ id: `${id}-single`, category: "SINGLE", ...normalized }];
  }
  if (period.rateBlockUType === "timeOfUseRates") {
    const rates = period.timeOfUseRates ?? [];
    if (rates.length === 0) throw new Error(`${label} has no time-of-use rates`);
    return rates.map((rate, rateIndex): NormalizedRate => {
      validateMeasureUnits(rate.rates, `${label} ${rate.type}`);
      const normalized = normalizeTiers(rate.rates, rate.period, `${label} ${rate.type}`);
      if (rate.timeOfUse.length === 0) throw new Error(`${label} ${rate.type} has no time windows`);
      return {
        id: `${id}-tou-${rateIndex}`,
        category: rate.type,
        ...normalized,
        windows: rate.timeOfUse.map((window) =>
          normalizeWindow(window.days, window.startTime, window.endTime, `${label} ${rate.type}`),
        ),
      };
    });
  }
  throw new Error(`Unsupported rate block ${period.rateBlockUType}`);
}

/** Converts supported single or time-varying solar prices into rates that the engine applies as credits. */
function normalizeFeedIn(plan: EnergyPlanDetail): NormalizedRate[] {
  const tariffs = plan.electricityContract.solarFeedInTariff ?? [];
  if (tariffs.length === 0) return [];
  if (tariffs.length !== 1) throw new Error("Plan has multiple ambiguous solar feed-in tariffs");
  const tariff = tariffs[0]!;
  const label = `plan ${plan.planId} solar feed-in tariff`;

  if (tariff.tariffUType === "timeVaryingTariffs" || tariff.timeVaryingTariffs) {
    const rates = tariff.timeVaryingTariffs ?? [];
    if (rates.length === 0) throw new Error(`${label} has no time-varying rates`);
    return rates.map((rate, index): NormalizedRate => {
      validateMeasureUnits(rate.rates, `${label} ${rate.type}`);
      const normalized = normalizeTiers(rate.rates, rate.period, `${label} ${rate.type}`);
      if (rate.timeVariations.length === 0) throw new Error(`${label} ${rate.type} has no time windows`);
      return {
        id: `${plan.planId}-feed-${index}`,
        category: `FEED_IN_${rate.type}`,
        ...normalized,
        windows: rate.timeVariations.map((window) =>
          normalizeWindow(window.days, window.startTime, window.endTime, `${label} ${rate.type}`),
        ),
      };
    });
  }

  const rates = tariff.singleTariff?.rates ?? [];
  validateMeasureUnits(rates, label);
  const normalized = normalizeTiers(rates, tariff.singleTariff?.period, label);
  return [{ id: `${plan.planId}-feed-single`, category: "FEED_IN", ...normalized }];
}

/** Normalizes controlled-load pricing only when this household actually has controlled-load usage. */
function normalizeControlledLoad(plan: EnergyPlanDetail): NormalizedControlledLoad {
  const controlledLoads = plan.electricityContract.controlledLoad ?? [];
  if (controlledLoads.length !== 1) {
    throw new Error(`Expected one controlled-load tariff, found ${controlledLoads.length}`);
  }
  const controlled = controlledLoads[0]!;
  const id = `${plan.planId}-controlled`;
  const label = `plan ${plan.planId} controlled load`;
  const pseudoPeriod: CdrTariffPeriod = {
    rateBlockUType: controlled.rateBlockUType ?? "",
    singleRate: controlled.singleRate,
    timeOfUseRates: controlled.timeOfUseRates,
  };
  return {
    dailySupplyCharge: controlled.dailySupplyCharge
      ? parseNonNegativePrice(controlled.dailySupplyCharge, `${label} daily supply charge`)
      : 0,
    rates: normalizeUsageRates(pseudoPeriod, id, label),
  };
}

/** Rejects rates measured in anything other than kWh to avoid treating demand or daily values as energy. */
function validateMeasureUnits(rates: CdrRate[], label: string): void {
  const invalid = rates.find((rate) => rate.measureUnit && rate.measureUnit.toUpperCase() !== "KWH");
  if (invalid) throw new Error(`${label} has unsupported measure unit ${invalid.measureUnit}`);
}

/** Checks every day of a leap year so seasonal tariff periods have neither gaps nor overlaps. */
function validateSeasonalCoverage(periods: NormalizedTariffPeriod[]): void {
  const start = Date.UTC(2000, 0, 1);
  for (let offset = 0; offset < 366; offset++) {
    const monthDay = new Date(start + offset * 86_400_000).toISOString().slice(5, 10);
    const matches = periods.filter((period) =>
      monthDayMatches(monthDay, period.startMonthDay, period.endMonthDay),
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one tariff period on ${monthDay}, found ${matches.length}`);
    }
  }
}
