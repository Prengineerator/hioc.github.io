# Phase 5 add-on — Cash counted at every clock-in and clock-out

Status: **BUILT** (2026-09-23). Branch `phase-5-attendance-payroll`.

## Why

The drawer is counted only at day open/close, coins are one lump ₹ figure, and
nothing ties a shortage to a person. Money that goes missing mid-day is nobody's.

## Owner decisions (2026-09-23)

| # | Decision |
|---|----------|
| CC-D1 | The **employee** counts the drawer by denomination at **clock-in and clock-out**; the punch is refused without it. |
| CC-D2 | Every denomination is counted: ₹500, 200, 100, 50, 20, 10, **5, 2, 1** (coins no longer a lump sum). |
| CC-D3 | A shortage is charged to the **person whose count revealed it**. |
| CC-D4 | Shortages go to the owner: **approve → payroll deduction**, waive, or **reassign** to another staffer. |
| CC-D5 | A **manager/owner can excuse one count** with a mandatory reason; logged and visible to the owner. |

Defaults chosen by the lead (owner can change):
- `cash_count_required` is **off** until the owner switches it on (Attendance settings).
- Tolerance **₹0** (configurable). Within tolerance: recorded, no shortage. Beyond it: the whole shortfall is charged.
- Per-staffer **handles cash** switch (default on) so kitchen staff aren't forced to count.
- **Cash-out / cash-in** entries (manager/owner, reason required) for bank deposits, petty expenses, top-ups — otherwise a deposit reads as a shortage.
- Overage is recorded and shown, never charged.

## The chain

Every count (clock-in, clock-out, day open/close, manual) is a checkpoint:

```
expected = previous counted + cash settled − cash refunded − cash out + cash in   (since previous count)
variance = counted − expected
```

The first-ever count has no previous → baseline (no variance). An override is a
checkpoint with nothing counted; the chain skips it (the next real count compares
to the last real count). Cash settled/refunded use the same cash rules as the
cash-day close (split parts, cash-only refunds), windowed by time.

Data: `supabase/2026-09-cash-counts.sql` — `cash_counts`, `cash_movements`,
`cash_count_overrides`, `cash_shortages`, `payroll_run_lines.cash_shortage_inr`,
settings columns, `staff_accounts.handles_cash`. Contract: `lib/cash/counts.ts`.

## Build (parallel, by file ownership)

| Ticket | Files |
|---|---|
| CC-1 migration, denominations, contract | lead (done) |
| CC-2 engine + punch enforcement + overrides + movements APIs | `lib/cash/checkpoints.ts`, `app/api/attendance/**`, `app/api/cash-counts/**`, `app/api/cash-movements/**`, `app/api/cash-days/**` |
| CC-3 staff UI: count sheet on punch, override + cash-out for managers, 9-row grid | `components/staff/*` (AttendancePunch, CashDayDenomGrid, CashDayManager, new CashCountSheet/CashOverridePanel/CashMovementForm), `app/staff/attendance`, `app/staff/cash` |
| CC-4 owner: shortages review, count log, settings, handles-cash | `app/owner/cash/**`, `app/api/owner/cash-*/**`, `components/owner/cash/**`, AttendanceSettingsPanel + settings API, team EditStaffModal + staff PATCH, OwnerHeader link |
| CC-5 payroll: approved shortages deducted at finalize, on payslip | `app/api/owner/payroll/**`, `lib/payroll/**`, `components/owner/PayrollScreen.tsx` |

## Deploy

1. Apply `supabase/2026-09-cash-counts.sql`; `npm run verify:db`.
2. Deploy (feature stays off).
3. Owner: mark non-cash staff, set tolerance, switch **Cash count at clock-in/out** on.

## Known limits

- **Shortage larger than a month's pay:** net pay clamps at ₹0 and the screen flags it; the remainder is not carried to next month.
- **Two counts in the same instant** can chain off the same previous count (no DB lock). Rare at one drawer; the owner review step catches an odd pair.
- **Settle time** comes from `orders.paid_at` (set once by trigger), not `updated_at` — a later status change must never move cash into a later window.
