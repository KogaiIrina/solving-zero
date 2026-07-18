import type {
  EligibilityStatus,
  EnergyPlanDetail,
  RawDer,
  RawServicePoint,
} from "./types.js";
import { getDistributor } from "./usageProfile.js";

export interface ApplicabilityResult {
  applicable: boolean;
  notes: string[];
}

export interface EligibilityResult {
  status: EligibilityStatus;
  notes: string[];
}

/** Explains whether a plan matches this household's fuel, customer class, network, and comparison date. */
export function assessPlanApplicability(
  plan: Pick<
    EnergyPlanDetail,
    "fuelType" | "customerType" | "effectiveFrom" | "effectiveTo" | "geography"
  >,
  servicePoint: RawServicePoint,
  asOf: Date,
): ApplicabilityResult {
  const notes: string[] = [];
  if (plan.fuelType !== "ELECTRICITY") notes.push(`Fuel type is ${plan.fuelType}, not electricity`);
  if (plan.customerType !== "RESIDENTIAL") notes.push(`Customer type is ${plan.customerType}, not residential`);

  const householdDistributor = canonicalDistributor(getDistributor(servicePoint));
  const distributors = plan.geography?.distributors ?? [];
  if (!distributors.some((distributor) => canonicalDistributor(distributor) === householdDistributor)) {
    notes.push("Plan is not offered on the household distributor network");
  }
  if (!isActivePlan(plan, asOf)) notes.push("Plan is not active on the comparison date");
  return { applicable: notes.length === 0, notes };
}

/** Uses structured household data for requirements we can prove, leaving free-text conditions as unknown. */
export function assessHouseholdEligibility(
  plan: Pick<EnergyPlanDetail, "electricityContract">,
  der: RawDer | undefined,
  servicePointId: string,
): EligibilityResult {
  const publishedConditions = plan.electricityContract.eligibility
    ?.flatMap(({ description, information }) => [information, description])
    .filter((value): value is string => Boolean(value?.trim())) ?? [];
  const conditions = [...new Set(publishedConditions)];
  if (conditions.length === 0) return { status: "ELIGIBLE", notes: [] };

  const explicitlyRequires = (feature: string) =>
    conditions.some((condition) => {
      const normalized = condition.toLowerCase();
      return (
        normalized.includes(feature) &&
        (normalized.includes("only available") ||
          normalized.includes("required") ||
          normalized.includes("must have"))
      );
    });
  const householdDer =
    der?.der_records.filter((record) => record.service_point_id === servicePointId) ?? [];
  const hasHouseholdDer = householdDer.length > 0;
  const knownFailures: string[] = [];
  if (hasHouseholdDer && explicitlyRequires("batter") && !householdHasBattery(householdDer)) {
    knownFailures.push("Requires a battery, but the household data shows no battery storage");
  }
  if (hasHouseholdDer && explicitlyRequires("solar") && !householdHasSolar(householdDer)) {
    knownFailures.push("Requires solar, but the household data shows no solar system");
  }
  if (knownFailures.length > 0) return { status: "INELIGIBLE", notes: knownFailures };
  return {
    status: "UNKNOWN",
    notes: [`Manual confirmation required: ${conditions.join(" ")}`],
  };
}

/** Removes legal suffix and punctuation differences so equivalent distributor names can be matched safely. */
export function canonicalDistributor(value: string): string {
  return value
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/(?:PROPRIETARYLIMITED|PTYLIMITED|PTYLTD|LIMITED|PTY|LTD)$/g, "");
}

/** Checks the plan's inclusive availability window at the requested comparison instant. */
export function isActivePlan(
  plan: Pick<EnergyPlanDetail, "effectiveFrom" | "effectiveTo">,
  asOf: Date,
): boolean {
  const from = parseOptionalTimestamp(plan.effectiveFrom, "effectiveFrom");
  const to = parseOptionalTimestamp(plan.effectiveTo ?? undefined, "effectiveTo");
  const instant = asOf.valueOf();
  return (from === null || from <= instant) && (to === null || to >= instant);
}

/** Parses an optional CLI date at midday UTC for deterministic plan-availability comparisons. */
export function comparisonDate(value: string | undefined): Date {
  if (!value) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid comparison date ${value}`);
  const parsed = new Date(`${value}T12:00:00Z`);
  if (parsed.toISOString().slice(0, 10) !== value) throw new Error(`Invalid comparison date ${value}`);
  return parsed;
}

/** Parses optional CDR timestamps and expands date-only end dates through the end of that day. */
function parseOptionalTimestamp(value: string | undefined, label: string): number | null {
  if (!value) return null;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}${label === "effectiveTo" ? "T23:59:59.999Z" : "T00:00:00.000Z"}`
    : value;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid plan ${label}: ${value}`);
  return parsed;
}

function householdHasBattery(records: RawDer["der_records"]): boolean {
  return records.some((record) =>
    record.ac_connections?.some((connection) =>
      connection.der_devices?.some(
        (device) =>
          (device.nominal_storage_capacity ?? 0) > 0 || device.type?.toUpperCase().includes("BATTERY"),
      ),
    ),
  );
}

function householdHasSolar(records: RawDer["der_records"]): boolean {
  return records.some((record) =>
    record.ac_connections?.some((connection) =>
      connection.der_devices?.some(
        (device) =>
          device.type?.toUpperCase() === "SOLAR_PV" &&
          (device.count ?? 0) > 0 &&
          (device.nominal_rated_capacity ?? 0) > 0,
      ),
    ),
  );
}
