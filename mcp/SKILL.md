---
name: shortfall-drug-shortage-mcp
description: Portable MCP skill for connecting third-party AI assistants (Rovo Studio, Claude Desktop, Cursor, or custom MCP clients) to Shortfall's read-only drug shortage server for hospital pharmacy and clinical informatics workflows.
allowed-tools: get-active-shortages get-shortage-impact get-past-responses get-response-status draft-clinician-message get-reversal-checklist
---

# Shortfall MCP Skill

Shortfall exposes a read-only Atlassian Rovo MCP server (`shortfall-mcp`)
that gives external AI assistants live, source-linked access to a hospital's
FDA drug shortage posture, Confluence/Jira impact maps (including 2nd-hop
Teamwork Graph protocol links), historical shortage decisions, and temporary
change reversal checklists.

All six MCP tools are strictly **read-only**. State-changing operations
(creating Jira tasks, logging temporary changes, or modifying formulary
settings) remain inside Jira, Confluence, or confirmation-gated Rovo agent
actions.

## Available Read Tools

1. **`get-active-shortages`**
   - **Inputs**: `ingredient` (string, optional)
   - **Returns**: Active FDA `Current` shortages matching this site's
     formulary, one distinct row per FDA presentation / package NDC, with
     per-NDC `source` URLs, `reducedMode` warnings, and the canonical openFDA
     disclaimer.
   - **When to use**: Start every shortage check here to get exact
     `shortageId` values and separate presentations.

2. **`get-shortage-impact`**
   - **Inputs**: `shortageId` (string, required)
   - **Returns**: Affected Confluence pages and open Jira work items, each
     with `kind`, `ref`, `title`, `url`, `owner`, `team`, `spaceKey`,
     `foundVia`, and `hop` (`1` = direct mention, `2` = 2nd-hop linked
     protocol discovered via Teamwork Graph), plus `reducedMode`.
   - **When to use**: Determine blast radius and identify protocol owners and
     owning teams.

3. **`get-past-responses`**
   - **Inputs**: `ingredient` (string, required)
   - **Returns**: Earlier Jira responses for the same ingredient, including
     `jiraWorkItem`, `url`, `state`, `openedAt`, `resolvedAt`, and
     `decisionSummary`.
   - **When to use**: Reuse the hospital's own prior P&T / pharmacy decisions
     instead of starting from scratch.

4. **`get-response-status`**
   - **Inputs**: `shortageId` (string, required)
   - **Returns**: Current Jira response work item, `state`,
     `decisionSummary`, and its list of `temporaryChanges` with reversal work
     item links.
   - **When to use**: Track execution progress on an active shortage response.

5. **`draft-clinician-message`**
   - **Inputs**: `shortageId` (string, required)
   - **Returns**: Structured fact bundle combining FDA presentation facts,
     FDA `source` URL, the full impact map, past responses, and the openFDA
     disclaimer.
   - **When to use**: Ground a draft conservation plan or clinician bulletin
     exclusively in verified site and FDA data. A human must review and
     approve before anything is distributed.

6. **`get-reversal-checklist`**
   - **Inputs**: `state` (string, optional: `open` | `reversal_open` |
     `reversed` | `all`; defaults to `open`)
   - **Returns**: Temporary changes across responses with `changeId`, `drug`,
     `shortageId`, `fdaStatus`, `description`, `changeState`,
     `responseWorkItem`, `reversalWorkItem`, and `reversalDue` (`true` when
     FDA status is `Resolved` while the temporary change is still `open`).
   - **When to use**: Audit active temporary restrictions and identify every
     change that must be rolled back after FDA marks supply resolved.

## Hospital Safety Rules (Mandatory)

1. **No patient data (PHI).** Never ask for, repeat, store, or transmit
   patient-identifiable information. If a user supplies patient details,
   decline to use them and continue with medication/protocol facts only.
2. **No clinical advice or substitute recommendations.** Never choose, rank,
   or recommend an alternative drug. If asked what to use instead, cite only
   alternatives already documented in the site's own Confluence pages or past
   responses, with direct links. If none exist, state that plainly.
3. **Exact canonical openFDA disclaimer.** Whenever FDA drug shortage data
   is shown or summarized, include this disclaimer verbatim:
   > Do not rely on openFDA to make decisions regarding medical care. While
   > we make every effort to ensure that data is accurate, you should assume
   > all results are unvalidated. We may limit or otherwise restrict your
   > access to the API in line with our Terms of Service.
4. **Never merge presentations (NDCs).** Different strengths, dosage forms,
   and package sizes of the same ingredient must remain distinct rows. You
   may group by ingredient for readability, but preserve every individual NDC
   and its FDA status.
5. **Cite every fact.** Link every claim to its FDA source URL, Confluence
   page URL, or Jira work item key. Separate direct mentions (`hop = 1`)
   from 2nd-hop Teamwork Graph linked protocols (`hop = 2`).
6. **Surface reduced mode honestly.** If any tool returns a non-empty
   `reducedMode` list (for example missing `read:graph:*` scopes), state
   explicitly what owner, team, or 2nd-hop link data could not be read
   rather than guessing.
7. **Respect the read-only boundary.** Do not claim to have created Jira
   tasks or logged changes through MCP. Direct the user to the Shortfall
   dashboard, Jira response panel, or Rovo agent for confirmed writes.

## Sample Workflows

### 1. Morning Shortage Triage
1. Call `get-active-shortages` with no filter.
2. Group results by ingredient while listing each NDC presentation
   separately with its FDA source link and update date.
3. For each active presentation, call `get-response-status` to flag any
   shortage that does not yet have an open Jira response.
4. Call `get-reversal-checklist` (`state: "open"`) to surface any resolved
   shortages with `reversalDue: true`.

### 2. Blast-Radius & Precedent Briefing
1. Call `get-active-shortages` with `ingredient: "<drug>"`.
2. Call `get-shortage-impact` for each matching `shortageId`, separating
   direct mentions (`hop = 1`) from 2nd-hop Teamwork Graph linked pages
   (`hop = 2`) and listing owners, teams, and spaces.
3. Call `get-past-responses` for the ingredient and highlight prior
   `decisionSummary` entries with Jira links.

### 3. Clinician Bulletin Draft (Human-Approved)
1. Call `draft-clinician-message` for the target `shortageId`.
2. Draft a concise clinician notice covering: affected presentation(s) and
   NDC(s), FDA status/date/source link, documented site protocols (quoted
   with links, never inventing substitutes), impacted owners/contacts, and
   the verbatim openFDA disclaimer.
3. Present the draft explicitly for pharmacist / clinical informatics sign-off.

### 4. Post-Resolution Reversal Audit
1. Call `get-reversal-checklist` with `state: "all"` (or `state: "open"`).
2. Lead with every item where `reversalDue` is `true`, listing `changeId`,
   `drug`, `description`, `responseWorkItem`, and `reversalWorkItem`.
3. Recommend opening or completing reversal tasks inside the Shortfall
   dashboard or Jira response panel.
