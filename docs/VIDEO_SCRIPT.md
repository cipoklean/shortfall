# Video script — Shortfall demo (under 5 minutes)

Real FDA data on the demo site. No third-party logos, no copyrighted music
(record screen + voiceover only, or royalty-free bed at low volume).

## 0:00–0:30 — The problem

*Screen: the FDA drug shortage list / Shortfall landing page.*

"Every week, US hospitals lose dozens of staff hours to drug shortages —
not making clinical decisions, but hunting down which protocols name the
drug, who owns them, and what was decided last time. Shortfall does that
hunt inside Jira and Confluence."

## 0:30–1:10 — Watch and match

*Screen: Shortfall dashboard, Sync now.*

"Shortfall syncs the FDA shortage list daily and matches it to the site's
own drug list — by package NDC first, then RxNorm ingredient and dosage
form. Every presentation stays a separate row."

*Show the matched list, open one shortage.* "Each row links straight back
to its FDA record."

## 1:10–2:00 — Impact map & 2nd-hop blast radius

*Screen: click a shortage row to open the Shortage Detail Drawer, then click Enrich owners.*

"Here's what it touches: the Confluence protocols and open Jira work that
name the drug, each with an owner and team resolved through the Teamwork
Graph — plus a 2nd-hop blast radius showing downstream protocols linked to
those affected pages, and earlier responses to the same drug so the site
reuses its own decisions."

## 2:00–2:40 — Respond and mark

*Screen: Jira response work item (per-owner tasks + Temporary Changes checklist), then an affected Confluence page byline.*

"One work item per shortage, a task per owner, and a temporary-change
checklist to log every workaround. Affected Confluence pages carry a byline
notice linking straight back to the response."

## 2:40–3:30 — The agent drafts

*Screen: Rovo Chat with the Shortfall agent.*

"Ask the agent what the shortage affects and what was done last time. It
answers with linked sources — and drafts the conservation plan only from
the site's own documented decisions. It never recommends a substitute drug,
and a person approves before anything is written."

## 3:30–4:10 — Reverse temporary changes

*Screen: resolved shortage → Temporary Changes & Reversal Checklist + opened reversal tasks.*

"When the FDA marks the shortage resolved, Shortfall turns every logged
temporary change into a tracked reversal task on the checklist — so
workarounds don't become permanent — and clears the Confluence page
notices."

## 4:10–4:40 — Guardrails and close

*Screen: 'What it will not do' section.*

"No patient data. No clinical advice. Every fact sourced. Nothing leaves
the site except calls to two public drug-data APIs."
