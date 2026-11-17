# Shortfall — agent notes

Forge app (TypeScript) for Codegeist 2026 + a static landing page.

## Commands

- `npm run build` / `npx tsc --noEmit` — typecheck
- `npm run lint` — eslint (src + test)
- `npm test` — vitest; offline, fixtures in `test/fixtures/`
- `forge lint` — manifest validation (run after every manifest edit)
- `forge deploy -e development --non-interactive` — deploy (may need
  `--approve MAJOR_VERSION_RULE` after egress changes)
- `forge install --demo-site -p Jira -e development --upgrade --non-interactive --confirm-scopes`
  (repeat with `-p Confluence`)
- `cd landing && node build.mjs` — build landing site into `landing/dist/`

## Environment

- Node must be `>=22.23.4` or `>=24.22.1`; the Forge CLI hard-fails on older.
  On this machine use `export PATH=$HOME/.local/node24/bin:$PATH`.
- Auth: `FORGE_EMAIL` + `FORGE_API_TOKEN` env vars (source `.env`); never run
  `forge login` or print the token.
- Demo site: `one-atlas-ojjg.atlassian.net` (provisioned via `forge site
  provision`; Jira + Confluence installed).

## Product rules that must hold

- No patient data. External fetch is limited to `api.fda.gov` and
  `rxnav.nlm.nih.gov` — ask before adding any host.
- No substitute-drug recommendations anywhere (UI, agent prompt, actions).
- Every fact links to a source; show the openFDA disclaimer with FDA data.
- Never merge presentations (NDCs); group by ingredient only for display.
- Missing Teamwork Graph scopes silently return less data — detect and
  surface as reduced mode, never fail silently.
- Writes (work items, tasks, notices) require admin-enabled auto-create or
  explicit person confirmation.
- Do NOT use `@forge/llm`; generative work goes through the Rovo agent.

## Gotchas learned

- `forge lint` enforces: action `actionVerb` ∈ CREATE/UPDATE/DELETE/TRIGGER/
  GET; function keys ≤23 chars; `confluence:contentBylineItem` has no
  `resolver`/`viewportConfiguration` (use `resource` + `viewportSize` +
  `viewportContainer` + `dynamicProperties`); SKILL.md `allowed-tools` is a
  space-delimited string matching `rovo:skill` `dependencies.tools`.
- FDA `openfda.package_ndc` covers the whole product family — only the
  record's own `package_ndc` identifies the presentation (see `src/match.ts`).
- `tsconfig` must emit for the Forge bundler; `outDir` points at
  `node_modules/.cache/forge-out`. Use `tsc --noEmit` for checks.
- `landing/config/site.json` is the single source of truth for all links on
  the landing page (still contains TODO placeholders).
