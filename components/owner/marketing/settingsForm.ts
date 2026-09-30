// The Settings tab's field list (every marketing_settings column, with the help
// text an owner needs) and how an edited form becomes a PATCH body.
//
// The kill switch (`enabled`) is deliberately NOT in this list: it saves by
// itself, behind a confirm dialog (see KillSwitch.tsx), so it is never bundled
// silently into a "Save settings" tap next to a budget change.
//
// Bounds come from SETTINGS_BOUNDS / MESSAGE_COST_BOUNDS — the same numbers as
// the database CHECKs — and every error sentence is the shared parser's, so the
// form and the server can't disagree. Pure: unit-tested in
// tests/marketingDashboardForms.test.ts.

import { parseSettingsPatch, validateMergedSettings } from '@/lib/marketing/parse';
import {
  MESSAGE_COST_BOUNDS,
  SETTINGS_BOUNDS,
  type IntSettingKey,
  type MarketingSettings,
  type MarketingSettingsPatch,
} from '@/lib/marketing/types';
import { numberToField, typedNumber } from './drafts';

export type SettingKey = IntSettingKey | 'message_cost_inr' | 'whatsapp_business_number';

export type SettingKind = 'int' | 'money' | 'hour_start' | 'hour_end' | 'text';

export interface SettingField {
  key: SettingKey;
  label: string;
  help: string;
  kind: SettingKind;
  /** Shown after the box: ₹, %, days… */
  unit?: string;
}

export interface SettingGroup {
  id: string;
  title: string;
  blurb: string;
  fields: SettingField[];
}

export const MESSAGE_COST_HELP = 'Meta marketing rate + 18% GST — ₹1.02 as of 2026. Every forecast and the monthly budget use this number, so update it if Meta changes its rates.';

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'money',
    title: 'Money',
    blurb: 'What you are willing to spend, and what a message costs.',
    fields: [
      {
        key: 'monthly_budget_inr',
        label: 'Monthly budget',
        unit: '₹',
        kind: 'int',
        help: 'The most WhatsApp messages can cost in one calendar month (India time). Sending stops on its own when it is used up and starts again on the 1st.',
      },
      {
        key: 'message_cost_inr',
        label: 'Cost of one message',
        unit: '₹',
        kind: 'money',
        help: MESSAGE_COST_HELP,
      },
      {
        key: 'daily_send_cap',
        label: 'Most messages per day',
        kind: 'int',
        help: 'A second brake, on top of the budget. The day resets at midnight India time. 0 stops all sending.',
      },
    ],
  },
  {
    id: 'window',
    title: 'When messages go out',
    blurb: 'All times are India time (IST).',
    fields: [
      {
        key: 'send_window_start_hour',
        label: 'Sending opens at (IST)',
        kind: 'hour_start',
        help: 'Nothing is sent before this hour. 11 am is a good default: nobody wants a promotion at 7 am.',
      },
      {
        key: 'send_window_end_hour',
        label: 'Sending closes at (IST)',
        kind: 'hour_end',
        help: 'Nothing is sent from this hour on. It must be later than the opening hour.',
      },
    ],
  },
  {
    id: 'frequency',
    title: 'How often one customer hears from you',
    blurb: 'WhatsApp also limits how many promotions one person gets from all businesses. Keep these below that.',
    fields: [
      {
        key: 'min_days_between',
        label: 'Days between messages to the same person',
        unit: 'days',
        kind: 'int',
        help: 'A customer is skipped if you messaged them more recently than this.',
      },
      {
        key: 'max_per_30_days',
        label: 'Most messages per person in 30 days',
        kind: 'int',
        help: 'Once a customer has had this many in the last 30 days, they are skipped.',
      },
      {
        key: 'pause_after_unread',
        label: 'Pause a customer after this many unread messages in a row',
        kind: 'int',
        help: 'People who keep ignoring you are more likely to block you, which hurts your WhatsApp number. 0 turns this off. It also switches itself off while delivery receipts are not connected.',
      },
    ],
  },
  {
    id: 'measuring',
    title: 'Measuring what works',
    blurb: 'How the agent tells real results from customers who would have come anyway.',
    fields: [
      {
        key: 'holdout_pct',
        label: 'Share held back as a comparison group',
        unit: '%',
        kind: 'int',
        help: 'These customers are deliberately NOT messaged. Comparing them with the messaged group shows how many extra orders the campaign really caused (its “lift”). 0 turns measuring off.',
      },
      {
        key: 'attribution_days',
        label: 'Count a return within',
        unit: 'days',
        kind: 'int',
        help: 'An order within this many days of the message counts as a return for that campaign.',
      },
    ],
  },
  {
    id: 'guardrails',
    title: 'Safety checks',
    blurb: 'The agent flags a campaign, and never sends it on Auto, when it breaks one of these.',
    fields: [
      {
        key: 'min_margin_pct',
        label: 'Smallest acceptable margin per returning order',
        unit: '%',
        kind: 'int',
        help: 'After the offer and the product cost, each returning order should still keep at least this share of the basket as profit.',
      },
      {
        key: 'default_food_cost_pct',
        label: 'Assumed food cost when none is entered',
        unit: '%',
        kind: 'int',
        help: 'Used for items whose cost you have not entered under Product costs. Entering real costs makes forecasts more accurate.',
      },
      {
        key: 'drop_alert_pct',
        label: 'Warn me when active customers fall by',
        unit: '%',
        kind: 'int',
        help: 'Compared with the average of the 4 weeks before. Shown on the Overview.',
      },
    ],
  },
  {
    id: 'whatsapp',
    title: 'Your WhatsApp number',
    blurb: 'Used to build the “Get offers on WhatsApp” link and QR code.',
    fields: [
      {
        key: 'whatsapp_business_number',
        label: 'WhatsApp business number',
        kind: 'text',
        help: 'With country code, like +919876543210. Customers who send START to this number opt in. Leave empty to switch the link off.',
      },
    ],
  },
];

/** A settings box's contents as the owner sees them. */
export type SettingsDraft = Record<SettingKey, string>;

export const SETTING_KEYS: SettingKey[] = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

export function settingsToDraft(s: MarketingSettings): SettingsDraft {
  const d = {} as SettingsDraft;
  for (const key of SETTING_KEYS) {
    d[key] = key === 'whatsapp_business_number' ? (s.whatsapp_business_number ?? '') : numberToField(Number(s[key]));
  }
  return d;
}

/** The typed value as what parseSettingsPatch wants for this field. */
function typed(key: SettingKey, raw: string): unknown {
  return key === 'whatsapp_business_number' ? raw : typedNumber(raw);
}

/** "Allowed: 0 to 1,000,000", or '' for the phone number. */
export function allowedRange(key: SettingKey): string {
  if (key === 'whatsapp_business_number') return '';
  const b = key === 'message_cost_inr' ? MESSAGE_COST_BOUNDS : SETTINGS_BOUNDS[key];
  return `Allowed: ${b.min.toLocaleString('en-IN')} to ${b.max.toLocaleString('en-IN')}`;
}

/** The bounds for a numeric input's min/max attributes (null for the text field). */
export function fieldBounds(key: SettingKey): { min: number; max: number } | null {
  if (key === 'whatsapp_business_number') return null;
  return key === 'message_cost_inr' ? { min: MESSAGE_COST_BOUNDS.min, max: MESSAGE_COST_BOUNDS.max } : SETTINGS_BOUNDS[key];
}

/** The parser's own sentence for one bad box, or null when it is fine. */
export function settingFieldError(key: SettingKey, raw: string): string | null {
  if (key === 'whatsapp_business_number' && raw.trim() === '') return null;
  const r = parseSettingsPatch({ [key]: typed(key, raw) });
  return r.ok ? null : r.error;
}

export interface SettingsPatchResult {
  /** Only the boxes that changed. Empty = nothing to save. */
  patch: MarketingSettingsPatch;
  /** Per-field problems, keyed by setting. */
  errors: Partial<Record<SettingKey, string>>;
  /** A problem that belongs to no single box (the send window order). */
  formError: string | null;
}

/**
 * Diffs the form against the saved settings. Sends only what changed; reports
 * every bad box at once (so the owner fixes them in one pass) and the one rule
 * that spans two boxes — the window must end after it starts, checked on the
 * MERGED values because changing only the end still has to beat the saved start.
 */
export function buildSettingsPatch(original: MarketingSettings, draft: SettingsDraft): SettingsPatchResult {
  const patch: MarketingSettingsPatch = {};
  const errors: SettingsPatchResult['errors'] = {};

  for (const key of SETTING_KEYS) {
    const raw = draft[key] ?? '';
    const error = settingFieldError(key, raw);
    if (error) {
      errors[key] = error;
      continue;
    }
    if (key === 'whatsapp_business_number') {
      if (raw.trim() !== original.whatsapp_business_number.trim()) patch.whatsapp_business_number = raw.trim();
      continue;
    }
    const value = typedNumber(raw);
    // Number(): a numeric column can arrive as "1.020" from some PostgREST paths; compare by value, not by type.
    if (value !== Number(original[key])) (patch as Record<string, number>)[key] = value;
  }

  const start = errors.send_window_start_hour ? null : typedNumber(draft.send_window_start_hour);
  const end = errors.send_window_end_hour ? null : typedNumber(draft.send_window_end_hour);
  const formError =
    start !== null && end !== null
      ? validateMergedSettings({ send_window_start_hour: start, send_window_end_hour: end })
      : null;

  return { patch, errors, formError };
}

export function hasSettingsProblems(r: SettingsPatchResult): boolean {
  return Object.keys(r.errors).length > 0 || r.formError !== null;
}
