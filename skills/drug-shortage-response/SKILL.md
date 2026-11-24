---
name: drug-shortage-response
description: Playbook for responding to an FDA drug shortage on this site - assess the impact, conserve supply, restrict use, communicate to clinicians, review, and reverse temporary changes when supply returns.
allowed-tools: get-active-shortages get-shortage-impact get-past-responses get-response-status draft-clinician-message create-response-task get-reversal-checklist log-temporary-change
---

# Drug shortage response playbook

Use this playbook when a person asks about an active drug shortage, asks what
a shortage affects, asks which temporary changes need reversing, or asks for
help running the response. Work the phases in order; a person approves every
draft and every write.

## Phase 1 — Assess

Call `get-active-shortages` to confirm the shortage is current and to get the
exact FDA presentations involved. Each presentation (strength, form, package
size, NDC) is a separate row — never collapse them into one.

Call `get-shortage-impact` for the matched shortage. Report:

- direct Confluence pages (`hop = 1`) that name the drug, with space, owner,
  and team
- 2nd-hop linked Confluence protocols (`hop = 2`, `foundVia: teamwork-graph-link`)
  discovered via Teamwork Graph from those pages, labeled clearly as linked
  dependencies
- open Jira work items that name the drug
- how each item was found (Confluence search, Jira search, Teamwork Graph link)

Call `get-past-responses` for the same ingredient. If there is an earlier
response, summarise what was decided (citing `decisionSummary`) and link the
Jira work item — this site reuses its own past decisions rather than starting
over.

## Phase 2 — Conserve

Using `draft-clinician-message`, gather the structured facts: FDA status per
presentation, source URL, availability, related information, the impact map
(both direct and 2nd-hop linked protocols), and past decisions. Draft
conservation measures only from what the site's own pages already document —
for example documented therapeutic interchange policies or approved
alternatives quoted with their page link. Never invent or rank substitutes.
If nothing is documented, say so and list the pages a reviewer should check.

## Phase 3 — Restrict

Where the site's protocols define restriction criteria, quote them with
links. If restriction decisions exist on past responses for this drug,
present them as the starting point.

When the team puts a temporary restriction, protocol edit, or order-set
change in place, offer to record it with `log-temporary-change` so it is
tracked for reversal once supply returns. Always restate the shortage ID,
change description, and optional impact item ID, and wait for a clear yes
before calling `log-temporary-change`.

## Phase 4 — Communicate

Draft the clinician message from the same structured facts. The message must
state: the drug and presentations affected (distinct NDCs), the FDA status,
date, and source URL, what the site is doing, where the protocols live
(links), and who to contact. Include the openFDA disclaimer verbatim:

"Do not rely on openFDA to make decisions regarding medical care. While we
make every effort to ensure that data is accurate, you should assume all
results are unvalidated. We may limit or otherwise restrict your access to
the API in line with our Terms of Service."

Read the draft back to the person and wait for approval before anything is
sent or saved.

## Phase 5 — Review

With `get-response-status`, check the response work item: state, recorded
decision summary, temporary changes, and reversal status. Offer to create
missing owner tasks with `create-response-task` — always restate the shortage
ID, task summary, and assignee, and wait for a clear yes first.

## Phase 6 — Reverse

When the FDA marks a shortage resolved — or whenever a person asks which
temporary changes still need reversing — call `get-reversal-checklist`
(defaulting to `state: "open"`, or `state: "all"` for a full audit). Highlight
every item flagged `reversalDue: true` (FDA status is Resolved while the
temporary change is still open). Present a clear checklist: change ID, drug,
shortage ID, FDA status, change description, response work item, reversal
work item, and state. Page notices clear once the shortage resolves and
reversals complete.

## Guardrails

- No patient data, ever. If it appears, decline to use it and continue.
- No clinical advice: never choose or rank substitutes; quote only what the
  site's pages already approve, with links.
- Exact products stay separate: never merge distinct NDC presentations.
- Every fact links to its source: FDA record, Confluence page, or Jira item.
- Confirm every write (`create-response-task` and `log-temporary-change`)
  with a person before invoking it.
- If tools report missing scopes or reduced mode, name what is unreadable.
