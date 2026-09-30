# WhatsApp marketing templates — submission guide

**Companion to:** `docs/MARKETING-AGENT-SPEC.md` §5, `docs/MARKETING-AGENT-SETUP.md` (step 4), `lib/marketing/types.ts` (`DEFAULT_TEMPLATES`), `lib/marketing/templates.ts`
**Date:** 2026-09-30
**Purpose:** Everything needed to create and submit the four WhatsApp templates the marketing agent sends, so the agent has approved copy to send. The agent, the dashboard and the send path are complete; these four templates (and, separately, the webhook signing secret below) are what is missing before a single customer can be messaged.

You create **four** templates. Each is created the same way; only the body differs. Section 3 has all four bodies ready to paste.

| Template name | Used by | Body starts with |
|---|---|---|
| `hioc_points_expiring_1` | Points expiring playbook | "Hi {{1}}, {{2}} of your HIOC reward points…" |
| `hioc_points_balance_1` | Points waiting playbook | "Hi {{1}}, you have {{2}} HIOC reward points…" |
| `hioc_winback_1` | Win-back stages 1, 2 and 3 (one template, three offers) | "Hi {{1}}, we've missed you at HIOC!…" |
| `hioc_offer_1` | Your own campaigns (Campaigns → New campaign) | "Hi {{1}}, {{2}} at HIOC!…" |

---

## Before this works at all: `WHATSAPP_APP_SECRET`

**Approved templates are not enough on their own.** `app/api/webhooks/whatsapp/route.ts` verifies the signature of every message WhatsApp sends us and rejects everything when `WHATSAPP_APP_SECRET` is not set. For marketing that means:

- a customer replying **STOP** or tapping **Stop promotions** is **not** recorded, so we could message someone who asked us to stop;
- a customer replying **START** to your QR code is **not** recorded, so nobody ever opts in;
- delivered / read receipts never arrive, so the dashboard cannot show delivery rates or measure lift.

Set `WHATSAPP_APP_SECRET` (Meta App → Settings → Basic → App Secret) on the Vercel deployment and subscribe the webhook to **both** the `messages` and `user_preferences` fields. Full steps: `docs/MARKETING-AGENT-SETUP.md`, step 3.

---

## 1. Where

Meta Business Suite → **WhatsApp Manager** → **Message templates** → **Create template**. Do this once per template, using the WhatsApp Business Account that owns the sending number (the same account the bill and feedback templates live in).

## 2. Template settings (the same for all four)

| Field | Value | Why it must be this |
|---|---|---|
| **Name** | exactly as in the table above, e.g. `hioc_winback_1` | Lowercase, digits and underscores only. The dashboard's default mapping uses these names (Playbooks → each card → WhatsApp message → *Template name*). A different name works too, as long as you type the same name into the dashboard. A mismatch is a failed send, not a warning. |
| **Category** | **Marketing** | See "Why Marketing" below. |
| **Language** | **English** → code `en` | The dashboard's *Language code* box defaults to `en` and must match. If you pick **English (US)** you get `en_US`, the template is then filed under a language the send does not ask for, and **every send fails with Meta error `#132001`** ("template name does not exist in the translation"). |
| **Header** | **None** | The agent never sends a header component. Adding one in Meta would make it mandatory on every send and every send would fail. |

### Why Marketing

A points reminder is only "Utility" when it is purely informational. As soon as a message nudges the customer to *do* something ("use them on your next coffee", "here's 10% off", "we've missed you"), it is Marketing, and Meta re-categorises a template it judges to be miscategorised, sometimes after approval and without telling you. We submit all four as Marketing from the start so nothing changes underneath us, and so the price we plan around (marketing rate plus 18% GST, about ₹1.02 a message) is the price we actually pay.

Marketing templates come with two obligations that the copy below already meets: an **opt-out on every message** (the footer and the "Stop promotions" button) and recipients who have **asked** for the messages (the agent only ever messages customers who opted in).

## 3. Body: copy-paste exactly

Paste each body exactly, including the apostrophe in `we've` / `Here's` and the `₹` sign. The dashboard keeps its own copy of the body for previews, and it must match what you submit here.

### `hioc_points_expiring_1`

```
Hi {{1}}, {{2}} of your HIOC reward points (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon!
```

| Var | Meaning | Sample value for Meta review |
|---|---|---|
| `{{1}}` | Customer's first name (falls back to `there`) | `Asha` |
| `{{2}}` | Points expiring | `80` |
| `{{3}}` | ₹ value of those points, bare number (the `₹` is in the body) | `80` |
| `{{4}}` | Date the oldest expiring points go | `5 Oct` |

### `hioc_points_balance_1`

```
Hi {{1}}, you have {{2}} HIOC reward points worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon!
```

| Var | Meaning | Sample value for Meta review |
|---|---|---|
| `{{1}}` | Customer's first name | `Asha` |
| `{{2}}` | Points balance | `120` |
| `{{3}}` | ₹ value of the balance, bare number | `120` |

### `hioc_winback_1`

```
Hi {{1}}, we've missed you at HIOC! Here's {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting!
```

| Var | Meaning | Sample value for Meta review |
|---|---|---|
| `{{1}}` | Customer's first name | `Asha` |
| `{{2}}` | The offer, worded by the agent. Reads as "10% off (up to ₹60) on orders above ₹150", "₹50 off on orders above ₹150" or "a FREE Cold Coffee with any order above ₹200" | `10% off (up to ₹60) on orders above ₹150` |
| `{{3}}` | The customer's own single-use code, locked to their phone number | `WBK7M3QX` |
| `{{4}}` | Last day the code works | `12 Oct` |

### `hioc_offer_1`

```
Hi {{1}}, {{2}} at HIOC! Enjoy {{3}} with code {{4}}, valid till {{5}}. See you soon.
```

| Var | Meaning | Sample value for Meta review |
|---|---|---|
| `{{1}}` | Customer's first name | `Asha` |
| `{{2}}` | The headline you type when you create the campaign (up to 60 characters) | `New hazelnut latte` |
| `{{3}}` | The offer, worded by the agent | `10% off (up to ₹60) on orders above ₹150` |
| `{{4}}` | The customer's own single-use code | `OFK7M3QX` |
| `{{5}}` | Last day the code works | `12 Oct` |

> **Order matters.** The blanks are filled in the order listed in the dashboard (Playbooks → *What fills each blank in the message*). The defaults already match the bodies above. If you ever reword a body so the blanks appear in a different order, reorder that list to match, or the wrong value lands in the wrong place.

## 4. Footer (all four)

```
Reply STOP to unsubscribe
```

25 characters, under Meta's 60. No variables are allowed in a footer. This is not optional copy: the webhook genuinely honours a reply of `STOP` (and `UNSUBSCRIBE`), records it in the consent ledger, and the agent never messages that number again.

## 5. Buttons (all four): exactly two, in this order

| Position | Type | Label | What it does |
|---|---|---|---|
| **1st** | **URL**, dynamic | `Order now` | Opens `https://hioc.in/r/{{1}}`, which records that the customer tapped and forwards them to the menu. |
| **2nd** | **Marketing opt-out** | `Stop promotions` | WhatsApp's own opt-out button. Tapping it opts the customer out of our marketing at once. |

**The URL button must be first.** The agent attaches each customer's private tracking token to the button at position 0. If "Stop promotions" came first, the token would land on the wrong button and every send would fail.

**Setting up the URL button.** In the template builder choose **Add button → Visit website**, set **URL type: Dynamic**, and enter the base URL `https://hioc.in/r/` (the `{{1}}` is added for you as the trailing variable). Sample value for review: `Xk3Q9aLm2PzB` (any 12 letters or digits will do), giving `https://hioc.in/r/Xk3Q9aLm2PzB`. That `{{1}}` belongs to the button and has nothing to do with the body's `{{1}}`.

**Setting up the opt-out button.** **Add button → Marketing opt-out**, label `Stop promotions`. Meta may show its own confirmation wording; leave it as Meta offers it.

If you would rather not track taps, you can leave the URL button out of a template. Then turn off **"Order now" button** for that template in the dashboard, or every send will fail: the message would carry a button the template does not have. The default is on, matching the templates above.

## 6. Rules these bodies follow (and how to keep to them if you edit)

| Meta rejection reason | How the copy avoids it |
|---|---|
| A variable at the **beginning or end** of the body | Every body starts with `Hi ` and ends with a full static sentence (`See you soon!`, `Your favourites are waiting!`). |
| **Adjacent** variables (`{{2}} {{3}}`) | Every pair is separated by words or punctuation. |
| Variables **not sequential** | They appear in the body in order 1, 2, 3… |
| **Too many variables for the amount of text** | Between three and five variables, in a full paragraph of text. |
| Sample value missing | Section 3 gives one for every variable; Meta will not accept the submission without them. |
| Variable value with a **newline, tab or a run of spaces** | The agent cleans every value before sending (line breaks and tabs removed, spaces collapsed, at most 100 characters, an empty value becomes `-`), so a long offer text or headline can't get a send rejected. |

If you reword a body, keep to the same rules. The dashboard warns you about the common mistakes (a variable at the start or end, two next to each other, a count that does not match) as you edit the preview text.

## 7. After approval: nothing to set in Vercel

Unlike the bill and feedback templates, **the marketing templates have no environment variables.** The template name and language live inside the dashboard, per playbook, so changing them never needs a redeploy.

1. In WhatsApp Manager, wait for each template to show status **Active** (Marketing templates usually clear in minutes to a few hours; allow up to a day). **Rejected** or **Paused** templates cannot be used.
2. Open `/owner/marketing` → **Playbooks**. Each card already has the default template name and language filled in. If you used the exact names above, there is nothing to change. If you used a different name, open the card → **Edit who, offer and message** → **Template name in WhatsApp Manager** → type it → **Save**.
3. On each card, press **Send test to my phone**. It sends one real message with sample values (name "Asha", a sample offer and code) to the phone number on your owner profile. (You can type a different number, but only one that has itself opted in to offers: a test is still a marketing message, so consent applies to it too. If your profile has no phone number, add one first.) Check on your phone that:
   - the text reads correctly and the sample values are in the right places;
   - **Order now** and **Stop promotions** both appear;
   - it arrives at all. If it does not, see the table below.
4. For `hioc_offer_1`, do the same from **Campaigns → New campaign**, step 4.

The test message costs one marketing message (about ₹1), is not counted as a campaign and does not use up your monthly budget. You can send 5 an hour.

## 8. If a test or a send fails

The dashboard shows Meta's own message on the failed row (Campaigns → open a campaign → *Reason* column). The usual causes:

| Meta code | What it means | Fix |
|---|---|---|
| `#132001` | Template name does not exist in that language. Almost always **`en` vs `en_US`**, or a typo in the name. | In WhatsApp Manager check the template's exact name and language code. In the dashboard set *Template name* and *Language code* to match. The language of an approved template cannot be changed; if it was created as English (US), either type `en_US` in the dashboard or create it again as English. |
| `#132000` | The number of variables does not match the template. | The list of blanks in the dashboard must have exactly as many entries as `{{n}}` in the approved body. |
| `#132012` | A variable or button parameter is in the wrong format. | Most often the URL button: it must be a **dynamic** URL and be the **first** button (section 5). |
| `131049` | Meta chose not to deliver this marketing message (its per-person limit across all businesses). **Not charged, not retried.** | Nothing to fix. If you see many, lower how often you message (Settings → days between messages). |
| `131050` | The customer tapped **Stop promotions**. | Nothing to fix. They are opted out automatically. |

Template **status** in WhatsApp Manager, and what to do:

| Status | Meaning | Action |
|---|---|---|
| `PENDING` | In review. | Wait. Sends fail until it clears. |
| `REJECTED` | Copy or category refused. | Read the reason in WhatsApp Manager, fix per section 6 and resubmit. |
| `PAUSED` | Quality dropped: too many customers blocked or reported the messages. | Sending is suspended for a while. Message fewer people less often, and check the offer is something customers want. It becomes `DISABLED` if it repeats. |
| `DISABLED` | Permanently off. | Create a new one with a new name (for example `hioc_winback_2`), then type the new name into the dashboard. No code change and no redeploy. |

Because these templates are Marketing already, Meta re-categorising a template does not change anything for us. That is the point of section 2.
