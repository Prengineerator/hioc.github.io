'use client';

// The offer editor and the template editor, shared by every playbook card and
// the new-campaign wizard. They edit DRAFTS (strings — see drafts.ts); nothing
// here talks to the server, and bounds/messages come from lib/marketing.

import { useId } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { parseOffer } from '@/lib/marketing/parse';
import {
  OFFER_BOUNDS,
  TEMPLATE_BODY_PREVIEW_MAX,
  TEMPLATE_MAX_VARS,
  TEMPLATE_TOKEN_LABELS,
  type FreeItemCandidate,
  type OfferType,
  type TemplateToken,
} from '@/lib/marketing/types';
import {
  AUTO_VARIANT_LABEL,
  OFFER_TYPE_LABELS,
  addToken,
  addableTokens,
  describeOfferForOwner,
  draftToOfferInput,
  moveToken,
  pickVariant,
  removeToken,
  renderTemplatePreview,
  switchOfferType,
  templateProblems,
  variantOptions,
  type OfferDraft,
  type TemplateDraft,
} from './drafts';
import { Help, Notice } from './ui';

const range = (b: { min: number; max: number }) => `${b.min.toLocaleString('en-IN')} to ${b.max.toLocaleString('en-IN')}`;

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

export function OfferEditor({
  draft,
  onChange,
  ranking,
  costsAvailable,
  types = ['none', 'percent', 'flat', 'free_item'],
}: {
  draft: OfferDraft;
  onChange: (next: OfferDraft) => void;
  /** GET /costs → free_item_ranking. Empty until product costs are entered. */
  ranking: readonly FreeItemCandidate[];
  /** false when the costs request itself failed, so the picker says so instead of "enter costs". */
  costsAvailable: boolean;
  types?: OfferType[];
}) {
  const set = (patch: Partial<OfferDraft>) => onChange({ ...draft, ...patch });
  const parsed = parseOffer(draftToOfferInput(draft));
  const preview = parsed.ok ? describeOfferForOwner(parsed.value, ranking) : '';

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="What do customers get?"
        value={draft.type}
        onChange={(e) => onChange(switchOfferType(e.target.value as OfferType))}
        options={types.map((t) => ({ value: t, label: OFFER_TYPE_LABELS[t] }))}
      />

      {draft.type === 'none' ? (
        <Help>No coupon is created and no discount is given. The message just reminds the customer.</Help>
      ) : null}

      {draft.type === 'percent' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Percent off (%)"
            type="number"
            inputMode="decimal"
            min={OFFER_BOUNDS.percent.min}
            max={OFFER_BOUNDS.percent.max}
            value={draft.percent}
            onChange={(e) => set({ percent: e.target.value })}
            hint={`Whole number, ${range(OFFER_BOUNDS.percent)}.`}
          />
          <Input
            label="Most they can save (₹)"
            type="number"
            inputMode="decimal"
            min={OFFER_BOUNDS.cap_inr.min}
            max={OFFER_BOUNDS.cap_inr.max}
            value={draft.cap_inr}
            onChange={(e) => set({ cap_inr: e.target.value })}
            hint="0 means no limit. A cap protects you on big orders."
          />
        </div>
      ) : null}

      {draft.type === 'flat' ? (
        <Input
          label="Amount off (₹)"
          type="number"
          inputMode="decimal"
          min={OFFER_BOUNDS.amount_inr.min}
          max={OFFER_BOUNDS.amount_inr.max}
          value={draft.amount_inr}
          onChange={(e) => set({ amount_inr: e.target.value })}
          hint={`Whole rupees, ${range(OFFER_BOUNDS.amount_inr)}.`}
        />
      ) : null}

      {draft.type === 'free_item' ? (
        <div className="flex flex-col gap-3">
          <Select
            label="Which free item?"
            value={draft.variant_id}
            onChange={(e) => onChange(pickVariant(draft, e.target.value, ranking))}
            options={variantOptions(ranking, draft.variant_id).map((o) => ({ value: o.value, label: o.label }))}
          />
          <Help>
            <strong>{AUTO_VARIANT_LABEL}</strong> picks the item that looks most generous to the customer for the least cost to you, each time the campaign is planned.
            {!costsAvailable
              ? ' Product costs could not be loaded, so only Auto is available right now.'
              : ranking.length === 0
                ? ' Enter your product costs (Product costs tab) to see the ranking and to choose a specific item. Until then a free-item campaign is flagged “No free item”.'
                : ' Items are ranked by price ÷ cost: the higher the number, the more value each rupee of your cost buys.'}
          </Help>
          <Input
            label="Free item price limit (₹)"
            type="number"
            inputMode="decimal"
            min={OFFER_BOUNDS.max_item_price.min}
            max={OFFER_BOUNDS.max_item_price.max}
            value={draft.max_item_price}
            onChange={(e) => set({ max_item_price: e.target.value })}
            hint="Auto only picks items priced at or under this, so a free item never costs you too much."
          />
        </div>
      ) : null}

      {draft.type !== 'none' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={draft.type === 'free_item' ? 'Minimum spend on other items (₹)' : 'Minimum order (₹)'}
            type="number"
            inputMode="decimal"
            min={OFFER_BOUNDS.min_order_inr.min}
            max={OFFER_BOUNDS.min_order_inr.max}
            value={draft.min_order_inr}
            onChange={(e) => set({ min_order_inr: e.target.value })}
            hint="0 means any order qualifies."
          />
          <Input
            label="Code valid for (days)"
            type="number"
            inputMode="decimal"
            min={OFFER_BOUNDS.validity_days.min}
            max={OFFER_BOUNDS.validity_days.max}
            value={draft.validity_days}
            onChange={(e) => set({ validity_days: e.target.value })}
            hint={`Through the end of that day, ${range(OFFER_BOUNDS.validity_days)} days.`}
          />
        </div>
      ) : null}

      {draft.type !== 'none' && preview ? (
        <p className="rounded-md bg-surface p-3 text-sm text-charcoal">
          <span className="font-semibold">Customers will read: </span>
          {preview}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function TemplateEditor({
  draft,
  onChange,
  allowHeadline,
  offerTextValue,
  headline,
}: {
  draft: TemplateDraft;
  onChange: (next: TemplateDraft) => void;
  /** `headline` is a manual-campaign-only variable (the server rejects it on a playbook). */
  allowHeadline: boolean;
  /** The real offer wording, so the preview shows it instead of a stock example. */
  offerTextValue: string;
  headline?: string;
}) {
  const varsLabelId = useId();
  const set = (patch: Partial<TemplateDraft>) => onChange({ ...draft, ...patch });
  const preview = renderTemplatePreview(draft, offerTextValue, headline);
  const problems = templateProblems(draft);
  const addable = addableTokens(allowHeadline);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Input
          label="Template name in WhatsApp Manager"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          hint="Exactly as approved: lowercase letters, numbers and underscores. Blank flags the campaign “No template”."
        />
        <Input
          label="Language code"
          value={draft.lang}
          onChange={(e) => set({ lang: e.target.value })}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          hint="Use en. “English (US)” is en_US and makes every send fail (#132001)."
        />
      </div>

      <div>
        <p className="text-sm font-semibold text-charcoal" id={varsLabelId}>
          What fills each blank in the message
        </p>
        <Help>In order: the first fills {'{{1}}'}, the second {'{{2}}'}, and so on. The order and count must match your approved template.</Help>
        <ol aria-labelledby={varsLabelId} className="mt-2 flex flex-col gap-1">
          {draft.vars.map((token, i) => (
            <li key={`${token}-${i}`} className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-1.5">
              <span className="w-12 shrink-0 font-mono text-sm text-muted">{`{{${i + 1}}}`}</span>
              <span className="min-w-0 flex-1 text-sm text-charcoal">{TEMPLATE_TOKEN_LABELS[token]}</span>
              <button
                type="button"
                aria-label={`Move ${TEMPLATE_TOKEN_LABELS[token]} up`}
                disabled={i === 0}
                onClick={() => set({ vars: moveToken(draft.vars, i, -1) })}
                className="flex h-10 w-10 items-center justify-center rounded-md text-charcoal hover:bg-[#f2efe9] disabled:opacity-30"
              >
                <span aria-hidden="true">↑</span>
              </button>
              <button
                type="button"
                aria-label={`Move ${TEMPLATE_TOKEN_LABELS[token]} down`}
                disabled={i === draft.vars.length - 1}
                onClick={() => set({ vars: moveToken(draft.vars, i, 1) })}
                className="flex h-10 w-10 items-center justify-center rounded-md text-charcoal hover:bg-[#f2efe9] disabled:opacity-30"
              >
                <span aria-hidden="true">↓</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${TEMPLATE_TOKEN_LABELS[token]}`}
                onClick={() => set({ vars: removeToken(draft.vars, i) })}
                className="flex h-10 w-10 items-center justify-center rounded-md text-red-700 hover:bg-red-50"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ol>
        {draft.vars.length === 0 ? <p className="mt-2 text-sm text-muted">No variables yet. A template needs at least one.</p> : null}
        <div className="mt-2 max-w-sm">
          <Select
            label="Add a variable"
            value=""
            placeholder={draft.vars.length >= TEMPLATE_MAX_VARS ? `At most ${TEMPLATE_MAX_VARS}` : 'Choose one to add…'}
            disabled={draft.vars.length >= TEMPLATE_MAX_VARS}
            onChange={(e) => set({ vars: addToken(draft.vars, e.target.value as TemplateToken) })}
            options={addable.map((t) => ({ value: t, label: TEMPLATE_TOKEN_LABELS[t] }))}
          />
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-line p-3">
        <div>
          <p className="text-sm font-bold text-charcoal">“Order now” button</p>
          <p className="text-xs text-muted">
            Each customer&apos;s button carries their own link to the menu, so you can see who tapped. Turn this on only if your approved template has the
            “Order now” URL button.
          </p>
        </div>
        <ToggleSwitch checked={draft.url_button} onChange={(v) => set({ url_button: v })} label="Order now button" />
      </div>

      <Textarea
        label="Your approved message text (preview only)"
        rows={5}
        maxLength={TEMPLATE_BODY_PREVIEW_MAX}
        value={draft.body_preview}
        onChange={(e) => set({ body_preview: e.target.value })}
        hint="Paste the body from WhatsApp Manager, with {{1}}, {{2}}… in it. This is never sent: WhatsApp sends its own approved copy. It only powers the preview below."
      />

      {problems.length > 0 ? (
        <Notice tone="warn" title="Check the message text">
          <ul className="list-disc space-y-1 pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div>
        <p className="text-sm font-semibold text-charcoal">Preview with sample values</p>
        {preview ? (
          <div className="mt-2 max-w-md rounded-lg rounded-tl-none border border-green-200 bg-[#e7f3e3] p-3 text-sm text-charcoal">
            <p className="whitespace-pre-line break-words">{preview}</p>
            {draft.url_button ? (
              <p className="mt-2 border-t border-green-200 pt-2 text-center font-semibold text-tan-dark">Order now</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">Paste your message text above to see how it will read.</p>
        )}
      </div>
    </div>
  );
}
