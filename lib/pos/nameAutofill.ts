// POS-5 — the guard behind the "phone-first" name autofill on the New order
// screen. Pulled out to a pure function for the same reason lib/pos/loyalty.ts
// is: a rule about what overwrites what belongs where it can be pinned down
// with a test, not buried in a component's effect.
//
// The rule: a lookup's name is offered whenever the field is either EMPTY or
// still holds whatever the LAST autofill put there — never when the cashier
// has typed something of their own. PosOrderEntry tracks "of their own" with a
// ref (`custNameUserEdited`) set true on every manual keystroke and reset to
// false right after an autofill; that ref is `userEdited` here.

/**
 * Whether a freshly-resolved lookup name should replace what's currently in
 * the name field.
 *
 * `userEdited` must be false immediately after an autofill (and after
 * `resetForNextOrder()`), and flip true the instant the cashier types into
 * the field by hand — including typing over an autofilled name, or clearing
 * it and typing a different one. An empty field is always fair game: a
 * blank name offers nothing for an autofill to clobber.
 */
export function shouldAutofillName(currentName: string, userEdited: boolean): boolean {
  return currentName.trim().length === 0 || !userEdited;
}
