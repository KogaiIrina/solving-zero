/**
 * Types for the exercise. Field meanings live in DATA_DICTIONARY.md — extend or narrow these freely.
 *
 * Household data (`usage`, `service-points`, `accounts`, `der`, `bills`) is the raw Fiskil shape:
 * snake_case. Plans you fetch from the CDR are camelCase (`EnergyPlanDetail`). Prices are strings and
 * GST-exclusive — parse them and add 10% for a consumer-facing figure.
 */

// ───────────────────────── Household: usage + service points (Fiskil) ─────────────────────────

export interface RawUsageRecord {
  service_point_id: string;
  /** The meter this read belongs to — joins to `service-points.json` → `meters[].meter_id`. */
  meter_id?: string;
  /** `E*` = import (positive kWh). `B*` = solar export — stored as NEGATIVE kWh. */
  register_suffix: string;
  /** The NEM register id — here the same as `register_suffix` (e.g. "E1", "B1"). */
  register_id?: string;
  /** True if this register is a separately-metered controlled load (e.g. hot water). */
  controlled_load?: boolean;
  /** Local date only, e.g. "2026-06-20". Interval i covers [i×30, (i+1)×30) min after local midnight. */
  read_start_date: string;
  unit_of_measure?: 'KWH';
  /** Read discriminant — "intervalRead" for the 30-minute interval data used here. */
  read_u_type?: string;
  interval_read: {
    read_interval_length: number; // 30 for NEM
    interval_reads: number[]; // 48 values/day; B* values are negative
    aggregate_value: number;
  };
  /** Fiskil data-broker internal identifiers (linking metadata; not needed for costing). */
  fiskil_id?: string;
  institution_id?: string;
  arrangement_id?: string;
}

export interface RawConsumption {
  usage: RawUsageRecord[];
}

export interface RawServicePoint {
  service_point_id: string;
  jurisdiction_code?: string;
  consumer_profile?: { classification?: string };
  location?: Record<string, unknown>;
  /** The participant with `role: "LNSP"` is the distributor — match it to a plan's geography. */
  related_participants?: Array<{ party: string; role: string }>;
  meters?: Array<{
    meter_id?: string;
    registers?: Array<{
      register_suffix: string;
      controlled_load?: boolean;
      register_consumption_type?: string;
      unit_of_measure?: string;
    }>;
  }>;
}

export interface RawServicePoints {
  service_points: RawServicePoint[];
}

// ───────────────────────── Household: current plan + context (Fiskil, snake_case) ─────────────────────────

/** A snake_case tariff rate. `time_of_use` times are full "HH:MM:SS+10:00" (note: fetched CDR plans use "HH:MM"). */
export interface SnakeRate {
  unit_price: string;
  measure_unit?: string;
  volume?: number;
  period?: string;
}

/** The household's CURRENT contract (from `accounts`), used to cost their actual/baseline spend. */
export interface RawElectricityContract {
  time_zone?: string;
  tariff_period?: Array<{
    rate_block_u_type?: 'singleRate' | 'timeOfUseRates' | string;
    daily_supply_charge?: string;
    start_date?: string;
    end_date?: string;
    time_zone?: string;
    single_rate?: { rates: SnakeRate[]; period?: string };
    time_of_use_rates?: Array<{
      type: 'PEAK' | 'SHOULDER' | 'OFF_PEAK' | string;
      rates: SnakeRate[];
      period?: string;
      time_of_use: Array<{ days: string[]; start_time: string; end_time: string }>;
    }>;
  }>;
  solar_feed_in_tariff?: Array<{
    tariff_u_type?: string;
    single_tariff?: { rates: SnakeRate[]; period?: string };
  }>;
}

export interface RawAccounts {
  accounts: Array<{
    account_id?: string;
    plans?: Array<{
      plan_overview?: { display_name?: string; start_date?: string; end_date?: string };
      plan_detail?: { fuel_type?: string; electricity_contract?: RawElectricityContract };
      service_point_ids?: string[];
    }>;
  }>;
}

/** The solar system. `nominal_rated_capacity` is kW per panel; `inverter_device_capacity` is kW. */
export interface RawDer {
  der_records: Array<{
    service_point_id?: string;
    approved_capacity?: number;
    ac_connections?: Array<{
      inverter_device_capacity?: number;
      der_devices?: Array<{
        type?: string; // e.g. "SOLAR_PV"
        count?: number;
        nominal_rated_capacity?: number;
        nominal_storage_capacity?: number;
      }>;
    }>;
  }>;
}

/** Real invoices — a cross-check for your computed spend. Amounts are strings, GST-INCLUSIVE (`gst` ≈ amount/11). */
export interface RawBilling {
  billing: Array<{
    transaction_u_type: 'usage' | 'otherCharges' | 'onceOff' | 'payment' | string;
    gst?: string;
    usage?: {
      amount: string;
      description: string;
      start_date: string;
      end_date: string;
      usage?: number;
      invoice_number?: string;
      is_estimate?: boolean;
      measure_unit?: string;
      service_point_id?: string;
      time_of_use_type?: string;
    };
    other_charges?: { amount: string; description: string };
    once_off?: { amount: string; description: string };
    payment?: { amount: string; method?: string };
  }>;
}

// ───────────────────────── The 10 retailers we give you (retailers.json) ─────────────────────────

/** One of the 10 companies to compare. `baseUri` already includes the host; append the CDR path. */
export interface Retailer {
  name: string;
  /** e.g. "https://cdr.energymadeeasy.gov.au/<slug>" — append `/cds-au/v1/energy/plans`. */
  baseUri: string;
}

// ───────────────────────── CDR plans (fetched / example fixture, camelCase) ─────────────────────────

export interface CdrRate {
  unitPrice: string;
  measureUnit?: string;
  /**
   * Present on TIERED / block rates: the upper kWh threshold this rate applies up to (the band ceiling).
   * Multiple rates in one `rates[]` array, each with a `volume`, = a stepped/tiered price. A flat plan
   * has a single rate with no `volume`. (CDR also uses `period` for the reset window — usually a day/month.)
   */
  volume?: number;
  period?: string;
}

export interface CdrTariffPeriod {
  dailySupplyCharge?: string;
  /** Discriminant for which rate block below is populated. */
  rateBlockUType: 'singleRate' | 'timeOfUseRates' | string;
  /** Single or TIERED: one rate = flat; multiple rates with `volume` ceilings = a block tariff. */
  singleRate?: { rates: CdrRate[] };
  timeOfUseRates?: Array<{
    type: 'PEAK' | 'SHOULDER' | 'OFF_PEAK' | string;
    /** TOU bands can themselves be tiered (multiple rates with `volume`). */
    rates: CdrRate[];
    /** Times are local "HH:MM" (24h, end exclusive, midnight = "00:00"); a window may wrap midnight. */
    timeOfUse: Array<{ days: string[]; startTime: string; endTime: string }>;
  }>;
}

/**
 * Controlled load — a SEPARATELY metered circuit (e.g. hot water) at its own cheaper rate.
 * NOTE: in CDR this lives at `electricityContract` level, NOT inside `tariffPeriod` — easy to miss.
 */
export interface CdrControlledLoad {
  rateBlockUType?: 'singleRate' | 'timeOfUseRates' | string;
  dailySupplyCharge?: string;
  singleRate?: { rates: CdrRate[] };
  timeOfUseRates?: CdrTariffPeriod['timeOfUseRates'];
}

/**
 * Demand charge — billed on peak DEMAND (kW), not energy (kWh). Rare on residential plans, common on
 * business. TRAP: a costing engine that treats this as ordinary usage makes the plan look falsely cheap.
 */
export interface CdrDemandCharge {
  amount?: string; // $/kW (GST-exclusive, like everything else)
  measureUnit?: string;
  chargePeriod?: string;
  startTime?: string;
  endTime?: string;
  days?: string[];
}

export interface EnergyPlanDetail {
  planId: string;
  displayName: string;
  brandName?: string;
  fuelType: 'ELECTRICITY' | string;
  customerType: 'RESIDENTIAL' | 'BUSINESS' | string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  geography?: { distributors?: string[] };
  electricityContract: {
    tariffPeriod: CdrTariffPeriod[];
    solarFeedInTariff?: Array<{ singleTariff?: { rates: CdrRate[] } }>;
    /** Separately-metered controlled load(s) — at contract level, not in tariffPeriod. */
    controlledLoad?: CdrControlledLoad[];
    /** Peak-demand (kW) charges — NOT energy. Treating these as usage understates the plan's cost. */
    demandCharges?: CdrDemandCharge[];
    eligibility?: Array<{ type?: string; description?: string; information?: string }>;
    fees?: Array<{ type?: string; term?: string; amount?: string; rate?: string; description?: string }>;
    discounts?: unknown[];
    incentives?: unknown[];
  };
}

// ───────────────────────── Output of estimatePlanCosts ─────────────────────────

export type EligibilityStatus = 'ELIGIBLE' | 'UNKNOWN' | 'INELIGIBLE';

export interface RankedPlanCost {
  planId: string;
  planName: string;
  /** False if the plan doesn't apply to this household (wrong distributor / customer type). */
  applicable: boolean;
  /** Annual cost in AUD; null when it can't be costed (say why in `notes`). */
  annualCostAud: number | null;
  breakdown?: { usageCost?: number; supplyCost?: number; solarCredit?: number; [k: string]: number | undefined };
  notes?: string[];
}
