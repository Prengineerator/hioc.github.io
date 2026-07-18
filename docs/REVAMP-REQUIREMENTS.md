# HIOC Platform Revamp — Requirement Gathering Document

**Product:** HIOC ordering platform (Kamla Nagar, Agra)
**Document type:** Requirements Gathering / Product Requirements (PRD)
**Version:** 0.1 (Draft for review)
**Date:** 2026-07-17
**Owner:** Product (Senior PM)
**Status:** 🟡 Draft — for stakeholder review & prioritization

> This document captures *all candidate requirements* for splitting the current single ordering app into **three distinct experiences** — **Customer**, **Staff**, and **Owner**. It is deliberately broad ("everything we could add"). Nothing here is committed until it is prioritized in the roadmap section and signed off. Requirement IDs are stable references for the backlog.

---

## 1. Background & Current State

HIOC today is a **single Next.js 14 + Supabase web app** ("order ahead, pay at the counter"). It was built as an MVP and has three broad areas already:

| Area | What exists today |
|---|---|
| **Public site** | Home, `/menu` (category tabs, cart, drawer), `/checkout` (guest — name, phone, pickup time, notes; no payment), `/login` (optional email-OTP or password), `/order-confirmation/[id]`, `/about`, `/contact` |
| **Staff back office** | `/staff` live order queue (`received → preparing → ready → completed`, polls every 15s), `/staff/menu` menu CRUD + availability toggle. Gated by middleware + a `role='staff'` check |
| **Data** | `menu_items` → `menu_item_variants` (sizes/prices) + `addon_groups`/`addon_options`; `orders` → `order_items` → `order_item_addons` (all snapshotted at order time); `profiles` (role: `staff` \| `customer`) |

**Key gaps that motivate the revamp** (from the MVP README's "explicitly NOT built"):
- No **payments** (UPI/Razorpay/cards).
- No **order notifications** (SMS/WhatsApp/push) — customer must revisit the link to see status.
- No **customer accounts beyond login** — no order history, saved details, reorder.
- No **inventory / stock-out automation**.
- **No analytics or reporting** of any kind → **there is no owner surface at all today.**
- No **multi-location**, no **menu images**, no **automated tests**.
- Order flow has **no accept/reject, cancel, or refund states**.
- Real-time is **polling (15s)**, not push.

---

## 2. Vision & Objectives

**Vision:** Turn HIOC from a one-way "order form" into a **connected operations platform** — where customers order and stay informed, staff run the counter/kitchen efficiently, and the owner sees the full health of the business in real time.

**Product objectives (candidate — to be ranked):**
1. **Reduce customer uncertainty** — real-time status + proactive "your order is ready" notifications.
2. **Increase order value & repeat rate** — accounts, reorder, loyalty, upsell.
3. **Speed up the counter** — faster staff order handling, KOT/printing, 86-ing, walk-in entry.
4. **Give the owner decision-making visibility** — sales, throughput, item performance, staff performance.
5. **Optionally accept payment online** — reduce counter friction, enable prepaid.

**Candidate success metrics (North-Star & supporting):**
| Objective | Metric |
|---|---|
| Customer clarity | % orders where customer opened live status; support "where's my order" queries ↓ |
| Order value | Average Order Value (AOV) ↑; addon attach-rate ↑ |
| Repeat business | 30/60/90-day repeat-customer rate ↑; reorders as % of orders |
| Counter speed | Median `received → ready` time ↓; orders/hour at peak ↑ |
| Owner visibility | Owner dashboard weekly active usage; time-to-answer a business question |

---

## 3. Scope

### In scope
- Re-architecting into **three role-scoped experiences** on a shared backend/data model.
- All functional requirements listed in §6–§8, prioritized by phase.
- Cross-cutting foundations (auth/RBAC, real-time, notifications, payments, catalog, order state machine) in §9.
- Data-model evolution in §11.

### Out of scope (for this revamp, unless promoted later)
- Third-party marketplace listing (Swiggy/Zomato) beyond existing links.
- Full delivery-fleet logistics (own riders) — only considered as a future option.
- Full-blown accounting/ERP — we report and export, we don't replace Tally/GST filing.
- Native mobile apps (iOS/Android) — we target **responsive web / PWA** first.

### Guiding assumptions
- Single location initially, but **design the data model to allow multi-location later**.
- The cafe already uses **Petpooja POS** (menu was sourced from it) — integration is a candidate, not a guarantee.
- Primary customer device is **mobile web**; primary staff device is a **counter tablet**; owner uses **phone + desktop**.
- Region: India → currency ₹, phone = Indian mobile, likely **English + Hindi**, **GST** applies, **DPDP Act** privacy obligations.

---

## 4. Personas & Stakeholders

| Persona | Description | Primary surface | Top needs |
|---|---|---|---|
| **Customer (guest)** | Walk-up / order-ahead, may never log in | Customer web | Fast menu → cart → order; know when it's ready |
| **Customer (member)** | Returning, logged in | Customer web | Order history, reorder, saved details, loyalty |
| **Cashier / Counter staff** | Takes & manages orders, collects payment | Staff app (tablet) | See new orders instantly, accept, collect payment, mark ready |
| **Barista / Kitchen** | Prepares items | Staff app / KDS | Clear ticket of what to make, 86 items, mark ready |
| **Shift lead / Manager** | Runs a shift, handles exceptions | Staff app (elevated) | Cancel/refund, reassign, pause ordering, reprint |
| **Owner** | Business decisions, may be off-site | Owner dashboard | Sales, trends, item & staff performance, config |

> Note: today only `staff` vs `customer` roles exist. The revamp introduces a **richer role model** (see §9.1).

---

## 5. Order Lifecycle (proposed state machine)

The current flow is `received → preparing → ready → completed`. The user's brief — *"customer places order, staff **accept** and prepare"* — plus real-world ops requires more states:

```
                 ┌──────────► rejected (by staff, with reason)
                 │
placed ─► received ─► accepted ─► preparing ─► ready ─► completed
   │                     │                                  
   │                     └────► cancelled (customer/staff, pre-prep)
   │
   └──► payment_pending ─► paid  (if online payment)         
                                        │
   any post-payment state ─────────────► refunded (partial/full)
```

**Requirement:** the platform must model at minimum: `placed`, `received`, `accepted`, `rejected`, `preparing`, `ready`, `completed`, `cancelled`, plus payment sub-states (`payment_pending`, `paid`, `refunded`). Each transition is timestamped and attributed to an actor (for audit + metrics like accept-time and prep-time).

---

## 6. Customer Experience — Functional Requirements

Legend — **Priority:** M=Must, S=Should, C=Could, W=Won't-yet · **Phase:** P1/P2/P3 · ✅=exists today (may need rework)

### 6.1 Browse & discover
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-001 | Browse menu by category / parent-category tabs ✅ | M | P1 |
| CUS-002 | Item cards show name, price(from), veg/non-veg, availability ✅ | M | P1 |
| CUS-003 | Item photos / image gallery per item | S | P1 |
| CUS-004 | Search by item name | M | P1 |
| CUS-005 | Filters: veg-only, category, price, popularity, "new" | S | P2 |
| CUS-006 | "Best sellers" / "Recommended" / "Chef's picks" rails | S | P2 |
| CUS-007 | Combos / meal deals; "goes well with" cross-sell at item & cart | C | P2 |
| CUS-008 | Allergen, calorie/nutrition & dietary tags | C | P3 |
| CUS-009 | Out-of-stock items shown greyed / auto-hidden in real time | M | P1 |
| CUS-010 | Store open/closed awareness — block ordering when closed, show next-open & prep ETA | M | P1 |
| CUS-011 | Monthly Drops / seasonal / featured section | C | P2 |

### 6.2 Customize, cart & checkout
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-020 | Variant (size) + addon-group selection with min/max rules ✅ | M | P1 |
| CUS-021 | Per-item special instructions | S | P1 |
| CUS-022 | Cart: edit qty, remove, see line totals & subtotal ✅ | M | P1 |
| CUS-023 | Persistent cart across refresh / return visit ✅ | M | P1 |
| CUS-024 | Order-type selector: **Takeaway / Dine-in / Delivery** | S | P2 |
| CUS-025 | Dine-in **table QR ordering** (scan → table pre-filled) | C | P3 |
| CUS-026 | Pickup-time as **structured slots** (not free text) with capacity | S | P1 |
| CUS-027 | Order-level notes ✅ | M | P1 |
| CUS-028 | Guest checkout (name + valid Indian mobile) ✅ | M | P1 |
| CUS-029 | Coupon / promo-code entry with validation | S | P2 |
| CUS-030 | Tip for staff | C | P2 |
| CUS-031 | Show taxes (GST) & any packaging/delivery charges in bill breakup | M | P1 |
| CUS-032 | Minimum-order / max-items guardrails | C | P2 |

### 6.3 Payment
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-040 | Pay-at-counter option ✅ | M | P1 |
| CUS-041 | Online payment — **UPI**, cards, wallets, netbanking (Razorpay/UPI intent) | S | P2 |
| CUS-042 | Payment status reflected on order; failed-payment retry | S | P2 |
| CUS-043 | Prepaid **wallet / credits** | W | P3 |
| CUS-044 | **Gift cards** | W | P3 |

### 6.4 Track & be notified
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-050 | Order confirmation with order number & pickup code ✅ | M | P1 |
| CUS-051 | **Live status** (received→accepted→preparing→ready) with progress UI & real-time updates | M | P1 |
| CUS-052 | Estimated ready-time / prep ETA shown | S | P1 |
| CUS-053 | Live **queue position** ("2 orders ahead") | C | P2 |
| CUS-054 | Proactive notifications: **WhatsApp / SMS / web-push / email** on accept & ready | M | P1 |
| CUS-055 | Notification when order rejected/cancelled (with reason) | M | P1 |
| CUS-056 | Pickup QR / code to show at counter | S | P2 |

### 6.5 Accounts, loyalty & feedback
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-060 | Optional login (email OTP / password) ✅ | S | P1 |
| CUS-061 | Phone-OTP login (more natural for India) | S | P2 |
| CUS-062 | **Order history** for logged-in customers | S | P2 |
| CUS-063 | Saved profile (name, phone, preferences) | S | P2 |
| CUS-064 | **Reorder** / "order again" from history | S | P2 |
| CUS-065 | Favorites / saved items | C | P2 |
| CUS-066 | Guest → account conversion (claim past orders by phone) | C | P2 |
| CUS-067 | **Loyalty / points / rewards** program | C | P3 |
| CUS-068 | Referral program | W | P3 |
| CUS-069 | **Ratings & reviews / feedback** per order & item | S | P2 |
| CUS-070 | Cancel / modify order **before staff accepts** | S | P2 |
| CUS-071 | Marketing opt-in (offers, newsletter) with consent | C | P2 |

### 6.6 Customer non-functional
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| CUS-080 | Mobile-first responsive; **installable PWA**, offline menu cache | S | P2 |
| CUS-081 | English + **Hindi** localization | C | P2 |
| CUS-082 | Accessibility (WCAG 2.1 AA target) | S | P2 |
| CUS-083 | Fast menu load (see NFRs §10) | M | P1 |

---

## 7. Staff Experience — Functional Requirements

The staff app is the **operations cockpit** — optimized for a counter tablet: glanceable, few taps, hard to mis-tap.

### 7.1 Order queue & lifecycle
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| STF-001 | Live order queue by status lane ✅ (rework to real-time push, not 15s poll) | M | P1 |
| STF-002 | **New-order alert** — sound + visual, until acknowledged | M | P1 |
| STF-003 | **Accept / Reject** a new order (reject requires reason) | M | P1 |
| STF-004 | Advance status: accepted→preparing→ready→completed ✅ | M | P1 |
| STF-005 | Full order detail: items, variants, addons, notes, customer name/phone, order type, ETA | M | P1 |
| STF-006 | Set / adjust **estimated ready time** on accept | S | P1 |
| STF-007 | Cancel an order (with reason); trigger refund if prepaid | S | P2 |
| STF-008 | Modify order on customer's behalf (add/remove item, qty) | C | P2 |
| STF-009 | Search / filter orders (number, phone, name, status, date) | S | P1 |
| STF-010 | Rush / priority flag; re-sort queue | C | P2 |
| STF-011 | "Ready" tap fires customer notification (WhatsApp/SMS/push) | M | P1 |
| STF-012 | Order status history / audit trail (who did what, when) | S | P2 |
| STF-013 | Full-screen "counter mode" kiosk view for a shared tablet | S | P1 |

### 7.2 Kitchen / preparation
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| STF-020 | **KOT (Kitchen Order Ticket)** print to thermal printer | S | P2 |
| STF-021 | **Kitchen Display System (KDS)** — station-filtered ticket view | C | P3 |
| STF-022 | Route items to stations (barista vs kitchen) | C | P3 |
| STF-023 | Per-item "started / done" ticking within an order | C | P2 |
| STF-024 | Reprint KOT / receipt | S | P2 |

### 7.3 Menu & availability
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| STF-030 | Menu CRUD: add/edit/delete items, variants, addons ✅ | M | P1 |
| STF-031 | Toggle item availability ✅ | M | P1 |
| STF-032 | **86 / snooze** item out-of-stock with auto-re-enable (e.g. till end of day) | S | P1 |
| STF-033 | Upload item photos | S | P2 |
| STF-034 | Bulk enable/disable; reorder items | C | P2 |
| STF-035 | Optional inventory decrement + low-stock alert | C | P3 |

### 7.4 Counter operations
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| STF-040 | **Walk-in / manual order entry** (POS-lite) at the counter | S | P2 |
| STF-041 | Mark payment collected + method (cash/UPI/card) | S | P1 |
| STF-042 | Print / show customer receipt & token | S | P2 |
| STF-043 | **Pause new orders / "busy mode"** (stop accepting or add delay) | S | P1 |
| STF-044 | Temporarily open/close store from staff app | S | P1 |
| STF-045 | End-of-day cash reconciliation summary | C | P3 |
| STF-046 | Shift handover notes | C | P3 |
| STF-047 | Refund initiation (manager-gated) | S | P2 |

### 7.5 Staff accounts & roles
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| STF-050 | Distinct staff roles (cashier / kitchen / manager) with permissions | S | P2 |
| STF-051 | Sensitive actions (cancel, refund, price edit) gated to manager | S | P2 |
| STF-052 | Clock in/out / basic attendance (feeds staff-performance metrics) | C | P3 |
| STF-053 | Per-staff action attribution on every order transition | S | P2 |

---

## 8. Owner Experience — Functional Requirements

Brand-new surface. The owner is often **off-site** → mobile-friendly dashboard + scheduled reports. Two halves: **Analytics/Metrics** (§8.1) and **Business Management/Config** (§8.2). The full metric catalog is §8.3.

### 8.1 Dashboards & analytics
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| OWN-001 | **Today at a glance**: live sales ₹, order count, AOV, orders in progress | M | P1 |
| OWN-002 | Live ops view — read-only mirror of the staff queue | S | P1 |
| OWN-003 | Revenue over time (day/week/month/custom range) with trend & comparison (WoW/MoM/YoY) | M | P1 |
| OWN-004 | Orders analytics: placed / accepted / completed / cancelled / rejected counts & rates | M | P1 |
| OWN-005 | **Best & worst sellers**, category performance, item revenue & units | M | P1 |
| OWN-006 | Addon attach-rate & addon revenue | S | P2 |
| OWN-007 | **Peak-hours heatmap** (day × hour) | S | P1 |
| OWN-008 | **Prep-time / SLA** metrics: median & p90 accept-time and prep-time, trend | M | P1 |
| OWN-009 | Payment mix (UPI/cash/card), collected vs pending | S | P2 |
| OWN-010 | Customer analytics: new vs returning, repeat rate, top customers, cohort retention, LTV | S | P2 |
| OWN-011 | Cancellation / rejection reason breakdown; refund totals | S | P2 |
| OWN-012 | Discount / coupon usage, cost & promo ROI | C | P2 |
| OWN-013 | Ratings / feedback summary (avg score, CSAT/NPS, themes) | C | P2 |
| OWN-014 | Checkout / cart **abandonment** funnel | C | P3 |
| OWN-015 | Staff performance: orders handled, median prep-time per staff/shift | C | P3 |
| OWN-016 | Menu health: stock-out incidents, most-86'd items | C | P3 |
| OWN-017 | Goal / target tracking vs actuals; simple forecast | C | P3 |
| OWN-018 | **Exports** (CSV/Excel/PDF) + scheduled email/WhatsApp reports (daily/weekly) | S | P2 |
| OWN-019 | Configurable alerts (revenue target hit, unusual spike/drop, downtime) | C | P3 |
| OWN-020 | Multi-location comparison (when >1 location) | W | P3 |

### 8.2 Business management & configuration
| ID | Requirement | Pri | Phase |
|---|---|---|---|
| OWN-030 | Store settings: hours, holidays, pickup slots & capacity, prep-time defaults | M | P1 |
| OWN-031 | Menu governance: pricing, categories, publish/unpublish, seasonal drops | S | P1 |
| OWN-032 | **Staff management**: invite/remove staff, assign roles & permissions | S | P2 |
| OWN-033 | Payment settings (gateway keys, accepted methods, tax/GST config) | S | P2 |
| OWN-034 | Notification settings (channels, templates, on/off per event) | S | P2 |
| OWN-035 | Promotions/coupons & campaign management; homepage banners/announcements | C | P2 |
| OWN-036 | Reviews management — read & respond to feedback | C | P3 |
| OWN-037 | Customer/CRM list with segments & broadcast (consent-aware) | C | P3 |
| OWN-038 | Branding (logo, colors, copy) & multi-location setup | W | P3 |
| OWN-039 | **Audit log** viewer (staff actions, config changes) | S | P2 |
| OWN-040 | GST / tax reports & invoice/settlement exports | C | P3 |

### 8.3 Metrics Catalog (the "any kind of metrics" master list)

Grouped so we can pick what each dashboard tile shows. Each is derivable from the order + event data model in §11.

**Sales & revenue**
- Gross revenue, net revenue (after discounts/refunds), tax collected
- AOV (average order value), items per order, revenue per item / per category
- Revenue by hour / day-of-week / date range; WoW, MoM, YoY deltas
- Discount amount given; refund amount; net-of-refund revenue
- Payment-method split; online vs pay-at-counter share

**Orders & throughput**
- Orders placed / accepted / rejected / completed / cancelled (counts + rates)
- Order acceptance rate; rejection rate & reasons; cancellation rate & reasons
- Orders per hour (throughput), peak-hour identification, concurrency
- Order type mix (takeaway/dine-in/delivery)

**Operational / SLA (time-based)**
- Time-to-accept (placed→accepted): median, p90
- Prep time (accepted→ready): median, p90, by item/category
- Fulfillment time (placed→completed): median, p90
- On-time vs promised-ETA rate; late-order count
- Busy-mode / store-closed minutes

**Menu & product**
- Units sold per item/variant; top/bottom sellers; category mix
- Addon attach-rate & addon revenue
- Stock-out (86) incidents & duration per item
- New-item / Monthly-Drop performance

**Customer**
- New vs returning customers; repeat rate (30/60/90-day)
- Cohort retention; customer lifetime value; top customers by spend/orders
- Avg orders per customer; days-between-orders
- Ratings/reviews: avg score, volume, CSAT/NPS, sentiment/themes

**Marketing & funnel**
- Cart → checkout → order conversion; abandonment rate & drop-off step
- Coupon usage, redemption rate, promo ROI, discount-to-revenue ratio
- Loyalty enrollment & redemption (if built)
- Channel/source attribution (QR, direct, social)

**Staff**
- Orders handled per staff/shift; median prep-time per staff
- Actions per staff (accepts, cancels, refunds); attendance (if tracked)

---

## 9. Cross-Cutting / Platform Requirements

These are shared foundations the three surfaces build on.

### 9.1 Authentication & Role-Based Access Control
| ID | Requirement | Pri |
|---|---|---|
| XC-001 | Expand roles beyond `staff`/`customer`: `customer`, `staff`, `kitchen`, `cashier`, `manager`, `owner` | M |
| XC-002 | Permission matrix per role; sensitive actions (refund, price change, config) gated | M |
| XC-003 | Owner surface behind owner role; staff surface behind staff+ roles; no privilege self-escalation (keep server-side, RLS-enforced) | M |
| XC-004 | Phone-OTP auth option for customers | S |
| XC-005 | Session management, secure logout, audit of role changes | M |

### 9.2 Real-time
| ID | Requirement | Pri |
|---|---|---|
| XC-010 | Replace 15s polling with **push/real-time** (e.g. Supabase Realtime / websockets) for staff queue & customer live status | M |
| XC-011 | Real-time availability propagation (86 an item → disappears for customers instantly) | S |

### 9.3 Notifications engine
| ID | Requirement | Pri |
|---|---|---|
| XC-020 | Multi-channel: **WhatsApp Business API**, SMS, email, web-push | M |
| XC-021 | Event-driven templates (accepted, ready, rejected, cancelled, refunded, promos) | M |
| XC-022 | Per-event/channel config + consent & opt-out handling | S |
| XC-023 | Delivery logging & retry | S |

### 9.4 Payments
| ID | Requirement | Pri |
|---|---|---|
| XC-030 | Payment gateway integration (UPI-first: Razorpay/UPI intent) | S |
| XC-031 | Reconciliation of gateway settlements; refunds (full/partial) | S |
| XC-032 | PCI-safe handling — no card data stored by us; use hosted/gateway flows | M (if XC-030) |

### 9.5 Catalog, order state machine & integrations
| ID | Requirement | Pri |
|---|---|---|
| XC-040 | Single source-of-truth **menu/catalog** shared by all three surfaces ✅(exists, keep) | M |
| XC-041 | Order **state machine** per §5, with timestamped, attributed transitions | M |
| XC-042 | **Petpooja POS** integration (menu sync, push orders to POS) — evaluate | C |
| XC-043 | Thermal-printer / KOT integration | S |
| XC-044 | Analytics event pipeline (order events, funnel events) feeding owner metrics | M |
| XC-045 | Feature flags / config service for phased rollout | S |

---

## 10. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Performance | Menu interactive < 2.5s on mid-range mobile / 4G; status/queue updates < 2s end-to-end |
| NFR-002 | Availability | ≥ 99.5% uptime, especially during 10:00–24:00 operating hours; graceful degradation if realtime drops (fallback to poll) |
| NFR-003 | Scalability | Handle peak-hour concurrency (order bursts) without queue lag |
| NFR-004 | Security | RLS-enforced data access; service-role only server-side; no client access to other customers' orders; secrets never client-exposed |
| NFR-005 | Privacy | **DPDP Act** compliance — consent for marketing, data-retention policy, PII minimization, right to erasure |
| NFR-006 | Payments | PCI-DSS via hosted gateway; no raw card storage |
| NFR-007 | Accessibility | WCAG 2.1 AA target on customer surface |
| NFR-008 | Devices/browsers | Customer: mobile web (iOS Safari/Android Chrome). Staff: tablet. Owner: phone+desktop. PWA-installable |
| NFR-009 | Localization | ₹ formatting, Indian phone validation ✅, English + Hindi (candidate) |
| NFR-010 | Observability | Error tracking, uptime monitoring, structured logs, order-event audit |
| NFR-011 | Reliability | Order data is source-of-truth; snapshotting preserved ✅; no lost orders on failure |
| NFR-012 | Maintainability | Automated tests (currently none), typed API contracts kept in sync (`lib/types.ts` ↔ schema) |
| NFR-013 | Backup/DR | Regular DB backups; recovery procedure documented |

---

## 11. Data Model Evolution (candidate)

Building on the existing schema (`menu_items`, `menu_item_variants`, `addon_groups`, `orders`, `order_items`, `order_item_addons`, `profiles`). Candidate additions:

| Change | Rationale | Feeds |
|---|---|---|
| Extend `order_status` enum → add `placed/accepted/rejected/cancelled` (+ payment sub-states) | Support accept/reject/cancel/refund | §5, STF-003/007, metrics |
| New `order_status_events` (order_id, from, to, actor_id, reason, at) | Timestamped, attributed transitions | SLA metrics, audit, OWN-008 |
| Add to `orders`: `order_type`, `promised_ready_at`, `pickup_code`, `location_id`, `coupon_id`, `discount_inr`, `tax_inr`, `total_inr`, `source` | Order-type, ETA, tokens, multi-loc, promos, tax breakup | CUS-024/026/031, metrics |
| New `payments` (order_id, method, amount, status, gateway_ref, refunded_inr) | Payment & refund tracking | XC-030/031, OWN-009 |
| New `notifications` (order_id, channel, event, status, sent_at) | Delivery logging | XC-023 |
| New `customers` / extend `profiles` (name, phone, prefs, marketing_consent) | Accounts, history, CRM | CUS-062/071, OWN-037 |
| New `coupons` / `promotions` | Discounts | CUS-029, OWN-035 |
| New `reviews` (order_id, item_id, rating, comment) | Feedback | CUS-069, OWN-013 |
| Add `image_url` to `menu_items`; new `menu_availability` snooze fields | Photos, 86-ing | CUS-003, STF-032/033 |
| New `locations`; add `role`s to `profiles`; `staff_shifts` | Multi-loc, RBAC, attendance | XC-001, STF-052 |
| Materialized views / rollups for metrics | Fast owner dashboards | §8.3 |

> **Discipline:** keep `lib/types.ts` in exact sync with the schema (existing convention). Preserve order-item **snapshotting** so historical orders never rewrite when the menu changes.

---

## 12. Proposed Phasing / Roadmap

A pragmatic sequencing — **each phase is independently shippable**. Exact scope confirmed after prioritization workshop.

### Phase 1 — "Connected ordering" (foundation)
Make the loop real-time and close the notification/accept gap.
- Order state machine + accept/reject (STF-003), real-time queue (XC-010), new-order alert (STF-002)
- Customer live status (CUS-051) + prep ETA (CUS-052)
- Notifications: WhatsApp/SMS on accept & ready (XC-020, CUS-054)
- Store open/closed + busy mode (CUS-010, STF-043/044), 86-ing (STF-032)
- Item photos (CUS-003), structured pickup slots (CUS-026), GST breakup (CUS-031)
- **Owner v1 dashboard**: today-at-a-glance, revenue trend, orders, best-sellers, SLA times, peak hours (OWN-001/003/004/005/007/008), store settings (OWN-030)
- RBAC expansion (XC-001)

### Phase 2 — "Value & retention"
- Online payment (CUS-041, XC-030), payment marking (STF-041), refunds (STF-047)
- Accounts: order history, reorder, saved details, phone-OTP (CUS-061/062/063/064)
- Ratings/feedback (CUS-069), coupons (CUS-029), search/filters (CUS-004/005)
- KOT printing (STF-020), walk-in POS-lite (STF-040), staff roles/permissions (STF-050)
- Owner: customer analytics, payment mix, cancellation reasons, exports & scheduled reports, promos (OWN-009/010/011/018/035), audit log (OWN-039)

### Phase 3 — "Scale & optimize"
- Loyalty/rewards (CUS-067), PWA/offline (CUS-080), Hindi (CUS-081), table QR (CUS-025)
- KDS & station routing (STF-021/022), inventory (STF-035), shift/attendance (STF-052)
- Owner: staff performance, forecasting, alerts, CRM/broadcast, GST reports, multi-location (OWN-015/017/019/037/040/020)
- Petpooja integration (XC-042) — decide build vs integrate

**Prioritization method:** score candidate requirements by **RICE** (Reach, Impact, Confidence, Effort) or MoSCoW in the workshop; the Pri/Phase columns above are the PM's starting proposal, not final.

---

## 13. Open Questions / Decisions Needed

1. **Online payments — in or out?** UPI-first via Razorpay, or stay pay-at-counter for now? (Drives XC-030, Phase-2 scope.)
2. **Notification channel priority** — WhatsApp Business API (best UX, setup cost) vs SMS (simplest) vs web-push (free, but requires opt-in)? Budget?
3. **Delivery** — does HIOC want to offer own-delivery, or takeaway/dine-in only? (Affects CUS-024, order model.)
4. **Petpooja** — integrate (menu + order push) or keep this app as the source of truth? Avoid double data entry.
5. **Three separate apps vs one app, three role-scoped areas** — recommend **one codebase / shared backend, three role-gated surfaces** (customer web, `/staff`, `/owner`) rather than three separate deployments, to reuse the catalog/order model. Confirm.
6. **Staff role granularity** — is a single "staff" role enough at one location, or do we need cashier/kitchen/manager splits from day one?
7. **Loyalty** — build in-house or defer? What mechanic (points, stamps, tiers)?
8. **Hardware** — is there a thermal printer / dedicated counter tablet / KDS screen? (Drives STF-020/021.)
9. **Multi-location horizon** — realistic timeline? Determines how hard we invest in `location_id` now.
10. **Budget & timeline** for the revamp, and who owns ops sign-off (owner vs manager).

---

## 14. Risks & Assumptions

| Risk | Impact | Mitigation |
|---|---|---|
| Notification costs (WhatsApp/SMS) at volume | Ongoing opex | Start with web-push + WhatsApp for key events only; measure |
| Staff adoption of new queue flow at a busy counter | Ops slowdown | Keep counter mode dead-simple; pilot during off-peak; training |
| Payment/refund edge cases | Money & trust | Use hosted gateway, strong reconciliation, manager-gated refunds |
| Real-time reliability on poor cafe wifi | Missed orders | Poll fallback (NFR-002); audible alert until acknowledged |
| Scope creep across three surfaces | Delayed launch | Strict phasing; Phase-1 is the shippable core |
| Data privacy (DPDP) with CRM/marketing | Legal | Consent-first, minimize PII, retention policy |
| `next@14.2.5` known advisory (from MVP notes) | Security | Patch/upgrade before public launch |

---

## 15. Appendix — Requirement ID Index

- **CUS-0xx** — Customer experience (§6)
- **STF-0xx** — Staff experience (§7)
- **OWN-0xx** — Owner experience (§8)
- **XC-0xx** — Cross-cutting/platform (§9)
- **NFR-0xx** — Non-functional (§10)

> Next step: circulate for stakeholder review → prioritization workshop (RICE/MoSCoW) → lock Phase-1 scope → write per-feature specs & acceptance criteria.
