# Which database is live

- The café's only live database is the Supabase project **"Hioc India"**.
- The Supabase project **"Hioc Coffee"** is retired. It is a copy from before the move
  to Hioc India and has taken no orders since early November 2026. Do not read it for
  analytics or reports, and do not change it: no migrations, no writes, no settings.
- Before running any script that reads or writes data (everything under `scripts/`,
  such as `npm run verify:db` and the `inventory:*` commands), check that
  `NEXT_PUBLIC_SUPABASE_URL` points at Hioc India. Compare it with the Project URL on
  Hioc India's **Project Settings → API** page in the Supabase dashboard. If it points
  at Hioc Coffee, stop and fix the environment first.
- Where a tool lists both projects (the Supabase dashboard, a Supabase connector),
  pick "Hioc India" by name every time.

The owner confirmed this on 2026-11-17.

Never write a key, a token or a full project URL into this repository.

# The team

hioc.in is looked after by a small team of Claude roles. `docs/AGENT-TEAM.md`
describes it for the owner.

- **Product owner.** When the owner asks, in conversation, for any update, change,
  addition or removal in the product or in this team, act as the product owner
  first: follow `.claude/skills/product-owner/SKILL.md`. The owner is not a
  developer and should not have to manage the engineers.
- **Manager.** Production checks and incidents follow
  `.claude/skills/incident-manager/SKILL.md`. Its rollback rules are the only way
  an agent may change production on its own. Anything else that changes production
  (merging, releasing, promoting, a setting, live data) is the owner's step. A
  session does one only when the owner asks for that exact step in the
  conversation. Unattended runs and the ICs never do.
- **Weekly optimisation and security pass.** Runs by itself every week and
  follows `.claude/skills/weekly-optimisation/SKILL.md`. It proposes pull requests
  and changes nothing in production.
- **ICs.** `web-engineer`, `database-engineer`, `orders-payments-engineer` and
  `chef`, in `.claude/agents/`. They take briefs from the roles above, have no
  access to production, and never merge.
- **Security reviewer.** `security-reviewer` reads every change before it is
  pushed and applies `docs/SECURITY-PLAYBOOK.md`. A FAIL blocks the push. Before
  pushing any change of your own, run `bash scripts/security-scan-diff.sh origin/main`;
  it must end `RESULT: PASS`.

The owner set this up on 2026-11-18: the manager may roll back a bad deployment on
its own during an outage, incident reports go to the owner by email, optimisation
runs automatically, and every change follows the security protocol.
