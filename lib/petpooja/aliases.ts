// Confident Petpooja -> current-menu renames, keyed by the NORMALIZED
// Petpooja item name (see match.ts's normalize()) so lookups are a plain
// object hit; values are the exact (case-sensitive) menu item name.
//
// Built by comparing the real 'Items' column of the four Petpooja order
// exports (Aug 2023 – Sep 2026) against the live menu snapshot, and — for
// renames — checking each pair's first/last sale dates: an old name that
// stops selling as the new one starts is a rename, two names sold side by
// side for months are two items.
//
// The menu was relaunched in mid-May 2024: the old names (Frappes, Shakes,
// 'Hot Chocolate', 'Mocha', ...) stop around 10–12 May 2024, '[N]'-marked
// names with a category suffix ('Hazelnut Creme Coffee [N]', 'Oreo
// Non-Coffee [N]') run 13 May – ~17 Jun 2024 (match.ts strips the suffix),
// and today's names start ~17–19 Jun 2024. Each old item maps to the
// current item its '[N]' successor became.
//
// Deliberately left unmatched rather than guessed (a wrong match is worse
// than none — see match.ts): discontinued lines with no successor on the
// menu (Crepes, Fries, Sandwiches other than the two below, scoops, other
// Shakes), non-menu lines ('Water Bottle', 'Corporate Coffee', 'Paper Bag',
// 'Beans Sell'), 'Chocochip Creme' / 'Choco-chip Frappe' (still sold in
// Petpooja but not on this app's menu), and names sold alongside several
// current items ('Rose', 'Rose Frappe', 'Cheesecake', 'Truffle Slice').
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

  // Spelling fixes: each old spelling stops as the menu's starts.
  'cappuccino': 'Cappucino', // until 3 Jun 2024; 'Cappucino' from 18 Jun
  'cappuccino iced': 'Cappucino Iced',
  'expresso': 'Espresso',
  'cinnoffle': 'Cinoffle',
  '90s sundae': "90's Sundae",
  'devils fantasy': "Devil's Fantasy",
  'on the rocks iced': 'On The Rocks', // 'On The Rocks Iced Coffee [N]' after match.ts strips ' coffee'

  // Name shortened / lengthened, same item.
  'devil s fantasy sundae': "Devil's Fantasy",
  'devils own': 'Devils Own Stuffed',
  'nutella croissant': 'Nutella Almond Croissant', // until 3 Jul 2024; new name from 4 Jul
  'signature chocolate': 'Signature Chocolate Creme', // 17–18 Jun 2024; Creme from 19 Jun
  'hioc s signature': "Hioc's Signature Creme",

  // Per-flavour Cremes. The flavour is part of the Petpooja name, so a
  // plain name -> name alias covers each one.
  'fruits creme (strawberry)': 'Fruity Strawberry Creme',
  'fruits creme (mango)': 'Fruity Mango Creme',
  'fruits (strawberry)': 'Fruity Strawberry Creme', // 'Fruits (Strawberry) Non-Coffee [N]'
  'fruits (mango)': 'Fruity Mango Creme',
  'minion (nutella banana)': 'Minion Creme (Nutella-Banana)', // '... Non-Coffee [N]'

  // Pre-relaunch (Aug 2023 – May 2024) names -> the current item their
  // '[N]' successor became. Frappes -> '<flavour> Creme Coffee [N]' -> Creme;
  // Shakes -> '<flavour> Non-Coffee [N]' -> Creme.
  'hot chocolate': 'Signature Hot Chocolate', // until 12 May; '... Non-Coffee [N]' from 14 May
  'mocha': 'Signature Mocha', // until 10 May; 'Signature Mocha Coffee [N]' from 14 May
  'mocha iced': 'Signature Mocha Iced',
  'signature frappe': "Hioc's Signature Creme",
  'hazelnut frappe': 'Hazelnut Creme',
  'caramel frappe': 'Caramel Creme',
  'caramel chips frappe': 'Caramel Chip Creme',
  'cookie crumble frappe': 'Cookie Crumble Creme',
  'lotus biscoff frappe': 'Lotus Biscoff Creme',
  'oreo shake': 'Oreo Creme',
  'krazy kitkat shake': 'Krazy Kitkat Creme',
  'chocolate shakes': 'Signature Chocolate Creme',
  'strawberry shakes': 'Fruity Strawberry Creme',
};
