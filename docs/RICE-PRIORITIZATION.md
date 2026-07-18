# HIOC Revamp — RICE Prioritization Sheet

**Companion to:** `docs/REVAMP-REQUIREMENTS.md`
**Version:** 0.1 (Draft for prioritization workshop)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Purpose:** Score every candidate requirement so the backlog is ranked by value-per-effort, and **lock a Phase-1 scope** the team can commit to.

---

## 1. Method

**RICE score = (Reach × Impact × Confidence) ÷ Effort.** Higher = better value for the effort.

Because HIOC is a **single high-volume cafe** (not a multi-tenant SaaS with thousands of accounts), classic "reach = users per quarter" doesn't discriminate well. We use a **relative 1–10 reach scale** = how much of the target audience's day the feature touches. Scales are fixed below so scores are comparable across surfaces.

| Factor | Scale | Meaning |
|---|---|---|
| **Reach (R)** | 1–10 | Breadth within the target audience per day. 10 = every order / every customer / every shift. 5 = a large recurring segment. 1 = rare edge case. (For owner-only features, reach = how central to the owner's routine.) |
| **Impact (I)** | 0.25 / 0.5 / 1 / 2 / 3 | Per-encounter impact. 3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal. |
| **Confidence (C)** | 0.5 / 0.8 / 1.0 | 100% = well-understood, 80% = some unknowns, 50% = speculative. |
| **Effort (E)** | person-weeks | One full-stack dev-week = 1.0. Includes design + build + test. Lower is better. |

**Conventions**
- ✅ **Carry** = already built and fine as-is → not scored, in scope by default (e.g. menu browse, cart, guest checkout, menu CRUD, existing catalog). Listed in §6.
- **Enabler** flag = foundational infra whose *direct* RICE understates its value because many features depend on it. These are sequenced first regardless of raw score (see §4).
- Scores are the **PM's starting proposal** — the workshop adjusts Effort (with eng) and Confidence, then we re-rank.

---

## 2. Scored requirements by surface (sorted by RICE ↓)

### 2.1 Customer
| ID | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| CUS-055 | Reject/cancel notification | 4 | 2 | 0.9 | 0.5 | **14.4** | Cheap once notif engine exists |
| CUS-051 | Live order status | 10 | 3 | 1.0 | 3.0 | **10.0** | Needs XC-010 realtime |
| CUS-052 | Prep ETA shown | 9 | 2 | 0.8 | 1.5 | **9.6** | |
| CUS-009 | Out-of-stock shown in real time | 8 | 2 | 0.9 | 1.5 | **9.6** | Needs XC-011 |
| CUS-021 | Per-item special instructions | 5 | 1 | 0.9 | 0.5 | **9.0** | |
| CUS-031 | GST / charges bill breakup | 10 | 1 | 0.9 | 1.0 | **9.0** | Compliance + trust |
| CUS-054 | WhatsApp/SMS/push on accept & ready | 10 | 3 | 0.9 | 3.0 | **9.0** | Depends XC-020 |
| CUS-083 | Fast menu load (perf) | 10 | 1.5 | 0.8 | 1.5 | **8.0** | |
| CUS-056 | Pickup QR / code | 8 | 1 | 0.8 | 1.0 | **6.4** | |
| CUS-004 | Search by item name | 6 | 1 | 0.9 | 1.0 | **5.4** | |
| CUS-026 | Structured pickup slots + capacity | 8 | 1.5 | 0.8 | 2.0 | **4.8** | |
| CUS-064 | Reorder / "order again" | 5 | 2 | 0.7 | 1.5 | **4.7** | Needs accounts |
| CUS-071 | Marketing opt-in | 5 | 0.5 | 0.8 | 0.5 | **4.0** | |
| CUS-003 | Item photos | 8 | 1 | 0.8 | 2.0 | **3.2** | Pair with STF-033 |
| CUS-042 | Payment status / retry | 7 | 1 | 0.7 | 1.5 | **3.3** | With payments |
| CUS-062 | Order history | 5 | 1.5 | 0.8 | 2.0 | **3.0** | |
| CUS-024 | Order-type selector (takeaway/dine-in/delivery) | 6 | 1 | 0.7 | 1.5 | **2.8** | |
| CUS-063 | Saved profile | 5 | 1 | 0.8 | 1.5 | **2.7** | |
| CUS-069 | Ratings & reviews / feedback | 6 | 1.5 | 0.7 | 2.5 | **2.5** | |
| CUS-041 | Online payment (UPI/cards) | 7 | 2 | 0.7 | 4.0 | **2.5** | Big P2 rock |
| CUS-070 | Cancel/modify before accept | 4 | 1 | 0.8 | 1.5 | **2.1** | |
| CUS-061 | Phone-OTP login | 6 | 1 | 0.7 | 2.0 | **2.1** | Dup of XC-004 |
| CUS-082 | Accessibility (WCAG AA) | 6 | 1 | 0.7 | 2.0 | **2.1** | Treat as NFR |
| CUS-006 | Recommended / best-seller rails | 6 | 1 | 0.6 | 2.0 | **1.8** | |
| CUS-011 | Monthly Drops / featured | 5 | 0.5 | 0.7 | 1.0 | **1.8** | |
| CUS-029 | Coupon / promo entry | 5 | 1 | 0.7 | 2.0 | **1.8** | Needs coupon backend |
| CUS-053 | Live queue position | 6 | 1 | 0.6 | 2.0 | **1.8** | |
| CUS-065 | Favorites | 4 | 0.5 | 0.7 | 1.0 | **1.4** | |
| CUS-080 | PWA / offline menu | 6 | 1 | 0.6 | 2.5 | **1.4** | |
| CUS-005 | Filters (veg/price/popularity) | 5 | 0.5 | 0.8 | 1.5 | **1.3** | |
| CUS-030 | Tip for staff | 4 | 0.5 | 0.6 | 1.0 | **1.2** | |
| CUS-066 | Guest→account claim by phone | 4 | 1 | 0.6 | 2.0 | **1.2** | |
| CUS-067 | Loyalty / rewards | 6 | 2 | 0.5 | 5.0 | **1.2** | |
| CUS-032 | Min-order guardrails | 3 | 0.25 | 0.7 | 0.5 | **1.1** | |
| CUS-081 | Hindi localization | 5 | 1 | 0.6 | 3.0 | **1.0** | |
| CUS-007 | Combos / cross-sell | 5 | 1 | 0.5 | 3.0 | **0.8** | |
| CUS-025 | Table QR ordering | 3 | 1 | 0.5 | 3.0 | **0.5** | |
| CUS-068 | Referral program | 3 | 1 | 0.5 | 3.0 | **0.5** | |
| CUS-008 | Allergen / nutrition tags | 3 | 0.5 | 0.6 | 3.0 | **0.3** | |
| CUS-043 | Wallet / credits | 2 | 1 | 0.5 | 4.0 | **0.3** | |
| CUS-044 | Gift cards | 2 | 0.5 | 0.5 | 4.0 | **0.1** | |

### 2.2 Staff
| ID | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| STF-011 | "Ready" tap fires customer notification | 10 | 3 | 0.9 | 0.5 | **54.0** | Wiring on top of XC-020; effort assumes engine exists |
| STF-002 | New-order alert (sound + visual) | 10 | 3 | 0.9 | 1.0 | **27.0** | |
| STF-044 | Temp open/close store | 7 | 2 | 0.9 | 0.5 | **25.2** | |
| STF-005 | Full order detail view | 10 | 2 | 0.9 | 1.0 | **18.0** | |
| STF-003 | Accept / Reject order (reason) | 10 | 3 | 1.0 | 2.0 | **15.0** | Core of the brief |
| STF-006 | Set / adjust ready ETA | 9 | 2 | 0.8 | 1.0 | **14.4** | |
| STF-043 | Pause new orders / busy mode | 7 | 2 | 0.8 | 1.0 | **11.2** | |
| STF-001 | Real-time queue (rework from 15s poll) | 10 | 3 | 0.9 | 2.5 | **10.8** | |
| STF-013 | Full-screen counter/kiosk mode | 8 | 1.5 | 0.8 | 1.0 | **9.6** | |
| STF-032 | 86 / snooze item + auto-reenable | 7 | 1.5 | 0.8 | 1.0 | **8.4** | |
| STF-041 | Mark payment collected + method | 7 | 1.5 | 0.8 | 1.0 | **8.4** | Manual; no gateway needed |
| STF-009 | Search / filter orders | 6 | 1 | 0.9 | 1.0 | **5.4** | |
| STF-051 | Sensitive actions manager-gated | 4 | 1.5 | 0.8 | 1.0 | **4.8** | |
| STF-053 | Per-staff action attribution | 5 | 1 | 0.8 | 1.0 | **4.0** | Feeds metrics |
| STF-024 | Reprint KOT / receipt | 5 | 0.5 | 0.7 | 0.5 | **3.5** | |
| STF-033 | Upload item photos | 6 | 1 | 0.8 | 1.5 | **3.2** | |
| STF-042 | Print receipt / token | 6 | 1 | 0.7 | 1.5 | **2.8** | |
| STF-007 | Cancel order + trigger refund | 4 | 2 | 0.7 | 2.0 | **2.8** | |
| STF-020 | KOT thermal printing | 6 | 2 | 0.6 | 3.0 | **2.4** | Hardware-dependent |
| STF-050 | Staff roles / permissions | 5 | 1.5 | 0.8 | 2.5 | **2.4** | |
| STF-047 | Refund init (manager-gated) | 3 | 1.5 | 0.7 | 1.5 | **2.1** | With payments |
| STF-023 | Per-item started/done ticking | 4 | 1 | 0.6 | 1.5 | **1.6** | |
| STF-034 | Bulk enable/disable, reorder | 4 | 0.5 | 0.8 | 1.0 | **1.6** | |
| STF-010 | Rush / priority flag | 4 | 0.5 | 0.7 | 1.0 | **1.4** | |
| STF-040 | Walk-in / manual POS-lite | 5 | 2 | 0.6 | 3.5 | **1.7** | |
| STF-045 | End-of-day cash reconciliation | 3 | 1 | 0.5 | 2.0 | **0.8** | |
| STF-022 | Station routing | 3 | 1 | 0.5 | 2.5 | **0.6** | |
| STF-046 | Shift handover notes | 2 | 0.5 | 0.6 | 1.0 | **0.6** | |
| STF-021 | Kitchen Display System (KDS) | 3 | 1.5 | 0.5 | 4.0 | **0.6** | |
| STF-052 | Clock in/out / attendance | 3 | 0.5 | 0.6 | 2.0 | **0.5** | |
| STF-035 | Inventory decrement + low-stock | 3 | 1 | 0.5 | 4.0 | **0.4** | |

### 2.3 Owner
| ID | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| OWN-005 | Best & worst sellers, category perf | 8 | 3 | 0.9 | 1.5 | **14.4** | |
| OWN-001 | Today-at-a-glance dashboard | 8 | 3 | 0.9 | 2.0 | **10.8** | |
| OWN-003 | Revenue over time + trend/compare | 8 | 3 | 0.9 | 2.0 | **10.8** | |
| OWN-004 | Orders analytics (counts + rates) | 8 | 2 | 0.9 | 1.5 | **9.6** | |
| OWN-030 | Store settings (hours/slots/prep) | 8 | 2 | 0.9 | 1.5 | **9.6** | |
| OWN-007 | Peak-hours heatmap | 7 | 2 | 0.8 | 1.5 | **7.5** | |
| OWN-008 | Prep-time / SLA metrics | 7 | 2 | 0.8 | 2.0 | **5.6** | |
| OWN-031 | Menu governance (owner-level) | 6 | 1.5 | 0.8 | 1.5 | **4.8** | |
| OWN-009 | Payment mix (collected vs pending) | 6 | 1 | 0.7 | 1.0 | **4.2** | With payments |
| OWN-002 | Live ops mirror (read-only queue) | 5 | 1 | 0.8 | 1.0 | **4.0** | Reuses staff queue |
| OWN-006 | Addon attach-rate & revenue | 5 | 1 | 0.8 | 1.0 | **4.0** | |
| OWN-011 | Cancellation / refund breakdown | 5 | 1 | 0.8 | 1.0 | **4.0** | |
| OWN-018 | Exports + scheduled reports | 6 | 1.5 | 0.8 | 2.0 | **3.6** | |
| OWN-033 | Payment settings / tax config | 5 | 1 | 0.7 | 1.0 | **3.5** | |
| OWN-039 | Audit log viewer | 4 | 1 | 0.8 | 1.0 | **3.2** | |
| OWN-032 | Staff management | 5 | 1.5 | 0.8 | 2.0 | **3.0** | |
| OWN-010 | Customer analytics (repeat/LTV/cohort) | 6 | 2 | 0.7 | 3.0 | **2.8** | |
| OWN-016 | Menu health / most-86'd | 4 | 1 | 0.7 | 1.0 | **2.8** | |
| OWN-034 | Notification settings | 5 | 1 | 0.7 | 1.5 | **2.3** | |
| OWN-013 | Ratings / feedback summary | 5 | 1 | 0.6 | 1.5 | **2.0** | |
| OWN-040 | GST / tax reports | 4 | 1.5 | 0.6 | 2.0 | **1.8** | |
| OWN-012 | Discount / promo ROI | 4 | 1 | 0.6 | 1.5 | **1.6** | |
| OWN-036 | Reviews management | 4 | 1 | 0.6 | 1.5 | **1.6** | |
| OWN-014 | Cart abandonment funnel | 4 | 1.5 | 0.5 | 2.5 | **1.2** | |
| OWN-015 | Staff performance metrics | 4 | 1 | 0.6 | 2.0 | **1.2** | |
| OWN-019 | Configurable alerts | 4 | 1.5 | 0.5 | 2.5 | **1.2** | |
| OWN-035 | Promotions / campaigns | 4 | 1.5 | 0.6 | 3.0 | **1.2** | |
| OWN-037 | CRM / broadcast | 4 | 1.5 | 0.5 | 3.5 | **0.9** | |
| OWN-017 | Goal tracking / forecast | 3 | 1 | 0.5 | 3.0 | **0.5** | |
| OWN-038 | Branding / multi-location setup | 2 | 1 | 0.4 | 3.0 | **0.3** | |
| OWN-020 | Multi-location comparison | 1 | 1 | 0.4 | 3.0 | **0.1** | |

### 2.4 Cross-cutting / platform
| ID | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| XC-032 | PCI-safe payment handling (hosted flows) | 7 | 1.5 | 0.9 | 0.5 | **18.9** | Constraint, not a feature — applies when XC-030 lands |
| XC-041 | Order **state machine** (§5 lifecycle) | 10 | 3 | 0.9 | 2.0 | **13.5** | 🔑 Enabler |
| XC-003 | Owner/staff route gating | 7 | 2 | 0.9 | 1.0 | **12.6** | 🔑 Enabler |
| XC-010 | Real-time infrastructure | 10 | 3 | 0.9 | 2.5 | **10.8** | 🔑 Enabler |
| XC-011 | Real-time availability propagation | 7 | 1.5 | 0.8 | 1.0 | **8.4** | |
| XC-005 | Session mgmt / role-change audit | 6 | 1.5 | 0.8 | 1.0 | **7.2** | |
| XC-020 | Notifications engine (multi-channel) | 10 | 3 | 0.8 | 3.5 | **6.9** | 🔑 Enabler |
| XC-021 | Event-driven notification templates | 8 | 1.5 | 0.8 | 1.5 | **6.4** | |
| XC-044 | Analytics event pipeline | 8 | 2 | 0.8 | 2.0 | **6.4** | 🔑 Enabler (owner metrics) |
| XC-022 | Consent / opt-out handling | 6 | 1 | 0.8 | 1.0 | **4.8** | |
| XC-002 | Permission matrix per role | 6 | 1.5 | 0.8 | 1.5 | **4.8** | |
| XC-023 | Notification delivery logging / retry | 6 | 1 | 0.7 | 1.0 | **4.2** | |
| XC-045 | Feature flags / config | 5 | 1 | 0.7 | 1.0 | **3.5** | |
| XC-001 | RBAC role expansion | 7 | 2 | 0.9 | 2.0 | **6.3** | 🔑 Enabler |
| XC-030 | Payment gateway integration | 7 | 2 | 0.7 | 3.5 | **2.8** | P2 rock |
| XC-043 | Thermal printer / KOT integration | 6 | 1.5 | 0.6 | 2.5 | **2.2** | |
| XC-031 | Reconciliation / refunds | 5 | 1.5 | 0.6 | 2.5 | **1.8** | |
| XC-042 | Petpooja POS integration | 4 | 1.5 | 0.4 | 5.0 | **0.5** | Low confidence — spike first |

> **NFRs (§10 of requirements doc)** are quality constraints, not RICE-scored line items. NFR-001 (perf), NFR-002 (uptime), NFR-004 (security/RLS), NFR-005 (DPDP privacy) are **mandatory in Phase 1**; the rest apply progressively.

---

## 3. Consolidated Top 25 (all surfaces)

| Rank | ID | Requirement | RICE | Surface |
|--:|---|---|--:|---|
| 1 | STF-011 | "Ready" tap → customer notification | 54.0 | Staff |
| 2 | STF-002 | New-order alert | 27.0 | Staff |
| 3 | STF-044 | Temp open/close store | 25.2 | Staff |
| 4 | XC-032 | PCI-safe handling (constraint) | 18.9 | Platform |
| 5 | STF-005 | Full order detail | 18.0 | Staff |
| 6 | STF-003 | Accept / Reject order | 15.0 | Staff |
| 7 | OWN-005 | Best & worst sellers | 14.4 | Owner |
| 8 | STF-006 | Set ready ETA | 14.4 | Staff |
| 9 | CUS-055 | Reject/cancel notification | 14.4 | Customer |
| 10 | XC-041 | Order state machine 🔑 | 13.5 | Platform |
| 11 | XC-003 | Owner/staff gating 🔑 | 12.6 | Platform |
| 12 | STF-043 | Pause / busy mode | 11.2 | Staff |
| 13 | STF-001 | Real-time queue rework | 10.8 | Staff |
| 14 | XC-010 | Real-time infrastructure 🔑 | 10.8 | Platform |
| 15 | OWN-001 | Today-at-a-glance | 10.8 | Owner |
| 16 | OWN-003 | Revenue trend | 10.8 | Owner |
| 17 | CUS-051 | Live order status | 10.0 | Customer |
| 18 | CUS-052 | Prep ETA | 9.6 | Customer |
| 19 | CUS-009 | Out-of-stock realtime | 9.6 | Customer |
| 20 | STF-013 | Counter/kiosk mode | 9.6 | Staff |
| 21 | OWN-004 | Orders analytics | 9.6 | Owner |
| 22 | OWN-030 | Store settings | 9.6 | Owner |
| 23 | CUS-031 | GST bill breakup | 9.0 | Customer |
| 24 | CUS-054 | Notifications on accept & ready | 9.0 | Customer |
| 25 | CUS-021 | Special instructions | 9.0 | Customer |

---

## 4. Enabler dependencies (why raw RICE isn't the whole story)

RICE undervalues foundations because their payoff is *indirect* — it flows through the features built on top. These **must be sequenced first** in Phase 1 even though a couple have mid-pack raw scores:

```
XC-041 Order state machine ──┬─► STF-003 accept/reject ──► CUS-051 live status ──► CUS-054 notify
                             ├─► OWN-004/008 order & SLA metrics
                             └─► STF-006 ETA
XC-010 Real-time infra ──────┬─► STF-001 realtime queue, STF-002 alert
                             ├─► CUS-051 live status
                             └─► XC-011 realtime availability ──► CUS-009 out-of-stock
XC-020 Notification engine ──┬─► STF-011 ready→notify, CUS-054, CUS-055
                             └─► XC-021 templates, XC-022 consent, XC-023 logging
XC-001 RBAC + XC-003 gating ─┬─► /owner surface exists at all
                             └─► STF-050/051 staff roles (P2)
XC-044 Analytics pipeline ───┴─► all OWN-* metrics
```

**Sequencing rule:** ship enablers → then the high-RICE features that ride them. STF-011's 54 is only cheap *because* XC-020 (6.9) paid the upfront cost.

---

## 5. Locked Phase-1 scope — "Connected Ordering"

The coherent, shippable release that closes the biggest gaps (real-time + accept + notify + owner-v1). Everything below is **committed for Phase 1**; estimate total ≈ **28–34 dev-weeks** (validate with eng).

**Foundations (build first)**
- XC-041 Order state machine · XC-010 Real-time infra · XC-001 RBAC + XC-003 gating + XC-005 session
- XC-020 Notifications engine (+ XC-021 templates, XC-022 consent, XC-023 logging)
- XC-044 Analytics event pipeline · XC-011 realtime availability

**Staff**
- STF-001 realtime queue · STF-002 new-order alert · STF-003 accept/reject · STF-005 order detail
- STF-006 ready ETA · STF-009 search/filter · STF-011 ready→notify · STF-013 counter mode
- STF-032 86/snooze · STF-041 mark payment collected · STF-043 busy mode · STF-044 open/close · STF-053 attribution

**Customer**
- CUS-051 live status · CUS-052 prep ETA · CUS-054 notify (accept & ready) · CUS-055 reject/cancel notify
- CUS-009 out-of-stock realtime · CUS-010 store open/closed awareness · CUS-021 special instructions
- CUS-026 pickup slots · CUS-031 GST breakup · CUS-056 pickup code · CUS-003 item photos (+STF-033 upload) · CUS-083 perf

**Owner v1**
- OWN-001 today-at-a-glance · OWN-002 live ops mirror · OWN-003 revenue trend · OWN-004 orders analytics
- OWN-005 best/worst sellers · OWN-007 peak heatmap · OWN-008 SLA/prep-time · OWN-030 store settings

**NFR gates for Phase 1:** NFR-001 perf, NFR-002 uptime + poll-fallback, NFR-004 security/RLS, NFR-005 DPDP consent.

**Explicitly deferred to Phase 2** (high value but bigger rocks / dependencies): CUS-041 online payment + XC-030 gateway + XC-032, accounts/history/reorder (CUS-062/063/064), coupons (CUS-029), ratings (CUS-069), KOT printing (STF-020/XC-043), walk-in POS-lite (STF-040), staff roles UI (STF-050), owner customer-analytics & exports (OWN-010/018).

---

## 6. Carry-over (already built — in scope, not scored)

CUS-001 browse · CUS-002 item cards · CUS-020 variant/addon select · CUS-022 cart · CUS-023 persistent cart · CUS-027 order notes · CUS-028 guest checkout · CUS-040 pay-at-counter · CUS-050 confirmation · CUS-060 optional login · STF-004 advance status · STF-030 menu CRUD · STF-031 availability toggle · XC-040 catalog.

> Some carry-overs get **light rework** in Phase 1 (e.g. STF-004 folds into the new state machine; CUS-050 gains a pickup code).

---

## 7. Next step

Workshop this sheet with eng + owner → adjust Effort/Confidence → confirm the Phase-1 lock → the **Phase-1 detailed spec** (`docs/PHASE-1-SPEC.md`) turns each locked item into user stories + acceptance criteria.
