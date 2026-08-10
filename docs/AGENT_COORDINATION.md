# HandyHub — Agent Coordination Protocol

**Owner:** Claude Code (lead architect / master coordinator)
**Partner:** Codex (implementation + verification)
**Status:** ACTIVE — read this before touching the repo.
**Last updated:** 2026-07-09

---

## 0. BLOCKING PRE-CONDITION — read first

> **Codex's worktree is on a stale base and MUST be rebased before any task begins.**

Observed state:

| | |
|---|---|
| Claude Code worktree | `HANDY-HUB-MVP-` @ `5a9032d` on `CUSTOMER-APP` (11 uncommitted files) |
| Codex worktree | `.worktrees/agents-error-checking-implementation` @ `77740a3` on `agents/error-checking-implementation` |
| Relationship | `77740a3` is an **ANCESTOR** of `5a9032d` — Codex is **~530 product files behind**, with **0 commits of its own** |

The Codex worktree **does not contain**: `functions/pricing.js`, `functions/accountLifecycle.js`,
`shared/js/domain/bookingStatusMeta.js`, `shared/js/domain/bookingRouter.js`.
It predates the **entire inspection-pricing system, the F1–F8 hardening pass, and every CX fix.**
It is currently dirty on `customer-app/tracking.html` — a file that is an **intentionally-removed
orphan** in the current lineage.

**Consequence:** every line Codex writes today is written against a codebase that no longer exists.
Merging it would resurrect deleted files and re-open closed defects.

**Required first action (Codex):**
1. Stash or discard the 5 dirty files in the worktree (`style.css`, `tracking.html`, 3 icons) — confirm with Claude Code first if any are wanted.
2. Rebase `agents/error-checking-implementation` onto `CUSTOMER-APP` (or re-cut the branch from it).
3. Verify: `functions/pricing.js` and `shared/js/domain/bookingRouter.js` exist, and `npm run lint` passes.
4. Report the new base SHA back before starting task work.

**No task in §8 may start until this is done and confirmed by Claude Code.**

---

## 1. Repository Assessment

**What this is.** A Ghanaian on-demand artisan marketplace. Three apps (`customer-app/`,
`artisan-app/`, `admin-dashboard/`) over a shared layer (`shared/`) and Firebase Cloud Functions
(`functions/`). Vanilla JS + ES modules, no build step for app code. Firestore (custom DB id
`ai-studio-…`), Cloud Functions region `europe-west1`, Paystack for payments (MTN/Telecel/AirtelTigo
Mobile Money), escrow with commission.

**Maturity: higher than it looks.** The financial core is genuinely production-grade and has been
verified, not assumed:
- Escrow holds are idempotent via an `_escrow_locks/{bookingId}` distributed mutex written **inside** `runTransaction`.
- The Paystack webhook verifies HMAC-SHA512 **and re-queries Paystack for the authoritative amount** rather than trusting the payload.
- Wallet credit is idempotent via `webhookLocks/{paystackRef}` inside the transaction → duplicate webhook delivery cannot double-credit.
- Withdrawals check `amount > available` inside a transaction; rollbacks use `FieldValue.increment`.
- Every money-moving booking transition now **claims its status change in a transaction before moving money** (`pricing.claimBookingTransition`).

**Recently closed (do not "re-fix"):** F1 callout-settlement bypass · F2 pay-callout dead-end ·
F3 status-vocabulary drift · F4 transactional hardening · F5 escrow-kind integrity · F6 lifecycle
sweeps · F7 notification field bug · F8 consolidation · CX-1 account-deletion money orphan ·
CX-2 ledger forgery · CX-5 timing-safe HMAC · CX-7 syntax gate.

**Known-open:** App Check *enforcement* toggle (Console, not code) · artisan app has **no** delete-account
path at all · pre-existing `check-filter-tabs` failures in `reviews.html` / `book-emergency` / `book-now` ·
runtime surfaces never tested (performance, a11y, multi-tab/offline).

**Standing hazard — audit noise.** Three external audits reported environment artifacts as CRITICAL.
All were false: "artisan Illegal return statement" (top-level `return` **is legal** in
`<script type="module">`; their harness parsed a module as a classic script), "broken dashboard
dependency" (all scripts exist; all 54 relative imports resolve — it is a **serve-root** artifact:
serve the **project root** on :8766 per `DEVELOPER.md`, *not* `customer-app/`), and "premature
payment-success" (already waits for the webhook). **Verify before fixing. Always.**

---

## 2. Agent Roles

### Claude Code owns (non-delegable)
System architecture · root-cause analysis · booking lifecycle & state machine · payment, escrow,
wallet & data-integrity decisions · Firebase architecture and authorization design (`firestore.rules`) ·
task decomposition, prioritization, dependency order · high-risk refactors · final code review ·
**final release-readiness decision**.

### Codex owns (delegated, scoped)
Focused implementation against a written spec · repo-wide searches (broken refs, dead routes,
duplicated logic, missing validation) · writing/updating unit, integration and E2E tests ·
reproducing bugs · verifying fixes · low-risk repetitive refactors · edge cases, error handling,
accessibility, regressions · concise technical reports with exact files/functions/evidence.

### Codex must NOT
- Rewrite architecture, or change **payment amounts, booking states, `firestore.rules`, escrow, or
  wallet logic** without explicit written approval from Claude Code.
- Touch a file outside the task's declared scope.
- Silently broaden scope.
- Mark work complete without evidence.
- Overwrite another agent's work.
- **Claim success because code compiles.** Compiling is not evidence.

---

## 3. Ownership Map (single-writer per subsystem)

High-risk subsystems have **exactly one active owner at a time**. Never both.

| Subsystem | Files | Owner | Codex access |
|---|---|---|---|
| **Firestore security rules** | `firestore.rules`, `firestore.indexes.json` | **Claude Code** | READ-ONLY. May *propose* a diff; may not apply. |
| **Payments / webhooks** | `functions/financial/**` | **Claude Code** | READ-ONLY. May write *tests* against it. |
| **Escrow & settlement** | `functions/financial/escrow.js`, `pricing.js` (`settleCallout`, `claimBookingTransition`) | **Claude Code** | READ-ONLY. |
| **Booking state machine** | `functions/pricing.js`, `quotes.js`, `bookings.js`, `dispatch.js` | **Claude Code** | READ-ONLY. |
| **Status vocabulary / routing** | `shared/js/domain/bookingStatusMeta.js`, `bookingRouter.js` | **Claude Code** | READ-ONLY (single source of truth — drift here breaks 6 surfaces). |
| **Account lifecycle / auth** | `functions/accountLifecycle.js`, `shared/js/backend/providers/firebase/firebaseAuthService.js`, `authGuard.js` | **Claude Code** | READ-ONLY. |
| Live tracking | `customer-app/live-tracking.html` | **Claude Code** (until CX work lands) | READ-ONLY for now. |
| **Tests** | `tests/**`, `scripts/check-*.cjs` | **Codex** | FULL WRITE. |
| Customer UI (non-booking) | `customer-app/**` except booking/tracking/settings-delete | **Codex** | WRITE, scoped per task. |
| Artisan UI | `artisan-app/**` | **Codex** | WRITE, scoped per task. |
| Admin UI | `admin-dashboard/**` | **Codex** | WRITE, scoped per task. |
| Shared CSS / components | `shared/css/**`, `shared/js/components/**` | **Codex** | WRITE, scoped per task. |
| Docs | `docs/**`, `README`, `DEVELOPER.md` | Either | Coordinate. |

**Rule:** if a task requires editing a Claude-Code-owned file, Codex **stops and reports**, returning a
proposed diff + rationale. It does not apply it.

---

## 4. Dependency Order (not severity order)

```
0. Rebase Codex worktree onto CUSTOMER-APP        ← BLOCKS EVERYTHING
1. Claude Code: commit + land the 11 dirty files  ← establishes a shared, stable base
2. Codex: test harness (unit + emulator + E2E)    ← everything after is verifiable
3. Codex: repo-wide inventory sweeps (read-only)  ← finds work; changes nothing
4. Claude Code: triage sweep output → specs       ← architecture decisions
5. Codex: implement scoped fixes from specs       ← parallel-safe, low-risk files only
6. Claude Code: review diffs, run tests, approve  ← gate
7. Claude Code: release-readiness decision
```

Steps 2 and 3 are the only ones Codex may run concurrently with each other.
Nothing else runs in parallel with a Claude-Code-owned subsystem edit.

---

## 5. Handoff Rules

**Claude Code → Codex.** Every delegated task is issued in this exact shape. No task without it:

```
TASK-ID:        CDX-nn
OBJECTIVE:      one sentence, outcome not activity
SCOPE:          exactly what is in bounds
FILES:          explicit allowlist — anything else is out of scope
CONSTRAINTS:    what must not change (esp. rules/financial/state)
ACCEPTANCE:     objectively checkable conditions
TESTS REQUIRED: the specific tests that must pass
RISKS:          known traps
OUTPUT FORMAT:  the report shape below
```

**Codex → Claude Code.** Every returned task uses this shape. A report missing evidence is rejected unread:

```
TASK-ID:        CDX-nn
INSPECTED:      what you actually read/ran
CHANGED:        what you changed and why
FILES CHANGED:  exact paths (must be ⊆ the FILES allowlist)
BUGS FOUND:     with file:line evidence
TESTS ADDED/RUN: names + commands
TEST RESULTS:   actual output, pass/fail counts — not a claim
REMAINING RISKS: what you are unsure about
NEEDS DECISION: anything touching architecture/rules/financial → STOP and ask
OUT-OF-SCOPE FOUND: report it, do not fix it
```

**Non-negotiables**
- Evidence > assertion. "Tests pass" without output = rejected.
- "It compiles" is **not** evidence of correctness.
- Found something outside scope? **Report it. Do not fix it.**
- Uncertain whether a change is architectural? **It is. Ask.**

---

## 6. Review Rules (Claude Code)

For every Codex return, I will:
1. Read the **actual diff** (`git diff`), not the summary.
2. Verify `FILES CHANGED ⊆ FILES` allowlist. Any extra file → automatic **REJECT**.
3. Check each acceptance criterion individually.
4. **Re-run the tests myself.** I do not accept reported results.
5. Run `npm run lint` (syntax gate + filters + tokens + status vocab).
6. For anything near money/rules/state: re-run the emulator regression suite.
7. Verdict: **APPROVE** / **REJECT** (with reason) / **RETURN FOR CORRECTION** (with a delta spec).

**Merge discipline:** Codex works on `agents/*` branches and opens a diff for review. Claude Code
merges. Codex never merges to `CUSTOMER-APP`/`main`.

---

## 7. Conflict Avoidance

- **One writer per subsystem** (§3). Enforced by the ownership map, not by convention.
- **Separate worktrees.** Codex stays in `.worktrees/agents-*`. No cross-worktree edits.
- **Rebase before every task.** Stale base = the failure mode we already hit (§0).
- **File allowlist per task.** Out-of-allowlist edits are rejected on sight.
- Claude Code declares "LOCKED: `<subsystem>`" while actively editing it; Codex does not touch it, even to test, until released.

---

## 8. First Five Tasks to Delegate (Codex)

> All are **read-only or test-only** by design. This is deliberate: Codex's base is stale and its
> output is unverified, so the first tasks build the verification substrate and produce evidence —
> without letting it write to any high-risk subsystem before it has earned trust on this codebase.

**CDX-00 — Rebase (blocking, §0).** Rebase onto `CUSTOMER-APP`; confirm `functions/pricing.js` +
`shared/js/domain/bookingRouter.js` exist; `npm run lint` green. Report new base SHA.
*Acceptance:* lint passes on the new base. *Files:* none (git only).

**CDX-01 — E2E test harness for the booking lifecycle (test-only, HIGH VALUE).**
Playwright, served from the **project root on :8766** (not `customer-app/` — see §1 hazard).
Cover: signup → login → dashboard → book-request → fee receipt → track. Assert **zero** page/console
errors. *Files:* `tests/**` only. *Constraints:* do not modify app code; if the flow is blocked,
report the blocker with evidence — do **not** "fix" it. *Acceptance:* a runnable suite + a pass/fail
report with real output.

**CDX-02 — Emulator regression suite, formalized (test-only).**
I have ad-hoc emulator tests proving F1/CX-2 (attacker-model REST against `firestore.rules`).
Turn them into a committed, runnable suite: inspection-cancel DENY, ledger-forgery DENY,
walletBalance-write DENY, cross-account DENY, legacy-cancel ALLOW, `awaiting→completed` ALLOW.
*Files:* `tests/**`. *Constraints:* **read-only on `firestore.rules`** — the suite tests the rules,
it never edits them. *Acceptance:* `npm run test:rules` runs green and fails loudly if a rule regresses.

**CDX-03 — Dead-route & broken-reference sweep (read-only, report only).**
Every `href`, `location.href`, `actionUrl`, and dynamic import across all three apps: does the target
exist? Known true positives to confirm and extend: notification `actionUrl`s, deleted `book-step*`
pages, `tracking.html` orphan. *Files:* none — **report only.** *Acceptance:* a table of
`source:line → target → exists?`. **Fix nothing.**

**CDX-04 — Accessibility + runtime audit of the customer app (read-only, report only).**
The one genuinely untested surface. Keyboard nav, focus order/trapping, contrast (esp. `--ui-faint`
on white), touch targets ≥44px, ARIA on the booking flow, reduced-motion. Playwright + axe.
*Files:* `tests/**` only. *Acceptance:* prioritized findings with selectors + screenshots. **Fix nothing.**

---

## 9. Tasks Claude Code Keeps

- Landing the 11 uncommitted files (account-deletion CF, ledger rule, syntax gate) — **in progress**.
- Any `firestore.rules` change, ever.
- Artisan-app account deletion (currently **absent**; must not be added without the same money/escrow guards as CX-1 — an unguarded copy would recreate the exact orphaned-funds bug).
- App Check enforcement rollout + verifying nothing breaks under it.
- Emergency-track product decision (still deadlocks at `accepted`; fold into inspection track or exempt — this is architecture + product, not implementation).
- Triage of every Codex sweep → converting findings into specs.
- Final review and the release call.

---

## 10. Risks of This Collaboration Model

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Codex builds on a stale base** | **Already happened** | §0 blocking rebase; re-verify base SHA before every task |
| Codex "fixes" an environment artifact and breaks working code | High (3 audits did exactly this) | Read-only sweeps first; report-don't-fix; §1 hazard list |
| Two agents edit a high-risk subsystem concurrently | Medium | Single-writer ownership map (§3) + explicit LOCKED declarations |
| Codex broadens scope silently | Medium | File allowlist per task; out-of-allowlist edit = auto-reject |
| "It compiles" accepted as done | Medium | Evidence-only reports; I re-run every test myself |
| Status-vocabulary drift reintroduced | Medium | `bookingStatusMeta.js` is Claude-owned + `npm run lint:status` CI guard |
| Duplicate work (both fix the same thing) | Medium | This doc is the single source of task state; nothing starts without a TASK-ID |
| Coordination overhead exceeds the speedup | Real | Codex gets *breadth* (sweeps, tests, a11y) where parallelism genuinely pays; I keep the *depth* (money, state, rules) where it doesn't |

**Honest caveat.** Two agents on one repo is only a win if the split is along a real seam. The seam
here is: **I own everything that can lose money or corrupt state; Codex owns everything that can be
verified by a test.** If a task doesn't fall cleanly on one side, it's mine until I decompose it.
