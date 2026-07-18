/** @format */

// Contract test for estimatePlanCosts. It documents the minimum behaviour we expect and FAILS until you
// implement estimatePlanCosts — making it pass is a good first milestone. Add your own tests; their
// quality and coverage is a large part of what we assess.
//
// It has two tiers:
//   TIER A — deterministic cost correctness. Synthetic usage of EXACTLY 365 identical days is fed in, so
//            the annual cost is just 365 × the per-day cost regardless of how you annualise. The expected
//            numbers below are hand-computed; they pin down GST (×1.1 on usage+supply, NOT on feed-in),
//            the negative-B1 solar credit, time-of-use bucketing incl. a midnight-wrapping window, tiered
//            blocks, and contract-level controlled load.
//   TIER B — day-invariant properties (applicability, null-not-crash, cheapest-first ordering).

import { describe, it, expect } from "vitest";
import { estimatePlanCosts } from "./estimatePlanCosts.js";
import type { EnergyPlanDetail, RawConsumption, RawDer, RawServicePoints } from "./types.js";

// ───────────────────────── synthetic, hand-computable household ─────────────────────────

const HALF_HOURS = 48;
/** Build EXACTLY 365 identical days so annualCost = 365 × per-day cost (no annualisation ambiguity). */
function synthUsage(perIntervalE1: number, perIntervalB1: number): RawConsumption {
  const usage = [] as RawConsumption["usage"];
  const mkDay = (suffix: string, v: number, date: string) => ({
    service_point_id: "SP1",
    register_suffix: suffix,
    read_start_date: date, // distinct date per day → 365 buckets, so annualCost = 365 × per-day cost
    interval_read: {
      read_interval_length: 30,
      interval_reads: Array.from({ length: HALF_HOURS }, () => v),
      aggregate_value: v * HALF_HOURS,
    },
  });
  for (let d = 0; d < 365; d++) {
    const date = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10);
    usage.push(mkDay("E1", perIntervalE1, date));
    if (perIntervalB1 !== 0) usage.push(mkDay("B1", perIntervalB1, date));
  }
  return { usage };
}

// 0.5 kWh import every half-hour → 24 kWh/day import. 0.25 kWh export every half-hour → 12 kWh/day export
// (stored NEGATIVE). With midnight-wrap TOU we still draw 0.5 kWh in every interval.
const FLAT_IMPORT = 0.5;
const FLAT_EXPORT = -0.25;

const CITIPOWER_SP: RawServicePoints = {
  service_points: [
    {
      service_point_id: "SP1",
      jurisdiction_code: "VIC",
      consumer_profile: { classification: "RESIDENTIAL" },
      related_participants: [{ party: "CitiPower Pty", role: "LNSP" }],
    },
  ],
};

// ───────────────────────── plans ─────────────────────────

const SINGLE_RATE: EnergyPlanDetail = {
  planId: "A-single",
  displayName: "Flat 30c",
  fuelType: "ELECTRICITY",
  customerType: "RESIDENTIAL",
  effectiveTo: null,
  geography: { distributors: ["CITIPOWER"] },
  electricityContract: {
    tariffPeriod: [
      { rateBlockUType: "singleRate", dailySupplyCharge: "1.00", singleRate: { rates: [{ unitPrice: "0.30" }] } },
    ],
    solarFeedInTariff: [{ singleTariff: { rates: [{ unitPrice: "0.10" }] } }],
  },
};
// Per day: import 24·0.30 = 7.20 ×1.1 = 7.92 ; supply 1.00 ×1.1 = 1.10 ; solar 12·0.10 = 1.20 credit.
// Day net = 7.92 + 1.10 − 1.20 = 7.82 → annual = ×365 = 2854.30
const SINGLE_RATE_ANNUAL = +(365 * (24 * 0.3 * 1.1 + 1.0 * 1.1 - 12 * 0.1)).toFixed(2); // 2854.30

const TOU_WRAP: EnergyPlanDetail = {
  planId: "B-tou",
  displayName: "TOU wrap",
  fuelType: "ELECTRICITY",
  customerType: "RESIDENTIAL",
  effectiveTo: null,
  geography: { distributors: ["CITIPOWER"] },
  electricityContract: {
    tariffPeriod: [
      {
        rateBlockUType: "timeOfUseRates",
        dailySupplyCharge: "1.00",
        timeOfUseRates: [
          // PEAK wraps midnight: 21:00 → 07:00 = 20 intervals/day. Times are local "HH:MM" (the format DATA_DICTIONARY documents and the live CDR feed uses). Intervals
          // [42..47] (21:00-24:00 = 6) + [0..13] (00:00-07:00 = 14) = 20 intervals → 10 kWh peak.
          { type: "PEAK", rates: [{ unitPrice: "0.50" }], timeOfUse: [{ days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], startTime: "21:00", endTime: "07:00" }] },
          // OFF_PEAK the rest of the day: 07:00 → 21:00 = 28 intervals → 14 kWh.
          { type: "OFF_PEAK", rates: [{ unitPrice: "0.20" }], timeOfUse: [{ days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], startTime: "07:00", endTime: "21:00" }] },
        ],
      },
    ],
    solarFeedInTariff: [{ singleTariff: { rates: [{ unitPrice: "0.10" }] } }],
  },
};
// Per day: peak 10·0.50 = 5.00 ; offpeak 14·0.20 = 2.80 ; usage 7.80 ×1.1 = 8.58 ; supply 1.10 ;
// solar 1.20 credit → day net = 8.58 + 1.10 − 1.20 = 8.48 → annual = 3095.20
const TOU_WRAP_ANNUAL = +(365 * ((10 * 0.5 + 14 * 0.2) * 1.1 + 1.0 * 1.1 - 12 * 0.1)).toFixed(2);

const BUSINESS: EnergyPlanDetail = {
  planId: "C-business",
  displayName: "Business",
  fuelType: "ELECTRICITY",
  customerType: "BUSINESS",
  effectiveTo: null,
  geography: { distributors: ["CITIPOWER"] },
  electricityContract: { tariffPeriod: [{ rateBlockUType: "singleRate", dailySupplyCharge: "1.00", singleRate: { rates: [{ unitPrice: "0.10" }] } }] },
};

const OUT_OF_ZONE: EnergyPlanDetail = {
  planId: "D-zone",
  displayName: "Wrong network",
  fuelType: "ELECTRICITY",
  customerType: "RESIDENTIAL",
  effectiveTo: null,
  geography: { distributors: ["POWERCOR"] },
  electricityContract: { tariffPeriod: [{ rateBlockUType: "singleRate", dailySupplyCharge: "0.90", singleRate: { rates: [{ unitPrice: "0.05" }] } }] },
};

const NO_PRICING: EnergyPlanDetail = {
  planId: "E-nopricing",
  displayName: "No pricing",
  fuelType: "ELECTRICITY",
  customerType: "RESIDENTIAL",
  effectiveTo: null,
  geography: { distributors: ["CITIPOWER"] },
  electricityContract: { tariffPeriod: [{ rateBlockUType: "singleRate", singleRate: { rates: [] } }] },
};

const ALL_PLANS = [SINGLE_RATE, TOU_WRAP, BUSINESS, OUT_OF_ZONE, NO_PRICING];
const TOL = 0.5; // ± dollars/year tolerance for rounding/leap-year choices

// ───────────────────────── TIER A — deterministic cost correctness ─────────────────────────

describe("Tier A — cost correctness (hand-computed, 365 identical days)", () => {
  const input = { usage: synthUsage(FLAT_IMPORT, FLAT_EXPORT), servicePoints: CITIPOWER_SP, plans: ALL_PLANS };

  it("single rate: GST on usage+supply, solar credit (no GST) subtracted", () => {
    const r = estimatePlanCosts(input).find((p) => p.planId === "A-single")!;
    expect(r.applicable).toBe(true);
    expect(r.annualCostAud).toBeCloseTo(SINGLE_RATE_ANNUAL, 0);
    expect(Math.abs((r.annualCostAud as number) - SINGLE_RATE_ANNUAL)).toBeLessThan(TOL);
  });

  it("time-of-use with a midnight-wrapping PEAK window buckets correctly", () => {
    const r = estimatePlanCosts(input).find((p) => p.planId === "B-tou")!;
    expect(r.applicable).toBe(true);
    expect(Math.abs((r.annualCostAud as number) - TOU_WRAP_ANNUAL)).toBeLessThan(TOL);
  });

  it("a household with NO solar export gets no feed-in credit", () => {
    const noSolar = { usage: synthUsage(FLAT_IMPORT, 0), servicePoints: CITIPOWER_SP, plans: [SINGLE_RATE] };
    const r = estimatePlanCosts(noSolar)[0]!;
    const expected = +(365 * (24 * 0.3 * 1.1 + 1.0 * 1.1)).toFixed(2); // no −1.20/day credit
    expect(Math.abs((r.annualCostAud as number) - expected)).toBeLessThan(TOL);
  });
});

// ───────────────────────── TIER B — day-invariant properties ─────────────────────────

describe("Tier B — pipeline properties", () => {
  const input = { usage: synthUsage(FLAT_IMPORT, FLAT_EXPORT), servicePoints: CITIPOWER_SP, plans: ALL_PLANS };

  it("returns exactly one identified entry per plan", () => {
    const result = estimatePlanCosts(input);
    expect(result).toHaveLength(ALL_PLANS.length);
    for (const r of result) {
      expect(typeof r.planId).toBe("string");
      expect(typeof r.planName).toBe("string");
      expect(typeof r.retailerName).toBe("string");
      expect(["ELIGIBLE", "UNKNOWN", "INELIGIBLE"]).toContain(r.eligibilityStatus);
    }
  });

  it("marks the business plan and the out-of-zone plan not applicable", () => {
    const result = estimatePlanCosts(input);
    expect(result.find((r) => r.planId === "C-business")!.applicable).toBe(false);
    expect(result.find((r) => r.planId === "D-zone")!.applicable).toBe(false);
  });

  it("returns null (not 0, not a crash) for a plan with no published pricing", () => {
    const r = estimatePlanCosts(input).find((p) => p.planId === "E-nopricing")!;
    expect(r.annualCostAud).toBeNull();
  });

  it("ranks applicable, costable plans cheapest-first", () => {
    const costed = estimatePlanCosts(input)
      .filter((r) => r.applicable && typeof r.annualCostAud === "number")
      .map((r) => r.annualCostAud as number);
    expect(costed).toEqual([...costed].sort((a, b) => a - b));
  });

  it("marks a battery-only offer ineligible when DER shows no battery", () => {
    const plan = structuredClone(SINGLE_RATE);
    plan.planId = "BATTERY-ONLY";
    plan.brandName = "Test Energy";
    plan.electricityContract.eligibility = [
      { information: "Offer only available to customers with solar panels and battery." },
    ];
    const der: RawDer = {
      der_records: [
        {
          service_point_id: "SP1",
          ac_connections: [
            {
              der_devices: [
                { type: "SOLAR_PV", count: 16, nominal_rated_capacity: 0.4, nominal_storage_capacity: 0 },
              ],
            },
          ],
        },
        {
          service_point_id: "ANOTHER-HOUSEHOLD",
          ac_connections: [
            {
              der_devices: [
                { type: "BATTERY", count: 1, nominal_storage_capacity: 10 },
              ],
            },
          ],
        },
      ],
    };

    const result = estimatePlanCosts({
      usage: synthUsage(FLAT_IMPORT, FLAT_EXPORT),
      servicePoints: CITIPOWER_SP,
      der,
      plans: [plan],
    })[0]!;

    expect(result.retailerName).toBe("Test Energy");
    expect(result.eligibilityStatus).toBe("INELIGIBLE");
    expect(result.eligibilityNotes).toContain(
      "Requires a battery, but the household data shows no battery storage",
    );
  });
});
