import { costUsageProfile, parsePrice, roundKwh, roundMoney, type NormalizedTariff } from "./costEngine.js";
import type { RawBilling } from "./types.js";
import { addDays, dateToTimestamp, validateIsoDate, type UsageProfile } from "./usageProfile.js";

const COST_TOLERANCE_AUD = 0.1;
const QUANTITY_TOLERANCE = 0.001_001;
const REQUIRED_COMPONENTS = ["DAILY_SUPPLY", "FEED_IN_CREDIT", "OFF_PEAK", "PEAK"] as const;

type BillUsage = NonNullable<RawBilling["billing"][number]["usage"]>;

export interface PassedBillReconciliation {
  status: "PASSED";
  startDate: string;
  endDate: string;
  days: number;
  usageKwh: { peak: number; offPeak: number; export: number };
  calculatedCostAud: number;
  invoicedCostAud: number;
  differenceAud: number;
  withinTolerance: true;
}

export interface BillReconciliationIssue {
  status: "WARNING" | "UNAVAILABLE";
  withinTolerance: false;
  message: string;
}

export type BillReconciliation = PassedBillReconciliation | BillReconciliationIssue;

interface InvoicePeriod {
  invoiceNumber: string;
  startDate: string;
  endDate: string;
  transactions: BillUsage[];
}

/** Cross-checks engine quantities and charges against real invoices so the current baseline is trustworthy. */
export function reconcileBills(
  bills: RawBilling | undefined,
  profile: UsageProfile,
  tariff: NormalizedTariff,
  servicePointId: string,
): BillReconciliation {
  if (!bills) {
    return { status: "UNAVAILABLE", withinTolerance: false, message: "No bills were supplied" };
  }
  if (!Array.isArray(bills.billing)) {
    return {
      status: "WARNING",
      withinTolerance: false,
      message: "Bills are missing their billing transaction list",
    };
  }
  const billedUsage = bills.billing.flatMap((transaction) => {
    if (transaction.transaction_u_type !== "usage" || !transaction.usage) return [];
    if (transaction.usage.service_point_id && transaction.usage.service_point_id !== servicePointId) return [];
    return [transaction.usage];
  });
  if (billedUsage.length === 0) {
    return {
      status: "UNAVAILABLE",
      withinTolerance: false,
      message: "No bill usage transactions were supplied for the household",
    };
  }

  try {
    return reconcileBillUsage(billedUsage, profile, tariff);
  } catch (error) {
    return {
      status: "WARNING",
      withinTolerance: false,
      message: error instanceof Error ? error.message : "Unknown bill reconciliation error",
    };
  }
}

/** Keeps strict invoice validation isolated so failures become warnings rather than blocking plan costing. */
function reconcileBillUsage(
  billedUsage: BillUsage[],
  profile: UsageProfile,
  tariff: NormalizedTariff,
): PassedBillReconciliation {
  if (billedUsage.some(({ is_estimate: isEstimate }) => isEstimate)) {
    throw new Error("Estimated bill transactions cannot be used for reconciliation");
  }

  const invoices = groupInvoices(billedUsage);
  for (let index = 1; index < invoices.length; index++) {
    const previous = invoices[index - 1]!;
    const current = invoices[index]!;
    if (current.startDate !== addDays(previous.endDate, 1)) {
      throw new Error(`Bill periods are not consecutive between ${previous.endDate} and ${current.startDate}`);
    }
  }

  const startDate = invoices[0]!.startDate;
  const endDate = invoices.at(-1)!.endDate;
  const billedDays = profile.days.filter(({ date }) => date >= startDate && date <= endDate);
  const expectedDays = (dateToTimestamp(endDate) - dateToTimestamp(startDate)) / 86_400_000 + 1;
  if (billedDays.length !== expectedDays) throw new Error("Usage does not fully cover the billed period");

  const billedProfile: UsageProfile = {
    days: billedDays,
    hasControlledLoad: billedDays.some((day) => day.controlledLoadKwh.some((value) => value > 0)),
  };
  const calculated = costUsageProfile(billedProfile, tariff);
  const invoiced = sumInvoiceValues(billedUsage);
  const calculatedPeak = calculated.usageKwhByCategory.PEAK ?? 0;
  const calculatedOffPeak = calculated.usageKwhByCategory.OFF_PEAK ?? 0;
  assertNear(calculatedPeak, invoiced.peakKwh, "Peak usage does not reconcile with bills");
  assertNear(calculatedOffPeak, invoiced.offPeakKwh, "Off-peak usage does not reconcile with bills");
  assertNear(calculated.exportKwh, invoiced.exportKwh, "Solar export does not reconcile with bills");
  assertNear(billedDays.length, invoiced.supplyDays, "Supply days do not reconcile with bills");

  const differenceAud = calculated.totalCostAud - invoiced.costAud;
  if (Math.abs(differenceAud) > COST_TOLERANCE_AUD) {
    throw new Error(
      `Calculated billed-period cost differs from invoices by $${Math.abs(differenceAud).toFixed(2)}`,
    );
  }
  return {
    status: "PASSED",
    startDate,
    endDate,
    days: billedDays.length,
    usageKwh: {
      peak: roundKwh(calculatedPeak),
      offPeak: roundKwh(calculatedOffPeak),
      export: roundKwh(calculated.exportKwh),
    },
    calculatedCostAud: roundMoney(calculated.totalCostAud),
    invoicedCostAud: roundMoney(invoiced.costAud),
    differenceAud: roundMoney(differenceAud),
    withinTolerance: true,
  };
}

/** Groups tariff lines into ordered invoices and requires one complete, unambiguous component set per bill. */
function groupInvoices(transactions: BillUsage[]): InvoicePeriod[] {
  const groups = new Map<string, BillUsage[]>();
  for (const transaction of transactions) {
    if (!transaction.invoice_number) throw new Error("Bill usage transaction is missing an invoice number");
    const group = groups.get(transaction.invoice_number) ?? [];
    group.push(transaction);
    groups.set(transaction.invoice_number, group);
  }

  return [...groups.entries()]
    .map(([invoiceNumber, invoiceTransactions]): InvoicePeriod => {
      const startDates = new Set(invoiceTransactions.map(({ start_date: date }) => billDate(date)));
      const endDates = new Set(invoiceTransactions.map(({ end_date: date }) => billDate(date)));
      if (startDates.size !== 1 || endDates.size !== 1) {
        throw new Error(`Invoice ${invoiceNumber} contains inconsistent usage periods`);
      }
      const descriptions = invoiceTransactions.map(({ description }) => description);
      for (const component of REQUIRED_COMPONENTS) {
        if (descriptions.filter((description) => description === component).length !== 1) {
          throw new Error(`Invoice ${invoiceNumber} must contain exactly one ${component} transaction`);
        }
      }
      if (descriptions.some((description) => !REQUIRED_COMPONENTS.includes(description as never))) {
        throw new Error(`Invoice ${invoiceNumber} contains an unsupported tariff component`);
      }
      const startDate = [...startDates][0]!;
      const endDate = [...endDates][0]!;
      if (endDate < startDate) throw new Error(`Invoice ${invoiceNumber} ends before it starts`);
      return { invoiceNumber, startDate, endDate, transactions: invoiceTransactions };
    })
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
}

/** Totals the bill quantities and GST-inclusive amounts used as reconciliation targets. */
function sumInvoiceValues(transactions: BillUsage[]) {
  // A local selector keeps each required component total explicit and identically validated.
  const quantity = (description: (typeof REQUIRED_COMPONENTS)[number]) =>
    transactions
      .filter((transaction) => transaction.description === description)
      .reduce((total, transaction) => {
        if (!Number.isFinite(transaction.usage)) throw new Error(`Invalid billed quantity for ${description}`);
        return total + transaction.usage!;
      }, 0);
  return {
    peakKwh: quantity("PEAK"),
    offPeakKwh: quantity("OFF_PEAK"),
    exportKwh: quantity("FEED_IN_CREDIT"),
    supplyDays: quantity("DAILY_SUPPLY"),
    costAud: transactions.reduce(
      (total, transaction) => total + parsePrice(transaction.amount, `bill amount for ${transaction.description}`),
      0,
    ),
  };
}

/** Extracts a validated calendar date from the bill's date or timestamp representation. */
function billDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) throw new Error(`Invalid bill date ${value}`);
  const date = value.slice(0, 10);
  validateIsoDate(date);
  return date;
}

/** Applies the invoice quantity tolerance and reports both values when reconciliation fails. */
function assertNear(calculated: number, invoiced: number, message: string): void {
  if (Math.abs(calculated - invoiced) > QUANTITY_TOLERANCE) {
    throw new Error(`${message}: calculated ${calculated.toFixed(3)}, invoiced ${invoiced.toFixed(3)}`);
  }
}
