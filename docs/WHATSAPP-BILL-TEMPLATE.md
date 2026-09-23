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

## 11. The re-runnable audit — `npm run verify:notifications`

Sections 12–14 below are the three Meta-side causes of "the bill never arrives" that **no amount of reading our own code can detect**: the send is accepted, a message id comes back, the delivery row says `sent`, and the phone stays silent. Because they are invisible from inside the app, they are checked from outside it by a script rather than left as a checklist someone did once:

```bash
npm run verify:notifications                      # audit this environment
npm run verify:notifications -- --strict          # pre-deploy gate: skips and warnings fail too
npm run verify:notifications -- --send-test +919876543210   # ONE real message
```

It prints, per channel, which adapter will actually run and *why*; every required variable as set/missing (secrets as length + last 4 only, never the value); and, from the Graph API, the token's validity and expiry, the live `status` and `category` of the template named in `WHATSAPP_TPL_BILL`, its parameter shape, and whether the header image is fetchable.

| Exit | Meaning |
|---|---|
| `0` | Nothing is broken **and** the environment's intent matches its reality. An unconfigured laptop exits 0 and says `NOT CONFIGURED`. |
| `1` | Genuine misconfiguration: invalid/expired token, template missing / not APPROVED / not UTILITY, wrong parameter shape, unreachable header image, a `--send-test` that Meta refused *or that could not be performed*, or — the check that matters most — `NOTIFY_PROVIDER=whatsapp` in an environment that **cannot actually deliver a bill** (missing credentials, or `WHATSAPP_TPL_BILL` unset). |
| `2` | The script itself could not run (bad arguments, crash). |
| `3` | **INCOMPLETE.** Nothing that ran failed, but the Meta-side probes could not run — so the MARKETING-vs-UTILITY question in §13, the most likely cause of "the bill never arrives", is still open. Deliberately not `0`: unproven is not proven. Set `WHATSAPP_WABA_ID` and re-run. |

**A skip is never a pass — including at the verdict.** The distinction the script draws is between *"there is nothing to check here"* (a laptop with no credentials: `SKIPPED`, exit 0) and *"the thing this script exists to check could not be checked"* (`COULD NOT VERIFY`, exit 3). Reading `RESULT: PASS` therefore means the bill path was actually proven, not merely that nothing objected.

Two variables exist only for this script and are never read by the app. `WHATSAPP_WABA_ID` is **effectively required in production** — see the exit-3 row above:

| Variable | What it unlocks | Where to find it |
|---|---|---|
| `WHATSAPP_WABA_ID` | The template probes (§13) — i.e. the MARKETING-vs-UTILITY answer. Without it the script tries to derive the WABA from the token's own granular scopes, which fails whenever `debug_token` does (common when a System User token inspects itself). It then reports `COULD NOT VERIFY` and exits **3** rather than pretending the template was checked. It is listed in `.env.local.example`. | WhatsApp Manager → **Account tools** → *WhatsApp Business Account ID* |
| `WHATSAPP_APP_ID` (+ the existing `WHATSAPP_APP_SECRET`) | A more reliable `debug_token` inspection (§12). Without them the script inspects the token with itself, which Meta allows for most — not all — System User tokens. | Meta for Developers → your app → **Settings → Basic** |

Run it against the **deployed** environment, not just a laptop: `vercel env pull .env.local` in a scratch checkout, or export the two variables into the shell (shell values win over `.env.local`, and the report names which source each value came from).

## 12. The token must be a permanent System User token

**The failure:** a token you generate by clicking around the Meta dashboard is a *user* token. It expires in **24 hours** (temporary) or **60 days** (extended). The day it dies, every send fails with `OAuthException code 190` — and before WA-1/WA-4 there was nothing in the product that said so. A cafe that "was working last month" and now isn't, with no deploy in between, is this.

**Which kind do I have?** `npm run verify:notifications` prints it:

- `token does not expire — expires_at=0` → permanent System User token. Correct.
- `expires_at=<number>` → a dashboard token with a countdown attached. The script names the exact date.

**Generating the permanent one:**

1. **business.facebook.com/settings** → **Users → System users** → **Add**. Name it for the job (`hioc-whatsapp-sender`) and give it the **Admin** role.
2. **Add assets** → assign the **WhatsApp Business Account** (the WABA, not the phone number) with **Full control**, and the **App** the Cloud API is registered under. A token whose system user owns no assets authenticates fine and can send nothing.
3. **Generate new token** → pick the app → **Token expiration: Never** → tick the scopes:
   - `whatsapp_business_messaging` — sending. Without it every send is refused.
   - `whatsapp_business_management` — reading templates. Without it §13's checks can't run.
4. **Copy it now.** Meta shows the value exactly once and will not show it again.
5. Vercel → **Settings → Environment Variables** → `WHATSAPP_TOKEN` for **Production *and* Preview** → **Redeploy**. Environment changes do not reach an existing deployment.
6. Confirm: `npm run verify:notifications` → `✓ token does not expire`.

> **Do not delete the system user, and do not remove its WABA asset.** Both revoke the token instantly, and the symptom is silence, not an error anyone sees. To rotate: generate the new token, update the env var, redeploy, *then* revoke the old one — in that order.

## 13. The category must be UTILITY — and the status APPROVED

**The failure, and why it is the prime suspect:** a bill template categorised **MARKETING** is subject to Meta's per-recipient **marketing limits** and to marketing opt-out. Meta **accepts** the send, returns a message id, our row logs `sent` — and the message is dropped before it reaches the handset. There is no error anywhere. This is the exact shape of "the customer never gets the bill while the log looks fine".

**This is not a one-time setup step.** Meta periodically **re-categorises templates on its own** based on how the content reads. A template approved as Utility in July can be Marketing in September with nobody having touched it, which is why §11's script exists and why it is worth re-running whenever bills go quiet.

**Checking:** `npm run verify:notifications` prints the live values fetched from Meta:

```
✓ template 'order_bill_1' is APPROVED             — live status from Meta: APPROVED
✗ template 'order_bill_1' is categorised UTILITY  — live category from Meta: MARKETING …
```

Or by hand: WhatsApp Manager → **Message templates** → the **Category** and **Status** columns.

**Fixing a MARKETING categorisation:**

1. WhatsApp Manager → **Message templates** → the template → **⋯ → Edit** → **Category: Utility** → **Submit**.
2. It re-enters review (minutes to ~24 h for Utility). **The currently approved version keeps sending while the edit is in review** — you are not dark in the meantime.
3. If Meta refuses, the body copy is reading as promotional. §4's copy is written specifically to avoid that: no greeting-for-its-own-sake, no offer, no invitation to return, and a closing line that names the message a payment receipt. Anything resembling a nudge to buy again re-triggers the classification.
4. **Appeal** is available once per template (template → **Appeal**). If the appeal fails, create a **new** template — `order_bill_2` with the §4 copy — get it approved as Utility, then point `WHATSAPP_TPL_BILL` at the new name. That is an environment-variable change plus a redeploy; **no code changes**, because the name is read from env everywhere.
5. **File it the same day you find it.** Approval queues are external clocks; nothing else in the phase waits on this one.

**Statuses other than APPROVED, and what they mean:**

| Status | What is happening | What to do |
|---|---|---|
| `PENDING` | In review. | Wait; sends fail until it clears. |
| `REJECTED` | Copy or category was refused. | Fix per §8/§4 and resubmit; `rejected_reason` is printed by the script. |
| `PAUSED` | Quality dropped — recipients blocked or reported the messages. | Sending is suspended for a period; fix the content or the sending pattern. It escalates to `DISABLED` if it repeats. |
| `DISABLED` | Permanently off. | A new template is the only route. |

## 14. The header image must be fetchable by *Meta's* crawler

Only relevant if you chose the **image** header in §3 — and if you did, `WHATSAPP_TPL_BILL_HEADER_IMAGE` is **mandatory on every send**, not optional.

The URL is fetched by **Meta's servers at send time**, not by the customer's phone. So it must be:

- **`https://`** — plain http is refused;
- **publicly reachable with no credentials** — this is the trap that costs the most time: a Vercel **preview** deployment sits behind Deployment Protection and answers a *login page* with HTTP 200 and `content-type: text/html`. In your logged-in browser the URL looks perfect. Meta gets the login page and rejects the send with a media error. Always test in a private window, or with `curl`;
- **an actual image** — `image/png` or `image/jpeg`, under **5 MB**;
- **stable** — Meta re-fetches it; do not point at a URL that rotates.

```bash
curl -sSI https://hioc.in/images/whatsapp-bill-header.png | head -3   # want: 200, content-type: image/png
```

`npm run verify:notifications` performs exactly this check (HEAD, falling back to a ranged GET for handlers that refuse HEAD) and fails on a non-image content type, a private/localhost host, or a non-200.

> **The mirror-image trap.** If the approved template's header is **TEXT or absent**, `WHATSAPP_TPL_BILL_HEADER_IMAGE` must be **unset** — the adapter attaches an image header whenever the variable is set, and Meta rejects a header component the template never declared. Both directions break every send, and the script fails on both, because it compares the variable against the header the **live template actually declares**.

---

## Appendix — creating it via the API instead

The template can also be created with `POST /{WABA_ID}/message_templates` (name, language, category, components) rather than the UI. Worth it only if you expect to manage several templates or want it in version control — the UI is faster for one. Ask and I'll write the script.
