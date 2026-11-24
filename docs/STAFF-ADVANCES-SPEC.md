# Salary advances on the Payroll page

Product owner spec, 2026-11-24. Builds on the payroll section of
`docs/PHASE-5-SPEC.md` (PAY-2 to PAY-5) and replaces its decision D5-7 ("no
advance ledger, the owner tracks the running balance") for advances. The general
± adjustment stays as it is.

## The short answer

When a staff member takes part of their salary early, the owner notes it down on
**/owner/payroll**, inside that person's row:

- the **amount** in ₹,
- the **date** it was given,
- an optional **note** (for example "UPI, rent").

At month end the Payroll page takes every advance off what the person earned,
automatically, and shows the salary still to pay:

> Earned ₹18,000 − deductions ₹0 − advance ₹5,000 = **Net ₹13,000**

If the advances come to more than they earned that month, the month pays **₹0**
and the rest comes off the **next month on its own**. Nothing is lost and nothing
is taken twice. The payslip email shows the advance as its own line.

## Decisions (owner, 2026-11-24)

| Topic | Decision |
|---|---|
| Where advances are entered and seen | The owner **Payroll** page, inside each person's row. Not the Team page. |
| An advance bigger than the month's pay | The whole advance comes off automatically. Pay goes to ₹0 and the rest carries to the next month by itself. The owner does not choose an amount each month. |
| Where the money comes from | The owner pays it (UPI or cash) and records it. **No change at the counter** and no link to the cash drawer. |
| Who can see or enter advances | The owner account only, the same as the rest of Payroll. Managers and staff cannot. |

## What the owner sees

**The payroll table** gets an **Advance** column between Deductions and Net. It
shows what comes off this month (for example `−₹5,000`). When part of it carries
to next month, a small "₹3,000 to next month" sits under it. **Net** is the pay
after the advance.

The cards at the top gain **Advances this month** (the total taken off across
everyone). **Total payout** is after advances.

**Opening a person's row** shows a new **Advances** box above Deductions:

1. **Carried from earlier**, if any: one line with the amount still owed from
   previous months.
2. **This month's advances**: date, amount, note, and a **Remove** button for a
   mistake.
3. **Add advance**: amount (₹), date (today by default, never a future date) and
   a note. Press **Add**, and the row's numbers update at once.
4. One line that adds it up, for example:
   *Advance to take off ₹5,000 · taken this month ₹5,000 · to next month ₹0.*

The bottom line of the row then reads:

> Earned ₹16,000 − deductions ₹500 − advance ₹4,000 = **Net ₹11,500**

and the **Finalize** button shows that net.

**After finalizing**, the row shows the advance taken off and anything carried to
next month. It cannot be changed without reversing the month, the same as every
other number there.

**CSV export** gains two columns: *Advance deducted* and *Advance carried to next
month*.

**The payslip email** gains:
- *Salary advance −₹5,000*
- and, when some carries over, *Advance still to recover next month: ₹3,000*.

## Worked examples (₹)

1. **A normal month.**
   - Monthly salary ₹18,000, full attendance in November: earned **₹18,000**.
   - Advances: ₹3,000 on 8 November and ₹2,000 on 20 November, so **₹5,000**.
   - **Net ₹13,000.**
2. **An advance bigger than the month's pay.**
   - Joined on 15 November, earned **₹9,000** in November.
   - Advance of ₹12,000 on 16 November.
   - November: ₹9,000 comes off, **net ₹0**, **₹3,000 carries** to December.
   - December: earned ₹18,000, the ₹3,000 comes off, **net ₹15,000**.
3. **With a deduction you ticked.**
   - Earned **₹16,000**. You tick an approved cash shortage of **₹500**.
   - Advance **₹4,000**.
   - **Net ₹11,500.**
4. **An advance noted after the month was finalized.**
   - November is already finalized and paid. You then remember a ₹1,000 advance
     from 28 November and add it.
   - November stays as it was paid. The ₹1,000 shows as *carried from earlier* on
     December and comes off December's pay.

## Rules that keep it safe

- **Money already given always comes back exactly once.**
  - What is still owed is worked out fresh each time: all advances dated up to
    the end of the month, minus every advance already taken off in a finalized
    month.
  - **Reversing** a finalized month gives its advance back to the balance, so it
    is taken off again when the month is finalized again. It is never lost and
    never taken twice.
- **Order of the maths.** Earned pay first, then the deductions you ticked (late
  marks, cash shortage), then the advance out of what is left. Late marks and
  cash shortages are not carried forward today, but advances are, so taking the
  advance last means nothing you are owed is dropped.
- **No negative pay.** Net never goes below ₹0. Whatever the month cannot cover
  is carried.
- **Locked once paid.** An advance cannot be removed once a month on or after
  its date has been finalized for that person, because it has already been taken
  off their pay. Reverse that month first. A removed advance is kept on record,
  marked removed, with who removed it and when.
- **Mistake guards.** Whole rupees only, from ₹1 to ₹1,00,000 per entry, never a
  future date. A larger amount can be entered as two entries.
- **Owner only.** The advances list and the routes that change it check for the
  owner account on every request, like the rest of Payroll. The new table is
  closed to the browser entirely (the same lock as the payroll tables).
- **Frozen with the month.** Finalizing records the advance taken off, the
  amount carried, and which advances were counted, next to the rest of that
  person's frozen month.

## Out of scope

- Staff taking an advance from the **counter cash drawer**. Counter staff see no
  change.
- Choosing how much of an advance to take off each month (instalments).
- Showing advances on the **Team** page.
- Staff seeing their own advance balance anywhere except their payslip email.
- Loans with interest, and any other kind of adjustment.

## Steps that are the owner's

1. **Database.** Run the new SQL file (to be added in `supabase/`) on **Hioc
   India** in the Supabase SQL editor **before** the new code goes live. The
   Payroll page needs it.
2. **Advances already given this month.** Once it is live, add them on the
   Payroll page with their real dates, so November's pay comes out right.
3. **Staff.** Nothing changes at the counter. You may want to tell staff that
   their payslip will now show advances as a separate line.

## For the engineers

- **database-engineer:**
  - a `staff_advances` table: who, amount, date given, note, who added it,
    removed at / by;
  - `payroll_run_lines.advance_inr`;
  - RLS on with no policies, plus the explicit REVOKEs used by the payroll
    tables;
  - kept honest in `scripts/verify-db.mjs`.
- **web-engineer:**
  - the advance step in `lib/payroll/compute.ts` (pure, with tests for the four
    examples above and for reversal);
  - outstanding balance and freezing in `app/api/owner/payroll/route.ts`;
  - an owner-only route to add and remove advances;
  - the Advances box, column and stat in `components/owner/PayrollScreen.tsx`;
  - the payslip line in `lib/payroll/payslipEmail.ts`;
  - the CSV columns.
