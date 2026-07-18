/**
 * Loads the household data UNMODIFIED (raw Fiskil shapes). Turning it into something you can cost is
 * part of the task. Plans are NOT loaded here — you fetch them live via fetchPlans (see GOAL_GUIDE.md).
 *
 * @format
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  EnergyPlanDetail,
  RawConsumption,
  RawServicePoints,
  RawAccounts,
  RawDer,
  RawBilling,
  Retailer,
} from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "user_data");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(RAW, name), "utf8")) as T;
}

/** The 10 companies to compare (name + base URI). Lives at the repo root, not in user_data. */
export function loadRetailers(): Retailer[] {
  return JSON.parse(readFileSync(join(ROOT, "retailers.json"), "utf8")) as Retailer[];
}

export function loadRecordedPlans(): EnergyPlanDetail[] {
  return JSON.parse(readFileSync(join(ROOT, "fixtures", "sample-plans.json"), "utf8")) as EnergyPlanDetail[];
}

/** Loads the household's raw half-hourly import and export records. */
export function loadUsage(): RawConsumption {
  return readJson<RawConsumption>("usage.json");
}

export function loadServicePoints(): RawServicePoints {
  return readJson<RawServicePoints>("service-points.json");
}

export function loadAccounts(): RawAccounts {
  return readJson<RawAccounts>("accounts.json");
}

export function loadDer(): RawDer {
  return readJson<RawDer>("der.json");
}

export function loadBills(): RawBilling {
  return readJson<RawBilling>("bills.json");
}
