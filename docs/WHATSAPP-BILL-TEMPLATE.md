# WhatsApp bill template — `order_bill_1` submission guide

**Companion to:** `docs/PHASE-4-SPEC.md` §7 (blocking input I3), `lib/notifications/templates.ts`, `lib/notifications/adapters.ts`
**Date:** 2026-08-05
**Purpose:** Everything needed to create and submit the WhatsApp bill template so `sendBillNotification` can actually deliver. The code path is complete; this template is the only thing missing.

> **Supersedes** the draft copy in `PHASE-3-SPEC.md` RCT-1. That draft was a single paragraph ending in `{{6}}` — a **parameter at the end of the body is one of Meta's standard rejection reasons**. The copy below carries the same six facts in the same order and avoids it.

---

## 1. Where

Meta Business Suite → **WhatsApp Manager** → **Message templates** → **Create template**.

## 2. Template settings

| Field | Value | Why it must be this |
|---|---|---|
| **Name** | `order_bill_1` | Must match `WHATSAPP_TPL_BILL` exactly. Lowercase, digits, underscores only. A name mismatch is a **silent** failure — the send fails at Meta and nothing in the app surfaces it today. |
| **Category** | **Utility** | A bill is transactional. Marketing category is throttled, subject to marketing opt-out, and wrong for a receipt. |
| **Language** | **English** → code `en` | Must match `WHATSAPP_TPL_LANG` (code defaults to `en`). If you pick "English (US)" you get `en_US` and every send fails. |

## 3. Header — pick one

**Recommended: Image** (matches the branded bill work in commits `198c290` / `9556459`; the asset is ready).

Upload `public/images/whatsapp-bill-header.png` — generated for this, 1200×628 (WhatsApp's 1.91:1), the wordmark on the brand `#f6efe9` background, **flattened with no alpha channel** so it can't disappear against WhatsApp's dark theme the way the transparent `logo-black.png` would.

> ⚠️ **If you choose an image header, `WHATSAPP_TPL_BILL_HEADER_IMAGE` becomes mandatory, not optional.** A template that declares an IMAGE header requires the header parameter on *every* send — omit it and Meta rejects the message. The env-var comment in `adapters.ts:22-26` describes the other direction (don't send a header the template doesn't declare); both traps are real.

**Lower-risk alternative: Text** — header text `Your HIOC bill`, no variables. Nothing extra to configure, nothing to host. Choose this if you want the fewest moving parts.

**Note either way:** changing a template's header later requires an edit and **re-approval**. Decide now rather than after go-live.

## 4. Body — copy-paste exactly

```
Hi {{1}}, here is your bill from HIOC.

Order: {{2}}
Total: ₹{{3}} for {{4}} item(s)
Paid by: {{5}}

Itemised receipt: {{6}}

Thank you for visiting. This is a payment receipt for your records.
```

The six variables map to `templateVarsFor(order, 'bill')` (`lib/notifications/templates.ts:122-136`):

| Var | Meaning | Example value the code sends |
|---|---|---|
| `{{1}}` | Customer first name (falls back to `there`) | `Ayush` |
| `{{2}}` | Order number, already formatted | `HIOC-001001` |
| `{{3}}` | Total in ₹, bare number (the `₹` is static in the template) | `480` |
| `{{4}}` | Item count | `3` |
| `{{5}}` | Payment method (`Cash`/`UPI`/`Card`/`Online`/`counter`) | `UPI` |
| `{{6}}` | Absolute receipt link | `https://hioc.in/order/<uuid>/receipt` |

> **Do not put a `#` before `{{2}}`.** `formatOrderNumber` already returns `HIOC-001001`, so `#{{2}}` would render `#HIOC-001001`. The comment at `templates.ts:126` ("the template literal supplies the '#'") predates that format and is stale — worth a one-line comment fix, no code change.

## 5. Footer (optional)

`This is an automated receipt from HIOC.` — 39 chars, under Meta's 60. No variables allowed in footers.

## 6. Buttons — **none**

Do not add buttons. The adapter sends only `header` (optional) + `body` components (`adapters.ts:99-119`). A template with a **dynamic URL button** requires a button parameter on every send, and every send would fail. A static URL button would work but duplicates `{{6}}` pointlessly.

## 7. Sample values for review

Meta requires a sample of every variable before it will accept the submission:

```
{{1}}  Ayush
{{2}}  HIOC-001001
{{3}}  480
{{4}}  3
{{5}}  UPI
{{6}}  https://hioc.in/order/8f14e45f-ceea-4e0a-9f2b-3c1a7b2d5e60/receipt
```

For an image header, upload the same banner file as the sample.

## 8. Why this copy passes review

| Meta rejection reason | How this copy avoids it |
|---|---|
| Parameter at the **beginning or end** of the body | Starts with `Hi `, ends with a full static sentence |
| **Adjacent** parameters (`{{3}} {{4}}`) | Every pair is separated by static text (`for`, `item(s)`, line breaks) |
| Parameters **not sequential** | They appear in the body in exact order 1→6, matching the array the code sends |
| **Miscategorised** as Marketing | Purely transactional wording; no offers, no CTA to return, and the closing line names it a payment receipt |
| Variable count mismatch at send time | Exactly 6, matching `templateVarsFor` |

## 9. After approval — environment

Vercel → Project → **Settings → Environment Variables** (Production *and* Preview), then **redeploy** (env changes don't apply to existing deployments):

```
NOTIFY_PROVIDER=whatsapp
WHATSAPP_TOKEN=<permanent System User token>
WHATSAPP_PHONE_ID=<Phone number ID — NOT the WABA id or App id>
WHATSAPP_TPL_BILL=order_bill_1
WHATSAPP_TPL_LANG=en
NEXT_PUBLIC_SITE_URL=https://hioc.in
# only if you chose the image header:
WHATSAPP_TPL_BILL_HEADER_IMAGE=https://hioc.in/images/whatsapp-bill-header.png
```

`NEXT_PUBLIC_SITE_URL` is not cosmetic — without it `{{6}}` renders as a broken relative path.

For local dev, uncomment the same keys in `.env.local` (all four WhatsApp vars are currently commented out there).

## 10. Verifying it actually works

1. **Template status is `APPROVED`** in WhatsApp Manager — not `PENDING`, `REJECTED`, `PAUSED` or `DISABLED`. Approval is typically minutes to ~24 h for Utility.
2. Confirm the banner is publicly reachable: `curl -I https://hioc.in/images/whatsapp-bill-header.png` → `200`. Meta's servers fetch it at send time.
3. Place a test order with **your own number**, then settle it — and note the current limitation:

   > **Until Phase-4 BILL-1 ships, paying at the POS does not send the bill.** The bill fires only on `status → 'completed'`. To test today: settle the order, then open it in the staff queue and **mark it Completed**.

4. Check the delivery log in Supabase:
   ```sql
   select event, channel, status, provider_ref, error, attempts, sent_at
   from notifications
   where event = 'bill'
   order by id desc
   limit 5;
   ```
   - `status='sent'` with a `provider_ref` → Meta accepted it.
   - `status='failed'` → the `error` column carries Meta's own message (e.g. template name/language mismatch).
   - **No row at all** → the channel was skipped before any send: a missing env var or no `customer_phone` on the order. This silent-skip case is exactly what Phase-4 BILL-3 makes visible.

5. The WhatsApp webhook already reconciles `delivered` / `read` / `failed` back onto that row, so re-running the query a minute later shows the real delivery outcome.

---

## Appendix — creating it via the API instead

The template can also be created with `POST /{WABA_ID}/message_templates` (name, language, category, components) rather than the UI. Worth it only if you expect to manage several templates or want it in version control — the UI is faster for one. Ask and I'll write the script.
