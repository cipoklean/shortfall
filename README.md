# Shortfall

Drug shortage response for Jira and Confluence. When the FDA puts a drug on
the shortage list, Shortfall finds which of the site's protocols and work
items name it, who owns each one, what was decided last time — and later
helps undo the temporary changes when supply returns.

## What it does

1. **Watch** — syncs the FDA drug shortage list daily and matches it to the
   site's drug list (formulary) using true 10→11-digit HIPAA NDC
   normalization first, then whole-word, combination-aware RxNorm
   ingredient + dosage form matching (presentations are never merged).
2. **Map impact** — finds the Confluence pages and open Jira work that name
   the drug, resolves owners, teams, and **2nd-hop blast radius** linked
   protocols via Teamwork Graph curated queries (`confluencePageOwners`,
   `confluencePageCreator`, `confluencePageLinkedConfluencePages`,
   `atlassianTeamsBySpace`, `atlassianUserInTeams`), and surfaces earlier
   responses to the same drug.
3. **Respond** — creates one Jira work item per shortage with per-owner
   Jira tasks, a Shortage Detail Drawer, a Jira issue panel, and a
   Temporary Changes & Reversal Checklist (auto-creation only when the
   admin enables it).
4. **Mark pages** — a notice in each affected Confluence page's byline
   linking straight to the Jira response.
5. **Draft** — a Rovo agent (8 Rovo actions: 6 read tools also exposed via
   `rovo:mcp` + standalone `mcp/SKILL.md` for external MCP clients, plus 2
   confirmation-gated write actions) drafts the conservation plan and
   clinician message from the site's own past decisions. A person approves
   before anything is written.
6. **Reverse** — when the FDA marks the shortage resolved, a reversal task
   opens for each tracked temporary change and the page notices clear.

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
  enables it; agent-initiated writes always confirm first.
- **Parameterized storage** — all Forge SQL queries use `sql.prepare`
  parameterized bindings.

## Architecture

Forge app (TypeScript, `nodejs24.x`), deployed per-installation, styled with
Atlassian Design Tokens (light/dark) and a Guided First-Run Setup Wizard:

```
manifest.yml                  modules: jira:globalPage, jira:issuePanel,
                              confluence:contentBylineItem, scheduledTrigger,
                              consumer (async queue), 8 action modules,
                              rovo:agent, rovo:skill, rovo:mcp, sql
src/
  fda.ts                      openFDA client (paged, resumable, API key optional)
  rxnav.ts                    NLM RxNav client, KVS-cached (NDC -> rxcui -> IN)
  match.ts                    10->11-digit HIPAA NDC + whole-word,
                              combination-aware matching (pure, unit-tested)
  sync.ts                     scheduled trigger -> queue -> 900s worker;
                              migration, fetch, match, impact, respond
  impact.ts                   Confluence CQL + Jira JQL + Teamwork Graph owners,
                              teams & 2nd-hop linked protocols
  respond.ts                  Jira response items, per-owner tasks, temporary
                              changes & reversal tasks
  graph.ts                    Teamwork Graph curated queries + reduced-mode probe
  storage/schema.ts           versioned Forge SQL migrations (migrationRunner)
                              and parameterized sql.prepare queries
  settings.ts                 KVS-backed admin settings
  actions.ts                  8 Rovo action handlers (6 read / MCP + 2 write)
  resolvers.ts                UI resolver functions (dashboard, drawer, panel, byline)
  prompts/shortage-agent.md   agent system prompt (enforces the rules above)
skills/drug-shortage-response/  rovo:skill playbook (assess -> reverse)
mcp/SKILL.md                  standalone MCP skill guide for external clients
ui/                           Custom UI source (esbuild -> static/): setup wizard,
                              dashboard + Shortage Detail Drawer, issue panel +
                              Temporary Changes & Reversal Checklist, byline
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
npm run ui:build     # bundle Custom UI resources into static/
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
cd landing && node build.mjs     # builds dist/ (with clean /setup, /privacy, /support), fetches FDA count
cd dist && python3 -m http.server 4173
```

## Status

- [x] M0 — app deploys and installs on the demo site (verified live)
- [x] M1 — feed + 10→11-digit NDC & RxNorm matching (verified live on demo site)
- [x] M2 — impact map, Teamwork Graph 2nd-hop blast radius, response & byline notices (verified live on demo site)
- [~] M3 — 8 Rovo actions, skill, `rovo:mcp` + `mcp/SKILL.md`, temporary changes & reversal (implemented; ready for live Rovo Chat/Studio check)
- [ ] M4 — clean-site install verification
- [ ] M5 — final video & Devpost submission materials
