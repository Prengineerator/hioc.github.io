// Coffey v2 — the shared vocabulary (docs/COFFEY-SPEC.md §1, §3.2, §4.6).
// One source of truth for: the step-1 mood cards and what each mood means to
// Jev, the step-2 flavour families and how an item is matched to one, the
// fixed texture and flavour-note vocabularies Jev tags from, and the counts
// the /coffey article quotes (so its numbers can never drift from the code).
//
// Pure data + tiny helpers: no Supabase, no 'server-only', safe to import from
// client components, the Jev tagger, the engine and tests.

import { DAYPARTS, MOODS, type FlavourFamily, type Mood } from './types';

// ---------------------------------------------------------------------------
// Moods
// ---------------------------------------------------------------------------

export interface MoodInfo {
  /** Step-1 card label. */
  card: string;
  icon: string;
  /** Match tag on a pick that suits this mood (§4.6). */
  tag: string;
  /** Reason clause, "A lovely pick — …, <clause>." (unchanged from v1 for the v1 moods). */
  clause: string;
  /** Results header — at most one emoji (tone guide §4). */
  header: string;
  /** How Jev is told what this mood needs: "The customer <need>." */
  need: string;
}

export const MOOD_INFO: Record<Mood, MoodInfo> = {
  boost: {
    card: 'Tired — need a boost',
    icon: '⚡',
    tag: 'A proper lift',
    clause: 'a good lift when you need the energy',
    header: "Coffey's picks for a little lift ⚡",
    need: 'is tired or sluggish and wants an energising lift — caffeine matters most',
  },
  focus: {
    card: 'Focused — working or studying',
    icon: '🎯',
    tag: 'Good for focus',
    clause: 'easy to sip while you focus',
    header: "Coffey's picks to help you focus ☕",
    need: 'is working or studying and wants steady alertness — moderate caffeine, not too sweet or heavy, easy to sip over a while',
  },
  unwind: {
    card: 'Stressed — need to unwind',
    icon: '🧘',
    tag: 'Calming',
    clause: 'soothing and gentle, easy to unwind with',
    header: "Coffey's picks to help you unwind 🧘",
    need: 'is stressed or tense and wants to unwind — something soothing and gentle, easy on the caffeine',
  },
  cosy: {
    card: 'Calm & cosy',
    icon: '☕',
    tag: 'Cosy',
    clause: 'warm and unhurried, a cosy choice',
    header: "Coffey's picks for a cosy moment ☕",
    need: 'is calm and relaxed and wants something warm, soothing and unhurried',
  },
  comfort: {
    card: 'Low — need some comfort',
    icon: '🤗',
    tag: 'Comforting',
    clause: 'rich and comforting',
    header: "Coffey's picks for some comfort ☕",
    need: 'is feeling low or stressed and wants something familiar, soft, creamy or sweet that feels like a hug',
  },
  celebrate: {
    card: 'Celebrating or treating myself',
    icon: '🎉',
    tag: 'A treat',
    clause: 'a little indulgence, lovely for celebrating',
    header: "Coffey's picks to celebrate 🎉",
    need: 'is celebrating or treating themselves and wants something indulgent, special and fun',
  },
  cool: {
    card: 'Hot — cool me down',
    icon: '🧊',
    tag: 'Refreshing',
    clause: 'cold and refreshing for a warm day',
    header: "Coffey's picks to cool you down 🧊",
    need: 'is hot on a warm day and wants something cold and refreshing',
  },
  surprise: {
    card: 'Curious — surprise me',
    icon: '✨',
    tag: 'Something new',
    clause: 'a little different from your usual, worth a try',
    header: "Coffey's picks to surprise you ✨",
    need: 'is curious and open to trying something unusual, distinctive or new',
  },
};

// ---------------------------------------------------------------------------
// Flavour families (step-2 "Flavours you love", soft, OR semantics)
// ---------------------------------------------------------------------------

export interface FlavourFamilyInfo {
  /** Step-2 chip label. */
  label: string;
  emoji: string;
  /** Match tag when a pick matches a family the customer asked for. */
  tag: string;
  /** Reason phrase, "…, with <phrase> — …" (§4.6). */
  phrase: string;
  /** Matched against the item NAME and each flavour note. Works for both the
   * v2 fixed vocabulary below and the free-text notes on pre-v2 rows. */
  pattern: RegExp;
}

export const FLAVOUR_FAMILY_INFO: Record<FlavourFamily, FlavourFamilyInfo> = {
  chocolatey: {
    label: 'Chocolatey',
    emoji: '🍫',
    tag: 'Chocolatey',
    phrase: 'rich chocolate notes',
    pattern: /chocolate|cocoa|choco|nutella|oreo|kit-?kat|brownie|fudge|truffle|mocha|black forest|dark fantasy|red velvet/i,
  },
  caramel: {
    label: 'Caramel & toffee',
    emoji: '🍯',
    tag: 'Caramel',
    phrase: 'buttery caramel notes',
    pattern: /caramel|toffee|butterscotch|dulce/i,
  },
  nutty: {
    label: 'Nutty',
    emoji: '🌰',
    tag: 'Nutty',
    phrase: 'toasty nutty notes',
    pattern: /hazelnut|almond|pistachio|walnut|cashew|nutella|\bnut(s|ty)?\b/i,
  },
  biscuit: {
    label: 'Cookies & biscuit',
    emoji: '🍪',
    tag: 'Cookies & biscuit',
    phrase: 'cookie-crumb notes',
    pattern: /biscuit|biscoff|lotus|cookie|oreo|crumble|brookie|kit-?kat|wafer|digestive/i,
  },
  fruity: {
    label: 'Fruity',
    emoji: '🍓',
    tag: 'Fruity',
    phrase: 'a bright, fruity flavour',
    pattern:
      /fruit|berry|berries|citrus|lemon|\blime\b|orange|mango|strawberry|raspberry|blueberry|cranberry|peach|\bapple\b|passion|pineapple|kiwi|watermelon|litchi|lychee|banana/i,
  },
  spiced: {
    label: 'Warm spice',
    emoji: '🌿',
    tag: 'Warm spice',
    phrase: 'warm spice',
    pattern: /cinnamon|cinoffle|chai|spice|ginger|cardamom|clove|nutmeg|biscoff/i,
  },
  floral: {
    label: 'Floral & tea',
    emoji: '🌸',
    tag: 'Floral & tea',
    phrase: 'delicate floral notes',
    pattern: /\brose\b|floral|lavender|hibiscus|jasmine|matcha|green tea|\btea\b/i,
  },
};

// ---------------------------------------------------------------------------
// Jev tagging vocabularies (§3.2) — Jev can't write free text, so textures and
// flavour notes are fixed lists, one yes/no question per word.
// ---------------------------------------------------------------------------

export const TEXTURES = [
  'silky',
  'creamy',
  'frothy',
  'thick',
  'icy',
  'fizzy',
  'crunchy',
  'crispy',
  'soft',
  'gooey',
  'flaky',
  'chewy',
] as const;

/** Extra wording for the texture questions where the bare word is ambiguous. */
export const TEXTURE_HINTS: Partial<Record<(typeof TEXTURES)[number], string>> = {
  icy: 'icy or slushy, served over lots of ice',
  fizzy: 'fizzy or sparkling',
  thick: 'thick, like a shake',
  flaky: 'flaky, like a croissant',
};

export interface FlavorNote {
  /** Stored in flavor_notes (≤ 24 chars — traitsValidate MAX_FLAVOR_NOTE_CHARS). */
  note: string;
  /** The step-2 family this note belongs to, or null (vanilla, espresso, …). */
  family: FlavourFamily | null;
  /** How the note is described in its Jev question, when the note alone is ambiguous. */
  hint?: string;
}

export const FLAVOR_VOCABULARY: readonly FlavorNote[] = [
  { note: 'chocolate', family: 'chocolatey' },
  { note: 'white chocolate', family: 'chocolatey' },
  { note: 'dark chocolate', family: 'chocolatey' },
  { note: 'red velvet', family: 'chocolatey', hint: 'red velvet cake — mild cocoa, vanilla and cream cheese' },
  { note: 'caramel', family: 'caramel' },
  { note: 'toffee', family: 'caramel' },
  { note: 'butterscotch', family: 'caramel' },
  { note: 'honey', family: null },
  { note: 'hazelnut', family: 'nutty', hint: 'hazelnut, including Nutella' },
  { note: 'almond', family: 'nutty' },
  { note: 'pistachio', family: 'nutty' },
  { note: 'biscuit', family: 'biscuit', hint: 'biscuit or cookie' },
  { note: 'biscoff', family: 'biscuit', hint: 'Lotus Biscoff — caramelised, lightly spiced biscuit' },
  { note: 'oreo', family: 'biscuit', hint: 'Oreo cookie' },
  { note: 'cinnamon', family: 'spiced' },
  { note: 'chai spice', family: 'spiced', hint: 'masala chai spices — cardamom, ginger, clove' },
  { note: 'ginger', family: 'spiced' },
  { note: 'rose', family: 'floral' },
  { note: 'matcha', family: 'floral', hint: 'matcha green tea' },
  { note: 'strawberry', family: 'fruity' },
  { note: 'blueberry', family: 'fruity' },
  { note: 'raspberry', family: 'fruity' },
  { note: 'cranberry', family: 'fruity' },
  { note: 'mixed berry', family: 'fruity' },
  { note: 'mango', family: 'fruity' },
  { note: 'orange', family: 'fruity', hint: 'orange or other citrus zest' },
  { note: 'lemon', family: 'fruity' },
  { note: 'banana', family: 'fruity' },
  { note: 'vanilla', family: null },
  { note: 'espresso', family: null, hint: 'coffee-forward — the taste of espresso comes through clearly' },
  { note: 'cream cheese', family: null, hint: 'cream cheese or cheesecake' },
  { note: 'buttery', family: null },
  { note: 'cheesy', family: null, hint: 'melted or baked cheese' },
  { note: 'garlic', family: null },
  { note: 'spicy', family: null, hint: 'chilli heat, e.g. peri peri' },
];

// ---------------------------------------------------------------------------
// What the /coffey article may quote (§6.3) — derived, never hand-typed.
// ---------------------------------------------------------------------------

/** Every taste dimension a Coffey (v2) trait row carries, in display order. */
export const TRAIT_DIMENSIONS: readonly { key: string; label: string }[] = [
  { key: 'temperature', label: 'Hot or iced' },
  { key: 'caffeine', label: 'Caffeine level' },
  { key: 'is_coffee', label: 'Coffee or not' },
  { key: 'kind', label: 'Drink, dessert or savoury' },
  { key: 'sweetness_level', label: 'Sweetness, 0–10' },
  { key: 'body', label: 'Body' },
  { key: 'intensity', label: 'Strength of flavour' },
  { key: 'refreshment', label: 'Refreshment' },
  { key: 'indulgence', label: 'Indulgence' },
  { key: 'novelty', label: 'Classic or adventurous' },
  { key: 'textures', label: 'Texture' },
  { key: 'flavor_notes', label: 'Flavour notes' },
  { key: 'mood_fit', label: 'Fit for each feeling' },
  { key: 'dayparts', label: 'Time of day' },
];

/** The single-answer trait questions (temperature, caffeine, is_coffee, kind,
 * sweetness, body, intensity, refreshment, indulgence, novelty). */
export const SCALAR_TRAIT_QUESTION_COUNT = 10;

/** How many questions Jev answers about every menu item when it tags traits. */
export const TRAIT_QUESTION_COUNT =
  SCALAR_TRAIT_QUESTION_COUNT + MOODS.length + DAYPARTS.length + TEXTURES.length + FLAVOR_VOCABULARY.length;
