-- 2026-07-menu-short-code — owner-defined POS shortform per menu item (POS-1
-- quick-add). Additive and idempotent ("if not exists"), safe to re-run. Existing
-- rows backfill to NULL. Keep lib/types.ts (MenuItem.short_code) in exact sync.
--
-- The code is a short, memorable token (e.g. 'CAP', 'LAT'). It is stored
-- UPPERCASE by the API, which also enforces ^[A-Za-z0-9]{1,8}$. NULL / '' = no
-- code, and codeless items simply fall back to name/fuzzy matching in the bar.

alter table menu_items add column if not exists short_code text;

-- Case-insensitive uniqueness so two coded items can never share a code, while
-- any number of items may remain codeless — the partial predicate keeps NULLs
-- and blanks out of the index so they never collide.
create unique index if not exists menu_items_short_code_uniq
  on menu_items (lower(short_code))
  where short_code is not null and short_code <> '';
