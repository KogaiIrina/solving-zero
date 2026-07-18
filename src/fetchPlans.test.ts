import { describe, expect, it, vi } from "vitest";
import { fetchPlans, type EnergyPlanSummary, type FetchDiagnostic } from "./fetchPlans.js";
import type { EnergyPlanDetail, RawServicePoints, Retailer } from "./types.js";

const SERVICE_POINTS: RawServicePoints = {
  service_points: [
    {
      service_point_id: "SP1",
      jurisdiction_code: "VIC",
      consumer_profile: { classification: "RESIDENTIAL" },
      related_participants: [{ party: "CitiPower Pty", role: "LNSP" }],
    },
  ],
};
const RETAILERS: Retailer[] = [
  { name: "One", baseUri: "https://one.example" },
  { name: "Two", baseUri: "https://two.example/" },
];
const AS_OF = new Date("2026-07-14T12:00:00Z");

describe("fetchPlans", () => {
  it("paginates, filters summaries before detail, sends endpoint versions, encodes IDs and deduplicates", async () => {
    const a = summary("A@VIC");
    const b = summary("B");
    const business = { ...summary("BUSINESS"), customerType: "BUSINESS" };
    const expired = { ...summary("EXPIRED"), effectiveTo: "2025-01-01T00:00:00Z" };
    const wrongNetwork = { ...summary("WRONG"), geography: { distributors: ["Powercor"] } };
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/plans")) {
        expect(new Headers(init?.headers).get("x-v")).toBe("1");
        const page = Number(url.searchParams.get("page"));
        return json({
          data: { plans: page === 1 ? [a, business, expired, wrongNetwork] : [a, b] },
          meta: { totalPages: 2, totalRecords: 6 },
        });
      }
      expect(new Headers(init?.headers).get("x-v")).toBe("3");
      const planId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return json({ data: detail(planId) });
    });
    const diagnostics: FetchDiagnostic[] = [];

    const result = await fetchPlans({
      servicePoints: SERVICE_POINTS,
      retailers: [RETAILERS[0]!],
      fetchFn: mock as typeof fetch,
      asOf: AS_OF,
      diagnostics,
    });

    expect(result.map(({ planId }) => planId)).toEqual(["A@VIC", "B"]);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock.mock.calls.some(([input]) => String(input).includes("A%40VIC"))).toBe(true);
    expect(mock.mock.calls.some(([input]) => String(input).includes("BUSINESS"))).toBe(false);
    expect(diagnostics).toEqual([
      expect.objectContaining({ stage: "DEDUPLICATION", planId: "A@VIC" }),
    ]);
  });

  it("preserves another retailer's results after a list failure", async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.hostname === "one.example") return new Response(null, { status: 503 });
      if (url.pathname.endsWith("/plans")) {
        return json({ data: { plans: [summary("OK")] }, meta: { totalPages: 1 } });
      }
      return json({ data: detail("OK") });
    });

    const result = await fetchPlans({
      servicePoints: SERVICE_POINTS,
      retailers: RETAILERS,
      fetchFn: mock as typeof fetch,
      asOf: AS_OF,
      diagnostics,
    });

    expect(result.map(({ planId }) => planId)).toEqual(["OK"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ retailer: "One", stage: "LIST", page: 1 }));
  });

  it("preserves successful details when another detail fails", async () => {
    const diagnostics: FetchDiagnostic[] = [];
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/plans")) {
        return json({ data: { plans: [summary("GOOD"), summary("BAD")] }, meta: { totalPages: 1 } });
      }
      if (url.pathname.endsWith("/BAD")) return new Response(null, { status: 500 });
      return json({ data: detail("GOOD") });
    });

    const result = await fetchPlans({
      servicePoints: SERVICE_POINTS,
      retailers: [RETAILERS[0]!],
      fetchFn: mock as typeof fetch,
      asOf: AS_OF,
      diagnostics,
    });
    expect(result.map(({ planId }) => planId)).toEqual(["GOOD"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ stage: "DETAIL", planId: "BAD" }));
  });

  it("throws instead of presenting an outage as an empty comparison", async () => {
    const failed = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      fetchPlans({
        servicePoints: SERVICE_POINTS,
        retailers: RETAILERS,
        fetchFn: failed as typeof fetch,
        asOf: AS_OF,
      }),
    ).rejects.toThrow(/Every retailer failed/);
  });

  it("throws when every applicable detail request fails", async () => {
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/plans")
        ? json({ data: { plans: [summary("ONLY")] }, meta: { totalPages: 1 } })
        : new Response(null, { status: 500 });
    });
    await expect(
      fetchPlans({
        servicePoints: SERVICE_POINTS,
        retailers: [RETAILERS[0]!],
        fetchFn: mock as typeof fetch,
        asOf: AS_OF,
      }),
    ).rejects.toThrow(/Every applicable plan detail request failed/);
  });

  it("keeps the same plan ID when it is published by different retailers", async () => {
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/plans")) {
        return json({ data: { plans: [summary("SHARED-ID")] }, meta: { totalPages: 1 } });
      }
      const plan = detail("SHARED-ID");
      delete plan.brandName;
      return json({ data: plan });
    });

    const result = await fetchPlans({
      servicePoints: SERVICE_POINTS,
      retailers: RETAILERS,
      fetchFn: mock as typeof fetch,
      asOf: AS_OF,
    });

    expect(result).toHaveLength(2);
    expect(result.map(({ planId }) => planId)).toEqual(["SHARED-ID", "SHARED-ID"]);
    expect(result.map(({ brandName }) => brandName)).toEqual(["One", "Two"]);
  });
});

/** Builds a minimal applicable list record so fetch tests vary only relevant fields. */
function summary(planId: string): EnergyPlanSummary {
  return {
    planId,
    displayName: planId,
    fuelType: "ELECTRICITY",
    customerType: "RESIDENTIAL",
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
    geography: { distributors: ["CITIPOWER"] },
  };
}

/** Builds a minimal costable detail record returned by mocked CDR endpoints. */
function detail(planId: string): EnergyPlanDetail {
  return {
    ...summary(planId),
    electricityContract: {
      timeZone: "LOCAL",
      tariffPeriod: [
        {
          startDate: "01-01",
          endDate: "12-31",
          rateBlockUType: "singleRate",
          dailySupplyCharge: "1",
          singleRate: { rates: [{ unitPrice: "0.3" }], period: "P1D" },
        },
      ],
    },
  };
}

/** Wraps test data in the JSON Response shape used by CDR endpoints. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
