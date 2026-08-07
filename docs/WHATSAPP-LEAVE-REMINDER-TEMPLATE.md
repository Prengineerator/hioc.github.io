# WhatsApp leave reminder — `leave_plan_reminder_1` submission guide

**Companion to:** `docs/PHASE-5-SPEC.md` §7b (D5-13), `app/api/cron/leave-reminders/route.ts`, `lib/notifications/adapters.ts`
**Date:** 2026-08-07
**Purpose:** Everything needed to submit the leave-reminder template so the scheduled nudge can actually send. **The cron already runs**, on the schedule below; it just logs a `skipped` row with the reason instead of sending. This template is the only thing missing.

> **Start this early if you want it at all.** Meta review typically takes hours but can run to days, and a rejection costs another round trip. Nothing else in Phase 5 is blocked on it — the in-app banner carries the job in the meantime — so this is entirely at your convenience.

---

## 1. Is it worth doing?

Honest answer: **only if staff are missing the deadline.**

The in-app banner already reaches everyone who opens the staff portal, and staff open it every shift to see the order board. WhatsApp adds reach to people who are *off* on the day the window is closing — which is exactly the group most likely to forget, so it is not nothing. But if the banner turns out to be enough, this is avoidable work and an avoidable ongoing message cost.

**Suggested:** run the banner alone for two or three weeks. If you find yourself chasing people by hand anyway, submit this.

---

## 2. Where

Meta Business Suite → **WhatsApp Manager** → **Message templates** → **Create template**.

## 3. Template settings

| Field | Value | Why it must be this |
|---|---|---|
| **Name** | `leave_plan_reminder_1` | Must match `WHATSAPP_TPL_LEAVE_REMINDER` exactly. Lowercase, digits, underscores only. A name mismatch fails at Meta on every send. |
| **Category** | **Utility** | This is an operational message to your own staff about a scheduling deadline, not marketing. Picking Marketing would subject it to marketing opt-out — meaning a staffer who once opted out of promotions would silently stop receiving work reminders. |
| **Language** | **English** → code `en` | Must match `WHATSAPP_TPL_LANG` (defaults to `en`). Choosing "English (US)" yields `en_US` and every send fails. |
| **Header** | **None** | Deliberately no header. A reminder is a one-line prompt; an image header would mean hosting an asset and would make `_HEADER_IMAGE` mandatory on every send, which is the trap the bill template hit. |

## 4. Body — copy-paste exactly

```
Hi {{1}}, please plan your day off for the week starting {{2}}.

Requests close on Saturday night. Open the staff portal to pick your day — your manager approves it before the week starts.
```

**Variables:**

| # | Meaning | Example |
|---|---|---|
| `{{1}}` | Staff first name | `Ravi` |
| `{{2}}` | The Monday the week starts, formatted | `10 Aug` |

**Sample values for the submission form** (Meta requires these, and rejects templates whose samples don't parse): `Ravi`, `10 Aug`.

> **Do not end the body on a variable.** A trailing `{{n}}` is one of Meta's standard rejection reasons — which is why the closing sentence carries no parameters.

## 5. Manager variant — do you need a second template?

The cron distinguishes two audiences: staff who haven't planned (`staff_submit`) and managers with undecided requests (`manager_decide`).

**Recommendation: submit only the staff template first.** The manager is one or two people who are in the portal constantly and already see the banner. A second template doubles the review surface for the smallest audience. If you do want it later:

```
Hi {{1}}, {{2}} leave requests are waiting for your decision for the week starting {{3}}.

Please review them before Saturday night so the roster is settled.
```

Name it `leave_decide_reminder_1` and it will need its own env var.

## 6. After approval

1. Set `WHATSAPP_TPL_LEAVE_REMINDER=leave_plan_reminder_1` in Vercel (Production **and** Preview).
2. Confirm `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are already set — they are, since the bill sends.
3. Make sure staff have phone numbers on `profiles.phone`. The cron logs `no phone number on the staff profile` per person otherwise, which is visible in `leave_reminder_log`.
4. Wire the send itself. **This is a code change, small but real** — `app/api/cron/leave-reminders/route.ts` currently computes the skip reason where the send belongs; the adapter call goes exactly there, and the row's `status` becomes `sent`.
5. Verify: `select kind, status, skip_reason, count(*) from leave_reminder_log group by 1,2,3;`

## 7. Schedule (already live)

`vercel.json` runs the job daily at **04:30 UTC = 10:00 IST**.

| Days before the Saturday deadline | Staff who haven't planned | Managers with pending requests |
|---|:--:|:--:|
| 3 (Wednesday) | ✅ | — |
| 1 (Friday) | ✅ | ✅ |
| 0 (Saturday, last call) | ✅ | ✅ |

Managers are deliberately left alone early in the week: chasing them on Monday about requests that mostly don't exist yet is how a reminder gets ignored.

Every nudge is idempotent on `(user, week, kind, channel, day)`, so a retried or twice-run cron cannot message the same person twice.
