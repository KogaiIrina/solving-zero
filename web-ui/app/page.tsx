import type { ComparisonReport } from "../../src/comparisonReport";
import generatedReport from "./comparison-report.json";

const report = generatedReport as ComparisonReport;
const current = report.current;
const recommendation = report.recommendation;
type CostedPlan = ComparisonReport["plans"][number] & { annualCostAud: number };
const costedPlans = report.plans.filter(
  (plan): plan is CostedPlan => plan.applicable && plan.annualCostAud !== null,
);
const comparablePlans = costedPlans.filter(
  (plan) => plan.eligibilityStatus !== "INELIGIBLE",
);
const knownIneligiblePlans = costedPlans.filter(
  (plan) => plan.eligibilityStatus === "INELIGIBLE",
);
const displayedPlans = [...comparablePlans.slice(0, 4), ...knownIneligiblePlans.slice(0, 1)];
const largestCurrentComponent = Math.max(
  current.breakdown.peakCostAud,
  current.breakdown.offPeakCostAud,
  current.breakdown.supplyCostAud,
  current.breakdown.solarCreditAud,
);

const money = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const preciseMoney = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
});

/** Renders the engine-generated comparison report produced before every development session and build. */
export default function Home() {
  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="SolvingZero comparison home">
          <span className="brand-mark" aria-hidden="true">0</span>
          <span>SolvingZero</span>
        </a>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div>
            <h1 id="hero-title">A clearer way to pay less for power.</h1>
            <p className="hero-intro">
              We checked your real half-hourly usage against {report.counts.total} electricity plans.
              Here is the strongest match worth checking first.
            </p>
            <div className="hero-metrics" aria-label="Current plan summary">
              <div>
                <span>Current annual estimate</span>
                <strong>{preciseMoney.format(current.annualCostAud)}</strong>
              </div>
              <div>
                <span>Current plan</span>
                <strong>{current.planName}</strong>
                <small>{current.retailerName}</small>
              </div>
            </div>
          </div>

          {recommendation ? (
            <article className="recommendation" aria-label="Recommended plan to check">
              <div className="recommendation-topline">
                <span className="status-dot" aria-hidden="true" />
                Best match to check
              </div>
              <p className="plan-kicker">{recommendation.plan.retailerName}</p>
              <h2>{recommendation.plan.planName}</h2>
              <div className="price-lockup">
                <strong>{preciseMoney.format(recommendation.plan.annualCostAud!)}</strong>
                <span>estimated per year</span>
              </div>
              <div className="saving-callout">
                <span>Potential annual saving</span>
                <strong>{preciseMoney.format(recommendation.annualSavingAud)}</strong>
              </div>
              {recommendation.plan.eligibilityNotes?.map((note) => (
                <p className="eligibility-note" key={note}>{note}</p>
              ))}
              <a className="primary-action" href="#plans">Compare plan details</a>
            </article>
          ) : (
            <article className="recommendation" aria-label="No cheaper plan found">
              <div className="recommendation-topline">
                <span className="status-dot" aria-hidden="true" />
                Comparison complete
              </div>
              <h2>No potentially usable plan in this comparison is cheaper.</h2>
            </article>
          )}
        </section>

        <section className="current-section" id="current-plan" aria-labelledby="current-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your current plan</p>
              <h2 id="current-title">Where your money goes</h2>
            </div>
            <p>
              Observed cost across {current.usagePeriod.days} days: <strong>{preciseMoney.format(current.observedCostAud)}</strong>
            </p>
          </div>

          <div className="current-grid">
            <div className="breakdown-card">
              <BreakdownRow label="Peak usage" value={current.breakdown.peakCostAud} className="peak" />
              <BreakdownRow label="Off-peak usage" value={current.breakdown.offPeakCostAud} className="offpeak" />
              <BreakdownRow label="Daily supply" value={current.breakdown.supplyCostAud} className="supply" />
              <BreakdownRow label="Solar credit" value={current.breakdown.solarCreditAud} className="solar" credit />
            </div>

            <BillCheck />
          </div>
        </section>

        <section className="plans-section" id="plans" aria-labelledby="plans-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your comparison</p>
              <h2 id="plans-title">Plans worth a closer look</h2>
            </div>
            <p>
              {report.counts.costed} plans costed · {report.counts.uncostable} plans excluded from
              safe costing · {report.counts.knownIneligible} known-ineligible offers separated
            </p>
          </div>

          <div className="plan-list">
            {displayedPlans.map((plan, index) => {
              const ineligible = plan.eligibilityStatus === "INELIGIBLE";
              const annualCost = plan.annualCostAud;
              const usageCost =
                plan.breakdown?.usageCost === undefined &&
                plan.breakdown?.controlledLoadCost === undefined
                  ? undefined
                  : (plan.breakdown?.usageCost ?? 0) +
                    (plan.breakdown?.controlledLoadCost ?? 0);
              const planSaving = current.annualCostAud - annualCost;
              const costDifference =
                planSaving > 0
                  ? `${money.format(planSaving)} saving`
                  : `${money.format(-planSaving)} more`;
              const priceSummary = ineligible
                ? "Household not eligible"
                : `${costDifference}${plan.eligibilityStatus === "UNKNOWN" ? " · check eligibility" : ""}`;
              return (
                <details
                  className={`plan-row${ineligible ? " is-ineligible" : ""}`}
                  key={`${plan.retailerName}-${plan.planId}`}
                  open={index === 0}
                >
                  <summary>
                    <span className="rank">{ineligible ? "—" : index + 1}</span>
                    <span className="plan-name">
                      <strong>{plan.planName}</strong>
                      <small>{plan.retailerName}</small>
                    </span>
                    <span className={`eligibility${ineligible ? " warning" : ""}`}>
                      {ineligible ? "Not eligible" : plan.eligibilityStatus === "UNKNOWN" ? "Eligibility check" : "Eligible"}
                    </span>
                    <span className="plan-price">
                      <strong>{preciseMoney.format(annualCost)}</strong>
                      <small>{priceSummary}</small>
                    </span>
                    <span className="expand" aria-hidden="true">+</span>
                  </summary>
                  <div className="plan-detail">
                    <div>
                      <span>Usage</span>
                      <strong>{formatBreakdown(usageCost)}</strong>
                    </div>
                    <div><span>Supply</span><strong>{formatBreakdown(plan.breakdown?.supplyCost)}</strong></div>
                    <div><span>Solar credit</span><strong>{formatBreakdown(plan.breakdown?.solarCredit, true)}</strong></div>
                    <p>
                      {[...(plan.eligibilityNotes ?? []), ...(plan.notes ?? [])].join("\n") ||
                        "No additional plan caveats were published."}
                    </p>
                  </div>
                </details>
              );
            })}
          </div>
        </section>

        <section className="method-note" aria-label="Method summary">
          <p className="eyebrow">How this was calculated</p>
          <p className="method-copy">
            Every estimate uses the same {current.usagePeriod.days}-day interval profile, including GST,
            daily supply charges and solar feed-in credits. Known-ineligible plans are not recommended,
            and plans with demand charges or unsafe pricing gaps are never treated as zero-cost offers.
          </p>
          {report.exclusionReasons.map(({ reason, count }) => (
            <small key={reason}>{count} excluded: {reason}</small>
          ))}
        </section>
      </main>

      <footer>
        <span>SolvingZero plan comparison</span>
        <span>Estimates are indicative, not an offer.</span>
      </footer>
    </div>
  );
}

function formatBreakdown(value: number | undefined, credit = false): string {
  return value === undefined
    ? "Not available"
    : `${credit ? "−" : ""}${preciseMoney.format(value)}`;
}

function BreakdownRow({
  label,
  value,
  className,
  credit = false,
}: {
  label: string;
  value: number;
  className: string;
  credit?: boolean;
}) {
  return (
    <div className={`breakdown-row${credit ? " credit" : ""}`}>
      <div><span className={`swatch ${className}`} />{label}</div>
      <strong>{credit ? "−" : ""}{preciseMoney.format(value)}</strong>
      <span className="bar">
        <i style={{ width: largestCurrentComponent > 0 ? `${(value / largestCurrentComponent) * 100}%` : "0%" }} />
      </span>
    </div>
  );
}

function BillCheck() {
  const bill = current.billReconciliation;
  const passed = bill.status === "PASSED";
  const unavailable = bill.status === "UNAVAILABLE";
  return (
    <aside className="bill-check">
      <span className="check-mark" aria-hidden="true">{passed ? "✓" : "!"}</span>
      <div>
        <p>
          {passed
            ? "Estimate checked against your bills"
            : unavailable
              ? "No bills available to check"
              : "We couldn't fully check this against your bills"}
        </p>
        {passed ? (
          <>
            <strong>Your estimate looks reliable</strong>
            <span>
              It matched {bill.days} days of bills within{" "}
              {preciseMoney.format(Math.abs(bill.differenceAud))}.
            </span>
          </>
        ) : (
          <>
            <strong>{unavailable ? "Based on usage data only" : "Treat this estimate as a guide"}</strong>
            <span>
              {unavailable
                ? "We couldn't find matching bills to confirm this estimate."
                : "Some bill information did not line up with your usage history."}
            </span>
          </>
        )}
      </div>
    </aside>
  );
}
