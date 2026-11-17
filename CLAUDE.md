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
