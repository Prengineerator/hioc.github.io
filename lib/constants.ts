// Static brand/contact constants shared across public + staff pages.
// Keep in sync with copy blocks supplied by the manager spec — do not
// paraphrase these values elsewhere; import from here instead.

export const CAFE_NAME = 'HIOC.';

export const CAFE_ADDRESS =
  'E/773, Near V Mart, Kamla Nagar, Agra, Uttar Pradesh 282004, India';

export const CAFE_HOURS = 'Open all days, 10:00 AM – 12:00 AM';

export const CAFE_HOURS_HOME = 'Open Daily, 10:00 AM – 12:00 AM';

export const CAFE_PHONE_DISPLAY = '+91 56279 63898';

export const CAFE_PHONE_HREF = 'tel:+915627963898';

export const CAFE_INSTAGRAM_URL = 'https://www.instagram.com/hioc.in/';

export const CAFE_INSTAGRAM_HANDLE = '@hioc.in';

export const CAFE_MAPS_EMBED_SRC =
  'https://www.google.com/maps?q=E%2F773%2C+Near+V+Mart%2C+Kamla+Nagar%2C+Agra%2C+Uttar+Pradesh+282004%2C+India&output=embed';

// The cafe's real menu categories, sourced from its live Petpooja POS export
// (Menu_sheet.zip) — `slug` is the exact `category` value stored on each
// menu_items row. `parent` groups related categories (e.g. Hot Coffee /
// Hot Non-Coffee both belong to "Hot") and is '' when a category has no
// parent group. Order here is the display order on /menu and the homepage.
export const MENU_CATEGORIES: {
  slug: string;
  label: string;
  parent: string;
}[] = [
  { slug: 'Coffee', label: 'Coffee', parent: 'Hot' },
  { slug: 'Hot Non-Coffee', label: 'Hot Non-Coffee', parent: 'Hot' },
  { slug: 'Creme Coffee', label: 'Crème Coffee', parent: 'Creme' },
  { slug: 'Creme Non-Coffee', label: 'Crème Non-Coffee', parent: 'Creme' },
  { slug: 'Iced Coffee', label: 'Iced Coffee', parent: 'Iced Drinks' },
  { slug: 'Iced Non-Coffee', label: 'Iced Non-Coffee', parent: 'Iced Drinks' },
  { slug: 'Cold Brews', label: 'Cold Brews', parent: '' },
  { slug: 'Stick Waffles', label: 'Stick Waffles', parent: 'Waffles' },
  { slug: 'Stuffed Waffles', label: 'Stuffed Waffles', parent: 'Waffles' },
  { slug: 'Sundae', label: 'Sundae', parent: '' },
  { slug: 'Waffle Crepes', label: 'Waffle Crepes', parent: '' },
  { slug: 'Waffle Chips', label: 'Waffle Chips', parent: '' },
  { slug: 'Eatery', label: 'Eatery', parent: '' },
  { slug: 'Cup Cakes', label: 'Cup Cakes', parent: '' },
  { slug: 'Cheesecakes', label: 'Cheesecakes', parent: '' },
  { slug: 'Monthly Drops', label: 'Monthly Drops', parent: '' },
];
