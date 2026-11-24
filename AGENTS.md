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

## Git

- Remote: `origin` = https://github.com/cipoklean/shortfall.git (main).
- ALWAYS commit as `cipoklean` — repo-local `user.name`/`user.email` are set;
  never commit as the Devin bot identity.

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
- `cursor` is a MySQL reserved word (migration 007 failed); use `resume_cursor`.
- Confluence v1 content API is removed (410): use `/wiki/api/v2/pages`,
  `/wiki/api/v2/spaces` and granular scopes `read:space/write:page/
  delete:page:confluence`; CQL search needs `search:confluence`.
- Forge SQL schemas are per install context — run migrations at every entry.
- Teamwork Graph API is user-context ONLY (`api.asUser()`); asUser(id)
  impersonation → NO_IMPERSONATION_SCOPES_DEFINED. Owner/team enrichment
  must run in a user-invoked resolver (`enrichImpact`) or byline context.
- JQL/CQL: `~` takes one term each — `text ~ "a" OR text ~ "b"`.
- Webtrigger ctx has no environmentId; installContext ARI carries cloudId.
  Evidence URLs are gated on token = cloudId (forge logs show principal=undefined).
- Demo evidence: site one-atlas-ojjg.atlassian.net, sample space SHOSP,
  response project PROC (response item PROC-126), dashboard via Jira Apps nav.
- Atlassian Forge CLI lives at `/home/ubuntu/.local/bin/forge` (Foundry's
  `~/.foundry/bin/forge` can shadow `forge` if PATH puts foundry first).
- All Forge SQL queries use parameterized `query()` / `execute()` backed by
  `sql.prepare().bindParams().execute()` — never `sql.executeRaw` string concat.
- Teamwork Graph calls MUST use `api.asUser()` (NO `userId` argument; passing
  `userId` activates offline impersonation -> NO_IMPERSONATION_SCOPES_DEFINED)
  and `<company>_<operation>` GraphQL operation names (`shortfall_*`).
- Custom UI iframes are sandboxed on Atlassian's Forge CDN origin: every
  internal and external link MUST use `@forge/bridge` `router.open()` with
  `siteUrl` prepended for relative paths (and `/wiki` for Confluence `webui`).
- Diagnostic webtriggers require encrypted `SHORTFALL_DIAG_TOKEN` env var and
  return HTTP 404 when unset (sealed by default on judge/prod sites).
