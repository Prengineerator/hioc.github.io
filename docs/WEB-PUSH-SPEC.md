# Offers as phone notifications (browser push)

Product owner spec, 2026-11-27. Adds a free marketing channel next to WhatsApp.
Companion to `docs/MARKETING-AGENT-SPEC.md`.

## The short answer

Customers can choose to get HIOC offers as **notifications on their phone**,
sent from hioc.in. They cost nothing per message. The owner writes one on
`/owner/marketing` → **Push** (a title, a line of text, and the page it opens)
and sends it to everyone who said yes.

Nobody gets them without saying yes. The customer taps **Get offers as
notifications** and then their phone asks *"Allow notifications?"*. Only an
"Allow" signs them up. They switch it off any time on **Account → Profile**, or
in their phone's settings.

## What customers see

- **Where they sign up:** logged-in customers only, so every yes belongs to a
  person and is recorded.
  - a card on the order confirmation page, under the WhatsApp opt-in card;
  - a switch on **Account → Profile**: *"Offers as phone notifications"*.
- **What arrives:** a notification with the HIOC icon, the owner's title and text.
  Tapping it opens the chosen hioc.in page (the menu, the shop, an item).
- **Switching off:** the same switch on Account → Profile. It stops at once on
  that phone. Signing up on two phones gives two switches' worth: turning it off
  on a phone turns it off for that phone; a **"Turn off on all my devices"** link
  sits under the switch.
- **iPhone:** works only once the customer has added hioc.in to their Home
  Screen (Apple's rule, iOS 16.4 or newer). The card says so on an iPhone and
  shows how. Android phones and computers work straight from the browser.

## What the owner sees

A **Push** tab on `/owner/marketing`:

1. How many customers and phones are signed up.
2. A form: **title** (up to 40 characters), **text** (up to 120), **opens**
   (the menu, the shop or any hioc.in link), and a live preview.
3. **Send test to me** (the owner's own signed-up phone) and **Send to
   everyone**, behind a confirm dialog showing the number of phones.
4. A list of past sends: when, how many phones it reached, how many tapped it.

**Limit:** at most one push to everyone per day, so customers don't switch it
off. Pushes are not counted against the WhatsApp budget and don't need the
WhatsApp Sending switch.

## Out of scope (next)

- The marketing agent's automatic reminders (Beanies, win-back) by push. They
  stay on WhatsApp for now.
- Order updates by push ("your order is ready").
- Sign-up without logging in, scheduling a push for later, pushes to part of the
  customer list.
- Push on staff.hioc.in or owner.hioc.in.

## Privacy

- **What is stored:** for each phone that says yes, the address the browser
  gives for sending to it, linked to the customer's account, plus a log of each
  yes and each switch-off with the time.
- **Who can see it:** nobody on screen. The owner sees only counts.
- **How long:** deleted as soon as the customer switches it off, or when the
  browser reports the phone is gone.

## The owner's steps

1. **Run the database file** from the pull request in Supabase on **Hioc
   India** (SQL editor).
2. **Add the push keys in Vercel** (hioc-in → Settings → Environment
   Variables, Production). The pull request includes a one-line command that
   prints a key pair. You add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (the café's contact email, as
   `mailto:…`), then redeploy. The private key is a secret: it goes only into
   Vercel, never into chat or the code.
3. **Switch it on:** `NEXT_PUBLIC_FLAG_WEB_PUSH` = `true` in Vercel, then
   redeploy. It is **off by default**, and customers see nothing until you do
   this.

## Build notes (for the engineers)

- **Database** (`database-engineer`): `push_subscriptions` (endpoint unique,
  p256dh, auth, user_id, user_agent, created_at, last_success_at) and
  `push_consent_events` (append-only: user_id, action subscribe/unsubscribe,
  source, at), `push_sends` (title, body, url, sent_by, device_count,
  delivered, clicked, created_at). RLS on, owner/service-role only; customers
  reach their own rows only through API routes. `verify-db` probes.
- **Web** (`web-engineer`): service worker served from the customer host only
  (`/sw.js`, scope `/`), with `push` and `notificationclick` handlers. The click
  opens only same-origin URLs. A customer web app manifest is needed for iPhone
  Home Screen installs. Opt-in card, Profile switch, `/owner/marketing` Push tab.
  Routes: `POST/DELETE /api/account/push` (session user only), owner send and
  test routes behind `getOwnerUser`, a click beacon. Send with the `web-push`
  package. Remove a subscription on a 404/410 from the push service. One
  broadcast per IST day, enforced on the server. Everything 404s while the
  flag is off. Check the site's Content-Security-Policy allows the worker.

## Acceptance checks

1. With the flag off, nothing about push appears anywhere and the routes 404.
2. On an Android phone, a logged-in customer taps the card, allows, and receives
   the owner's test push. Tapping it opens the chosen page.
3. Turning the Profile switch off stops pushes to that phone. "Turn off on all
   my devices" stops them everywhere. Both are logged.
4. Declining the phone's prompt signs nobody up.
5. A second broadcast on the same day is refused with a clear message.
6. A phone that has gone away (410) is removed on the next send.
7. Lint, type check, tests, build and the security gate pass.
