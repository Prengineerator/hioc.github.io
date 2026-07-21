# HIOC Revamp — Phase 3 RICE Re-score

**Companion to:** `docs/PHASE-3-SPEC.md`, `docs/RICE-PRIORITIZATION.md`, `docs/PHASE-2-RICE.md`
**Version:** 0.2 (re-scored after owner decisions D2–D6 — `PHASE-3-SPEC.md §8`)
**Date:** 2026-07-21
**Owner:** Product (Senior PM)
**Purpose:** Score the Phase-3 ticket set so the **milestone order (3A → 3B → 3C) and within-milestone sequence are confirmed by the numbers**, and stretch items are cleanly separated from committed scope.

---

## 1. Method (unchanged)

**RICE = (Reach × Impact × Confidence) ÷ Effort**, same fixed scales as `docs/RICE-PRIORITIZATION.md §1` (R 1–10 breadth/day · I 0.25/0.5/1/2/3 · C 0.5/0.8/1.0 · E person-weeks). **🔑 Enabler** = foundation whose direct RICE understates its value → sequenced first regardless of raw score.

**Reach calibration for this phase:** staff surfaces score R≈4–5 (every staff shift, every counter order — consistent with Phase-2's staff tickets); dine-in-only items assume dine-in ≈ 30–50 % of daily orders once capturable (today it's 0 % *in the system*, which is the point of the phase). Confidence on printing and QR rose to 0.8 once D3 (printer exists) and D6 (QR pays online first) were decided; FND3-4/POS-4 are scored at their D2-reduced **void-only** scope.

---

## 2. Scored Phase-3 tickets (sorted by RICE ↓ within group)

### 2.1 Foundations
| Ticket | Requirement | R | I | C | E | **RICE** | Flag |
|---|---|--:|--:|--:|--:|--:|---|
| FND3-1 | Tables registry + owner CRUD | 4 | 1 | 1.0 | 0.5 | **8.0** | Cheap, unblocks 3 pillars |
| FND3-3 | Staff order-creation path | 4 | 2 | 0.8 | 1.0 | **6.4** | 🔑 |
| FND3-5 | Dine-in state-machine rules | 4 | 1 | 0.8 | 0.5 | **6.4** | Pairs with FND3-3 |
| FND3-2 | Channel & staff attribution | 6 | 0.5 | 1.0 | 0.5 | **6.0** | Data integrity forever |
| FND3-6 | Owner-configurable permission matrix | 4 | 1.5 | 0.8 | 1.0 | **4.8** | Owner-requested; unhard-codes FND-5 |
| FND3-4 | Corrections engine (void-only, D2) | 3 | 1.5 | 0.8 | 0.75 | **4.8** | 🔑 for 3B |

### 2.2 Pillar A — Staff POS
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| POS-2 | Collect payment & complete | 4 | 1 | 0.8 | 0.5 | **6.4** | Cheap; closes the money loop |
| POS-1 | Staff order entry (STF-040) | 4 | 3 | 0.8 | 1.5 | **6.4** | **Headline of the phase** |
| POS-3 | Tables board | 4 | 1.5 | 0.8 | 1.0 | **4.8** | |
| POS-4 | Void UI (STF-008) | 3 | 1 | 0.8 | 0.5 | **4.8** | Rides FND3-4 |

### 2.3 Pillar B — Kitchen, receipts & bill delivery
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| KOT-2 | Receipt & token print (STF-042) | 4 | 1 | 0.8 | 0.5 | **6.4** | Browser-print suffices → 3A |
| RCT-1 | Bill on WhatsApp at settle | 4 | 1 | 0.8 | 0.5 | **6.4** | Owner-requested; reuses WA channel (template approval = I3) |
| KOT-1 | KOT per order (STF-020/024) | 4 | 1.5 | 0.8 | 1.0 | **4.8** | Printer confirmed (D3) |
| RCT-2 | Bill by email | 2 | 1 | 0.8 | 0.5 | **3.2** | Owner-requested; first email adapter (D9) — low reach, but the expense-claim/GST-record use case |

### 2.4 Pillar C — Table QR
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| QR-1 | Scan-to-order (CUS-025) | 3 | 2 | 0.8 | 1.0 | **4.8** | Pay-first decided (D6) |
| QR-2 | Printable QR assets | 3 | 0.5 | 0.8 | 0.5 | **2.4** | |

### 2.5 Pillar D — Ops, cash & analytics
| Ticket | Requirement | R | I | C | E | **RICE** | Notes |
|---|---|--:|--:|--:|--:|--:|---|
| OPS-1 | Channel & dine-in analytics | 2 | 1.5 | 0.8 | 1.0 | **2.4** | Needs 3A data first anyway |
| OPS-2 | Cash day open/close by denomination (STF-045) | 2 | 2 | 0.8 | 1.5 | **2.1** | Owner-requested; the daily cash-control ritual |

### 2.6 Stretch — scored to justify exclusion
| Ticket | Requirement | R | I | C | E | **RICE** | Verdict |
|---|---|--:|--:|--:|--:|--:|---|
| — | KDS / stations (STF-021/022) | 2 | 1 | 0.5 | 2.0 | **0.5** | ⏭ After 3B proves volume |
| — | Split bills / merge tables | 2 | 0.5 | 0.5 | 1.5 | **0.3** | ⏭ Real-POS territory |
| — | Per-item ticking (STF-023) | 2 | 0.5 | 0.5 | 1.0 | **0.5** | ⏭ With KDS |

---

## 3. What the numbers say

1. **3A order confirmed:** the top of the board is FND3-1 (8.0) plus the FND3-3/5 + POS-1/2 cluster (all 6.4) — exactly Milestone 3A. POS-1's raw score understates it the same way pillar headliners did in Phase 2 (it's I=3, the whole phase's reason to exist); the enabler rule sequences its foundations first.
2. **The 3B cliff closed when D2 landed:** at void-only scope, FND3-4/POS-4 (both 4.8) justify their sprint — the full rounds engine, which scored 2.4 in v0.1, would not have. The decision removed ≈ 6 pts of the lowest-scoring committed work in the phase.
3. **No low-confidence ticket remains on the committed board:** D3/D6 lifted KOT and QR to C = 0.8; the only C ≤ 0.5 work left is the stretch table, which stays out.
4. **Committed scope = §2.1–2.5 (18 tickets).** Stretch table §2.6 stays out; nothing in it beats the weakest committed ticket. The committed floor is OPS-2 (2.1) — it and RCT-2 (3.2) are in on explicit owner calls (drawer control, bill-to-inbox), not on score.
