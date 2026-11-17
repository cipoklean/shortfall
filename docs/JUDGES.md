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

1. In Jira, open **Apps → Shortfall**.
2. **Clinical spaces**: pick the Confluence spaces holding protocols/order
   sets. Only these count toward the impact map.
3. **Drug list**: paste or upload a CSV, or press **Load sample hospital**
   (creates a fictional Confluence space, drug list and Jira project using
   the normal product APIs — no patient data anywhere).
4. **Response mode**: automatic or manual work-item creation, and the Jira
   project for responses.
5. **Run first sync**. The dashboard shows matched shortages, the impact
   map, owners, and the last sync result.

## What to try

- Open a matched shortage → the Jira work item lists affected pages, owners,
  and what was decided in earlier responses.
- Open an affected Confluence page → the byline shows a shortage notice
  linking to the response.
- Ask the **Shortfall** agent in Rovo Chat: *"What does the cefazolin
  shortage affect and what did we do last time?"* — every fact is linked.
- In Rovo Studio, the `Shortfall` MCP tools (`get-active-shortages`,
  `get-shortage-impact`, `get-past-responses`, `get-response-status`,
  `draft-clinician-message`) can be attached to a custom agent.
- Mark a shortage resolved (or wait for FDA to) → reversal tasks open per
  temporary change and the page notices clear.
- Leave a Teamwork Graph scope off → the dashboard runs in reduced mode and
  lists exactly what it cannot read.

## What it deliberately does not do

- Holds no patient data.
- Never recommends a substitute drug — only quotes alternatives your own
  pages already approve.
- Shows the openFDA disclaimer wherever FDA data appears.
- Creates nothing automatically unless your admin enabled it.

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
  impersonate for the graph API). Owner/team enrichment therefore runs when
  a user clicks **Enrich owners** on the dashboard rather than in the
  scheduled job; missing graph scopes are listed under "Reduced mode" on
  the dashboard instead of failing.
- The openFDA disclaimer appears wherever FDA data is shown.
