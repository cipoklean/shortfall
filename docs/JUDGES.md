# Judge guide — Shortfall

Shortfall is a Forge app that turns the public FDA drug shortage list into a
tracked, reversible response inside your Jira and Confluence site.

**Requires an Atlassian Cloud site with Rovo enabled**, with Jira and
Confluence both present.

## Install

1. Open the installation link: `TODO: installation link from the developer
   console (sharing enabled)`
2. Pick your site and approve the requested scopes.
3. Grant the Teamwork Graph scopes — this needs an **organization admin**:
   - Atlassian Administration → Apps → your site → Connected apps
   - Select **Shortfall** → Permissions
   - Enable the Teamwork Graph scopes (users, teams, Confluence pages, Jira
     work items). Scope changes take about a minute.

## Set up (about five minutes)

1. In Jira, open **Apps → Shortfall**. On a fresh site, the **Guided
   First-Run Setup Wizard** walks you through every step (the UI follows
   Atlassian Design Tokens for both light and dark themes).
2. **Clinical spaces**: pick the Confluence spaces holding protocols/order
   sets. Only these count toward the impact map.
3. **Drug list**: paste or upload a CSV (10-digit NDCs are normalized to
   11-digit HIPAA format automatically), or press **Load sample hospital**
   (creates a fictional Confluence space, drug list and Jira project using
   the normal product APIs — no patient data anywhere).
4. **Response mode**: automatic or manual work-item creation, and the Jira
   project for responses.
5. **Run first sync**. The dashboard shows matched shortages (matched by
   10→11-digit HIPAA NDC first, then whole-word, combination-aware RxNorm
   ingredient + dosage form), the impact map, owners, and the last sync
   result.

## What to try

- Click a matched shortage row → the **Shortage Detail Drawer** shows the
  FDA presentation facts, direct Confluence/Jira hits, **2nd-hop blast
  radius** linked protocols, resolved owners/teams, and earlier responses.
- Click **Enrich owners** → runs user-context Teamwork Graph curated
  queries (`confluencePageOwners`, `confluencePageCreator`,
  `confluencePageLinkedConfluencePages`, `atlassianTeamsBySpace`,
  `atlassianUserInTeams`) to map owners, teams, and linked 2nd-hop pages.
- Open the Jira response work item → the panel lists affected pages,
  per-owner Jira tasks, earlier decisions, and the **Temporary Changes &
  Reversal Checklist** where workarounds can be logged and checked off.
- Open an affected Confluence page → the byline shows a shortage notice
  linking straight to the Jira response.
- Ask the **Shortfall** agent in Rovo Chat: *"What does the cefazolin
  shortage affect and what did we do last time?"* — every fact is linked.
  The agent has 8 Rovo actions (6 read actions + 2 confirmation-gated write
  actions) and a `rovo:skill` playbook.
- In Rovo Studio, the `Shortfall` `rovo:mcp` server exposes all 6 read
  actions as tools for custom agents, and `mcp/SKILL.md` provides a
  standalone skill definition for external MCP clients.
- Mark a shortage resolved (or wait for FDA to) → reversal tasks open per
  tracked temporary change and the page notices clear.
- Leave a Teamwork Graph scope off → the dashboard runs in reduced mode and
  lists exactly what it cannot read.

## What it deliberately does not do

- Holds no patient data.
- Never recommends a substitute drug — only quotes alternatives your own
  pages already approve.
- Never merges presentations (NDCs); every strength/package stays separate.
- Shows the openFDA disclaimer wherever FDA data appears.
- Uses parameterized Forge SQL (`sql.prepare`) across all queries.
- Creates nothing automatically unless your admin enabled it (and agent
  writes always confirm first).

## Verified on the reference demo site

All of the following ran against live data on `one-atlas-ojjg.atlassian.net`
(2026-11-17), not fixtures:

- Sync queued as an async job fetched 1,580 FDA records
  (`meta.last_updated` 2026-11-13) and matched 305 presentations against a
  12-item formulary; re-running produced zero duplicates.
- The sample hospital loader created space `SHOSP` with six fictional
  protocol pages and a 12-item formulary via the normal Confluence v2 APIs.
- Impact mapping found 72 affected pages/work items via CQL.
- Response creation produced Jira work item `PROC-126`; the byline notice
  on "Rapid sequence intubation order set" links to it.

## Reduced mode

- Teamwork Graph calls run only in a real user context (Forge cannot
  impersonate for the graph API). Owner, team, and 2nd-hop linked-page
  enrichment therefore runs when a user clicks **Enrich owners** on the
  dashboard rather than in the scheduled job; missing graph scopes are
  listed under "Reduced mode" on the dashboard instead of failing.
- The openFDA disclaimer appears wherever FDA data is shown.
