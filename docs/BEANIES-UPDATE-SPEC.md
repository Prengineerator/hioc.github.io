# Beanies update on WhatsApp

Product owner spec, 2026-11-27. Builds on `docs/MARKETING-AGENT-SPEC.md` and
takes the item "Utility-category transactional Beanies statements" off its
out-of-scope list (§11). Template mechanics follow
`docs/WHATSAPP-BILL-TEMPLATE.md`.

## The short answer

Every customer who earns Beanies on a café order gets one short WhatsApp
**account update**. It goes right after their bill, whether or not they ever
tapped "Yes, send me offers":

> Hi Asha, you earned 25 HIOC Beanies on order #1042. Your balance is 120
> Beanies, worth ₹120. The oldest of them expire on 5 Dec. Reply STOP to stop
> these updates.

It states facts only and does not invite the customer back. That keeps it a
WhatsApp **utility** message (about ₹0.14 each with GST), which may go to
customers who have not opted in to marketing. It needs no marketing switch and
no marketing consent. It stays dormant until Meta approves the new template and
its name is saved in Vercel.

The two **promotional** Beanies reminders that already exist ("your Beanies
expire soon", "you have Beanies waiting") stay for opted-in customers only. They
move from sending on their own to **Approve first**.

## Decisions (owner, 2026-11-27)

| Topic | Decision |
|---|---|
| Who gets a Beanies message without opting in | Every customer with a verified phone, as a plain account update after an order that earned Beanies. No "come back" wording. |
| Promotional Beanies reminders | Stay opted-in only. Each send waits for the owner's Approve on `/owner/marketing`. |

## What customers see

- **When:** once per café order that earns Beanies: dine-in, takeaway or web,
  including counter orders linked to an account by phone. It arrives right after
  the bill message, at the moment the order is completed and paid.
- **Who is skipped:**
  - orders that earn no Beanies (no account behind the order, or a bill with the
    ₹49 jar spend offer);
  - customers without a verified phone on their account;
  - anyone who has replied STOP to the café's WhatsApp.
- **The message:** template `hioc_beanies_update_1`, category **Utility**,
  English.

  ```
  Hi {{1}}, you earned {{2}} HIOC Beanies on order #{{3}}. Your balance is {{4}} Beanies, worth ₹{{5}}. The oldest of them expire on {{6}}. Reply STOP to stop these updates.
  ```

  | Var | Meaning | Sample |
  |---|---|---|
  | `{{1}}` | First name, or "there" | `Asha` |
  | `{{2}}` | Beanies earned on this order | `25` |
  | `{{3}}` | Order number | `1042` |
  | `{{4}}` | Balance after this order | `120` |
  | `{{5}}` | ₹ value of the balance, bare number | `120` |
  | `{{6}}` | Date the oldest unspent Beanies expire, IST, e.g. `5 Dec` | `5 Dec` |

  Meta does not allow a variable at the very start or end of a body, which is
  why the message ends on fixed text.

## What the owner sees

- Nothing new to switch on in `/owner/marketing`. This message is not part of
  the marketing agent: it uses no marketing budget, and turning marketing
  sending off does not stop it.
- Each send is recorded in the same delivery log as the bill, under the event
  `beanies`, so a failed or skipped send can be traced like a bill.

## Cost

About **₹0.14 per message** (Meta's utility rate ₹0.115 + 18% GST). For
example, 30 orders a day that earn Beanies cost about ₹4 a day, about ₹125 a
month. There is no cap. Only orders that earn Beanies trigger it, one message per
order.

## Out of scope

- Shop (Instant Coffee) orders. Their Beanies arrive on delivery, and the
  delivery log only takes café orders. Next, if wanted.
- Messages when Beanies are redeemed, reversed or expired.
- Changing the bill template itself (it is approved and working; it stays as is).
- Any change to who receives promotional messages. Those still need the
  customer's own "yes".

## Build notes (for the engineers)

- **Database** (`database-engineer`): one file,
  `supabase/2026-11-beanies-update.sql`, widening `notifications_event_check`
  to `accepted, ready, rejected, cancelled, bill, feedback, beanies`. It must
  keep `feedback`. `scripts/verify-db.mjs` probes it.
- **Send** (`orders-payments-engineer`): `earnForOrder` reports the Beanies it
  credited. The status route's after-response step sends the update after the
  bill only when that number is > 0. It reads the balance and the oldest
  unspent credit's expiry from the ledger (`lib/loyalty/expiry.ts` rules) and
  the phone only from the verified profile. It checks `whatsapp_opt_outs` and
  logs through `deliverAndLog`, so the send is idempotent per order. New
  `NotificationEvent` `'beanies'`; the template name comes from
  `WHATSAPP_TPL_BEANIES`, and the send is skipped with a logged reason while
  that is unset. Never throws, never delays the counter.
- Not gated on `NEXT_PUBLIC_FLAG_MARKETING` or `marketing_consent`. It is
  gated on the existing notifications flag and on the template name being set.

## The owner's steps

1. **Submit the template** in Meta WhatsApp Manager: name
   `hioc_beanies_update_1`, category **Utility**, language English, the body
   and samples above.
2. **Run the database file** in Supabase on **Hioc India** (SQL editor): the
   `supabase/2026-11-beanies-update.sql` file from the pull request.
3. **Once Meta approves**, add `WHATSAPP_TPL_BEANIES` =
   `hioc_beanies_update_1` in Vercel → hioc-in → Settings → Environment
   Variables (Production), then redeploy.
4. **Promotional reminders to Approve first:** `/owner/marketing` →
   Playbooks → *Beanies expiring* and *Beanies waiting* → mode **Review**
   → Save.

## Acceptance checks

1. A completed, paid café order that earns 25 Beanies, from a customer with a
   verified phone who never opted in, sends one `hioc_beanies_update_1` message
   with the six values filled in correctly, after the bill.
2. Completing the same order again, or resending the bill, sends no second
   Beanies message.
3. No message for: an order that earned nothing, the ₹49-jar bill, a customer
   who sent STOP, an account without a verified phone.
4. With `WHATSAPP_TPL_BEANIES` unset, nothing is sent and the log shows a skip
   with its reason. Marketing on or off makes no difference.
5. Lint, type check, tests and the security gate pass.
