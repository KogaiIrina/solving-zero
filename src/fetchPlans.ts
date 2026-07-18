import { assessPlanApplicability } from "./planApplicability.js";
import type { EnergyPlanDetail, RawServicePoints, Retailer } from "./types.js";
import { getHouseholdServicePoint } from "./usageProfile.js";

export interface EnergyPlanSummary {
  planId: string;
  displayName: string;
  fuelType: string;
  customerType: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  geography?: { distributors?: string[] };
}

export interface FetchDiagnostic {
  retailer: string;
  stage: "LIST" | "DETAIL" | "DEDUPLICATION";
  message: string;
  planId?: string;
  page?: number;
}

export interface FetchPlansInput {
  servicePoints: RawServicePoints;
  /** The 10 companies to compare — from `loadRetailers()`. */
  retailers: Retailer[];
  /** Dependency injection keeps network behavior deterministic in tests. */
  fetchFn?: typeof fetch;
  asOf?: Date;
  /** Optional caller-owned collection for partial-failure and deduplication diagnostics. */
  diagnostics?: FetchDiagnostic[];
}

interface ListResponse {
  data?: { plans?: EnergyPlanSummary[] };
  meta?: { totalPages?: number; totalRecords?: number };
}

interface DetailResponse {
  data?: EnergyPlanDetail;
}

/** Fetches, prefilters, and deduplicates plan details while preserving diagnostics for partial retailer failures. */
export async function fetchPlans(input: FetchPlansInput): Promise<EnergyPlanDetail[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const diagnostics = input.diagnostics ?? [];
  const asOf = input.asOf ?? new Date();
  if (!Number.isFinite(asOf.valueOf())) throw new Error("Invalid comparison date");
  const summaries: Array<{ retailer: Retailer; summary: EnergyPlanSummary }> = [];
  let retailersWithListData = 0;

  for (const retailer of input.retailers) {
    const listed = await listRetailerPlans(retailer, fetchFn, diagnostics);
    if (listed === null) continue;
    retailersWithListData++;
    for (const summary of filterApplicableSummaries(listed, input.servicePoints, asOf)) {
      summaries.push({ retailer, summary });
    }
  }
  if (retailersWithListData === 0) throw new Error("Every retailer failed while listing plans");

  const uniqueSummaries = deduplicateSummaries(summaries, diagnostics);
  const details = await mapWithConcurrency(
    uniqueSummaries,
    8,
    async ({ retailer, summary }) => {
      try {
        return { retailer, plan: await fetchPlanDetail(retailer, summary.planId, fetchFn) };
      } catch (error) {
        diagnostics.push({
          retailer: retailer.name,
          stage: "DETAIL",
          planId: summary.planId,
          message: errorMessage(error),
        });
        return null;
      }
    },
  );
  const plans = details.filter(
    (detail): detail is { retailer: Retailer; plan: EnergyPlanDetail } => detail !== null,
  );
  if (uniqueSummaries.length > 0 && plans.length === 0) {
    throw new Error("Every applicable plan detail request failed");
  }
  return deduplicateDetails(plans, diagnostics);
}

/** Removes summary records that cannot apply before expensive detail requests are made. */
export function filterApplicableSummaries(
  summaries: EnergyPlanSummary[],
  servicePoints: RawServicePoints,
  asOf: Date,
): EnergyPlanSummary[] {
  const servicePoint = getHouseholdServicePoint(servicePoints);
  return summaries.filter((summary) => {
    try {
      return assessPlanApplicability(summary, servicePoint, asOf).applicable;
    } catch {
      return false;
    }
  });
}

/** Reads every list page for one retailer and returns partial data only when at least one page succeeded. */
async function listRetailerPlans(
  retailer: Retailer,
  fetchFn: typeof fetch,
  diagnostics: FetchDiagnostic[],
): Promise<EnergyPlanSummary[] | null> {
  const plans: EnergyPlanSummary[] = [];
  let page = 1;
  let totalPages = 1;
  let fetchedAnyPage = false;

  while (page <= totalPages) {
    try {
      const url = new URL(`${retailer.baseUri.replace(/\/$/, "")}/cds-au/v1/energy/plans`);
      url.searchParams.set("fuelType", "ELECTRICITY");
      url.searchParams.set("page", String(page));
      url.searchParams.set("page-size", "100");
      const response = await fetchFn(url, { headers: { "x-v": "1" } });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      const body = (await response.json()) as ListResponse;
      if (!Array.isArray(body.data?.plans)) throw new Error("Response is missing data.plans");
      const reportedPages = body.meta?.totalPages ?? 1;
      if (!Number.isInteger(reportedPages) || reportedPages < 1) throw new Error("Response has invalid totalPages");
      totalPages = reportedPages;
      plans.push(...body.data.plans);
      fetchedAnyPage = true;
      page++;
    } catch (error) {
      diagnostics.push({
        retailer: retailer.name,
        stage: "LIST",
        page,
        message: errorMessage(error),
      });
      return fetchedAnyPage ? plans : null;
    }
  }
  return plans;
}

/** Requests the versioned CDR detail endpoint where a plan's actual tariff is published. */
async function fetchPlanDetail(retailer: Retailer, planId: string, fetchFn: typeof fetch): Promise<EnergyPlanDetail> {
  const encodedPlanId = encodeURIComponent(planId);
  const url = `${retailer.baseUri.replace(/\/$/, "")}/cds-au/v1/energy/plans/${encodedPlanId}`;
  const response = await fetchFn(url, { headers: { "x-v": "3" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const body = (await response.json()) as DetailResponse;
  if (!body.data || typeof body.data.planId !== "string") throw new Error("Response is missing plan detail data");
  return body.data;
}

/** Removes repeated list entries within a retailer before they cause duplicate network requests. */
function deduplicateSummaries(
  summaries: Array<{ retailer: Retailer; summary: EnergyPlanSummary }>,
  diagnostics: FetchDiagnostic[],
) {
  const seen = new Set<string>();
  return summaries.filter(({ retailer, summary }) => {
    const key = `${retailer.name}|${retailer.baseUri}|${summary.planId}`;
    if (!seen.has(key)) {
      seen.add(key);
      return true;
    }
    diagnostics.push({
      retailer: retailer.name,
      stage: "DEDUPLICATION",
      planId: summary.planId,
      message: "Duplicate plan summary was ignored",
    });
    return false;
  });
}

/** Deduplicates within a retailer without assuming plan IDs are globally unique across the market. */
function deduplicateDetails(
  plans: Array<{ retailer: Retailer; plan: EnergyPlanDetail }>,
  diagnostics: FetchDiagnostic[],
): EnergyPlanDetail[] {
  const seen = new Set<string>();
  return plans.flatMap(({ retailer, plan }) => {
    const key = `${retailer.name}|${retailer.baseUri}|${plan.planId}`;
    if (!seen.has(key)) {
      seen.add(key);
      return [{ ...plan, brandName: plan.brandName?.trim() || retailer.name }];
    }
    diagnostics.push({
      retailer: retailer.name,
      stage: "DEDUPLICATION",
      planId: plan.planId,
      message: "Duplicate plan detail was ignored",
    });
    return [];
  });
}

/** Converts unknown caught values into stable user-facing network diagnostics. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown fetch error";
}

/** Runs detail requests with a small worker pool to limit latency without flooding retailer endpoints. */
async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  concurrency: number,
  task: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs = Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      outputs[index] = await task(inputs[index]!);
    }
  });
  await Promise.all(workers);
  return outputs;
}
