import { INTERVAL_MINUTES } from "./usageProfile.js";

const AEST_OFFSET_MINUTES = 10 * 60;
const VALID_DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN", "PUBLIC_HOLIDAYS"]);
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const clockCache = new Map<string, TariffClockValue>();

export type TariffClockBasis = "AEST" | "LOCAL";

export interface TariffClockValue {
  date: string;
  day: string;
  minute: number;
  monthDay: string;
}

export interface TimeWindow {
  days: string[];
  startMinute: number;
  endMinute: number;
}

/** Converts a fixed-order usage interval into the clock a tariff declares, including LOCAL DST shifts. */
export function intervalTariffClock(
  date: string,
  intervalIndex: number,
  basis: TariffClockBasis,
  localTimeZone: string,
): TariffClockValue {
  const cacheKey = `${basis}|${localTimeZone}|${date}|${intervalIndex}`;
  const cached = clockCache.get(cacheKey);
  if (cached) return cached;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  if (basis === "AEST") {
    const clock = clockFromUtcDate(new Date(Date.UTC(year, month - 1, day, 0, intervalIndex * INTERVAL_MINUTES)));
    clockCache.set(cacheKey, clock);
    return clock;
  }

  // Each supplied row is in fixed NEM/AEST order. Convert every interval instant independently so the
  // DST transition hours use the offset actually in force, rather than one offset for the whole date.
  const instant = new Date(
    Date.UTC(year, month - 1, day, 0, intervalIndex * INTERVAL_MINUTES - AEST_OFFSET_MINUTES),
  );
  const parts = localFormatter(localTimeZone).formatToParts(instant);
  // Keep locale-part lookup in one place so missing conversion fields are validated together below.
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const localYear = part("year");
  const localMonth = part("month");
  const localDay = part("day");
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  const weekday = part("weekday")?.slice(0, 3).toUpperCase();
  if (!localYear || !localMonth || !localDay || !weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Could not convert ${date} interval ${intervalIndex} to ${localTimeZone}`);
  }
  const clock = {
    date: `${localYear}-${localMonth}-${localDay}`,
    day: weekday,
    minute: hour * 60 + minute,
    monthDay: `${localMonth}-${localDay}`,
  };
  clockCache.set(cacheKey, clock);
  return clock;
}

/** Parses and validates a published day/time band into the engine's numeric window shape. */
export function normalizeWindow(days: string[], startTime: string, endTime: string, label: string): TimeWindow {
  if (days.length === 0) throw new Error(`${label} has a time window without days`);
  const normalizedDays = days.map((day) => day.toUpperCase());
  const unsupportedDays = normalizedDays.filter((day) => !VALID_DAYS.has(day));
  if (unsupportedDays.length > 0) throw new Error(`${label} has unsupported days: ${unsupportedDays.join(", ")}`);
  const startMinute = parseClockMinutes(startTime);
  const endMinute = parseClockMinutes(endTime);
  if (startMinute === endMinute) throw new Error(`${label} has an ambiguous all-day time window`);
  return { days: normalizedDays, startMinute, endMinute };
}

/** Tests a tariff instant against an end-exclusive band, including bands that cross midnight. */
export function windowMatches(window: TimeWindow, day: string, minute: number): boolean {
  if (!window.days.includes(day)) return false;
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute < window.endMinute;
  }
  return minute >= window.startMinute || minute < window.endMinute;
}

/** Converts supported CDR and account clock strings to minutes after midnight for consistent comparison. */
export function parseClockMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[+-]\d{2}:\d{2})?$/);
  if (!match) throw new Error(`Invalid tariff time ${value}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(`${match[3] ?? "0"}.${match[4] ?? "0"}`);
  if (hours > 23 || minutes > 59 || seconds >= 60) throw new Error(`Invalid tariff time ${value}`);
  return hours * 60 + minutes + seconds / 60;
}

/** Normalizes optional seasonal boundaries so every tariff period has an explicit month/day range. */
export function normalizeMonthDay(value: string | undefined, fallback: "START" | "END"): string {
  const monthDay = value ?? (fallback === "START" ? "01-01" : "12-31");
  if (!/^\d{2}-\d{2}$/.test(monthDay)) throw new Error(`Invalid tariff period date ${monthDay}`);
  const parsed = new Date(`2000-${monthDay}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(5, 10) !== monthDay) {
    throw new Error(`Invalid tariff period date ${monthDay}`);
  }
  return monthDay;
}

/** Tests a month/day against a seasonal range, including seasons that cross New Year. */
export function monthDayMatches(monthDay: string, startMonthDay: string, endMonthDay: string): boolean {
  if (startMonthDay <= endMonthDay) return monthDay >= startMonthDay && monthDay <= endMonthDay;
  return monthDay >= startMonthDay || monthDay <= endMonthDay;
}

/** Produces the day, month, or year key used to reset cumulative tier consumption. */
export function resetBucket(clock: TariffClockValue, reset: "DAY" | "MONTH" | "YEAR"): string {
  if (reset === "DAY") return clock.date;
  if (reset === "MONTH") return clock.date.slice(0, 7);
  return clock.date.slice(0, 4);
}

/** Reuses the relatively expensive Intl formatter needed for each LOCAL tariff interval. */
function localFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-AU-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Reads an already-normalized UTC/AEST instant without applying another timezone conversion. */
function clockFromUtcDate(date: Date): TariffClockValue {
  const iso = date.toISOString();
  return {
    date: iso.slice(0, 10),
    day: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getUTCDay()]!,
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
    monthDay: iso.slice(5, 10),
  };
}
