# Apex site execution log

The working record from executing `docs/superpowers/plans/2026-08-27-apex-site.md`.
Preserved because git history holds the commits but not the reasoning: the
pre-flight scan, every decision taken without asking, and what each costs if
it turns out wrong.

Ruling 11 is an open residual, not a closed decision.

---

# SDD ledger — plan: docs/superpowers/plans/2026-08-27-apex-site.md

Spec: docs/superpowers/specs/2026-08-27-apex-site-design.md (read, reachable)
Branch: feat/apex-site, off main at 357fadc. NOT implementing on main — main is what production deploys from and the user gave no consent to work there.

## Pre-flight conflict scan

### Cross-task: shared files and interfaces

| Tasks | Produces → Consumes | Finding |
|---|---|---|
| 1 → 2 | `/tebex` path; Task 2's apex note links `appealy.creeperdiamonds.xyz/tebex` | Clean. Task 1 creates the page before Task 2 links it. |
| 2 → 3 | `home/index.html` → nginx `root` and the Dockerfile `COPY` | Clean, and the ordering matters: Task 3's block would 404 without Task 2. |
| 2 → 4 | `home/` supersedes `landing/` | Clean. Task 4 deletes only after the replacement exists. |
| 1 → 4 | `build-site.sh` page count | Clean, checked: the script copies `site/*.html` and has never included `landing/`, so deleting it does not change the count. Both tasks expecting `pages 5` is correct. |
| 3 → 5 | nginx `server_name` → the domain mapping | Clean. Task 5 Step 5 verifies the apex serves `home/` and not `site/`, which is exactly the symptom of a `server_name` that failed to match. |

### Per-task self-consistency

| Task | Finding |
|---|---|
| 1 | Creates `tebex.html`, links it from four pages, verifies both with greps that would catch a miss. Consistent. |
| 2 | Ships a deliberate `AUTHOR:` placeholder, gated twice — Step 5 here and Task 5 Step 1 before the domain goes live. Consistent. |
| 3 | `grep -c "^server {"` → 2 matches the two column-0 `server {` lines the task produces. `default_server` → 1. Consistent. |
| 4 | Greps for references before deleting. Consistent. |
| 5 | Entirely manual runbook. See Ruling 2. |

### Rulings made before execution

Ruling 1: Task 3's Steps 6 and 7 — deploy and post-deploy verification — are NOT executed by a subagent. Deploying is an outward-facing production action, and the plan's own text says `--ref main` while this work is on a feature branch, so running it as written would deploy code that does not contain the change. Implementers do the code and commit; the deploy and its verification happen at finish, with the user, after a merge they approve. Cost if wrong: the nginx change sits unverified one step longer, which is the same position it is in now.

Ruling 2: Task 5 is not dispatched to a subagent at all. It creates a Cloud Run domain mapping, edits DNS in Cloudflare, and gates on a human confirming an About paragraph was written and a mailbox receives mail. None of that is a subagent's to do, and two of the steps are irreversible from a bot's perspective. It is handed to the user as a runbook at finish. Cost if wrong: nothing — the steps are documented either way and someone has to press the buttons.

Ruling 3: Executing Tasks 1-4 only. That is every code change in the plan; Task 5 and two steps of Task 3 are operational and surface to the user at finish. Cost if wrong: the plan reads as five tasks and four get subagent review, which the finish message must state plainly rather than implying all five were executed.

## Progress

Task 1: implemented DONE_WITH_CONCERNS (commits a275c6c + c859030, pages 4 -> 5). Two commits because its own self-review caught it restating the dedicated hosting price and removed it — the exact constraint the design rests on. Declared deviation: added a sixth "Source" section (AGPL-3.0 + GitHub) beyond the five the brief specified. Review dispatched (sonnet); named risk 2 asks whether the restate-vs-link failure happened anywhere it did NOT catch.
Task 1: review NEEDS FIXES, 3 Important. Verified independently before ruling.
Ruling 4: The "subscriptions" contradiction is MY error, not the implementer's. tebexService.ts:108,122 create Tebex packages with type: "subscription" and a one-year period; tebexWebhook.ts:133 handles recurring-payment.ended; site/pricing.html already states "Paid plans are created as annual subscriptions." The plans ARE subscriptions. My brief's "no subscriptions and no consumables" came from my own apex spec and is false against the code. The page's text STANDS; the spec and plan get corrected. The implementer's only fault was not flagging that it had contradicted a given fact. Cost if wrong: a Tebex compliance page describing the billing model the way the billing code implements it, which is the safe direction.
Ruling 5: Restore the og:/twitter: tags. The reviewer is right, and for a stronger reason than "the brief said exactly": this page's realistic distribution is someone PASTING the link — to a reviewer, in an email, in Discord. That is precisely when Open Graph tags matter. noindex stops search indexing and says nothing about link previews. Cost if wrong: seven meta tags on a page nobody shares.
Ruling 6: Delete the "Source" section. The lede already states AGPL-3.0, the header already links GitHub, and the footer already carries both "GitHub repository" and "AGPL-3.0 licence". A section whose entire content appears twice elsewhere on the same page is the second copy the page's own comment warns against. Implementer and reviewer both reached this; I agree. Cost if wrong: a reviewer needs one extra glance at the footer.
Ruling 7: Folding in one Minor that would normally stay out of the loop — the top-of-file comment claims the page "states none of them twice" while Refunds does restate the 14-day window. The file is being edited anyway, and this plan has repeatedly paid for comments that assert things the code does not do. Cost if wrong: negligible.
Task 1: complete (commits 357fadc..1f07951, 1 fix round, review clean)
Ruling 4 second half executed: corrected the false "no subscriptions" claim in BOTH the spec and the plan (commit e717ff1). Left the error visible in each rather than silently edited — the whole point of that page is not contradicting the billing code, and a spec that quietly rewrites its own mistakes teaches the next reader to trust it more than it deserves. Controller doc edit, not a code fix; noted here because the skill otherwise forbids controller fixes.
Task 2: implemented DONE_WITH_CONCERNS (commit ce758cd, 8567 bytes vs the original 8471 so nothing large was inlined; AUTHOR: marker at home/index.html:180). Declared deviation: dropped the old page note that appealy.creeperdiamonds.xyz is a temporary domain. Review dispatched (sonnet). Named risk 3 asks it to check every sentence describing the PERSON rather than the product — an invented-but-plausible biographical line is the failure that reads naturally and therefore survives review.
Task 2: review NEEDS FIXES, 1 Important. home/index.html:150 "Builds Discord tools. Appealy is the one currently running." asserts a plural body of work and implies other projects exist but are not running. Neither fact was given. Exactly the invented-biography failure risk 3 was written to catch, and it reads naturally enough to have shipped.
Risk 1 (dropped temporary-domain note) judged CORRECT as implemented: the brief enumerated what should survive the restructure and named the Tebex note explicitly while saying nothing about this one, and a personal site announcing that its single project's URL may move reads as hedging on a page meant to project stability. Operational detail survives in home/README.md. No fix.
Self-containment independently verified: 9 unique src/href values, one data: favicon byte-identical to landing's, seven absolute external URLs, one mailto. No root-relative path. AUTHOR: marker verbatim at :180, single hit — the later gate will fire.
Task 2: complete (commits e717ff1..9587b2f, 1 fix round, review clean)
Resolved the re-reviewer's unverifiable item myself: the meta description at :8 reads "an open-source Discord bot for applications, ban appeals and tickets" while the tagline at :150 reads "a Discord bot for applications and ban appeals". Not a defect — a visible tagline being tighter than a meta description is normal, and it is a subset of given facts rather than a new claim. Gates re-verified: 1 AUTHOR marker, 0 root-relative paths.
Task 3: implemented DONE_WITH_CONCERNS (commit d64b9d8, no deploy attempted as instructed). Two declared items, both real.
Ruling 8: My brief's add_header snippet described a security-header set as "the same policy as the main block". The main block has none — I independently confirmed zero occurrences of X-Content-Type-Options, X-Frame-Options or Referrer-Policy anywhere in web/nginx.conf. Third plan defect this session, after the subscriptions claim and the --ref main deploy step. The implementer matched reality over my snippet, which was correct: adding headers to the apex alone would be inconsistent, and adding them to both is a separate change with its own review. Cost if wrong: the apex ships with the same header posture as the site next to it, which is the stated requirement.
Observation for the final review (NOT a Task 3 finding): the Appealy marketing site carries no security headers at all. Low risk for static pages, but worth a deliberate decision rather than an accident.
Minor plan defect noted: the plan's verification says `grep -c "default_server"` expect 1, but the implementer's own explanatory comment contains the string, so the count is 2. The check should read the directive, not count the string. Told the reviewer to verify by reading rather than counting.
Task 3: complete (commits 9587b2f..d64b9d8, review clean, no fix round)
Reviewer verified default_server by READING, not counting: nginx.conf:51 is the only real directive and sits on the pre-existing block; the apex listen at :182 carries none. Braces 21/21, both blocks closed at :167 and :206 with nothing trailing, root at :184 matches Dockerfile COPY at :83 exactly, and all three proxy_pass directives (142/147/164) are inside the first block. Apex has no proxy_pass and no /api, /auth or /dashboard location.
Noted well: the apex correctly OMITS Cross-Origin-Opener-Policy, which is OAuth-popup-specific and scoped to /dashboard/, and the immutable-cache header, since there are no hashed assets under the apex. That is reasoning, not copying.
Task 3: minor (deferred): the apex Cache-Control comment is long relative to the two lines it justifies.
Task 3: minor (deferred, for the final review): the marketing site's own location / carries no X-Content-Type-Options, X-Frame-Options or Referrer-Policy. The apex does not regress against it, but that baseline is the weaker one.
Task 4: complete (commits d64b9d8..b5ef8e7, review clean, no fix round)
Reviewer upheld leaving the three home/ references: all past-tense provenance ("replaces", "was a signpost", "carried over from"), none inviting a dead-end lookup — a different class from the present-tense wrong pointers this session flagged elsewhere. It also grepped the bare word "landing" across the whole tree including Dockerfile, nginx.conf and terraform.yml, which the brief's --include flags would have missed, and confirmed no live doc or config references the deleted directory.
Task 4: minor (deferred): the report's summary arithmetic is wrong — it says 28 references / 25 documentation, its own itemised breakdown totals 33 documentation and 36 overall. No substantive conclusion changes; every reference was still reasoned about correctly. Cosmetic, but it would mislead an auditor who trusted the count without re-running the grep.

=== ALL 4 CODE TASKS COMPLETE. Task 5 (domain mapping) and Task 3's deploy steps remain, both for the user per Rulings 1 and 2. ===

=== FINAL WHOLE-BRANCH REVIEW (opus, 8 commits, three passes) ===
Verdict: READY TO MERGE WITH FIXES. No Critical. nginx verified safe by direct read: exactly one `listen ... default_server` directive at :51 on the pre-existing block, apex :182 carries none, braces 21/21, apex proxies nothing, root matches Dockerfile COPY exactly, and the only ${} token in the new block is ${PORT} so envsubst leaves $uri alone. Reviewer also established two things worth keeping: server_name creeperdiamonds.xyz does NOT match the appealy subdomain (exact match, no implicit wildcard), and mid-rollout is a non-event because Cloud Run swaps revisions atomically and both revisions answer every resolvable Host identically.
Four Important, all text: (1) home/README.md:33-39 documents an nginx block that is not the deployed one — claims www.creeperdiamonds.xyz in server_name and a SPA try_files fallback, both false, inherited verbatim from landing/README.md; (2) site/README.md still says "Four pages" and omits tebex.html; (3) PLAN DEFECT at plan:306 and :466 — grep -c "default_server" expect 1 is wrong, real count is 2, and :466 is in the checklist the USER runs next; (4) PLAN DEFECT — the domain-mapping doc step was bundled into Task 5, which nobody executes, so DOCKER.md has no durable record of apex routing.
Ruling 9: PARKED — home/README.md and site/README.md are both served publicly (COPY is wholesale, .dockerignore excludes no *.md), which contradicts build-site.sh's deliberate copy-by-extension "README is not something to publish". Pre-existing, affects site/ equally, and fixing it right means one decision covering both mechanisms. Its own change. Cost if wrong: two README files remain publicly readable, containing nothing sensitive.
Ruling 10: PARKED — the tagline at home/index.html:150 omits "tickets" where the meta description includes it. Already ruled acceptable earlier; the final reviewer agreed it is not a defect. Cost if wrong: one word.
Fix wave: 5 of 6 addressed and independently verified. home/README.md now points at web/Dockerfile:83 and web/nginx.conf:181 instead of pasting a second config copy, and states unambiguously that www.creeperdiamonds.xyz is NOT handled, names the default_server fallback, and says what adding it would require. site/README.md is five pages. Both plan greps fixed and the new pattern verified to match only line 51. DOCKER.md carries the mapping runbook with the DNS-only reason stated. No breakage; nginx.conf and Dockerfile untouched; the tebex.html change is comment-only.
Ruling 11: PARKED — site/tebex.html:18-19 still claims the 14-day refund window is "the one thing stated in prose rather than only linked". False: :83 (no consumables or loot boxes) and :106 (nothing sold, no analytics or telemetry) are both prose-only, and :83 is a claim no linked page makes at all. The "restates no figure" half was fixed; the enumeration half was not. THIRD time this comment has overclaimed and been corrected. Parked because the process permits no second fix wave and it is a Minor in a comment on a page that otherwise works — but it is the exact failure this session has punished repeatedly, and the remaining fix is deleting one sentence. Cost if wrong: a comment that a careful reader can falsify in ten seconds, on the page whose whole purpose is being accurate.
