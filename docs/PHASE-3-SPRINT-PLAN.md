# HIOC Revamp — Phase 3 Sprint & Epic Plan

**Companion to:** `docs/PHASE-3-SPEC.md`, `docs/PHASE-3-RICE.md`, `supabase/phase3-migration.sql` *(to be created by ticket FND3-M)*
**Version:** 0.2 (re-scoped after owner decisions D2–D8 — `PHASE-3-SPEC.md §8`)
**Date:** 2026-07-21
**Owner:** Product (Senior PM)
**Scope:** The Phase-3 "Dine-In & Counter Ops" release, committed scope from `PHASE-3-RICE.md §3`. Assumes Phase 1 + Phase 2 are live.

---

## 1. Planning assumptions

| Assumption | Value |
|---|---|
| Execution model | **AI-agent implementers** working ticket-by-ticket from this plan, with human (owner/PM) review per PR — see §5 playbook |
| Sprint length | 2 weeks · 1 pt ≈ 1 focused dev-day (unchanged scale, used for sequencing/WIP even with agent executors) |
| Target velocity | ~20–22 pts / sprint |
| Total Phase-3 size | **≈ 92 pts** (well under Phase 2's 157 — this phase reuses far more than it invents) |
| Duration | **4 sprints + a 1-week hardening tail ≈ 9 weeks**, milestone-gated (3A → 3B → 3C) |
| Branch | `phase-3-dinein-counter-ops` off `main` (same convention as `phase-2-value-retention`) |
| DoD | Per `docs/PHASE-3-SPEC.md §0`; per-ticket DoD in §5.3 below |

> **Blocking inputs:** effectively none. **I1** table inventory only seeds the migration (fallback: ship unseeded, owner adds tables via the FND3-1 CRUD); **I3** WhatsApp bill-template approval (drafted in spec RCT-1, submitted to Meta in Sprint 1) gates RCT-1 *sends*, not its code. The printer is locally connected via USB (D3), so KOT-1 needs no model-specific work. All product decisions were made 2026-07-21 — see the spec §8 decision log.

---

## 2. Epics

| Epic | Name | Pts | Maps to |
|---|---|--:|---|
| **F3** | Dine-in foundations (migration, tables, staff-create, corrections, permissions) | 25 | FND3-1…6 |
| **POS** | Staff POS surfaces | 19 | POS-1…4 |
| **KOT/RCT** | Kitchen tickets & bill delivery (print/WhatsApp/email) | 14 | KOT-1/2 · RCT-1/2 |
| **QR** | Table QR self-ordering | 7 | QR-1/2 |
| **OPS** | Ops, cash management & analytics | 13 | OPS-1/2 |
| **Q3Q** | Quality, security & release | 14 | tests, RLS, gates, UAT |
| | **Total** | **92** | |

*(Stretch — not in the 81: KDS/stations, split bills, per-item ticking — `PHASE-3-SPEC.md §10`.)*

---

## 3. Ticket backlog (by epic)

### Epic F3 — Foundations (25 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| FND3-M | `phase3-migration.sql` + `lib/types.ts` sync (tables, orders cols, voids, amendments, cash_days, role_permissions, RLS, views) | §7 | 3 | — (I1 seeds it; unseeded fallback OK) |
| FND3-1 | Tables registry + owner CRUD UI | FND3-1 | 3 | FND3-M |
| FND3-2 | Channel + `created_by` + table snapshot on orders (backfill incl.) | FND3-2 | 2 | FND3-M |
| FND3-3 | Staff order-creation mode in `POST /api/orders` | FND3-3 | 5 | FND3-2 |
| FND3-5 | State-machine dine-in rules + notification skips | FND3-5 | 3 | FND3-3 |
| FND3-6 | Owner-configurable permission matrix (`role_permissions` + grid UI + `hasPermission()`) | FND3-6 | 5 | P2 FND-5, owner team mgmt |
| FND3-4 | Corrections engine (voids, recompute, audit) | FND3-4 | 4 | FND3-3, FND3-6 |

*(FND3-M is the migration split out of FND3-1/2 so schema lands once, reviewed once — the Phase-2 pattern.)*

### Epic POS — Staff POS (19 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| POS-1 | Staff order-entry screen (flag `NEXT_PUBLIC_FLAG_STAFF_POS`) | POS-1 | 8 | FND3-3, FND3-1 |
| POS-2 | Collect payment & complete (at entry or later; + manager comp) | POS-2 | 3 | FND3-5 |
| POS-3 | Tables board (free/occupied, realtime) | POS-3 | 5 | POS-1, POS-2 |
| POS-4 | Void UI (reason + manager gate, struck-through lines) | POS-4 | 3 | FND3-4, POS-1 |

### Epic KOT/RCT — Kitchen tickets & bill delivery (14 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| KOT-2 | Receipt & token print (80 mm print-CSS) | KOT-2 | 3 | POS-2 |
| RCT-1 | Bill on WhatsApp at settle (`bill` event + template + resend) | RCT-1 | 3 | POS-2, **I3 (template approval — submit S1)** |
| KOT-1 | KOT per order + reprint (+ struck-through voids); local USB printer via system dialog (D3) | KOT-1 | 5 | POS-4 |
| RCT-2 | Bill by email (first email adapter per D9 + `customer_email` capture) | RCT-2 | 3 | RCT-1 |

### Epic QR — Table QR (7 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| QR-1 | `/t/<qr_token>` scan-to-order flow (flag `NEXT_PUBLIC_FLAG_TABLE_QR`, pay-first per D6) | QR-1 | 5 | FND3-1/2 |
| QR-2 | Printable QR cards in owner tables CRUD | QR-2 | 2 | QR-1 |

### Epic OPS — Ops, cash management & analytics (13 pts)
| Ticket | Title | Spec | Pts | Depends on |
|---|---|---|--:|---|
| OPS-1 | Channel/dine-in analytics on owner dashboard | OPS-1 | 5 | FND3-2 data live |
| OPS-2 | Cash day-open/close by denomination (`cash_days`, over/short, sign-off, export) | OPS-2 | 8 | POS-2, FND3-6 |

### Epic Q3Q — Quality, security & release (14 pts)
| Ticket | Title | Pts | Depends on |
|---|---|--:|---|
| Q3Q-1 | 3A test pack: staff-create path, state-machine entries/guards, settle concurrency | 5 | FND3-3/5, POS-2 |
| Q3Q-2 | 3B test pack: correction math (property-style: totals = Σ non-voided), version-guard races, void gating | 3 | FND3-4 |
| Q3Q-3 | RLS/security review (tables + `qr_token` exposure, staff-create authz), print smoke on device, UAT + launch checklist | 6 | all |

---

## 4. Sprint sequence & milestone gates

| Sprint | Theme | Tickets (pts) | Load |
|---|---|---|--:|
| **S1** | Foundations + entry begins | FND3-M (3) · FND3-1 (3) · FND3-2 (2) · FND3-3 (5) · FND3-5 (3) · POS-1 start (5 of 8) | 21 |
| **S2** | **Milestone 3A ships** | POS-1 finish (3) · POS-2 (3) · POS-3 (5) · KOT-2 (3) · RCT-1 (3) · Q3Q-1 (5) | 22 |
| **S3** | **Milestone 3B** — corrections, kitchen & permissions | FND3-6 (5) · FND3-4 (4) · POS-4 (3) · KOT-1 (5) · Q3Q-2 (3) | 20 |
| **S4** | **Milestone 3C** — cash, QR & email | OPS-2 (8) · QR-1 (5) · QR-2 (2) · RCT-2 (3) | 18 |
| **S5** | Hardening tail (1 week) | OPS-1 (5) · Q3Q-3 (6) | 11 |

**Gate 3A (end S2):** one full real service day on staff POS — every walk-in/dine-in order entered and settled in-system; zero pricing discrepancies vs manual check; a settled bill received on a test WhatsApp (or confirmed dark-pending I3); queue/realtime unaffected for web orders. *Rollback = flag off; web channel untouched.*
**Gate 3B (end S3):** a full service day running on printed KOTs (the real USB printer); a void executed with manager gate + audit visible; the owner flips a permission and the gate changes behavior immediately.
**Gate 3C / launch (end S5):** the drawer ties out by denomination **three consecutive days**; RLS review signed; QR pilot on 2 tables before all-table rollout; analytics tie out against a hand-counted day.

---

## 5. Agent execution playbook

*This section exists because tickets will be implemented by AI agents. Each ticket = one branch/PR, picked only when its §3 dependencies are merged. An agent takes exactly one ticket, follows this contract, and stops at the ticket boundary — no opportunistic scope.*

### 5.1 Read before writing any code (every ticket)
1. `docs/PHASE-3-SPEC.md` — your ticket's section **is the requirement**; its Given/When/Then is your test list.
2. `lib/types.ts` — the schema mirror; it must stay in exact sync with migrations (header comment explains).
3. `lib/orders/stateMachine.ts` — all lifecycle rules are table-driven here; never bypass it.
4. `app/api/orders/route.ts` + `lib/api/orders.ts` — the create/quote/pricing stack you must reuse, not fork.
5. `lib/api/auth.ts` — `getStaffUser()` / `getManagerUser()` / `getOwnerUser()` gates; pick the narrowest.
6. `supabase/phase2-migration.sql` — the migration idiom to imitate (sections, comments, RLS blocks).
7. The nearest existing analog of your surface (e.g. building POS-3? read `app/staff/page.tsx` + `lib/realtime/hooks.ts` first).

### 5.2 Guardrails (violations = rejected PR)
- **Money:** integer ₹ everywhere; **prices, discounts, and totals computed server-side only** — clients render, never calculate. Amendment recompute lives in one server module.
- **Snapshots:** never mutate or delete historical rows — items are *voided*, labels are *snapshotted*, prices copy at write time.
- **Concurrency:** every order write goes through the `version` optimistic guard; on conflict, re-fetch and re-present — never force.
- **State machine:** new transitions/guards go in the transition table in `lib/orders/stateMachine.ts`, nowhere else; both API and UI consume it.
- **Authz:** server routes enforce roles via `lib/api/auth.ts` + RLS; UI hiding is not authorization. Phase-3 sensitive actions go through the FND3-6 `hasPermission()` helper (never a hard-coded role check); unknown keys fail closed to manager. `qr_token` never reaches an unauthenticated client payload.
- **Flags:** new surfaces mount behind their `lib/flags.ts` flag (default ON, env-off), matching the existing `boolEnv` pattern.
- **Time/phone:** store UTC, display IST; phones E.164 via `lib/phone.ts`.
- **Sync:** any migration change lands in the same PR as its `lib/types.ts` mirror.
- **Tests:** vitest in `tests/`, mirroring existing test style; state-machine and money-math changes are untestable-by-hand — they ship with tests or not at all.

### 5.3 Per-ticket definition of done
- [ ] Every Given/When/Then in the ticket's spec section demonstrably satisfied (map them in the PR description).
- [ ] `npm test` and `npm run build` green; new logic covered per §5.2.
- [ ] No regression to the web ordering channel (`channel = customer_web` path untouched or covered by tests).
- [ ] Edge cases listed in the spec section handled or explicitly deferred **in writing** in the PR.
- [ ] Flag-gated if user-facing; migration idempotent if schema-touching.

### 5.4 Primary touchpoints per ticket *(orientation, not a fence — verify against the code)*
| Ticket | Touches |
|---|---|
| FND3-M | `supabase/phase3-migration.sql` (new) · `lib/types.ts` |
| FND3-1 | `app/api/tables/` (new) · `app/owner/tables/` (new page) · owner nav in `app/owner/layout.tsx` |
| FND3-2 | `app/api/orders/route.ts` · `lib/api/orders.ts` · `lib/types.ts` (Order) |
| FND3-3 | `app/api/orders/route.ts` · `lib/api/auth.ts` (reuse) · `lib/orders/stateMachine.ts` (entry) |
| FND3-5 | `lib/orders/stateMachine.ts` · `lib/notifications/engine.ts` + `templates.ts` |
| FND3-4 | `app/api/orders/[id]/amend/` (new) · new `lib/orders/amend.ts` · `lib/promotions/validate.ts` (recompute hook) |
| FND3-6 | new `lib/permissions.ts` (`hasPermission()`) · `role_permissions` table · `app/owner/staff/page.tsx` (grid UI) |
| POS-1 | `app/staff/orders/new/` (new) · reuse `lib/cart/` pieces where sane · `app/api/orders/quote` (reuse) |
| POS-2 | `app/api/orders/[id]/payment/route.ts` (extend) · staff order detail |
| POS-3 | `app/staff/tables/` (new) · `lib/realtime/hooks.ts` |
| POS-4 | staff order detail · void flow (reuses the refund manager-gate pattern) |
| KOT-1/2 | `app/staff/print/` (new print-CSS routes) · `components/staff/` |
| RCT-1 | `lib/types.ts` (`NotificationEvent` + `'bill'`) · `lib/notifications/templates.ts` + `engine.ts` · settle hook in POS-2 route |
| RCT-2 | `lib/notifications/adapters.ts` (first email adapter, D9 provider + env keys) · POS-1 email field · `orders.customer_email` |
| QR-1 | `app/t/[token]/` (new) · `lib/cart/CartContext.tsx` (dine-in context) · checkout page |
| QR-2 | `app/owner/tables/` (extend) |
| OPS-1 | `lib/analytics/queries.ts` · `app/owner/page.tsx` · migration views |
| OPS-2 | `app/staff/cash/` day-open/close views (denomination grid) · `app/api/cash-days/` routes · `cash_days` table |

---

## 6. Risks & mitigations

| Risk | Hit | Mitigation |
|---|---|---|
| Service model shifts later (rounds wanted after all) | 3B rework | `order_amendments.kind` is an open enum — rounds attach without schema break; POS-1 picker is reusable as an amendment mode |
| Correction math drifts from checkout math | Money bugs | One shared server recompute module + Q3Q-2 property tests (totals ≡ Σ non-voided) |
| Print dialog too slow for service (printer exists, D3) | KOT-1 UX | print-CSS pilot first; direct ESC/POS integration is a pre-scoped fast-follow ticket |
| Meta rejects/slow-walks the bill template | RCT-1 sends delayed | Copy submitted in S1 (I3); code ships dark; printed bill is never gated on it |
| Staff-create path weakens checkout authz | Security | FND3-3 reuses, never bypasses, guards; Q3Q-3 review is a launch gate |
| Owner mis-configures permissions and loosens money controls | Fraud surface | Shipped defaults are safe (D4); owner-only editing, every flip audited, unknown keys fail closed to manager |
| Two entry channels fight over one table | Data mess | v1 rule is explicit: multiple open orders per table are fine (counter model), QR orders stay separate orders — merging is out of scope |
| Agent scope-creep across tickets | Review chaos | §5 contract: one ticket, one PR, stop at the boundary |
