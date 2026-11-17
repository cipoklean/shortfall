---
name: drug-shortage-response
description: Playbook for responding to an FDA drug shortage on this site - assess the impact, conserve supply, restrict use, communicate to clinicians, review, and reverse temporary changes when supply returns.
allowed-tools: get-active-shortages get-shortage-impact get-past-responses get-response-status draft-clinician-message create-response-task
---

# Drug shortage response playbook

Use this playbook when a person asks about an active drug shortage, asks what
a shortage affects, or asks for help running the response. Work the phases in
order; a person approves every draft and every write.

## Phase 1 — Assess

Call `get-active-shortages` to confirm the shortage is current and to get the
exact FDA presentations involved. Each presentation (strength, form, package
size) is a separate row — never collapse them into one.

Call `get-shortage-impact` for the matched shortage. Report:

- every Confluence page that names the drug, with its owner and team
- every open Jira work item that names the drug
- how each item was found (search, formulary NDC, link)

Call `get-past-responses` for the same ingredient. If there is an earlier
response, summarise what was decided and link the Jira work item — this site
reuses its own past decisions rather than starting over.

## Phase 2 — Conserve

Using `draft-clinician-message`, gather the structured facts: FDA status per
presentation, availability, related information, the impact map, and past
decisions. Draft conservation measures only from what the site's own pages
already document — for example documented therapeutic interchange policies
or approved alternatives quoted with their page link. Never invent or rank
substitutes. If nothing is documented, say so and list the pages a reviewer
should check.

## Phase 3 — Restrict

Where the site's protocols define restriction criteria, quote them with
links. If restriction decisions exist on past responses for this drug,
present them as the starting point.

## Phase 4 — Communicate

Draft the clinician message from the same structured facts. The message must
state: the drug and presentations affected, the FDA status and date, what the
site is doing, where the protocols live (links), and who to contact. Include
the openFDA disclaimer verbatim:

"Do not rely on openFDA to make decisions regarding medical care. Always
speak to your health provider about the risks and benefits of FDA-regulated
products. We may limit or otherwise restrict your access to the API in line
with our Terms of Service."

Read the draft back to the person and wait for approval before anything is
sent or saved.

## Phase 5 — Review

With `get-response-status`, check the response work item: per-owner tasks,
their assignees and due dates, and what is still open. Offer to create
missing owner tasks with `create-response-task` — always restate the task
summary and assignee and wait for a clear yes first.

## Phase 6 — Reverse

When the FDA marks the shortage resolved, every temporary change needs an
explicit reversal task. Use `get-response-status` to list temporary changes
and confirm each has a reversal task. Present a checklist: change, page or
work item, owner, reversal task, state. Page notices clear when the reversal
completes.

## Guardrails

- No patient data, ever. If it appears, decline to use it and continue.
- No clinical advice: never choose or rank substitutes; quote only what the
  site's pages already approve, with links.
- Every fact links to its source: FDA record, Confluence page or Jira item.
- If tools report missing scopes or reduced mode, name what is unreadable.
