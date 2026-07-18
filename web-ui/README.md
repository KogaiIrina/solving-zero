# SolvingZero plan comparison UI

A minimal, responsive local report for the electricity-plan comparison exercise. Before development or a validation build, it runs the root comparison engine against the recorded plan fixture and generates `app/comparison-report.json`. The page contains no separate plan names, prices, rankings, or eligibility decisions.

Known-ineligible plans remain visible for transparency but cannot become the recommendation. Plans with conditions that cannot be verified from the supplied household data are labelled for manual confirmation.

## How the engine connects to the page

There is no separate HTTP API or long-running backend process. This is a read-only generated report:

1. The root TypeScript engine calculates the current cost and all candidate costs.
2. `scripts/generate-web-report.ts` turns those results into one shared comparison report.
3. The web `predev`, `prebuild`, and `pretypecheck` scripts write that report to `app/comparison-report.json`.
4. The server-rendered page imports the report and presents it.

This avoids duplicating business rules in an API layer. Run the engine by itself with `npm run compare`; run the generated web report with `npm --prefix web-ui run dev`.

## Local development

```bash
npm install
npm --prefix web-ui install
npm --prefix web-ui run dev
```

The development server is available at `http://localhost:3000` by default.

## Validation

```bash
npm --prefix web-ui run build
npm --prefix web-ui run typecheck
```

Both checks regenerate the report first. The build is only a local validation step; this project has no deployment configuration.
