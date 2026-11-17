'use client';

// The /suggest wizard, v2 — "Ask Coffey" (docs/COFFEY-SPEC.md §1). Owns all
// client state; talks to the server only through components/suggest/api.ts,
// which is the seam that follows the lib/suggest/types.ts contract. The
// non-visual logic (state shape, the request, the recap and relax rules) lives
// in ./wizardModel.ts; the two question steps are drawn by ./WizardSteps.tsx.
//
// Three steps, with Coffey (the mascot and a speech bubble) on every one:
//   1. "How are you feeling?": one feeling, one tap, straight to step 2.
//   2. "What sounds good?": five groups of toggle chips and a collapsed
//      "More options", with a sticky "Show my picks".
//   3. Coffey's picks, under a recap of what Coffey understood.
// What the customer picks is sent as v2 SuggestInputs (the API also still accepts
// v1 bodies, but nothing here sends one).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { CoffeyBubble } from '@/components/coffey/CoffeyBubble';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import { customizeModalProps, needsCustomizeModal, tickedPick } from '@/components/suggest/addonHint';
import { ResultsSkeleton, ThinkingCopy } from '@/components/suggest/ResultsSkeleton';
import { BackButton, FeelingStep, WantsStep } from '@/components/suggest/WizardSteps';
import {
  buildInputs,
  initialState,
  missLabel,
  recapLabels,
  relaxState,
  selectMood,
  unmetLine,
  type WizardState,
} from '@/components/suggest/wizardModel';
import { fetchSuggestions, getAnonId, postSuggestEvent } from '@/components/suggest/api';
import { buttonVariants } from '@/components/ui/Button';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { MenuFacet } from '@/lib/suggest/facets';
import type {
  FlavourAddonSuggestion,
  FlavourCounts,
  Mood,
  RelaxHint,
  SuggestInputs,
  SuggestResponse,
  SuggestionPick,
  SugarPreset,
  AddonPreset,
} from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

// Above SUGGEST_LIMITS.deciderTimeoutMs (9s) plus room for the rest of the
// route's work; the skeleton cards + Coffey's rotating "thinking" lines cover
// the wait.
const SUGGEST_TIMEOUT_MS = 15000;

const FALLBACK_HEADER = "Here's what I'd pour for you ☕";


type Step = 'feeling' | 'wants' | 'results';

interface CustomizeTarget {
  item: MenuItem;
  sessionId: string;
  beforeCartTotal: number;
  /** The sugar option Coffey preselected for this pick, if any (§4.7). */
  sugarPreset: SugarPreset | null;
  /** The add-on Coffey points to for a requested flavour, if any
   * (COFFEY-ADDONS-PAIRINGS-SPEC §1.1). Highlighted in the modal, never
   * preselected. */
  flavourAddon: FlavourAddonSuggestion | null;
  /** The add-on presets still ticked on the card: preselected in the modal. */
  addonPresets: AddonPreset[];
}

// The customise modal for a pick. Coffey's sugar preselection (§4.7) goes in as
// `initialSelection`; the flavour add-on (COFFEY-ADDONS-PAIRINGS-SPEC §1.1) goes
// in as `suggestedOptions` and is NOT preselected, so it can never quietly add to
// the bill. The engine names groups and options; the modal vets them against the
// item. Hints stack, sugar first (components/suggest/addonHint.ts).
function CustomizeModal({ target, onClose }: { target: CustomizeTarget; onClose: () => void }) {
  const { initialSelection, suggestedOptions, hint } = customizeModalProps(target.item, target);
  return (
    <MenuItemCustomizeModal
      item={target.item}
      onClose={onClose}
      initialSelection={initialSelection}
      suggestedOptions={suggestedOptions}
      hint={hint}
    />
  );
}

export function SuggestWizard({ flavourCounts = null,
  facets = null,
}: {
  flavourCounts?: FlavourCounts | null;
  facets?: MenuFacet[] | null;
}) {
  const router = useRouter();
  const { addItem, totalItems, setPendingSuggestionSessionId } = useCart();

  const [step, setStep] = useState<Step>('feeling');
  const [wiz, setWiz] = useState<WizardState>(initialState);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [response, setResponse] = useState<SuggestResponse | null>(null);
  // True when the picks on screen came from "Show me something different".
  const [showingRefined, setShowingRefined] = useState(false);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 'up' | 'down'>>({});
  // Per pick (menu item id): option ids the customer un-ticked on the card's
  // "Made your way" row. Absent = everything ticked. Reset on every new response.
  const [untickedByPick, setUntickedByPick] = useState<Record<string, string[]>>({});
  const [customizeTarget, setCustomizeTarget] = useState<CustomizeTarget | null>(null);
  const [closedCustomizeTarget, setClosedCustomizeTarget] = useState<CustomizeTarget | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Has this session already produced an explicit signal (added to cart,
  // refined, or the customer chose to browse the menu instead)? Only if not
  // do we consider it "dismissed" when the customer leaves (see the pagehide
  // effect below).
  const engagedRef = useRef(false);
  // The last request sent, so "Try again" can replay it exactly (same inputs,
  // same refine / exclude context).
  const lastRequestRef = useRef<{ inputs: SuggestInputs; opts: { refineOf?: string; exclude?: string[] } } | null>(
    null,
  );

  useEffect(() => {
    sessionIdRef.current = response?.sessionId ?? null;
  }, [response]);

  // Accessibility: move focus to the current step's heading on every step
  // change, so a screen-reader user (and a keyboard user who just tapped a
  // card or pressed Back) lands on the new step's content instead of wherever
  // the old control used to be. It also runs when a request starts and ends,
  // because "Show me something different" replaces the very button that was
  // focused.
  // Not on the first render: nothing has changed yet, and focusing the heading
  // on page load draws a focus ring around it before the customer has done
  // anything.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step, loading]);

  // 'dismissed' (§7): fires once, only if suggestions were actually shown and
  // the customer leaves without adding anything, refining, or explicitly
  // choosing "browse the menu" (those each fire their own event instead).
  // Covers both an in-app navigation away (this component unmounting) and a
  // real tab close/reload (pagehide — postSuggestEvent uses sendBeacon there).
  useEffect(() => {
    function fireIfDue() {
      if (sessionIdRef.current && !engagedRef.current) {
        postSuggestEvent(sessionIdRef.current, 'dismissed');
        engagedRef.current = true;
      }
    }
    window.addEventListener('pagehide', fireIfDue);
    return () => {
      window.removeEventListener('pagehide', fireIfDue);
      fireIfDue();
    };
  }, []);

  const itemsById = useMemo(() => {
    const map = new Map<string, MenuItem>();
    for (const item of response?.items ?? []) map.set(item.id, item);
    return map;
  }, [response]);

  const runSuggest = useCallback(
    async (inputs: SuggestInputs, opts: { refineOf?: string; exclude?: string[] } = {}) => {
      lastRequestRef.current = { inputs, opts };
      setStep('results');
      setLoading(true);
      setErrorMsg(null);
      const anonId = getAnonId();

      const attempt = () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
        return fetchSuggestions(
          {
            inputs,
            anonId,
            refineOf: opts.refineOf,
            excludeItemIds: opts.exclude?.slice(0, SUGGEST_LIMITS.excludeMax),
          },
          { signal: controller.signal },
        ).finally(() => clearTimeout(timer));
      };

      try {
        let result: SuggestResponse;
        try {
          result = await attempt();
        } catch {
          // One retry on timeout/network error, per §3.3.
          result = await attempt();
        }
        setResponse(result);
        setUntickedByPick({});
        setShowingRefined(opts.refineOf !== undefined);
        engagedRef.current = false;
        const shown = [
          ...(result.usual ? [result.usual.menuItemId] : []),
          ...result.picks.map((p) => p.menuItemId),
        ];
        setShownIds((prev) => Array.from(new Set([...prev, ...shown])));
      } catch {
        setErrorMsg(
          "We couldn't quite get suggestions together just now. Please try again in a moment, or head straight to the menu.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Step 1: one tap picks the feeling, applies its context defaults, and moves on.
  function pickMood(mood: Mood) {
    setWiz((prev) => selectMood(prev, mood));
    setStep('wants');
  }

  function submitForSuggestions() {
    if (wiz.mood === null) return;
    runSuggest(buildInputs(wiz, flavourCounts));
  }

  function handleRefine() {
    if (!response) return;
    postSuggestEvent(response.sessionId, 'refined');
    engagedRef.current = true;
    runSuggest(buildInputs(wiz, flavourCounts), { refineOf: response.sessionId, exclude: shownIds });
  }

  // "Show me more options": drop the one constraint the engine named, on screen
  // as well as in the request, so what the customer sees on Change matches.
  function handleRelax(constraint: RelaxHint['constraint']) {
    const next = relaxState(wiz, constraint);
    setWiz(next);
    runSuggest(buildInputs(next, flavourCounts));
  }

  // "Try again" after an error: the same request, with the same refine context.
  function handleRetry() {
    const last = lastRequestRef.current;
    if (last) runSuggest(last.inputs, last.opts);
  }

  function togglePreset(menuItemId: string, optionId: string) {
    setUntickedByPick((prev) => {
      const cur = prev[menuItemId] ?? [];
      return {
        ...prev,
        [menuItemId]: cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId],
      };
    });
  }

  function handleAddToCart(item: MenuItem, rawPick: SuggestionPick) {
    if (!response) return;
    // Only what is still ticked on the card counts from here on.
    const pick = tickedPick(rawPick, new Set(untickedByPick[rawPick.menuItemId] ?? []));
    // A pick that carries a flavour add-on never takes the one-tap path, even on
    // an otherwise simple item: the customer has to see the suggestion (§1.1).
    const isSimple = !needsCustomizeModal(item, pick);
    engagedRef.current = true;
    if (isSimple && item.variants[0]) {
      const variant = item.variants[0];
      addItem({
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantLabel: variant.label,
        unitPriceInr: variant.price_inr,
        gstExempt: item.gst_exempt === true,
        addons: [],
        specialInstructions: '',
        suggestionSessionId: response.sessionId,
      });
      postSuggestEvent(response.sessionId, 'added_to_cart', item.id);
    } else {
      // Required addon choices (or multiple sizes) mean this has to go
      // through the existing customize modal, same as /menu (§3.2). The
      // session id rides along via the cart's one-shot "pending" hint since
      // that modal calls addItem() itself and isn't part of this phase.
      setPendingSuggestionSessionId(response.sessionId);
      setCustomizeTarget({
        item,
        sessionId: response.sessionId,
        beforeCartTotal: totalItems,
        sugarPreset: pick.sugarPreset ?? null,
        flavourAddon: pick.flavourAddon ?? null,
        addonPresets: pick.addonPresets ?? [],
      });
    }
  }

  function handleCloseCustomize() {
    setClosedCustomizeTarget(customizeTarget);
    setCustomizeTarget(null);
    setPendingSuggestionSessionId(null);
  }

  // Fires 'added_to_cart' only if the modal's close actually followed a
  // successful add (cart total grew) — a Cancel/Escape/X close must not.
  useEffect(() => {
    if (!closedCustomizeTarget) return;
    if (totalItems > closedCustomizeTarget.beforeCartTotal) {
      postSuggestEvent(closedCustomizeTarget.sessionId, 'added_to_cart', closedCustomizeTarget.item.id);
    }
    setClosedCustomizeTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalItems, closedCustomizeTarget]);

  function handleFeedback(menuItemId: string, direction: 'up' | 'down') {
    if (!response) return;
    postSuggestEvent(response.sessionId, direction === 'up' ? 'feedback_up' : 'feedback_down', menuItemId);
    setFeedbackGiven((prev) => ({ ...prev, [menuItemId]: direction }));
  }

  function handleBrowseMenu() {
    if (response) {
      postSuggestEvent(response.sessionId, 'browse_menu');
    }
    engagedRef.current = true;
    router.push('/menu');
  }

  function renderCard(pick: SuggestionPick, isUsual = false) {
    const item = itemsById.get(pick.menuItemId);
    if (!item) return null;
    return (
      <SuggestionCard
        key={pick.menuItemId}
        item={item}
        pick={pick}
        isUsual={isUsual}
        missLabel={isUsual ? null : missLabel(pick.misses, wiz, flavourCounts)}
        feedback={feedbackGiven[pick.menuItemId]}
        untickedOptionIds={new Set(untickedByPick[pick.menuItemId] ?? [])}
        onTogglePreset={(optionId) => togglePreset(pick.menuItemId, optionId)}
        onAddToCart={() => handleAddToCart(item, pick)}
        onFeedback={(dir) => handleFeedback(pick.menuItemId, dir)}
      />
    );
  }

  const recap = recapLabels(wiz, flavourCounts);
  const unmetText = response ? unmetLine(response.unmet, wiz, flavourCounts) : null;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-28 pt-4">
      {step === 'feeling' ? <FeelingStep selected={wiz.mood} headingRef={headingRef} onPick={pickMood} /> : null}

      {step === 'wants' ? (
        <WantsStep
          state={wiz}
          flavourCounts={flavourCounts}
          facets={facets}
          cartHasItems={totalItems > 0}
          headingRef={headingRef}
          onChange={setWiz}
          onBack={() => setStep('feeling')}
          onSubmit={submitForSuggestions}
        />
      ) : null}

      {step === 'results' ? (
        <section aria-labelledby="suggest-step3-heading">
          <BackButton onClick={() => setStep('wants')} />
          {/* One bubble stays mounted from "thinking" through the picks (and the
              error), so its live region is already on the page when its text
              changes and a screen reader speaks Coffey's header when it lands. */}
          <CoffeyBubble expression={loading || errorMsg ? 'thinking' : 'happy'} live>
            {loading ? (
              <ThinkingCopy />
            ) : errorMsg ? (
              "I couldn't pull the picks together just now."
            ) : (
              response?.header || FALLBACK_HEADER
            )}
          </CoffeyBubble>

          <h1
            id="suggest-step3-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-6 text-2xl font-bold text-charcoal outline-none"
          >
            {loading ? 'Finding your picks…' : errorMsg ? 'We had trouble with that' : 'Your picks'}
          </h1>

          {/* What Coffey understood, in the customer's own words. */}
          {!loading ? (
            <p className="mt-2 text-sm text-muted">
              <span className="font-semibold text-charcoal">You asked for:</span> {recap.join(' · ')}{' '}
              <button
                type="button"
                onClick={() => setStep('wants')}
                className="inline-flex min-h-[44px] items-center px-1 font-semibold text-tan-dark underline hover:text-charcoal"
              >
                Change
              </button>
            </p>
          ) : null}

          {loading ? (
            <div className="mt-6">
              <ResultsSkeleton />
            </div>
          ) : errorMsg ? (
            <div className="mt-6 flex flex-col items-center gap-4 rounded-md border border-line bg-cream p-6 text-center">
              <p className="text-muted">{errorMsg}</p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button type="button" onClick={handleRetry} className={buttonVariants({ size: 'md' })}>
                  Try again
                </button>
                <Link href="/menu" className={buttonVariants({ size: 'md', variant: 'secondary' })}>
                  Browse the menu
                </Link>
              </div>
            </div>
          ) : response ? (
            <>
              {showingRefined ? <p className="mt-3 text-sm text-muted">Here are some different picks.</p> : null}

              {response.relaxHint ? (
                <div
                  role="status"
                  className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal"
                >
                  <span>{response.relaxHint.message}</span>
                  <button
                    type="button"
                    onClick={() => handleRelax(response.relaxHint!.constraint)}
                    className="min-h-[44px] shrink-0 rounded-full border border-tan px-3 text-sm font-semibold text-tan-dark hover:bg-tan-dark hover:text-cream"
                  >
                    Show me more options
                  </button>
                </div>
              ) : null}

              {unmetText ? <p className="mt-4 text-sm text-charcoal">{unmetText}</p> : null}

              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {response.usual ? renderCard(response.usual, true) : null}
                {response.picks.map((pick) => renderCard(pick))}
              </div>

              {response.picks.length === 0 && !response.usual ? (
                <p className="mt-6 text-center text-sm text-muted">
                  {response.relaxHint
                    ? 'Nothing quite fits yet — try the option above, or browse the full menu below.'
                    : 'Nothing on the menu fits all of that right now — change a choice, or browse the full menu.'}
                </p>
              ) : null}

              <div className="mt-8 flex flex-col items-center gap-1">
                {response.refinesLeft > 0 ? (
                  <button
                    type="button"
                    onClick={handleRefine}
                    className={buttonVariants({ variant: 'secondary' })}
                  >
                    Show me something different
                  </button>
                ) : (
                  <Link href="/menu" className={buttonVariants({ variant: 'secondary' })}>
                    Browse the full menu
                  </Link>
                )}
                <Link
                  href="/coffey"
                  className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
                >
                  What can Coffey do?&nbsp;<span aria-hidden="true">→</span>
                </Link>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <div className="mt-10 text-center">
        <button
          type="button"
          onClick={handleBrowseMenu}
          className="min-h-[44px] px-2 text-sm text-muted underline hover:text-charcoal"
        >
          No thanks, I&apos;ll browse the menu
        </button>
      </div>

      {customizeTarget ? <CustomizeModal target={customizeTarget} onClose={handleCloseCustomize} /> : null}
    </div>
  );
}
