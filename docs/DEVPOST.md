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
  drug list by NDC, then by RxNorm ingredient + dosage form.
- **Map impact**: finds the Confluence pages and open Jira work naming the
  drug, each item's owner and team via the Teamwork Graph, and earlier
  responses to the same drug.
- **Respond**: one Jira work item per shortage, a task per owner, a panel
  with the FDA facts and the impact map.
- **Mark pages**: a notice on each affected page linking to the response.
- **Draft**: the Rovo agent drafts the conservation plan and clinician
  message from the site's own past decisions. A person approves first.
- **Reverse**: when FDA marks the shortage resolved, one task per temporary
  change and the page notices clear.

## How the Forge requirement is met

Built entirely on Forge (TypeScript): `jira:globalPage` dashboard and
`jira:issuePanel` response view (Custom UI), `confluence:contentBylineItem`
page notices, `scheduledTrigger` + async `consumer` for the sync pipeline,
Forge SQL (versioned `migrationRunner` schema) and KVS storage, and six
`action` modules. External fetch is declared for exactly two public hosts:
`api.fda.gov` and `rxnav.nlm.nih.gov`.

## Bonus prize justifications

- **Rovo agent**: `rovo:agent` with a rules-enforcing prompt, conversation
  starters, six actions and a `rovo:skill` playbook (assess → conserve →
  restrict → communicate → review → reverse).
- **Atlassian MCP**: `rovo:mcp` exposes the five read actions as tools in
  Rovo Studio.
- **Teamwork Graph**: `api.asUser().requestTeamworkGraph` resolves owners
  and teams for affected content, with reduced-mode reporting when granular
  scopes aren't granted.

## Safety by design

No patient data anywhere. No substitute-drug recommendations — only
alternatives the site's own pages already approve, quoted with links. Every
fact links to its source and carries the openFDA disclaimer. Writes need
consent. Sample data is created through the same APIs a customer uses.

## Links

- Demo video: `TODO`
- Repository: `TODO`
- Installation link: `TODO`
