// Limits on an add-on group, shared by the add-on form (client) and the server
// validator (lib/menu/addonChanges.ts), so the form refuses what the API would.

export const ADDON_NAME_MAX = 60;
export const ADDON_OPTIONS_MAX = 30;
export const ADDON_PRICE_MAX = 100_000;
