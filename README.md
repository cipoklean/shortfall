# Shortfall

**FDA drug shortage response inside Jira and Confluence — built on Atlassian Forge for Codegeist 2026.**

> When a drug goes into shortage, a hospital does not struggle to look up the FDA list — it struggles to find which protocols and order sets name the drug, who owns each one, what was decided last time, and later how to undo every temporary workaround when supply returns. **Shortfall turns that scavenger hunt into a tracked, reversible workflow inside Atlassian Cloud.**

- **Codegeist 2026 Track:** Apps for Specialized Industries (Hospital Pharmacy & Clinical Informatics)
- **Bonus Prizes Targeted:** Best Rovo Agent (`rovo:agent` + `rovo:skill` + 8 `action` modules) · Best App with Atlassian MCP (`rovo:mcp` + standalone `mcp/SKILL.md`) · Best Teamwork Graph Integration (curated GraphQL queries + 2nd-hop protocol blast radius)
- **Judge Setup Guide:** [`docs/JUDGES.md`](docs/JUDGES.md) · **Demo Script:** [`docs/VIDEO_SCRIPT.md`](docs/VIDEO_SCRIPT.md) · **Devpost Draft:** [`docs/DEVPOST.md`](docs/DEVPOST.md)

---

## Why This Matters

- US hospitals spent **20.2 million staff hours** and **$894 million** in labor managing drug shortages in a single year ([Vizient 2024 Drug Shortages Survey](https://newsroom.vizientinc.com/press_releases/drug-shortages-cost-hospitals-nearly-900-million-annually-in-labor-costs-new-report)).
- Large hospitals spend up to **66 staff hours per week** hunting down affected protocols, chasing owners, and updating order sets ([ASHP 2024 National Survey](https://www.ashp.org/drug-shortages/shortage-resources/drug-shortages-survey)).

Shortfall uses Jira, Confluence, Teamwork Graph, Rovo, and Atlassian MCP as the hospital's institutional memory for drug shortages.

---

## How Shortfall Works (6-Step Loop)

```text
  openFDA Drug Shortages API + NLM RxNav (public drug data only)
                                │
                                ▼
  1. WATCH ──────► Daily scheduledTrigger -> async queue (900s) -> Forge SQL
                   10->11-digit HIPAA NDC + strict single-vs-combo RxNorm match
                                │
                                ▼
  2. MAP IMPACT ─► Direct Confluence v2 page scan (zero CQL lag) + Jira JQL
                   Teamwork Graph: human owners, teams & 2nd-hop linked pages
                                │
                                ▼
  3. RESPOND ────► At most 1 Jira [Shortage] work item per shorted ingredient
                   Priority by FDA status (High / Medium), clickable ADF links,
                   linked [Owner Review] tasks (real Jira Relates links)
                                │
                                ▼
  4. MARK PAGES ─► Confluence contentBylineItem notice on every affected page
                   linking straight to the active Jira response & FDA record
                                │
                                ▼
  5. DRAFT ──────► Rovo Shortfall agent + 6-phase playbook skill + 6 MCP tools
                   Drafts conservation plans & clinician notices from the
                   hospital's own past decisions (person approves all writes)
                                │
                                ▼
  6. REVERSE ────► When FDA marks supply Resolved: opens [Reversal] Jira tasks
                   with clickable protocol links + 4-step reversal checklist;
                   Confluence page notices clear when reversal completes
```

---

## Forge Architecture & Codegeist Bonus Mapping

Shortfall runs 100% on Atlassian Forge (`nodejs24.x`, TypeScript) with **zero `@forge/llm` billing** (all generative drafting goes through Rovo) and **exactly two public external hosts** (`api.fda.gov`, `rxnav.nlm.nih.gov`).

| Atlassian Capability | Manifest Module(s) | What It Powers in Shortfall |
|---|---|---|
| **Jira Dashboard & Setup** | `jira:globalPage` (`shortfall-dashboard`) | Custom UI styled with Atlassian Design Tokens (light & dark mode): Guided First-Run Setup Wizard, KPI strip, ingredient-grouped shortage table (distinct NDC rows), Shortage Detail Drawer, CSV formulary import, and Sample Hospital loader/remover |
| **Jira Response Panel** | `jira:issuePanel` (`shortage-response-panel`) | Embedded on `[Shortage]` work items: FDA presentation facts, direct + 2nd-hop impact map, "Seen Before" past decisions, and Temporary Changes & Reversal tracker |
| **Confluence Page Notices** | `confluence:contentBylineItem` (`shortage-page-notice`) | Dynamic byline indicator + popup on affected protocol pages linking directly to the open Jira response and FDA source records via `@forge/bridge` `router.open()` |
| **Teamwork Graph API** | `api.asUser().requestTeamworkGraph` (`src/graph.ts`) | Curated GraphQL queries (`confluencePageOwners`, `confluencePageCreator`, `confluencePageContributors`, `atlassianUserInTeams`, `atlassianTeamsBySpace`, `confluencePageLinkedConfluencePages`) resolving human owners, teams, and **2nd-hop linked protocol blast radius**, with explicit reduced-mode reporting |
| **Rovo Agent & Skill** | `rovo:agent` (`shortage-agent`), `rovo:skill` (`drug-shortage-response`), 8 `action` modules | Rules-enforcing prompt (`src/prompts/shortage-agent.md`), 6-phase response playbook (`skills/drug-shortage-response/SKILL.md`), 6 read actions + 2 confirmation-gated write actions, plus a one-click **"Ask Shortfall in Rovo"** dashboard launcher (`rovo.open()`) |
| **Atlassian MCP** | `rovo:mcp` (`shortfall-mcp`) + [`mcp/SKILL.md`](mcp/SKILL.md) | Exposes all 6 read actions (`get-active-shortages`, `get-shortage-impact`, `get-past-responses`, `get-response-status`, `draft-clinician-message`, `get-reversal-checklist`) to Rovo Studio and external MCP clients |
| **Async Pipeline & Storage** | `scheduledTrigger`, `consumer`, `sql` (MySQL) + `@forge/kvs` | 17 versioned Forge SQL migrations (`migrationRunner`), 100% parameterized `sql.prepare().bindParams()`, SHA-256 FDA change detection, batched upserts, and KVS caching |

---

## Try It in 5 Minutes (Judge Walkthrough)

Full instructions (including org-admin Teamwork Graph scope approval) are in [`docs/JUDGES.md`](docs/JUDGES.md).

1. **Install** Shortfall on an Atlassian Cloud site with **Jira, Confluence, and Rovo** enabled, and have an organization admin enable the Teamwork Graph scopes under *Atlassian Administration -> Connected apps -> Shortfall -> Permissions*.
2. **Open Jira -> Apps -> Shortfall** and switch to **Setup & Formulary**.
3. Click **Load sample hospital** — creates a fictional perioperative/ICU Confluence space (`SHOSP`, 10 protocol pages owned by your user, zero patient data), a 12-item surgical formulary, historical decision context, and a resolved Bumetanide reversal scenario via the normal product APIs, and maps impact immediately with no CQL lag. *(One click on **Remove sample hospital** cleans up everything it created.)*
4. Pick your Jira response project (auto-create stays **OFF** by default until an admin opts in), click **Sync now**, then click **Enrich owners & links (Teamwork Graph)** to resolve human owners, discover 2nd-hop linked order sets (*ED airway escalation checklist*, *Orthopedic arthroplasty admission order set*), and create linked `[Owner Review]` Jira tasks with real **`Relates`** issue links.
5. Click **"Ask Shortfall in Rovo"** in the dashboard header (or choose **Shortfall** in the Rovo agent picker — not the default generic Rovo agent) and ask:
   - *"What does the cefazolin shortage affect and what did we do last time?"*
   - *"Which temporary changes still need to be reversed?"*
6. Open any affected page in `SHOSP` (e.g., *Rapid sequence intubation order set* or *ICU diuretic protocol — loop diuretic infusions*) to inspect the **Shortfall** Confluence byline notice.

---

## Safety, Privacy & Clinical Guardrails

Shortfall is built for healthcare teams where accuracy and restraint matter more than automation:

1. **No patient data.** Never asks for, stores, or displays patient information. Inbound traffic is public FDA/NLM drug metadata only; nothing about the customer's Jira or Confluence site leaves Atlassian Cloud.
2. **No clinical advice.** Never selects, ranks, or recommends a substitute drug. Only alternatives already approved on the hospital's own Confluence pages are quoted, always with a link.
3. **Every fact has a source.** Every shortage links to both the [FDA Drug Shortages Database](https://dps.fda.gov/drugshortages) and the exact `openFDA record (raw data)` NDC query, accompanied verbatim by the openFDA disclaimer.
4. **Exact products stay separate.** Different strengths, dosage forms, and package sizes (NDCs) are never merged into one row; single-ingredient presentations never match combination formulary items (and vice versa).
5. **Honest reduced mode.** Missing Teamwork Graph scopes or unavailable capabilities are listed clearly on the dashboard rather than failing silently.
6. **Consent-gated writes.** Automatic Jira response creation is **OFF** by default on fresh installs; agent write actions (`create-response-task`, `log-temporary-change`) always ask for explicit human confirmation first.
7. **Zero raw SQL concatenation.** Every Forge SQL query uses parameterized `sql.prepare().bindParams().execute()`.

---

## Engineering Highlights (Verified Live)

Measured live on reference demo site `one-atlas-ojjg.atlassian.net` (**v7.17.0**) against real openFDA data (1,581 records):

- **Ultra-low Forge SQL footprint:** Cut from ~3,200 statements/sync (initial prototype) down to **17 statements combined** for a full no-change sync + dashboard load (11 sync statements via SHA-256 FDA content-hash skip + 6 dashboard load statements via single-query aggregate KPIs and KVS-cached schema version guard).
- **Pharmacy-grade matching:** Converts FDA 10-digit hyphenated NDCs (`4-4-2`, `5-3-2`, `5-4-1`) to HIPAA 11-digit (`5-4-2`) format, strips FDA `openfda.rxcui` SPL family contamination, enforces whole-word token boundaries (`epinephrine` != `norepinephrine`), and enforces strict single-vs-combo symmetry.
- **Zero-lag impact discovery:** Direct Confluence v2 storage-body scan maps newly created protocol pages immediately on Load/Sync with zero CQL indexing delay, while excluding Shortfall's own Jira response project from self-matching.
- **Clean Jira tickets:** At most 1 open `[Shortage]` work item per shorted ingredient (`Current` = High, `To Be Discontinued` = Medium, `Resolved` = no ticket), explicit `assignee: null` when unresolved (no silent fallback to a project lead), clickable ADF page & FDA links, and 1 idempotent `[Owner Review]` task per human owner per ingredient connected via real Jira `Relates` issue links.
- **Offline test suite:** **49/49 Vitest unit tests** across 4 test files running strictly offline against saved openFDA and RxNav fixtures (`test/fixtures/`).

---

## Repository Structure

```text
manifest.yml                     Forge modules, scopes, and external egress (api.fda.gov, rxnav.nlm.nih.gov)
src/
  index.ts                       Forge function entry points (UI resolver, trigger, queue worker, actions, byline)
  fda.ts                         Paged openFDA shortages client (exponential backoff, timeout, optional API key)
  rxnav.ts                       NLM RxNav client with KVS cache and bounded concurrency
  match.ts                       Pure deterministic matcher (11-digit HIPAA NDC, RxNorm IN, strict combo symmetry)
  sync.ts                        Scheduled/manual async sync pipeline (SHA-256 skip, batched upserts, stale-lock recovery)
  impact.ts                      Direct Confluence v2 page scan + Jira JQL impact mapper (excludes response project)
  graph.ts                       Teamwork Graph curated queries (owners, creator, contributors, teams, 2nd-hop pages)
  respond.ts                     Jira responses, ADF builders, Relates links, per-owner tasks, reversal & cleanup
  actions.ts                     8 Rovo action handlers (6 read / MCP tools + 2 write tools; human status labels)
  resolvers.ts                   Custom UI resolvers (dashboard, setup wizard, detail drawer, panel, byline, enrich)
  sample.ts                      Idempotent Sample Hospital loader/remover (SHOSP + 10 pages + 12 surgical drugs)
  settings.ts                    KVS-backed site settings (autoCreateResponses defaults false)
  storage/schema.ts              17 versioned Forge SQL migrations + parameterized query/execute helpers
  webtrigger.ts                  Sealed dev diagnostic endpoints (HTTP 404 unless SHORTFALL_DIAG_TOKEN is set)
  prompts/shortage-agent.md      Rovo agent system instructions
skills/drug-shortage-response/   Rovo skill 6-phase response playbook (SKILL.md)
mcp/SKILL.md                     Standalone MCP skill guide for Rovo Studio and external MCP clients
ui/                              Custom UI source bundled via esbuild -> static/ (dashboard, issue-panel, byline)
scripts/cleanup-demo.ts          Safe dry-run-by-default cleanup CLI for demo Jira response projects
test/                            49 offline Vitest unit tests + real openFDA / RxNav fixtures
landing/                         Zero-dependency static site (/, /setup, /privacy, /support) with live FDA counter
docs/                            JUDGES.md, DEVPOST.md, VIDEO_SCRIPT.md
```

---

## Local Development & Verification

Requires **Node.js 22.23.4+ or 24.22.1+** and `@forge/cli`. Authenticate with `FORGE_EMAIL` and `FORGE_API_TOKEN` environment variables (never commit tokens).

```bash
npm install
npm run ui:build        # bundle Custom UI resources (ui/ -> static/)
npm run build           # TypeScript typecheck (tsc --noEmit)
npm run lint            # ESLint (src + test)
npm test                # 49 offline Vitest tests against saved fixtures
forge lint              # validate Forge manifest & Rovo skill/MCP config
forge deploy -e development --non-interactive
forge install --demo-site -p Jira -e development --upgrade --non-interactive
forge install --demo-site -p Confluence -e development --upgrade --non-interactive
```

Build and preview the static landing site locally:

```bash
npm run landing:build   # builds landing/dist/ (including clean /setup, /privacy, /support)
cd landing/dist && python3 -m http.server 4173
```

---

## Disclaimer

> Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.

Shortfall is an independent application built for Codegeist 2026 and is not affiliated with or endorsed by Atlassian or the FDA.
