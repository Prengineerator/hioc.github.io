// Confident Petpooja -> current-menu renames, keyed by the NORMALIZED
// Petpooja item name (see match.ts's normalize()) so lookups are a plain
// object hit; values are the exact (case-sensitive) menu item name.
//
// Built by comparing the real 'Items' column of the four Petpooja order
// exports (182 distinct item names, ~54.9k line occurrences) against the
// live menu snapshot. With this table, the generic exact/waffle-suffix/
// plural rules in match.ts resolve 94.5% of occurrences (152/182 distinct
// names). Genuinely discontinued or too-ambiguous-to-guess names — all
// Crepes flavours (not on the current menu at all), 'Corporate Coffee',
// 'Water Bottle', 'Paper Bag', 'Beans Sell', bare 'Rose'/'Cheesecake'/
// 'Truffle Slice' (each could mean several current items), 'Fruits Creme
// (mango|strawberry)' (the current menu split this into two separate
// per-flavour items, which a flat name->name alias can't express) — are
// deliberately left unmatched rather than guessed; a wrong match is worse
// than none (see match.ts).
export const ITEM_ALIASES: Record<string, string> = {
  // Same toasted-bread item; 'Garlic Bread' (946x) and 'Garlic Bread Toast'
  // (306x) never appear as two separate line items on the same bill.
  'garlic bread': 'Garlic Bread Toast',

  // Plural POS entry for the same single-variant cheesecake (also handled
  // by the generic trailing-'s' rule; listed for clarity).
  'biscoff cheesecakes': 'Biscoff Cheesecake',

  // Missing the word 'Cheese' + hyphen dropped; same sandwich.
  'indo cottage cheese sandwich': 'Indo-Cottage Sandwich',

  // Missing the word 'Sandwich'; same item.
  'cheesy mushroom': 'Cheesy Mushroom Sandwich',

  // Petpooja spells 'Kitkat' solid where the menu hyphenates 'Kit-kat';
  // both have the same B/L waffle-flavour variant pair.
  'krazy kitkat waffle': 'Krazy Kit-kat',

  // 'X Waffle Chips' is Petpooja's name for the same flavour's Regular
  // no-waffle-base version now just called 'X Chips' on the menu.
  'tripple choco waffle chips': 'Tripple Choco Chips',
  'choco chip waffle chips': 'Choco-Chip Chips',
  'black forest waffle chips': 'Black Forest Chips',
  'valentino waffle chips': 'Valentino Chips',
  'crumble waffle chips': 'Crumble Chips',

  // Petpooja appended the category name ('Iced Non-Coffee') to these four
  // iced-drink names; same drinks.
  'berry lemonata iced non coffee': 'Berry Lemonata Iced',
  'sunrise iced non coffee': 'Sunrise Iced',
  'raspberry cream iced non coffee': 'Raspberry Cream Iced',
  'choco berry iced non coffee': 'Choco Berry Iced',

  // Word order swapped; same drink (Large/Extra Large both sides).
  'nutella mocha iced': 'Nutella Iced Mocha',

  // 'Stick' is Petpooja's old name for the same B/L waffle item.
  'cinoffle stick': 'Cinoffle',

  // Trailing '*' annotation on an otherwise-identical name.
  'ginger orange honey tea*': 'Ginger Orange Honey Tea',

  // 'Cake' -> 'Slice' format rename, same flavour, both single-variant.
  'choco truffle cake': 'Choco Truffle Slice',
};
