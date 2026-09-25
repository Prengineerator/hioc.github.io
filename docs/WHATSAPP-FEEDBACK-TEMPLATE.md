# WhatsApp feedback template — `order_feedback_1` submission guide

**Companion to:** `lib/notifications/templates.ts`, `lib/notifications/adapters.ts`, `lib/feedback/payload.ts`, `app/api/cron/feedback-requests/route.ts`, `app/api/webhooks/whatsapp/route.ts`
**Purpose:** Everything needed to create and submit the post-order feedback template in Meta Business Manager so the 30-minutes-after-completion send can actually deliver. The code path — the cron, the button handling, the web feedback page, the owner inbox — is complete; this template (and, separately, the webhook signing secret below) are the two things missing before any of it reaches a customer.

---

## Before this works at all: `WHATSAPP_APP_SECRET`

**`WHATSAPP_APP_SECRET` is not set in production today.** `app/api/webhooks/whatsapp/route.ts` verifies every inbound request's HMAC signature against it and fails **closed** — no secret configured means every POST (delivery-status callbacks *and* the customer's replies) is rejected with 401 and nothing is written. This is not new to the feedback feature: the delivery-status webhook has had the same gap since it shipped. The feedback feature just means more now depends on it — a customer tapping "Loved it" or typing "STOP" silently bounces off until an operator sets this.

Set it from **Meta App → Settings → Basic → App Secret**, as the `WHATSAPP_APP_SECRET` environment variable on the deployment. Nothing else in this document works without it.

---

## 1. Where

Meta Business Suite → **WhatsApp Manager** → **Message templates** → **Create template**.

## 2. Template settings

| Field | Value | Why it must be this |
|---|---|---|
| **Name** | `order_feedback_1` | Must match `WHATSAPP_TPL_FEEDBACK` (env override; defaults to `order_feedback_1` — `lib/notifications/adapters.ts`). Lowercase, digits, underscores only. |
| **Category** | **Utility** | This is a receipt-adjacent follow-up about an order the customer just had, not marketing — Marketing category is throttled and subject to marketing opt-out, which would silently stop reaching anyone who ever opted out of promotions. |
| **Language** | **English** → code `en` | Must match `WHATSAPP_TPL_FEEDBACK_LANG` if set, else `WHATSAPP_TPL_LANG`, else `en` (same per-event fallback chain the other templates use). Choosing "English (US)" yields `en_US` and every send fails with Meta's `#132001`. |
| **Header** | **None** | Deliberately no header — the adapter never sends a header component for this template, and adding one in Meta would make it mandatory on every send. |

## 3. Body — copy-paste exactly

```
Hi {{1}}, thanks for ordering from HIOC! How was your order {{2}}?

Tap a button below, or rate it in more detail on our website.
```

**Variables:**

| # | Meaning | Example |
|---|---|---|
| `{{1}}` | Customer's first name (falls back to "there" if none on the order) | `Priya` |
| `{{2}}` | Order number, exactly as `formatOrderNumber` prints it — no extra `#` | `HIOC-001089` |

**Sample values for the submission form:** `Priya`, `HIOC-001089`.

Do not end the body on a variable — a trailing `{{n}}` is one of Meta's standard rejection reasons. This body doesn't.

## 4. Footer

```
Reply STOP to opt out
```

Required copy, not optional: the opt-out promise is what makes the Utility-category send acceptable, and `app/api/webhooks/whatsapp/route.ts` genuinely honours a reply of `STOP` or `UNSUBSCRIBE` (case-insensitive) by recording it in `whatsapp_opt_outs` and never asking that phone again.

## 5. Buttons — exactly four, in this order

| Index | Type | Label | Meaning |
|---|---|---|---|
| 0 | Quick reply | `😍 Loved it` | Rating 5 |
| 1 | Quick reply | `🙂 It was okay` | Rating 3 |
| 2 | Quick reply | `😞 Not happy` | Rating 1 |
| 3 | **URL** (dynamic) | `Rate your order` | `https://hioc.in/feedback/{{1}}` — the `{{1}}` here is the URL button's own variable, unrelated to the body's `{{1}}` |

**The labels must be typed exactly as shown, emoji included.** `lib/feedback/payload.ts`'s `ratingFromButtonText` matches these labels verbatim as a fallback for when a WhatsApp client sends the button's title instead of its payload — a label typo there means that fallback silently stops working (the primary path, matching the payload, still works either way).

**The URL button is dynamic, not static.** In the template builder, set the base URL to `https://hioc.in/feedback/` and mark the trailing segment as the **dynamic** `{{1}}` variable (**Website URL → Dynamic**). At send time, the adapter supplies a fresh, single-use token as that variable's value — a *static* URL button cannot carry a per-customer token at all, so this step isn't optional. Sample value for submission: any placeholder string, e.g. `abc123`.

**What happens on the send side** (no action needed here, described for context): `lib/notifications/engine.ts`'s `sendFeedbackRequestNotification` builds the four button components — quick-reply buttons 0–2 carry a `payload` of `fb:<feedback_request_id>:<rating>` (5/3/1 respectively — `lib/feedback/payload.ts`), and the URL button (index 3) carries the token as its `text` parameter, which Meta appends to the base URL you configured above.

## 6. After approval

1. Confirm the approved name and language match `WHATSAPP_TPL_FEEDBACK` / `WHATSAPP_TPL_FEEDBACK_LANG` (or leave both unset if you used the defaults — `order_feedback_1` / `en`).
2. Set `WHATSAPP_APP_SECRET` if you haven't already (see the top of this document) — without it, every button tap and reply is silently rejected.
3. Confirm the webhook is subscribed to the **`messages`** field (Meta App → WhatsApp → Configuration → Webhook) — this is the same subscription the delivery-status callbacks already use; nothing new to add there, just confirm it's on.
4. Optionally set `GOOGLE_REVIEW_URL` if you want an *environment variable* to override the Settings-page Google review link (Settings → Post-order feedback → Google review link, which defaults to `https://g.page/r/CVAlGTvqRc1fEBM/review`). Most operators won't need this — the Settings-page field is the normal way to change it.
5. Place a test order through to `completed`, or use the owner feedback inbox's "Resend feedback template" action on any existing thread, and confirm the message + buttons render as expected on a real phone.

## 7. Why a separate template from the bill/status ones

`order_bill_1`, `order_accepted`, `order_ready_1`, etc. are all plain body-only templates — none of them carries buttons, because none of them expects a structured reply. This one does, and Meta's button-component rules (`sub_type: quick_reply` vs `sub_type: url`, the dynamic-URL variable, the four-button cap) are specific enough that reusing one of the existing templates' shape wasn't an option even for a "just add buttons" change — hence its own name, its own env vars (`WHATSAPP_TPL_FEEDBACK[_LANG]`), and its own section in `lib/notifications/adapters.ts`'s `whatsappTemplateName`/`whatsappTemplateLang` maps.
