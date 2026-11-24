# Shortfall — Devpost submission text (draft)

## Tagline

When the FDA puts a drug on shortage, Shortfall shows what it touches, who
owns it, and what you did last time — then runs the response in Jira and
Confluence.

## The problem

US hospitals spent 20.2 million staff hours and $894 million in labor
managing drug shortages in a year (Vizient 2024). Large hospitals spend up
to 66 staff hours a week on it (ASHP 2024). The work is not the clinical
decision — it's the scavenger hunt: which protocols and order sets name the
drug, who owns each one, what was decided last time, and remembering to undo
the temporary changes when supply returns.

## What Shortfall does

- **Watch**: syncs the FDA shortage list daily and matches it to the site's
  drug list via true 10→11-digit HIPAA NDC normalization first, then
  whole-word, combination-aware RxNorm ingredient + dosage form matching
  (never merging presentations).
- **Map impact**: finds the Confluence pages and open Jira work naming the
  drug, resolves owners, teams, and **2nd-hop blast radius** linked
  protocols via Teamwork Graph curated queries, and pulls earlier responses
  to the same drug.
- **Respond**: one Jira work item per shortage, per-owner Jira tasks, a
  Shortage Detail Drawer on the dashboard, a Jira issue panel with the FDA
  facts and impact map, and a Temporary Changes & Reversal Checklist.
- **Mark pages**: a notice on each affected page linking to the response.
- **Draft**: the Rovo agent drafts the conservation plan and clinician
  message from the site's own past decisions. A person approves before any
  write runs.
- **Reverse**: when FDA marks the shortage resolved, one reversal task opens
  per tracked temporary change and the page notices clear.

## How the Forge requirement is met

Built entirely on Forge (TypeScript, `nodejs24.x`): `jira:globalPage`
dashboard (with a Guided First-Run Setup Wizard, Shortage Detail Drawer,
and Atlassian Design Tokens for light/dark themes), `jira:issuePanel`
response view (including per-owner tasks and the Temporary Changes &
Reversal Checklist), `confluence:contentBylineItem` page notices,
`scheduledTrigger` + async `consumer` for the sync pipeline, parameterized
Forge SQL (`sql.prepare` with a versioned `migrationRunner` schema) and KVS
storage, and eight `action` modules. External fetch is declared for exactly
two public hosts: `api.fda.gov` and `rxnav.nlm.nih.gov`.

## Bonus prize justifications

- **Rovo agent**: `rovo:agent` with a rules-enforcing prompt, conversation
  starters, eight actions (six read actions + two confirmation-gated write
  actions), and a `rovo:skill` playbook (assess → conserve → restrict →
  communicate → review → reverse).
- **Atlassian MCP**: `rovo:mcp` exposes all six read actions as tools in
  Rovo Studio, paired with a standalone `mcp/SKILL.md` for external MCP
  clients.
- **Teamwork Graph**: `api.asUser().requestTeamworkGraph` runs curated
  queries (`confluencePageOwners`, `confluencePageCreator`,
  `confluencePageLinkedConfluencePages`, `atlassianTeamsBySpace`,
  `atlassianUserInTeams`) to resolve owners, teams, and 2nd-hop linked
  protocols — with explicit reduced-mode reporting when granular scopes
  aren't granted.

## Safety by design

No patient data anywhere. No substitute-drug recommendations — only
alternatives the site's own pages already approve, quoted with links. Every
fact links to its source and carries the openFDA disclaimer. All SQL uses
parameterized `sql.prepare` bindings. Writes need admin auto-create or
explicit person confirmation. Sample data is created through the same APIs
a customer uses.

## Links

- Demo video: `TODO`
- Repository: https://github.com/cipoklean/shortfall
- Installation link: `TODO`
