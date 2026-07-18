import type { RawConsumption, RawServicePoint, RawServicePoints, RawUsageRecord } from "./types.js";

export const INTERVAL_MINUTES = 30;
export const INTERVALS_PER_DAY = 48;

export interface UsageDay {
  date: string;
  importKwh: number[];
  controlledLoadKwh: number[];
  exportKwh: number[];
}

export interface UsageProfile {
  days: UsageDay[];
  hasControlledLoad: boolean;
}

interface RegisterDefinition {
  suffix: string;
  controlledLoad: boolean;
  direction: "IMPORT" | "EXPORT";
}

/** Selects and validates the one residential connection that every later calculation is scoped to. */
export function getHouseholdServicePoint(servicePoints: RawServicePoints): RawServicePoint {
  if (servicePoints.service_points.length !== 1) {
    throw new Error(`Expected one household service point, found ${servicePoints.service_points.length}`);
  }

  const servicePoint = servicePoints.service_points[0]!;
  if (servicePoint.consumer_profile?.classification !== "RESIDENTIAL") {
    throw new Error("The household service point is not residential");
  }
  return servicePoint;
}

/** Finds the household's network operator, which is the reliable way to decide whether a plan is available. */
export function getDistributor(servicePoint: RawServicePoint): string {
  const distributors = servicePoint.related_participants?.filter(({ role }) => role === "LNSP") ?? [];
  if (distributors.length !== 1) {
    throw new Error(`Expected one LNSP distributor, found ${distributors.length}`);
  }
  return distributors[0]!.party;
}

/** Finds the household's current financially responsible retailer for user-facing identification. */
export function getCurrentRetailer(servicePoint: RawServicePoint): string {
  const retailers = servicePoint.related_participants?.filter(({ role }) => role === "FRMP") ?? [];
  if (retailers.length !== 1) return "Unknown retailer";
  return retailers[0]!.party;
}

/** Maps the service-point jurisdiction to an IANA zone so LOCAL tariffs follow daylight-saving changes. */
export function getJurisdictionTimeZone(servicePoint: RawServicePoint): string {
  const timeZones: Record<string, string> = {
    ACT: "Australia/Sydney",
    NSW: "Australia/Sydney",
    NT: "Australia/Darwin",
    QLD: "Australia/Brisbane",
    SA: "Australia/Adelaide",
    TAS: "Australia/Hobart",
    VIC: "Australia/Melbourne",
    WA: "Australia/Perth",
  };
  const jurisdiction = servicePoint.jurisdiction_code?.toUpperCase();
  const timeZone = jurisdiction ? timeZones[jurisdiction] : undefined;
  if (!timeZone) throw new Error(`Unsupported or missing jurisdiction ${jurisdiction ?? "unknown"}`);
  return timeZone;
}

/** Validates raw register reads and combines them into one consistent import/export profile per day. */
export function normalizeUsageProfile(usage: RawConsumption, servicePoint: RawServicePoint): UsageProfile {
  if (usage.usage.length === 0) throw new Error("No household usage was supplied");

  const records = usage.usage.filter((record) => {
    if (record.service_point_id !== servicePoint.service_point_id) {
      throw new Error(`Usage record ${record.read_start_date} belongs to another service point`);
    }
    return true;
  });
  const definitions = registerDefinitions(servicePoint, records);
  const recordsByDate = new Map<string, Map<string, RawUsageRecord>>();

  for (const record of records) {
    validateIsoDate(record.read_start_date);
    validateIntervalRead(record, definitions.get(record.register_suffix));

    const day = recordsByDate.get(record.read_start_date) ?? new Map<string, RawUsageRecord>();
    if (day.has(record.register_suffix)) {
      throw new Error(`Duplicate ${record.register_suffix} usage for ${record.read_start_date}`);
    }
    day.set(record.register_suffix, record);
    recordsByDate.set(record.read_start_date, day);
  }

  const dates = [...recordsByDate.keys()].sort();
  for (let index = 1; index < dates.length; index++) {
    if (dateToTimestamp(dates[index]!) - dateToTimestamp(dates[index - 1]!) !== 86_400_000) {
      throw new Error(`Usage dates are not consecutive between ${dates[index - 1]} and ${dates[index]}`);
    }
  }

  const days = dates.map((date): UsageDay => {
    const dayRecords = recordsByDate.get(date)!;
    const missing = [...definitions.keys()].filter((suffix) => !dayRecords.has(suffix));
    if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")} usage for ${date}`);

    const day: UsageDay = {
      date,
      importKwh: emptyIntervals(),
      controlledLoadKwh: emptyIntervals(),
      exportKwh: emptyIntervals(),
    };
    for (const [suffix, record] of dayRecords) {
      const definition = definitions.get(suffix)!;
      const target =
        definition.direction === "EXPORT"
          ? day.exportKwh
          : definition.controlledLoad
            ? day.controlledLoadKwh
            : day.importKwh;
      record.interval_read.interval_reads.forEach((value, index) => {
        target[index] = target[index]! + (definition.direction === "EXPORT" ? Math.abs(value) : value);
      });
    }
    return day;
  });

  if (days.every((day) => day.importKwh.every((value) => value === 0))) {
    throw new Error("No general import usage was supplied");
  }
  return {
    days,
    hasControlledLoad: days.some((day) => day.controlledLoadKwh.some((value) => value > 0)),
  };
}

/** Reconciles meter metadata with observed suffixes so every register has one costing role. */
function registerDefinitions(
  servicePoint: RawServicePoint,
  records: RawUsageRecord[],
): Map<string, RegisterDefinition> {
  const declared = servicePoint.meters?.flatMap((meter) => meter.registers ?? []) ?? [];
  const suffixes = new Set([...declared.map(({ register_suffix: suffix }) => suffix), ...records.map((r) => r.register_suffix)]);
  const definitions = new Map<string, RegisterDefinition>();

  for (const suffix of suffixes) {
    const register = declared.find(({ register_suffix: declaredSuffix }) => declaredSuffix === suffix);
    const sample = records.find(({ register_suffix: recordSuffix }) => recordSuffix === suffix);
    const direction = registerDirection(suffix);
    if (register?.unit_of_measure && register.unit_of_measure.toUpperCase() !== "KWH") {
      throw new Error(`Unsupported unit ${register.unit_of_measure} for register ${suffix}`);
    }
    definitions.set(suffix, {
      suffix,
      direction,
      controlledLoad: sample?.controlled_load ?? register?.controlled_load ?? false,
    });
  }
  return definitions;
}

/** Infers whether a NEM register imports or exports energy from its standard suffix. */
function registerDirection(suffix: string): RegisterDefinition["direction"] {
  if (/^E/i.test(suffix)) return "IMPORT";
  if (/^B/i.test(suffix)) return "EXPORT";
  throw new Error(`Unsupported register ${suffix}`);
}

/** Rejects malformed interval rows before bad quantities can distort every plan estimate. */
function validateIntervalRead(record: RawUsageRecord, definition: RegisterDefinition | undefined): void {
  if (!definition) throw new Error(`Unsupported register ${record.register_suffix}`);
  const { aggregate_value: aggregateValue, interval_reads: intervals, read_interval_length: intervalLength } =
    record.interval_read;

  if (record.unit_of_measure && record.unit_of_measure.toUpperCase() !== "KWH") {
    throw new Error(`Unsupported unit ${record.unit_of_measure} for register ${record.register_suffix}`);
  }
  if (intervalLength !== INTERVAL_MINUTES || intervals.length !== INTERVALS_PER_DAY) {
    throw new Error(`${record.register_suffix} usage for ${record.read_start_date} must contain 48 half-hour intervals`);
  }
  if (!Number.isFinite(aggregateValue) || intervals.some((value) => !Number.isFinite(value))) {
    throw new Error(`${record.register_suffix} usage for ${record.read_start_date} contains a non-finite value`);
  }
  if (definition.direction === "IMPORT" && intervals.some((value) => value < 0)) {
    throw new Error(`${record.register_suffix} import usage cannot be negative on ${record.read_start_date}`);
  }
  if (definition.direction === "EXPORT" && intervals.some((value) => value > 0)) {
    throw new Error(`${record.register_suffix} export usage cannot be positive on ${record.read_start_date}`);
  }
  if (definition.direction === "EXPORT" && definition.controlledLoad) {
    throw new Error(`Export register ${record.register_suffix} cannot be controlled load`);
  }

  const intervalTotal = intervals.reduce((total, value) => total + value, 0);
  if (Math.abs(intervalTotal - aggregateValue) > 0.000_001) {
    throw new Error(`${record.register_suffix} intervals do not match the aggregate for ${record.read_start_date}`);
  }
}

/** Creates an independent zero-filled half-hour day for accumulating one usage category. */
function emptyIntervals(): number[] {
  return Array.from({ length: INTERVALS_PER_DAY }, () => 0);
}

/** Enforces real YYYY-MM-DD dates because lexicographic ordering is used throughout the costing pipeline. */
export function validateIsoDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date ${date}`);
  }
}

/** Converts a validated date to a timezone-neutral day number for gap and duration checks. */
export function dateToTimestamp(date: string): number {
  validateIsoDate(date);
  return Date.parse(`${date}T00:00:00Z`);
}

/** Advances a calendar date without local-time daylight-saving effects. */
export function addDays(date: string, days: number): string {
  return new Date(dateToTimestamp(date) + days * 86_400_000).toISOString().slice(0, 10);
}
