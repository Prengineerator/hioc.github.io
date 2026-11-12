# State machines — where each lifecycle is defined

Every lifecycle in the app (a status column, a multi-field state, a job/run, or a
client-side flow) is declared in ONE pure module: its states, a transitions table,
and a `canTransition…`-style check returning `{ ok, code, message }`. Routes, SQL
callers and UIs import that module instead of re-stating the rule.

House rules (copy `lib/orders/stateMachine.ts` + `tests/stateMachine.test.ts`):

- **Every writer goes through the module**, and writes are compare-and-set:
  `.update(…).eq('status', from)` / `.in('status', allowedFroms)` / the `version`
  column, then check the returned row — zero rows is a 409 "it changed", never a
  silent success.
- **UI helpers are built on the table** (`canApprove(row)` etc.), so a button is
  offered exactly when the server would accept it.
- **Modules are client-safe** (no `server-only` imports) and unit-tested.
- Adding a state or a move: edit the module and its test first, then the
  writers. Several modules also pin themselves to the SQL CHECK constraint in a
  test, so a migration that adds a state fails a test until the module knows it.

## Money and orders

| Lifecycle | Module |
|---|---|
| Order fulfilment status (`orders.status`) | `lib/orders/stateMachine.ts` — incl. `OPEN_STATUSES`, `isDeadOrder`, ready → preparing only via add-items |
| Payment status (`orders.payment_status`), gateway ownership, settle / re-settle / comp / refund | `lib/orders/paymentStateMachine.ts` |
| Refund rows (`refunds.status`: pending → processed \| failed; pending resolved from Razorpay's `amount_refunded`) | `lib/orders/refundStateMachine.ts` |
| Razorpay `payments` row | `lib/payments/paymentRowStateMachine.ts` |
| Retry contract for amend / balance (`expected_version`) | `lib/orders/concurrency.ts` |
| Order-create idempotency keys (claimed / completed / stale) | `lib/orders/idempotency.ts` |
| Shop orders (`shop_orders.status` + Shiprocket / refund claims) | `lib/shop/status.ts` |
| Loyalty per-order ledger (none → redeemed → earned → reversed) | `lib/loyalty/orderLedger.ts` |
| Coupon / spend-offer redemption liveness | `lib/promotions/redemptionLiveness.ts` |
| Coffee pass (stored active / refunded / void; derived used_up / expired) | `lib/passes/stateMachine.ts` |
| Online settlement reports and sync runs | `lib/online-settlements/lifecycle.ts` |

## Staff operations

| Lifecycle | Module |
|---|---|
| Attendance session (+ approval) | `lib/attendance/sessionState.ts` |
| Employment record (current pay rate) | `lib/attendance/employmentState.ts` |
| Leave request | `lib/leave/state.ts` |
| Finalized-payroll month lock (shared by attendance, leave, shortages, employment) | `lib/payroll/lock.ts` |
| Payroll run | `lib/payroll/runState.ts` (+ shortage marking in `lib/payroll/shortages.ts`) |
| Cash shortage (pending → approved \| waived; consumed by payroll) | `lib/cash/counts.ts` |
| Cash day (open / closed / reopened; derived ended) | `lib/cash/dayState.ts` |
| Cash expense review | `lib/cash/expenses.ts` |
| Staff account activation (auth ban + role + account status) | `lib/staff/accounts.ts` (`classifyActivation`) |
| PIN lockout (compare-and-set on `failed_attempts`) | `lib/staff/pinAuth.ts` / `lib/staff/pinPolicy.ts` |
| PIN overlay (unlocked / locked — one lock path) | `components/staff/pin/overlayState.ts` |

## Catalog, inventory, marketing, messaging

| Lifecycle | Module |
|---|---|
| Menu change requests (+ `applied_at` confirmation) | `lib/menu/changeRequestStatus.ts` |
| Menu item availability (available / snoozed / sold out / out of stock) | `lib/menu/availability.ts` |
| Stock requests (store room + warehouse routes) | `lib/inventory/rules.ts` (`STOCK_REQUEST_TRANSITIONS`), phases in `lib/inventory/warehouse.ts` |
| Marketing campaigns and recipients | `lib/marketing/lifecycle.ts` |
| Marketing consent (ledger + opt-out row; `mayMarketTo` / `isOptedOut`) | `lib/marketing/consentState.ts` |
| Notification delivery ladder + writer rules (claim / finish / skip / resend / receipt) | `lib/notifications/status.ts` |
| Feedback request delivery | `lib/feedback/deliveryState.ts` |
| Feedback thread (open / in_progress / resolved; reopen on inbound) | `lib/feedback/threadState.ts` |

## Client flows

| Flow | Module |
|---|---|
| Staff print queue and dock (shell-level; per-printer × copy targets) | `lib/pos/printQueue.ts`, `lib/pos/printDock.ts` |
| Ordered saves (printer settings) | `lib/staff/saveQueue.ts` |
| Order detail modal (panel + the one request in flight) | `components/staff/orderDetailState.ts` |
| Staff money/line writes (`expected_version`, no blind retry) | `components/staff/submitMachine.ts`, `components/staff/orderWrite.ts` |
| Cash forms' retry safety (client-named row id) | `lib/cash/clientRowId.ts` |
| Customer order placement (Idempotency-Key per attempt) | `components/checkout/placement.ts` |
| Order page actions (retry / switch / cancel are exclusive) | `app/order/[id]/orderPageState.ts` |
| Shop checkout after an unverified payment | `components/shop/shopCheckout.ts` |
| Ritual purchase: no second sale while the first may be paid | `components/passes/ritualSaleGuard.ts` |
| Phone OTP and login | `lib/hooks/phoneOtpMachine.ts`, `app/login/loginFlow.ts` |
| Newest-response-wins refetches | `lib/hooks/requestSequence.ts`, `components/staff/latestRequest.ts` |
| Cart across tabs | `lib/cart/cartStorage.ts` |

## Database side (optional migrations)

The app works without these; each adds a database-level guard the TypeScript
path already enforces. Apply in any order.

- `supabase/2026-11-order-payments-state-machine.sql` — `guard_refund_total` locks
  the order row and counts pending refunds against the cap (keeps the
  `search_path` pinned by `2026-09-security-advisor-fixes.sql`).
- `supabase/2026-11-peripheral-money-state-machine.sql` — one earn / redeem /
  reverse loyalty row per order (unique indexes, skipped with a NOTICE where
  duplicates already exist); no Ritual pass issued on a cancelled or rejected sale.
- `supabase/2026-11-menu-inventory-state-machine.sql` —
  `menu_change_requests.applied_at`; `inventory_pick` / `inventory_receive`
  refuse requests from another route.
