# Marketing agent — owner runbook

**Companion to:** `docs/MARKETING-AGENT-SPEC.md` (§9 is the source of these steps), `docs/WHATSAPP-MARKETING-TEMPLATES.md`
**Date:** 2026-09-30
**For:** the owner, with your developer for the steps marked **(developer)**. Nothing here needs you to write code.
**Time:** about 1 hour of your time, plus waiting for WhatsApp to approve four message templates (minutes to a day).

---

## What you are switching on

A helper that uses WhatsApp to bring customers back:

- **Beanies reminders.** "Your Beanies are about to expire" and "you have Beanies waiting".
- **Win-back.** Three gentle messages, each a little stronger, to customers who have gone quiet. "Quiet" is measured against each customer's own habits: a daily regular is flagged after two weeks, a monthly visitor after six.
- **Your own campaigns.** A new item, a slow-day offer.
- **A drop alert** when fewer customers ordered last week than usual.

Before anything is sent, the helper works out what the messages will cost and what they should earn, and shows you. It never messages anyone who has not said yes.

### Three switches must all be on before a single message goes out

| Switch | Where | Starts as |
|---|---|---|
| The **Marketing** page is enabled | Vercel setting (step 2) | Off |
| A playbook is on **Review** or **Auto** | `/owner/marketing` → Playbooks | Off |
| **Sending** is on | `/owner/marketing` → Overview | **Off** |

Even then, in **Review** mode nothing is sent until you tap **Approve**. You can stop everything at any time: **Overview → Turn sending off** takes effect immediately.

---

## The steps

### 1. Apply the database update (developer)

1. Supabase → **SQL editor** → paste the whole of `supabase/2026-10-marketing-agent.sql` → **Run**. It is safe to run twice.
2. **One-time secret.** The update starts a timer inside Supabase that asks the website to send queued messages every 5 minutes. It uses a secret called `cron_secret` stored in Supabase's Vault. **If you already set up the post-order feedback messages, this already exists and you can skip this.** To check, run:

   ```sql
   select name from vault.secrets where name = 'cron_secret';
   ```

   If that returns a row, you are done. If it returns nothing, run this once, with the real value (it must be exactly the same as the `CRON_SECRET` setting in Vercel), and do not paste it anywhere else:

   ```sql
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   ```

   Without it the timer still fires but is refused by the website, so approved campaigns would sit in the queue and never send.
3. Check it worked: run `npm run verify:db`, or the "Verify" queries at the bottom of the SQL file. Expect all seven marketing tables to exist and the timer `marketing-send-poll` to be listed. (A tick before the code is deployed gets a 404. That is normal until step 2.)

**If you skip this step**, `/owner/marketing` shows "Apply `supabase/2026-10-marketing-agent.sql` in Supabase → SQL editor, then reload." Do that and reload.

### 2. Turn the Marketing page on (developer)

Vercel → your project → **Settings → Environment Variables** → add `NEXT_PUBLIC_FLAG_MARKETING` = `true` for **Production** (and Preview if you use it) → **Redeploy**. Settings only reach a deployment when it is redeployed.

Then open `/owner/marketing`. You should see a **Marketing** link in the top menu and, on the Overview, a banner reading **Sending is OFF**. Nothing can be sent yet.

### 3. Connect WhatsApp receipts and STOP / START (developer)

This step is easy to skip and expensive to skip. **Without it, a customer who replies STOP is not recorded, START never opts anyone in, and you cannot see whether messages were delivered or whether the campaign worked.**

1. Meta for Developers → your app → **Settings → Basic** → copy the **App Secret**.
2. Vercel → Environment Variables → add `WHATSAPP_APP_SECRET` with that value → **Redeploy**.
3. Meta for Developers → your app → **WhatsApp → Configuration → Webhook → Manage** and make sure both of these are subscribed:
   - `messages`
   - `user_preferences`

   `messages` carries replies (STOP, START), button taps and delivery receipts. `user_preferences` tells us when someone taps WhatsApp's own "Stop promotions". Only `messages` is on today if you set up the feedback messages, so add `user_preferences`.

How you will know it works: after the first message is delivered to a phone, the Overview stops showing **"Delivery receipts are not connected"**.

### 4. Create the four message templates

Follow `docs/WHATSAPP-MARKETING-TEMPLATES.md`. It has the exact wording to paste, the sample values Meta asks for, and the buttons. Create all four (Beanies expiring, Beanies waiting, win-back, and your own offers) and wait until each shows **Active** in WhatsApp Manager. Choose **English** (not "English (US)"), or every send fails with error `#132001`.

### 5. Settings and product costs

**Settings tab** (`/owner/marketing?tab=settings`):

| Setting | What to put | Why |
|---|---|---|
| **WhatsApp business number** | Your WhatsApp number with country code, like `+919876543210` | Builds the QR code and link in step 6. |
| **Monthly budget** | Start small, for example ₹500 to ₹1,000 | The most messages can cost in a month. Sending stops by itself when it is used up. |
| **Cost of one message** | Leave at ₹1.02 | Meta's marketing rate plus 18% GST, as of 2026. Change it only if Meta changes its price. |
| **Sending opens / closes** | 11 am to 8 pm (default) | India time. Nobody gets a promotion at 7 am. |
| Everything else | Leave as it is | The defaults are cautious: at most one message per person a week, four a month, 10% held back to measure results. |

Press **Save**.

**Product costs tab.** Enter what each item costs you to make (ingredients and packaging for one serving), one line per size. This is what lets the helper tell "10% off a ₹320 order" (costs you ₹32) from "a free Cold Coffee" (worth ₹180 to the customer, but costs you only your ₹45), and pick the free item that gives customers the most for the least. Tips:

- Start with your best sellers. Tick **Only items with no cost yet (best sellers first)**.
- A rough figure is far better than none. You can refine it later.
- Aim for **50% or more** of your sales covered. Below that, every campaign is flagged **Product costs missing**, and Auto mode will not send it without you.
- A ⚠ marks an item whose cost is above half its price. Worth a second look.

### 6. Print the opt-in QR card

Customers only get messages if they say yes. The main way they do it is a QR code.

1. `/owner/marketing?tab=audience` → **Get customers to opt in** → **Print the card**. Choose A5 (or "fit to page"). It prints on its own, without the rest of the page. The card reads **"Scan to get HIOC offers on WhatsApp"**.
2. **Test it once with your own phone before printing a stack.** Scan the QR. WhatsApp opens with the word START ready to send. Tap send. You should get a reply within seconds: "You're subscribed to HIOC offers on WhatsApp…". The Audience tab then shows one more opted-in customer, listed as **Sent START on WhatsApp**.
3. Put the card on tables and at the counter.

Customers can also opt in from a card on their order page after they order, and from their Account page. **You cannot add customers yourself**, and that is deliberate. India's data-protection law and WhatsApp's own rules need the customer to say yes. A number you type in would not count as consent, and messaging people who did not ask is the fastest way to get your WhatsApp number restricted.

### 7. Try each message on your phone, then turn on two playbooks

1. `/owner/marketing?tab=playbooks` → open a card (**Edit who, offer and message**) → **Send test to my phone**. One real message arrives with sample values. Check that it reads well, that **Order now** and **Stop promotions** both show, and that nothing says `-` where a value should be. Repeat for each playbook.
2. Set **Beanies expiring** and **Win-back · stage 1** to **Review** and press **Save**. Leave the others **Off** for now.

**Review** means: each morning the helper prepares the campaign and waits for you. Nothing is sent until you tap **Approve**.

### 8. Turn Sending on

**Overview → Turn sending on** → read the box → confirm. From here, campaigns you approve go out inside your send window and budget.

The helper plans each morning (about 9:45 am India time). Look in **Approvals** from about 10.

---

## Your first two weeks

Spend five minutes a day, once the morning plan is in.

### Every day: Approvals

Each card is one campaign. Read it top to bottom:

| Look at | You want to see |
|---|---|
| **Who** | A believable number of people. 0 or 1,500 when you have 200 regulars means something is off. |
| **Message cost** | The number of messages times ₹1.02. This is the most it can cost you in message fees. |
| **Expected profit** | Positive, after message cost **and** the offer. |
| **Break-even** | Well **below** the expected return. If break-even is 0.6% and we expect 12%, only about 1 in 150 people has to come back for the campaign to pay for itself. If it says **Not reachable**, each returning order loses money. Skip it. |
| **Warnings** (red) | None. If there are any, read the sentence under each. It is written for you. Approve only if you understand why and accept it. |
| **How the message will read** | Sensible. The code and offer are real, and "there" is not used as a name too often. |

Then tap **Approve & send** (a box tells you exactly how many messages and the most it can cost) or **Skip**. A campaign you leave for two days expires on its own; it is not sent.

### Once a week: Campaigns

Open a finished campaign (tap its row). Wait until **Still counting returns** turns into **Returns were counted**: by default a return is counted for 7 days after the message. Then read **Measured lift** (next section). Also glance at the Overview: opted-in customers should be growing, and **Spent this month** should be comfortably under budget.

### When to move a playbook from Review to Auto

**After about two campaigns from that playbook have finished with a positive measured lift, and neither had any red warning.** In practice:

1. Open the two finished campaigns. **Measured lift** shows a plus figure (for example "+4.2 points"), not "Not enough data yet" and not a minus.
2. Neither campaign had a warning on its card, and the delivered and read numbers look healthy.
3. Then set that playbook to **Auto** and Save. You are asked to confirm.

**Auto** sends by itself, but only when every safety check passes. Anything with a warning (thin margin, over budget, product costs missing…) still comes to Approvals for you. Keep the strongest offer, **Win-back · stage 3**, on Review longest.

If a playbook's lift is zero or negative after two campaigns, the message or offer is not working. Change the offer or the wording rather than sending more.

---

## Reading the numbers

**Lift.** The most important number. Ten percent of each campaign (the *holdout*) are deliberately **not** messaged. Some customers would have come back anyway, and lift compares the two groups:

> Messaged customers who came back: 10.6%. Held-back customers who came back on their own: 5%. **Lift: +5.6 points.** Only that difference is the campaign's doing.

"Came back" on its own flatters a campaign. Lift is the honest figure. It shows only once the held-back group is at least 20 people. Before that you see **Not enough data yet**; raise the held-back share in Settings, or wait for a bigger campaign.

**ROI.** Profit divided by what you spent (messages plus the cost of the offer). **4.0×** means every ₹1 spent is expected to bring back ₹4 of profit. Below 0 means a loss. Before a campaign, ROI is a forecast; on the Overview it is an estimate from recent results.

**Break-even.** The share of the people you message who must come back for the campaign to just cover its message cost. The lower it is compared with what we expect, the safer the campaign.

**Expected vs learned conversion.** Each playbook starts from a research figure (for example 12% of lapsed customers return). As campaigns finish, the helper blends in what really happens in your cafe, and forecasts use the learned figure. Playbook cards show both.

---

## What it will never do

| It never… | Because |
|---|---|
| Messages someone who has not opted in | Consent law and WhatsApp policy. |
| Messages someone who opted out, even if you approved the campaign days ago | Opt-outs are checked again at the moment of sending, and they win. |
| Messages the same person more than once a week (four times in 30 days) | Your limits in Settings; WhatsApp has its own limit as well. |
| Sends outside your window, over your monthly budget or over your daily cap | Settings. |
| Sends with Sending off | The master switch. |
| Sends through a fake channel when WhatsApp is not configured | They are skipped and shown as "WhatsApp is not configured". |

---

## If something is wrong

### Nothing is sending

Check in this order:

1. **Overview says "Sending is OFF".** Turn it on. It is the most common reason.
2. **Outside the send window.** It only sends between the hours in Settings (India time).
3. **Budget used up.** Overview → *Spent this month* is at 100%. It resumes on the 1st, or raise the budget in Settings.
4. **Daily cap reached.** Settings → most messages per day.
5. **Campaign not approved.** It is still in Approvals. Or it has a "not before" time in the future. A campaign untouched for 2 days expires.
6. **Template problem.** Open the campaign (Campaigns → tap the row) and look at the **Reason** column. `#132001` means the template name or language does not match WhatsApp Manager (see below). A **No template** warning means the template name is empty.
7. **"WhatsApp is not configured".** The website is missing `WHATSAPP_TOKEN` or `WHATSAPP_PHONE_ID` (developer). The Overview also shows a notice.
8. **People are skipped** for one of the reasons in the Reason column (messaged too recently, monthly limit reached, paused because their last messages went unread…). This is the helper protecting your WhatsApp number, not a fault.

### Error and message lookup

| What you see | What it means | What to do |
|---|---|---|
| `#132001` | The template name does not exist **in that language**. Usually **English (US)** (`en_US`) was chosen instead of **English** (`en`), or the name has a typo. | WhatsApp Manager → check the exact name and language. Playbooks → card → set *Template name* and *Language code* to match. Details in `docs/WHATSAPP-MARKETING-TEMPLATES.md`, section 8. |
| `#132000` / `#132012` | The number of blanks, or the button, does not match the template. | The list of "what fills each blank" must have as many entries as the approved body has `{{n}}`. The **Order now** button must be the first button. |
| `131049` | WhatsApp chose not to deliver a marketing message to that person (its own limit across all businesses). **Not charged and not retried.** | Normal. If you see many, message less often (Settings). |
| `131050` | The customer tapped **Stop promotions**. They are opted out automatically. | Normal. If you see many, message less often or improve the offers. |
| **"Delivery receipts are not connected"** on the Overview | `WHATSAPP_APP_SECRET` is missing, or the webhook is not subscribed to `messages` and `user_preferences`. | Step 3. Until then STOP/START, delivered/read counts and lift do not work. |
| **"Apply supabase/2026-10-marketing-agent.sql…"** (`migration_missing`) | The database update has not been applied. | Step 1, then reload. |
| **Product costs missing** warning | Costs are entered for under half your sales. | Product costs tab (step 5). |
| **Not enough data yet** (lift) | The held-back group is under 20 people, or nothing has been delivered yet. | Wait, or raise the held-back share in Settings. |
| Opted-in count is not growing | Few customers have seen the QR code, or the business number is not set. | Audience tab. Set the number, print the card, test a scan with your own phone, and put it where customers wait. |
| A customer says they never signed up | Look in the Audience tab → *Last 30 days* for how they were added. Everything is logged with its source. | Use **Record an opt-out** with their number. They are removed at once. |
| Test message never arrives | The template is not Active yet, or its name or language is wrong. | Check the template in WhatsApp Manager and the error on the test. |

---

## Turning it off

- **Stop all messages right now:** Overview → **Turn sending off**. Immediate. Approved campaigns wait in the queue; anything already sent cannot be recalled.
- **Stop one kind of campaign:** Playbooks → set it to **Off** → Save.
- **Hide the whole page:** set `NEXT_PUBLIC_FLAG_MARKETING` to `false` in Vercel and redeploy (developer). The customer opt-in card on the order page disappears too.

## Where things are

| You want to… | Go to |
|---|---|
| See if sending is on, what you have spent, what came back | Overview |
| Approve or skip what the helper prepared | Approvals |
| Turn a kind of campaign on, edit its offer or wording, test it | Playbooks |
| See what was sent, who got it and how it went, or make your own campaign | Campaigns |
| See who can be messaged, print the QR card, record an opt-out | Audience |
| Enter what your items cost to make | Product costs |
| Budget, message cost, send hours, limits, kill switch | Settings |
