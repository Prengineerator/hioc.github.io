# Taking money at the counter — card terminal & QR

**Version:** 0.1 · **Date:** 2026-09-14 · **Status:** plan, no code yet
**Owner decisions captured:** Razorpay for QR ordering; **Pine Labs at the counter**; one printer at the counter.
**Companion:** `docs/POS-DEVICE-SETUP.md` (the printer half, actionable today)

---

## 1. What is actually wrong today

Nothing is broken. The gap is that **the counter's payment record is an assertion, not a fact.**

When a staffer settles a card order, they tap "Card" in `PosPaymentModal`, the route writes `payment_method='card'`, `payment_status='paid'`, and that is the end of it. The card machine sitting next to the till has no idea an order exists; the staffer keys the amount into it by hand.

Two consequences, in the order they will bite:

1. **The amount is typed twice.** ₹450 becomes ₹4,500, or the tap is taken for the previous customer's total. Nothing in the system can notice — the order says paid either way.
2. **Card takings cannot be reconciled.** The cash-day machinery (`computeCashFlows`) balances the drawer because cash is counted. Card has no equivalent: the only record that a card was charged is the staffer's tap, and the only record of what the *bank* received is a separate settlement report nobody joins up.

Integration fixes both by making the terminal the source of truth: the POS sends the amount, the terminal charges it, and the answer comes back and sets `payment_status`.

## 2. What we already have

Worth being precise, because most of the shape exists:

- `payments` (from `phase2-migration.sql`) already has a **`gateway` column**, defaulting to `'razorpay'`, with `gateway_order_id` / `gateway_payment_id` and `unique (gateway, gateway_order_id)`. A second provider is a new value in that column, not a new table.
- `lib/payments/gateway.ts` is a **REST-over-fetch** integration with no SDK, and degrades to `null` when unconfigured so callers fall back to pay-at-counter. That is the pattern a second provider should copy exactly.
- `PaymentMethod` is already `'cash' | 'upi' | 'card' | 'online'`.
- Split tender (POS4-1) already exists, so "₹200 cash + ₹300 card" is a case the design must keep working — the terminal is charged only for the card part.

## 3. The two providers, doing two different jobs

| | Where | What it does | Status |
|---|---|---|---|
| **Razorpay** | Customer's own phone, table-QR ordering | Customer scans the table QR, orders, pays online in their browser | **Already built** — `openRazorpayCheckout` in `QrCheckout.tsx`, server intent in `gateway.ts` |
| **Pine Labs** | The counter | Staff punch the order; the terminal beeps with the exact amount; customer taps | **To build** |

These do not overlap and neither replaces the other. A QR diner pays on their phone and never touches the terminal; a walk-in at the till taps a card on the terminal and never sees a checkout page.

> **Assumption flagged:** "Razorpay for QR ordering" is read as *the existing online checkout on the customer's phone*, which is built and working. If what is wanted instead is a **Razorpay dynamic-QR standee at the counter** — a printed/displayed UPI QR that the customer scans to pay a specific amount — that is a *different, smaller* feature and is not covered below. Say so and it gets its own ticket; it is genuinely useful for UPI-heavy counters and avoids terminal fees.

## 4. How the counter integration works

Pine Labs' Plutus Smart terminals support a **cloud API**: our server calls Pine Labs, Pine Labs pushes the request down to the specific terminal, and the terminal prompts the customer. Nothing runs on the counter PC.

```
POS "Charge ₹450 (card)"
      │
      ▼
our server  ──POST──▶  Pine Labs cloud  ──push──▶  terminal beeps, shows ₹450
      │                                                    │
      │◀────────── poll for result ◀───────────── customer taps card
      ▼
payments row (gateway='pinelabs') + order.payment_status='paid'
```

The important property: **the staffer never types an amount into the terminal.** They tap Charge; the machine already knows.

### Why there is no Windows app in that diagram

The counter machine is a browser. It cannot open a socket to a card terminal, and it cannot fetch `http://192.168.1.50` from an HTTPS page — mixed content blocks it (`http://localhost` is exempt, arbitrary LAN addresses are not). So a *local* terminal integration would require installing a helper application on the counter PC.

The cloud API removes that requirement entirely. It also means the same integration works from a phone, a tablet, or the event stand — none of which could run a Windows helper.

### The sequencing problem this design must handle

A card payment is not instant and can end in four ways, not two. The design has to survive all of them:

- **Approved** → record it, settle the order.
- **Declined** → the order stays unpaid, the staffer tries another tender. Not an error state; a normal Tuesday.
- **Cancelled at the terminal** → same as declined.
- **No answer** — the network dropped mid-transaction, or the staffer walked away. **This is the dangerous one**: the customer may have been charged. The POS must never silently mark it unpaid, and must never let the staffer charge a second time without being told. The order gets a visible "waiting on the terminal" state, and the poll continues; an unresolved transaction is surfaced, not swallowed.

That last case is the reason this is a ticketed piece of work rather than an afternoon: the failure that costs real money is the double charge, and it is entirely in the retry logic.

## 5. The Windows helper app — decided against, for now

The question asked was whether a Windows application with a config screen could be built. It can. With **one counter printer and a cloud-capable terminal, it would carry no load**, and it would cost:

- a second thing to install, version and update on every counter machine — exactly the problem the installable PWA was chosen to avoid, where a deploy *is* the update;
- a local HTTP server on the cafe's PC, which is a real security surface (any website that machine visits could reach it) needing localhost-only binding, a pairing token, and a locked CORS origin;
- Windows-only, so the phone, the tablet and the event stand fall back to something else anyway.

**It gets reopened if any of these become true — and then it is the right answer, not a compromise:**

1. **A second printer** — kitchen tickets to the kitchen, receipts to the counter, from one machine. A browser cannot route per job; this is the most likely trigger.
2. **The terminal turns out to be LAN-only.** If Pine Labs cannot cloud-enable your specific machine, a helper on the counter PC is the only remaining path.
3. **A cash drawer that must open on settle.** The drawer kicks from the printer via an ESC/POS command a browser cannot send.
4. **Printer status** — "out of paper" before the ticket is lost, rather than after.

If it is built, it is a **small tray agent** (print + terminal + drawer over `http://localhost`), not an Electron wrapper around the POS. The agent leaves the POS a web app; the wrapper would drag the whole interface into a release channel for no benefit.

## 6. Tickets (sketch, ~13 pts)

- **PAY7-1 (2) — Provider credentials & health.** `lib/payments/pinelabs.ts` following `gateway.ts`'s shape: REST over fetch, no SDK, returns `null` when unconfigured so the counter falls back to "tap Card as today". Extend `verify:notifications`-style doctoring so a misconfigured terminal is *visible*, not a mystery at the till. **Trap:** the unconfigured state must be indistinguishable from today's behaviour — this cannot make the counter worse while it is being set up.
- **PAY7-2 (4) — Charge & poll.** `POST /api/orders/[id]/terminal-charge` → initiate, then poll to a terminal state. Writes a `payments` row with `gateway='pinelabs'`. **Traps:** idempotency key per *charge attempt* (the REF-2 pattern — a double-tap must replay, never double-charge); the no-answer case above; amount comes from the server's recomputed total, never the client (F13).
- **PAY7-3 (3) — The counter's experience.** "Waiting on the terminal" state in `PosPaymentModal` with cancel, decline handling, and a card part inside a split tender. **Trap:** it must not take over the screen — the FLOW-1 rule stands.
- **PAY7-4 (2) — Reconciliation.** Card takings appear alongside cash on the cash-day screen, keyed to terminal reference. **Trap:** `computeCashFlows` must not change for cash; it has been rewritten once already because a wrong drawer destroys trust.
- **PAY7-5 (2) — Refunds.** Route a card refund back through the terminal rather than a manual reversal, reusing REF-1/REF-2's manager gating and idempotency.

## 7. What the owner has to obtain first — start this now

Terminal APIs are **gated by the provider**, exactly like the Meta template currently blocking the WhatsApp bill. The request has a lead time we do not control, so it should be raised before any code is written.

Ask Pine Labs (your relationship manager, or their integration desk) for:

1. **Cloud API access for the Plutus Smart integration**, enabled on your merchant account.
2. Confirmation that **your specific terminal model is cloud-capable** and mapped to your store. Older or basic terminals are not, and that answer changes the design (§5, trigger 2).
3. The **integration kit** — it carries the credential set (merchant, store and client identifiers plus a security token), the test and production endpoints, and the exact field names. The kit is the authority on those names; nothing here should be treated as final API shape.
4. A **test/UAT terminal or sandbox**, so this is not first exercised on a paying customer.

Two things to check while you are talking to them: whether the API is included in your current rate or priced separately, and whether an integrated transaction settles on the same cycle as a manual one.

## 8. Open questions

- **Q1** — Razorpay at the counter: is the QR answer the existing customer-phone checkout (assumed), or a dynamic-QR standee at the till? §3.
- **Q2** — Does the cafe want a **cash drawer** that opens on settle? It is the cheapest single trigger for the helper app, and worth knowing now rather than after the printer is mounted.
- **Q3** — On a terminal decline, should the order sit unpaid on the board, or drop back into the payment panel for another tender? (Recommend: back to the panel — the customer is standing there.)
- **Q4** — Tips on the terminal: supported by most Plutus flows. Out of scope unless wanted, and it changes the amount the terminal reports back versus the order total, which the reconciliation in PAY7-4 has to expect.
