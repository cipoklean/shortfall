# Shortfall

Drug shortage response for Jira and Confluence. When the FDA puts a drug on
the shortage list, Shortfall finds which of the site's protocols and work
items name it, who owns each one, what was decided last time — and later
helps undo the temporary changes when supply returns.

## What it does

1. **Watch** — syncs the FDA drug shortage list daily and matches it to the
   site's drug list (formulary) by NDC, then RxNorm ingredient + dosage form.
2. **Map impact** — finds the Confluence pages and open Jira work that name
   the drug, each item's owner and team (via the Teamwork Graph), and earlier
   responses to the same drug.
3. **Respond** — creates one Jira work item per shortage with a task per
   owner (only when the admin enables automatic creation).
4. **Mark pages** — a notice in each affected page's byline linking to the
   response.
5. **Draft** — a Rovo agent drafts the conservation plan and clinician
   message from the site's own past decisions. A person approves before
   anything is written.
6. **Reverse** — when the FDA marks the shortage resolved, a task opens per
   temporary change and the page notices clear.

## Product rules

- **No patient data.** Inbound data is public FDA and NLM data only. Nothing
  about the site is sent to any external host.
- **No clinical advice.** Never chooses, ranks or recommends a substitute
  drug; only alternatives the site's own pages already approve, quoted with
  a link.
- **Every statement has a source**, and the openFDA disclaimer is shown
  wherever FDA data appears.
- **Exact products stay separate** — presentations (NDCs) are never merged.
- **Reduced mode** — missing Teamwork Graph scopes or unavailable products
  are listed in the UI, not hidden.
- **Writes need consent** — automatic creation is off unless the admin
  enables it; agent-initiated writes always ask first.

## Architecture

Forge app (TypeScript), deployed per-installation:

```
manifest.yml                  modules: jira:globalPage, jira:issuePanel,
                              confluence:contentBylineItem, scheduledTrigger,
                              consumer (async queue), 6 action modules,
                              rovo:agent, rovo:skill, rovo:mcp, sql
src/
  fda.ts                      openFDA client (paged, resumable, API key optional)
  rxnav.ts                    NLM RxNav client, KVS-cached (NDC -> rxcui -> IN)
  match.ts                    matching engine — pure, unit-tested on fixtures
  sync.ts                     scheduled trigger -> queue -> 900s worker;
                              migration, fetch, match, impact, respond
  impact.ts                   Confluence CQL + Jira JQL + Teamwork Graph owners
  respond.ts                  Jira response items + reversal tasks
  graph.ts                    Teamwork Graph probe + reduced-mode detection
  storage/schema.ts           versioned Forge SQL migrations (migrationRunner)
  settings.ts                 KVS-backed admin settings
  actions.ts                  the six action handlers (agent + MCP tools)
  resolvers.ts                UI resolver functions (dashboard, byline, panel)
  prompts/shortage-agent.md   agent system prompt (enforces the rules above)
skills/drug-shortage-response/  rovo:skill playbook (assess -> reverse)
static/                       Custom UI resources (dashboard, panel, byline)
test/fixtures/                real openFDA + RxNav responses; tests never
                              touch the network
landing/                      marketing/docs site (plain static, no tracking)
docs/                         JUDGES.md, VIDEO_SCRIPT.md, DEVPOST.md
```

External hosts (declared under `permissions.external.fetch.backend`):
`api.fda.gov`, `rxnav.nlm.nih.gov`. Nothing else.

## Develop

Requires Node.js 22.23.4+ or 24.22.1+ and `@forge/cli`. Set `FORGE_EMAIL`
and `FORGE_API_TOKEN` instead of `forge login`.

```bash
npm install
npm run build        # tsc --noEmit
npm run lint         # eslint
npm test             # vitest (offline, uses saved fixtures)
forge lint           # manifest validation
forge deploy -e development --non-interactive
forge install --demo-site -p Jira -e development --upgrade --non-interactive
forge tunnel         # local iteration
```

Landing page:

```bash
cd landing && node build.mjs     # builds dist/, fetches the build-time FDA count
cd dist && python3 -m http.server 4173
```

## Status

- [x] M0 — app deploys and installs on the demo site
- [~] M1 — feed + matching (engine + fixtures done, sync wired)
- [ ] M2 — impact + response
- [ ] M3 — agent, skill, MCP, reversal
- [ ] M4 — clean-site verification
- [ ] M5 — submission materials
