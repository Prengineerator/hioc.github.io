-- ===========================================================================
-- Coffey — preset events: measuring the add-ons Coffey preselects
-- (docs/COFFEY-SPEC.md §11.7: "watch how often customers un-tick it, and how
-- many combo picks are added").
--
-- suggestion_events.event has a CHECK (suggestion_events_event_check, created
-- inline in 2026-09-suggestion-engine.sql) that lists nine event names. Three
-- more are added here, mirroring SUGGESTION_EVENTS in lib/suggest/types.ts:
--
--   preset_shown    the server sent a pick that carries an add-on preset
--                   (menu_item_id = the pick, value_inr = what the presets
--                   cost together). Written only by POST /api/suggest.
--   preset_removed  the customer took the add-on off (card chip un-ticked, or
--                   removed in the customise screen before adding).
--   preset_kept     the pick went into the cart with at least one of its
--                   preset add-ons still on the line.
--
-- Nothing else changes. The constraint is replaced by name in a single
-- statement, so this file is safe to re-run.
--
-- Safe to apply before OR after deploying the code: until it is applied every
-- insert of a new event name is refused by the CHECK. The server logs that and
-- carries on (the 'shown' rows are a separate insert and are unaffected), the
-- events route answers 204 for the two client names, and the owner dashboard's
-- "Add-ons Coffey preselects" card reads zero and says so.
--
-- Once applied: run `npm run verify:db`.
-- ===========================================================================

-- One statement on purpose: the old constraint goes and the new one arrives
-- together, so a failure can never leave the table with no constraint at all.
alter table suggestion_events
  drop constraint if exists suggestion_events_event_check,
  add constraint suggestion_events_event_check
    check (event in (
      'shown', 'added_to_cart', 'feedback_up', 'feedback_down',
      'refined', 'dismissed', 'browse_menu', 'checkout_started', 'ordered',
      'preset_shown', 'preset_removed', 'preset_kept'));
