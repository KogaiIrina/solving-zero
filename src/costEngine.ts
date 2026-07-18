import {
  intervalTariffClock,
  monthDayMatches,
  resetBucket,
  windowMatches,
  type TariffClockBasis,
  type TariffClockValue,
  type TimeWindow,
} from "./tariffClock.js";
import { INTERVALS_PER_DAY, type UsageProfile } from "./usageProfile.js";

export const GST_MULTIPLIER = 1.1;

export type TierReset = "DAY" | "MONTH" | "YEAR";

export interface PriceTier {
  unitPrice: number;
  upperKwh: number | null;
}

export interface NormalizedRate {
  id: string;
  category: string;
  tiers: PriceTier[];
  reset: TierReset;
  /** Undefined means this rate applies all day. */
  windows?: TimeWindow[];
}

export interface NormalizedTariffPeriod {
  id: string;
  startMonthDay: string;
  endMonthDay: string;
  dailySupplyCharge: number;
  usageRates: NormalizedRate[];
}

export interface NormalizedControlledLoad {
  dailySupplyCharge: number;
  rates: NormalizedRate[];
}

export interface NormalizedTariff {
  clockBasis: TariffClockBasis;
  localTimeZone: string;
  periods: NormalizedTariffPeriod[];
  feedInRates: NormalizedRate[];
  controlledLoad?: NormalizedControlledLoad;
}

export interface CostTotals {
  usageKwhByCategory: Record<string, number>;
  usageCostAudByCategory: Record<string, number>;
  exportKwh: number;
  controlledLoadKwh: number;
  usageCostAud: number;
  controlledLoadCostAud: number;
  supplyCostAud: number;
  solarCreditAud: number;
  totalCostAud: number;
}

interface TierCounter {
  bucket: string;
  volume: number;
}

/** Applies one normalized tariff to every interval and returns comparable GST-aware cost components. */
export function costUsageProfile(profile: UsageProfile, tariff: NormalizedTariff): CostTotals {
  if (profile.days.length === 0) throw new Error("Cannot cost an empty usage profile");
  if (profile.hasControlledLoad && !tariff.controlledLoad) {
    throw new Error("The household has controlled-load usage but the plan has no controlled-load pricing");
  }

  const counters = new Map<string, TierCounter>();
  const usageKwhByCategory: Record<string, number> = {};
  const usageCostExGstByCategory: Record<string, number> = {};
  let usageCostExGst = 0;
  let controlledLoadCostExGst = 0;
  let supplyCostExGst = 0;
  let solarCreditAud = 0;
  let exportKwh = 0;
  let controlledLoadKwh = 0;

  for (const day of profile.days) {
    const supplyClock = intervalTariffClock(day.date, 24, tariff.clockBasis, tariff.localTimeZone);
    const supplyPeriod = matchingPeriod(tariff.periods, supplyClock);
    supplyCostExGst += supplyPeriod.dailySupplyCharge;
    if (profile.hasControlledLoad) supplyCostExGst += tariff.controlledLoad!.dailySupplyCharge;

    for (let intervalIndex = 0; intervalIndex < INTERVALS_PER_DAY; intervalIndex++) {
      const clock = intervalTariffClock(day.date, intervalIndex, tariff.clockBasis, tariff.localTimeZone);
      const period = matchingPeriod(tariff.periods, clock);
      const importKwh = day.importKwh[intervalIndex]!;
      const usageRate = matchingRate(period.usageRates, clock, `${day.date} interval ${intervalIndex}`);
      const intervalUsageCost = tieredCost(importKwh, usageRate, clock, counters);
      usageCostExGst += intervalUsageCost;
      usageCostExGstByCategory[usageRate.category] =
        (usageCostExGstByCategory[usageRate.category] ?? 0) + intervalUsageCost;
      usageKwhByCategory[usageRate.category] = (usageKwhByCategory[usageRate.category] ?? 0) + importKwh;

      const controlledKwh = day.controlledLoadKwh[intervalIndex]!;
      if (profile.hasControlledLoad) {
        const controlledRate = matchingRate(
          tariff.controlledLoad!.rates,
          clock,
          `controlled load on ${day.date} interval ${intervalIndex}`,
        );
        if (controlledKwh > 0) {
          controlledLoadCostExGst += tieredCost(controlledKwh, controlledRate, clock, counters);
        }
        controlledLoadKwh += controlledKwh;
      }

      const intervalExport = day.exportKwh[intervalIndex]!;
      exportKwh += intervalExport;
      if (tariff.feedInRates.length > 0) {
        const feedInRate = matchingRate(
          tariff.feedInRates,
          clock,
          `solar feed-in on ${day.date} interval ${intervalIndex}`,
        );
        if (intervalExport > 0) solarCreditAud += tieredCost(intervalExport, feedInRate, clock, counters);
      }
    }
  }

  const usageCostAud = usageCostExGst * GST_MULTIPLIER;
  const controlledLoadCostAud = controlledLoadCostExGst * GST_MULTIPLIER;
  const supplyCostAud = supplyCostExGst * GST_MULTIPLIER;
  return {
    usageKwhByCategory,
    usageCostAudByCategory: Object.fromEntries(
      Object.entries(usageCostExGstByCategory).map(([category, cost]) => [category, cost * GST_MULTIPLIER]),
    ),
    exportKwh,
    controlledLoadKwh,
    usageCostAud,
    controlledLoadCostAud,
    supplyCostAud,
    solarCreditAud,
    totalCostAud: usageCostAud + controlledLoadCostAud + supplyCostAud - solarCreditAud,
  };
}

/** Validates published block prices and converts cumulative thresholds into the engine's tier model. */
export function normalizeTiers(
  rates: Array<{ unitPrice: string; volume?: number }>,
  period: string | undefined,
  label: string,
): { tiers: PriceTier[]; reset: TierReset } {
  if (rates.length === 0) throw new Error(`${label} has no prices`);
  const tiers = rates.map((rate, index): PriceTier => {
    const unitPrice = parseNonNegativePrice(rate.unitPrice, `${label} tier ${index + 1} unit price`);
    const upperKwh = rate.volume ?? null;
    if (upperKwh !== null && (!Number.isFinite(upperKwh) || upperKwh <= 0)) {
      throw new Error(`${label} tier ${index + 1} has an invalid volume`);
    }
    return { unitPrice, upperKwh };
  });

  for (let index = 0; index < tiers.length - 1; index++) {
    const upper = tiers[index]!.upperKwh;
    const previous = index === 0 ? 0 : tiers[index - 1]!.upperKwh;
    if (upper === null || (previous !== null && upper <= previous)) {
      throw new Error(`${label} tier volumes must be increasing cumulative thresholds`);
    }
  }
  if (tiers.length > 1 && tiers.at(-1)!.upperKwh !== null) {
    throw new Error(`${label} must end with an unbounded tier`);
  }
  if (tiers.length === 1 && tiers[0]!.upperKwh !== null) {
    throw new Error(`${label} has a bounded price without a fallback tier`);
  }
  return { tiers, reset: normalizeReset(period, tiers.length > 1, label) };
}

/** Parses a required numeric price while preserving legitimate negative values such as source feed-in rates. */
export function parsePrice(value: string | undefined, label: string): number {
  const price = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(price)) throw new Error(`Invalid ${label}`);
  return price;
}

/** Parses charges that must not be negative, preventing malformed prices from becoming credits. */
export function parseNonNegativePrice(value: string | undefined, label: string): number {
  const price = parsePrice(value, label);
  if (price < 0) throw new Error(`${label} cannot be negative`);
  return price;
}

/** Rounds a final consumer-facing amount to Australian currency precision. */
export function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

/** Rounds reported energy quantities to the precision used by the supplied invoices. */
export function roundKwh(value: number): number {
  return Number(value.toFixed(3));
}

/** Requires exactly one seasonal tariff period for an instant so gaps or overlaps are never guessed. */
function matchingPeriod(periods: NormalizedTariffPeriod[], clock: TariffClockValue): NormalizedTariffPeriod {
  const matches = periods.filter((period) =>
    monthDayMatches(clock.monthDay, period.startMonthDay, period.endMonthDay),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one tariff period for ${clock.date}, found ${matches.length}`);
  }
  return matches[0]!;
}

/** Requires exactly one usage band for an instant so incomplete or overlapping schedules are rejected. */
function matchingRate(rates: NormalizedRate[], clock: TariffClockValue, label: string): NormalizedRate {
  const matches = rates.filter(
    (rate) => !rate.windows || rate.windows.some((window) => windowMatches(window, clock.day, clock.minute)),
  );
  if (matches.length !== 1) throw new Error(`Expected one tariff rate for ${label}, found ${matches.length}`);
  return matches[0]!;
}

/** Prices a quantity across cumulative tiers and carries consumption within the declared reset bucket. */
function tieredCost(
  kwh: number,
  rate: NormalizedRate,
  clock: TariffClockValue,
  counters: Map<string, TierCounter>,
): number {
  if (kwh === 0) return 0;
  const bucket = resetBucket(clock, rate.reset);
  const counter = counters.get(rate.id);
  const priorVolume = counter?.bucket === bucket ? counter.volume : 0;
  let remaining = kwh;
  let consumed = priorVolume;
  let cost = 0;

  for (const tier of rate.tiers) {
    const available = tier.upperKwh === null ? remaining : Math.max(0, tier.upperKwh - consumed);
    const quantity = Math.min(remaining, available);
    cost += quantity * tier.unitPrice;
    remaining -= quantity;
    consumed += quantity;
    if (remaining <= 0) break;
  }
  if (remaining > 0.000_000_001) throw new Error(`No price tier covers all usage for ${rate.category}`);
  counters.set(rate.id, { bucket, volume: priorVolume + kwh });
  return cost;
}

/** Converts source-specific period labels to supported reset rules and rejects ambiguous tiered prices. */
function normalizeReset(period: string | undefined, tiered: boolean, label: string): TierReset {
  if (!period) {
    if (tiered) throw new Error(`${label} has tiered prices without a reset period`);
    return "DAY";
  }
  const normalized = period.trim().toUpperCase();
  if (normalized === "P1D" || normalized === "DAY" || normalized === "DAILY") return "DAY";
  if (normalized === "P1M" || normalized === "MONTH" || normalized === "MONTHLY") return "MONTH";
  if (normalized === "P1Y" || normalized === "YEAR" || normalized === "YEARLY") return "YEAR";
  throw new Error(`${label} has unsupported reset period ${period}`);
}
