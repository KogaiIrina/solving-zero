import { describe, expect, it } from "vitest";
import { calculateCurrentPlanCost } from "./currentPlanCost.js";
import { loadAccounts, loadBills, loadServicePoints, loadUsage } from "./loadData.js";

/** Reloads fresh fixtures so mutation-based validation tests cannot affect one another. */
function loadHousehold() {
  return {
    usage: loadUsage(),
    servicePoints: loadServicePoints(),
    accounts: loadAccounts(),
    bills: loadBills(),
  };
}

describe("calculateCurrentPlanCost", () => {
  it("calculates the current plan and reconciles it with the supplied bills", () => {
    const result = calculateCurrentPlanCost(loadHousehold());

    expect(result).toEqual({
      planName: "Origin Go Variable",
      retailerName: "Origin Energy Electricity Limited",
      distributor: "CitiPower Pty",
      usagePeriod: { startDate: "2025-08-07", endDate: "2026-06-20", days: 318 },
      usageKwh: { peak: 1263.494, offPeak: 2808.37, export: 4730.871 },
      breakdown: {
        peakCostAud: 413.06,
        offPeakCostAud: 557.6,
        supplyCostAud: 355.08,
        solarCreditAud: 47.31,
      },
      observedCostAud: 1278.44,
      annualCostAud: 1467.39,
      billReconciliation: {
        status: "PASSED",
        startDate: "2025-08-07",
        endDate: "2026-06-06",
        days: 304,
        usageKwh: { peak: 1015.209, offPeak: 2220.671, export: 4727.999 },
        calculatedCostAud: 1064.98,
        invoicedCostAud: 1064.94,
        differenceAud: 0.04,
        withinTolerance: true,
      },
    });
  });

  it("treats the signed feed-in price as a credit magnitude", () => {
    const household = loadHousehold();
    const positivePriceHousehold = structuredClone(household);
    const feedInRates =
      positivePriceHousehold.accounts.accounts[0]!.plans![0]!.plan_detail!.electricity_contract!
        .solar_feed_in_tariff![0]!.single_tariff!.rates;
    feedInRates[0]!.unit_price = "0.01";

    expect(calculateCurrentPlanCost(household).breakdown.solarCreditAud).toBe(47.31);
    expect(calculateCurrentPlanCost(positivePriceHousehold).breakdown.solarCreditAud).toBe(47.31);
  });

  it("rejects intervals that do not reconcile with their aggregate", () => {
    const household = loadHousehold();
    household.usage.usage[0]!.interval_read.aggregate_value += 1;

    expect(() => calculateCurrentPlanCost(household)).toThrow(/do not match the aggregate/);
  });

  it("reports bill gaps without blocking a valid tariff calculation", () => {
    const household = loadHousehold();
    household.bills.billing = household.bills.billing.filter(
      ({ usage }) => usage?.invoice_number !== "123742214",
    );

    const result = calculateCurrentPlanCost(household);
    expect(result.observedCostAud).toBe(1278.44);
    expect(result.billReconciliation).toMatchObject({
      status: "WARNING",
      withinTolerance: false,
      message: expect.stringMatching(/Bill periods are not consecutive/),
    });
  });

  it("ignores bill usage belonging to another service point", () => {
    const household = loadHousehold();
    const foreign = structuredClone(household.bills.billing.find(({ usage }) => usage?.description === "PEAK")!);
    foreign.usage!.service_point_id = "OTHER";
    foreign.usage!.amount = "9999";
    household.bills.billing.push(foreign);

    const reconciliation = calculateCurrentPlanCost(household).billReconciliation;
    expect(reconciliation.status).toBe("PASSED");
    if (reconciliation.status === "PASSED") expect(reconciliation.invoicedCostAud).toBe(1064.94);
  });

  it("calculates the baseline when bills are unavailable", () => {
    const household = loadHousehold();
    const result = calculateCurrentPlanCost({
      usage: household.usage,
      servicePoints: household.servicePoints,
      accounts: household.accounts,
    });

    expect(result.observedCostAud).toBe(1278.44);
    expect(result.billReconciliation).toEqual({
      status: "UNAVAILABLE",
      withinTolerance: false,
      message: "No bills were supplied",
    });
  });

});
