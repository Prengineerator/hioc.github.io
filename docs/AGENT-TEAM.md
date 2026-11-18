# The HIOC agent team — owner guide

**Date:** 2026-11-18
**For:** the owner. Steps marked **(developer)** can be handed to your developer. Nothing here needs you to write code.
**Time:** about 30 minutes to switch on.

---

## What this is

A small team of Claude roles that looks after hioc.in: it watches the site, restores
it when a new release breaks it, proposes fixes, keeps the site fast and secure
week by week, and takes your change requests. You talk to one of them, the
product owner. The rest report to you by email.

| Role | What it does | When it runs |
|---|---|---|
| **Watchman** | Checks every 5 minutes that hioc.in is serving and can reach its database. It is a small GitHub job, not Claude. | All day, every day |
| **Manager** | Finds out what is wrong, rolls back a bad release under fixed rules, gets a fix proposed, emails you. | Woken by the watchman, and once an hour on its own |
| **Weekly optimisation and security pass** | Runs the security checks first, then makes the site faster and cleaner, and proposes the changes for you to accept. | Mondays 6:51 am IST |
| **Product owner** | Your contact for any change. Turns what you ask for into work for the engineers and checks it. Also keeps the to-do list. | Whenever you talk to it, and Mondays 10:31 am IST |
| **Engineers (ICs)** | `web-engineer`, `database-engineer`, `orders-payments-engineer`, `chef`. They do the work they are briefed on. | When the roles above brief them |
| **Security reviewer** | Reads every change before it leaves the session. A fail blocks it. It cannot edit code, so it is independent of the author. | Before every push |

## When the site goes down

1. The watchman fails three checks in a minute and wakes the manager.
2. The manager confirms the outage itself, twice, and reads the Vercel and Supabase evidence.
3. **If a release made in the last 24 hours broke the site**, the manager points the
   site back at the previous release. This usually restores service in a minute or two.
4. It records the incident, has the right engineer propose a fix as a pull request,
   and emails you a short report: what happened, what it did, what you need to do.

**After a rollback, Vercel stops putting new releases live until one is promoted.**
The report will say so. When the fix is merged: Vercel → project `hioc-in` →
Deployments → the new build → **Promote**. Until then the site stays on the older,
working release.

### What the manager may do without asking you

One thing: roll the site back to the release before the current one. Only when all
of this is true:

- the outage is confirmed twice, a minute apart;
- the current release is less than 24 hours old, and the previous release is working right now when tested directly;
- the database (Hioc India) is healthy;
- the release did not change the database's structure;
- nobody has already rolled back.

If any of these is not true it does nothing to the site and emails you with what it
recommends.

### What no agent ever does

- Merge a pull request, release a build, or promote one.
- Change a setting in Vercel, Supabase, Razorpay or WhatsApp.
- Write to the database, or run any script against it.
- Read or touch the retired database, Hioc Coffee.
- Put a customer's or staff member's details, a key, or the detail of a security weakness into this repository. It is public.

## Automatic optimisation

Every Monday morning, before the café opens, the weekly pass:

1. **Runs the security protocol first** (`docs/SECURITY-PLAYBOOK.md`): the scan, the
   type check, the tests, Supabase's security notices for Hioc India, and known
   vulnerabilities in the packages the site uses.
2. **Speeds up and polishes the screens**, using the existing `code-revamp` skill.
3. **Reads Supabase's performance notices** and has the database engineer write any
   index or policy change as a file for your developer to run.
4. **Fixes the most frequent error** showing in production that week.

You receive one pull request to accept, plus a separate one if there is a security
fix. It never changes what customers, staff or you see or pay; anything like that
comes to you as a proposal. If last week's pull request is still waiting, it does
not pile a second one on top. It reminds you instead.

The old weekly "Code revamp" run on GitHub has been retired in favour of this. It
had failed every Monday since at least 12 October 2026, because the
`ANTHROPIC_API_KEY` secret it needs was never added to the repository.

## Security

These hold for every role, every time.

- **Every change is checked before it leaves.** The author runs
  `scripts/security-scan-diff.sh`, which fails if the change adds any finding to
  the playbook's scan. Then the security reviewer reads the change. A fail blocks it.
- **GitHub enforces the same check.** Every pull request that touches the app runs
  the scan comparison alongside the lint, type check, tests and build.
- **Production is read-only** for every agent, except the manager's single rollback.
- **Outside text is never an instruction.** Alert messages, error logs, and issues
  or comments on this public repository can be written by strangers. The roles
  treat them as information only.
- **Nothing secret goes in the repository.** The watchman's wake-up token lives in
  GitHub's encrypted secrets and is never printed in a log.
- **You approve any new power.** Giving an agent a new action it may take alone, or
  removing one of these checks, needs your explicit yes to the product owner.

Two things are rules in the agents' instructions, not locks, and you can make them
locks:

- The Vercel and Supabase connectors can do more than the agents are told to do.
  Give each scheduled task only the connectors listed in step 3 below, and keep
  the environment they run in free of database keys (step 2).
- The full scan (`scripts/security-scan.sh`) reports on the whole codebase,
  including code older than this team. The weekly pass works through whatever it
  shows and reports each item to you.

## Talking to the product owner

Open a Claude session on this repository and say what you want in your own words:
"add a festival offer", "the cart is confusing on a phone", "stop the hourly check
at night". Any request for a change goes to the product owner automatically. It
will tell you what it understood, warn you if money, customer messages, customer
data or a database step are involved, and report back when it is done and checked.

---

## Switching it on

Three scheduled tasks already exist in your Claude account, **paused**:
*HIOC manager — production check*, *HIOC weekly optimisation and security pass* and
*HIOC product owner — weekly review*. They could not be finished from the session
that created them, so steps 2 and 3 are yours.

### 1. Merge this change (developer)

The team's instructions are read from `main`. Until they are merged, a task that
runs replies "Team files are not on main yet." and stops.

### 2. Make the cloud environment safe

The tasks run in a Claude cloud environment. An unattended agent should start with
no database address and no database key in it, and with no network route to the
retired database, Hioc Coffee. The agents reach Supabase through the connector
only, so they need none of these.

Check the environment the tasks use before step 3: its saved variables should not
include `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`, and its allowed
hosts should not include a Supabase project address. If a session of your own
needs those (the `inventory:*` commands do), give the team its own environment
without them.

### 3. Finish the three tasks

Go to <https://claude.ai/code/routines>. For each task: open it → the menu next to
its name → **Edit**.

| Task | Repository | Connectors |
|---|---|---|
| HIOC manager — production check | this repository | Vercel and Supabase, nothing else |
| HIOC weekly optimisation and security pass | this repository | Vercel and Supabase, nothing else |
| HIOC product owner — weekly review | this repository | none |

The tasks were created with no repository and no connectors attached, so add them
here. Give each task only what the table lists: a connector an agent does not
have is one it cannot be talked into misusing. Save, then resume the task.

### 4. Connect the watchman to the manager

1. In the manager task's **Edit** dialog: Trigger row → **+** → **API** →
   **Generate token**. Copy the **Fire URL** and the **Token**. The token is shown
   once.
2. In GitHub: this repository → Settings → Secrets and variables → Actions → **New
   repository secret**, twice:
   - `CLAUDE_MANAGER_FIRE_URL` — the Fire URL
   - `CLAUDE_MANAGER_FIRE_TOKEN` — the token

   Paste them nowhere else. If the token is ever exposed, **Regenerate** it in the
   same dialog and update the secret.

### 5. Test it

GitHub → Actions → **Uptime watch** → **Run workflow** → tick **Send a test alert**
→ Run. Within a couple of minutes a new session appears in your Claude sessions
list, checks the site and finishes with "All clear — hioc.in is up."

---

## Stopping it

- **Everything:** pause the three tasks at <https://claude.ai/code/routines>, and
  disable *Uptime watch* in GitHub → Actions.
- **Only the automatic rollback:** tell the product owner "do not roll back
  without asking me". The manager will then report and wait.

## Limits you should know

- **The watchman can be late.** GitHub starts scheduled jobs when it has capacity.
  This repository's weekly job has been starting 5 to 8 hours after its set time.
  A 5-minute job is treated better than a weekly one, but watch the Actions tab in
  the first days: if the checks are far apart, use a dedicated uptime service
  instead. Any service that can send a web request with custom headers can wake
  the manager the same way.
- **The manager's own schedule is hourly at best.** That is the fastest a Claude
  scheduled task can repeat. The watchman is what makes the response quick.
- **Scheduled tasks are a research preview** and every run uses your Claude plan's
  usage. The manager's hourly check is the largest share. The product owner can
  limit it to café hours if you ask.
- **Vercel keeps one hour of logs on the current plan**, so the manager sees only
  the last hour of detail.
- **The fix is proposed, not applied.** After a rollback the site is working on the
  older release, and the fix waits for you to merge and promote it.
- **Tests cannot see the live database.** A fix that depends on the database is
  marked "not confirmed" until it is live.

## Where everything lives

| What | File |
|---|---|
| Manager's rules | `.claude/skills/incident-manager/SKILL.md` |
| Weekly optimisation and security pass | `.claude/skills/weekly-optimisation/SKILL.md` |
| Product owner | `.claude/skills/product-owner/SKILL.md` |
| Engineers and the security reviewer | `.claude/agents/` |
| Watchman | `.github/workflows/uptime-watch.yml` |
| Health check the watchman reads | `app/api/health/route.ts` |
| Security protocol | `docs/SECURITY-PLAYBOOK.md`, `scripts/security-scan.sh`, `scripts/security-scan-diff.sh` |
