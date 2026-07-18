<!-- @format -->

# SolvingZero Compare Plans Overview

This is a **2-hour** coding exercise, please don't spend more time on it. This is about lean engineering decisions more than about how much you finish. Maintain a decison log so we can see what you assess, build, leave out, and hand off to AI. Please log your core decisions so we can see _when_ and _why_ you made them.

> Anything you build here is for evaluation only, it won't be used in production.

SolvingZero helps Australian households understand their electricity and make smart choices. A core part of that is fetching real data, working out the costs, and assessing the options.

## Quick start guide

**Fastest — zero local setup (GitHub Codespaces):**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Sbendat/solvingzero-compare-plans-exercise)

Click the badge (or **Code ▸ Codespaces ▸ Create codespace on main**). The dev container installs dependencies and runs the setup check for you — a working environment in the browser in about a minute.

**Local:**

```bash
nvm use          # optional — pins Node 22 (see .nvmrc)
npm install
npm run verify   # confirms your toolchain + that the data loads (does NOT test your solution)
npm test         # runs the focused backend calculation and integration tests
```

You implement two stubs in `src/`: [`fetchPlans.ts`](src/fetchPlans.ts) and [`estimatePlanCosts.ts`](src/estimatePlanCosts.ts). Then read [`GOAL_GUIDE.md`](GOAL_GUIDE.md) and pick where to start.

## The task

This exercise asks that you pull plans from ten different electrcity providers (retailers) from a publically avaliable API and then use that data to calculate and identify a cheaper plan the user can move to. If time permits you can wireframe a UI for the user as well.

In this folder is a real household's electricity usage and relevant data, almost everything you need should already be provided here in this project. Feel free to reach out if anything is unclear or ambigious.

## The ten retailers

You are given a fixed list of ten retailers in [`retailers.json`](retailers.json), each with a working base URI. If you should need more information about a retailers base URI we have also provided the `CDR Base URIs.pdf`

### Fetching plans

The "Product Reference Data" (PRD) plans are avaiable via public unauthenticated endpoints.

1. **List a retailer's plans.** `GET {baseUri}/cds-au/v1/energy/plans` with header **`x-v: 1`**. Supports `type`, `fuelType`, `effective`, and pagination. The response's `meta.totalRecords` / `meta.totalPages` tell you when to stop.
2. **Get plan detail.** The pricing lives in the detail: `GET {baseUri}/cds-au/v1/energy/plans/{planId}` with header **`x-v: 3`** (note: the detail endpoint is a **different version** from the list). If a `planId` contains an `@`, **URL-encode it as `%40`** or the request 406s.

**Filtering to this household** (narrow before you cost):

- **Fuel:** `fuelType` = `ELECTRICITY`.
- **Customer type:** `customerType` = `RESIDENTIAL`.
- **Active:** drop expired plans (`effectiveTo` in the past).
- **Distributor:** the household's distributor is the `LNSP` party in `service-points.json` (`related_participants`). Match it to a plan's `geography.distributors`.
  - **The names don't match verbatim** so you'll need a small reconciliation (e.g. `CitiPower Pty` → `CITIPOWER`). Don't filter by postcode — many regions split postcodes; use the distributor instead.

> **How plan pricing is structured** (rate blocks, time-of-use, tiered, controlled load, feed-in, demand charges, GST, the two snake*case/camelCase formats) is documented in [`DATA_DICTIONARY.md`](DATA_DICTIONARY.md) → \_Plans — CDR `EnergyPlanDetail`*. Both cost goals rely on it.

## What you'll build — the goals

**These are in no particular order.** See [`GOAL_GUIDE.md`](GOAL_GUIDE.md) for a starting point on each.

- **What is this household paying today?** — cost their _current_ plan (`accounts.json`) against their real usage, as of today.
- **Find the cheapest plan** — fetch + filter + cost the 10 retailers' plans, rank them.
- **User-facing UI** — a minimal CLI or UI that shows your calculations. This is not a design test.

Underpinning all of it is a **cost engine** (cost a plan against 30-minute usage: flat / time-of-use / others, GST, solar credit) and the **fetch + filter + dedup** that feeds it — the two cost goals share both.

## The data you're given

In `user_data/` (real household data, de-identified — see **[`DATA_DICTIONARY.md`](DATA_DICTIONARY.md)**):

- **`usage.json`** — 30-minute interval reads (E1 import, B1 export).
- **`service-points.json`** — the home's connection, distributor, meters/registers.
- **`accounts.json`** — the household's current plan (today's tariff).
- **`bills.json`** — their real bills (a cross-check for your costing).
- **`der.json`** — the solar system.

## What is provided

- TypeScript types ([`src/types.ts`](src/types.ts)), data loaders ([`src/loadData.ts`](src/loadData.ts)), a wired test runner, the data dictionary, the 10 retailers + their base URIs, a fetch guide, and a recorded plans snapshot.

## What we assess

1. **Code quality & testing** — structure, types, your own tests, readability, sensible (not excessive) abstraction. _Largest single component._
2. **Calculation correctness** — do today's cost and the plan costs reflect the tariffs, usage, GST, and solar credits? Does the baseline reconcile with the bills?
3. **Data-issue handling** — did you notice the messy/invalid plans, and handle them sensibly (not crash, not silently mis-cost)?

There is also a **short live walkthrough** after you submit (~20–30 min): we'll ask you to talk through your code and make a small change or two live. It's a conversation about your own work, not a test of memorisation — but being able to extend your own code matters.

## Write-ups

- Spend 20 to 30mins writing up each meaningful decision: what you decided, the options you considered, why you chose, and what you'd do with more time. Include how you **sequenced** the goals and what you left out.

## Running it

```bash
npm install
npm run verify    # setup smoke-test: confirms Node/TS + that the data loads
npm test          # focused backend calculation and integration tests
npm run typecheck
```

## Compare plans from the command line

The recorded fixture is the deterministic default and does not require network access:

```bash
npm run compare -- --as-of 2026-07-14 --top 5
```

To fetch current plans from the ten supplied retailer endpoints instead:

```bash
npm run compare:live -- --top 5
```

## Run the web report

```bash
npm --prefix web-ui install
npm --prefix web-ui run dev
```

There is no separate backend server or REST API. The web `predev`, `prebuild`, and `pretypecheck` steps run the root engine through
`scripts/generate-web-report.ts`, write one comparison report, and then server-render that report. `npm run compare`
runs the same engine without the web presentation.

The output leads with the validated current-plan cost, shows a potential saving only when a costed alternative is
cheaper and not known to be ineligible, identifies the retailer, surfaces eligibility caveats, and reports plans
that were excluded rather than silently treating them as zero-cost offers. The web report regenerates from this
same engine before every web development session and local validation check.
