-- ===========================================================================
-- Marketing agent — the two loyalty reminders say "Beanies", not "points".
--
-- Loyalty points were renamed Beanies (lib/loyalty/brand.ts). The marketing
-- agent's migration (2026-10-marketing-agent.sql) now seeds the Beanies
-- wording, but its insert is `on conflict do nothing`, so a database that ran
-- it earlier still carries the old "HIOC reward points" preview text on the
-- points_expiring and points_balance playbooks (what the owner sees in the
-- Playbooks editor and in approvals; it must match the Meta-approved body in
-- docs/WHATSAPP-MARKETING-TEMPLATES.md and lib/marketing/types.ts).
--
-- Only the EXACT old default text is replaced, so an owner who has since edited
-- a preview keeps their words. Template NAMES (hioc_points_*_1), variables and
-- every other field are untouched. Safe to re-run: a second run matches nothing.
-- ===========================================================================

update public.marketing_playbooks
   set template = jsonb_set(
         template, '{body_preview}',
         to_jsonb('Hi {{1}}, {{2}} of your HIOC Beanies (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon!'::text)
       ),
       updated_at = now()
 where key = 'points_expiring'
   and template->>'body_preview' = 'Hi {{1}}, {{2}} of your HIOC reward points (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon!';

update public.marketing_playbooks
   set template = jsonb_set(
         template, '{body_preview}',
         to_jsonb('Hi {{1}}, you have {{2}} HIOC Beanies worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon!'::text)
       ),
       updated_at = now()
 where key = 'points_balance'
   and template->>'body_preview' = 'Hi {{1}}, you have {{2}} HIOC reward points worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon!';

-- ---------------------------------------------------------------------------
-- Verify (expect no rows still saying "reward points"):
--   select key, template->>'body_preview' from public.marketing_playbooks
--    where key in ('points_expiring', 'points_balance');
-- ---------------------------------------------------------------------------
