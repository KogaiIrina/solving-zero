import { describe, expect, it } from "vitest";
import { costUsageProfile, normalizeTiers, type NormalizedTariff } from "./costEngine.js";
import { intervalTariffClock } from "./tariffClock.js";
import { INTERVALS_PER_DAY, type UsageDay, type UsageProfile } from "./usageProfile.js";

describe("tier resets", () => {
  it.each([
    ["P1D", 7.26],
    ["P1M", 8.36],
    ["P1Y", 9.46],
  ])("applies cumulative tier thresholds with a %s reset", (period, expected) => {
    const profile: UsageProfile = {
      days: ["2025-01-31", "2025-02-01", "2025-02-02"].map((date) =>
        usageDay(date, { import: [[0, 8], [1, 8]] }),
      ),
      hasControlledLoad: false,
    };
    const tiers = normalizeTiers(
      [{ unitPrice: "0.10", volume: 10 }, { unitPrice: "0.20" }],
      period,
      "test tier",
    );
    expect(costUsageProfile(profile, tariffWithRate(tiers)).totalCostAud).toBeCloseTo(expected, 8);
  });
});

describe("shared cost components", () => {
  it("costs separately metered controlled load and time-varying solar feed-in", () => {
    const profile: UsageProfile = {
      days: [
        usageDay("2025-01-01", {
          import: [[0, 1]],
          controlled: [[0, 2]],
          export: [[0, 3], [32, 1]],
        }),
      ],
      hasControlledLoad: true,
    };
    const tariff: NormalizedTariff = {
      ...tariffWithRate(normalizeTiers([{ unitPrice: "0.30" }], "P1D", "usage")),
      periods: [
        {
          id: "period",
          startMonthDay: "01-01",
          endMonthDay: "12-31",
          dailySupplyCharge: 0.4,
          usageRates: [
            {
              id: "usage",
              category: "SINGLE",
              ...normalizeTiers([{ unitPrice: "0.30" }], "P1D", "usage"),
            },
          ],
        },
      ],
      controlledLoad: {
        dailySupplyCharge: 0.2,
        rates: [
          {
            id: "controlled",
            category: "CONTROLLED",
            ...normalizeTiers([{ unitPrice: "0.10" }], "P1D", "controlled"),
          },
        ],
      },
      feedInRates: [
        {
          id: "feed-offpeak",
          category: "FEED_IN_OFF_PEAK",
          ...normalizeTiers([{ unitPrice: "0.05" }], "P1D", "feed offpeak"),
          windows: [{ days: ["WED"], startMinute: 0, endMinute: 16 * 60 }],
        },
        {
          id: "feed-peak",
          category: "FEED_IN_PEAK",
          ...normalizeTiers([{ unitPrice: "0.10" }], "P1D", "feed peak"),
          windows: [{ days: ["WED"], startMinute: 16 * 60, endMinute: 0 }],
        },
      ],
    };

    const result = costUsageProfile(profile, tariff);
    expect(result.usageCostAud).toBeCloseTo(0.33, 8);
    expect(result.controlledLoadCostAud).toBeCloseTo(0.22, 8);
    expect(result.supplyCostAud).toBeCloseTo(0.66, 8);
    expect(result.solarCreditAud).toBeCloseTo(0.25, 8);
    expect(result.totalCostAud).toBeCloseTo(0.96, 8);
  });

  it("selects seasonal tariff periods", () => {
    const profile: UsageProfile = {
      days: [usageDay("2025-01-31", { import: [[0, 1]] }), usageDay("2025-07-01", { import: [[0, 1]] })],
      hasControlledLoad: false,
    };
    const tariff: NormalizedTariff = {
      clockBasis: "AEST",
      localTimeZone: "Australia/Melbourne",
      feedInRates: [],
      periods: [
        seasonalPeriod("summer", "12-01", "03-31", 0.1),
        seasonalPeriod("winter", "04-01", "11-30", 0.2),
      ],
    };
    expect(costUsageProfile(profile, tariff).usageCostAud).toBeCloseTo(0.33, 8);
  });

  it("applies tiered feed-in thresholds as credits without GST", () => {
    const profile: UsageProfile = {
      days: [usageDay("2025-01-01", { export: [[0, 12]] })],
      hasControlledLoad: false,
    };
    const tariff = tariffWithRate(normalizeTiers([{ unitPrice: "0" }], "P1D", "usage"));
    tariff.feedInRates = [
      {
        id: "tiered-feed",
        category: "FEED_IN",
        ...normalizeTiers(
          [{ unitPrice: "0.10", volume: 10 }, { unitPrice: "0.05" }],
          "P1D",
          "tiered feed-in",
        ),
      },
    ];

    const result = costUsageProfile(profile, tariff);
    expect(result.solarCreditAud).toBeCloseTo(1.1, 8);
    expect(result.totalCostAud).toBeCloseTo(-1.1, 8);
  });
});

describe("tariff clocks", () => {
  it("converts each spring DST transition interval using the offset then in force", () => {
    expect(intervalTariffClock("2025-10-05", 0, "LOCAL", "Australia/Melbourne")).toMatchObject({
      date: "2025-10-05",
      minute: 0,
    });
    expect(intervalTariffClock("2025-10-05", 4, "LOCAL", "Australia/Melbourne")).toMatchObject({
      date: "2025-10-05",
      minute: 180,
    });
  });

  it("keeps AEST tariffs in fixed interval order", () => {
    expect(intervalTariffClock("2025-10-05", 4, "AEST", "Australia/Melbourne")).toMatchObject({
      date: "2025-10-05",
      minute: 120,
    });
  });
});

/** Creates the smallest all-year tariff needed to isolate tier and clock behavior. */
function tariffWithRate(tiers: ReturnType<typeof normalizeTiers>): NormalizedTariff {
  return {
    clockBasis: "AEST",
    localTimeZone: "Australia/Melbourne",
    feedInRates: [],
    periods: [
      {
        id: "period",
        startMonthDay: "01-01",
        endMonthDay: "12-31",
        dailySupplyCharge: 0,
        usageRates: [{ id: "usage", category: "SINGLE", ...tiers }],
      },
    ],
  };
}

/** Creates one flat-price season for testing selection across tariff-period boundaries. */
function seasonalPeriod(id: string, startMonthDay: string, endMonthDay: string, unitPrice: number) {
  return {
    id,
    startMonthDay,
    endMonthDay,
    dailySupplyCharge: 0,
    usageRates: [
      {
        id: `${id}-usage`,
        category: "SINGLE",
        tiers: [{ unitPrice, upperKwh: null }],
        reset: "DAY" as const,
      },
    ],
  };
}

/** Creates a usage day with sparse overrides so tests can target exact half-hour windows. */
function usageDay(
  date: string,
  values: {
    import?: Array<[number, number]>;
    controlled?: Array<[number, number]>;
    export?: Array<[number, number]>;
  },
): UsageDay {
  // Expand sparse index/value pairs into the 48 values required by the production engine.
  const intervals = (entries: Array<[number, number]> = []) => {
    const result = Array.from({ length: INTERVALS_PER_DAY }, () => 0);
    entries.forEach(([index, value]) => (result[index] = value));
    return result;
  };
  return {
    date,
    importKwh: intervals(values.import),
    controlledLoadKwh: intervals(values.controlled),
    exportKwh: intervals(values.export),
  };
}
