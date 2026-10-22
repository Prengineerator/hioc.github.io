import { describe, expect, it } from 'vitest';
import type { MenuItemChangeRequest, MenuItemChangePayload } from '@/lib/menu/changeRequestTypes';
import {
  actionTone,
  addonGroupName,
  buildRequestDiff,
  categoryLabel,
  changedFieldLabels,
  diffAddonGroups,
  diffVariants,
  formatFieldValue,
  formatIstDateTime,
  formatPrice,
  menuTabFromParam,
  pendingByItemId,
  statusTone,
  type DiffRow,
} from '@/components/owner/menu/menuDiff';

function request(over: Partial<MenuItemChangeRequest>): MenuItemChangeRequest {
  return {
    id: 'req-1',
    action: 'update',
    menu_item_id: 'item-1',
    item_name: 'Cappuccino',
    payload: null,
    snapshot: null,
    status: 'pending',
    requested_by: 'u-1',
    requested_by_name: 'Asha',
    requested_at: '2026-10-19T09:35:00.000Z',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    ...over,
  };
}

const FULL: MenuItemChangePayload = {
  name: 'Cappuccino',
  description: 'Espresso with steamed milk',
  category: 'Coffee',
  parent_category: 'Hot',
  is_veg: true,
  is_available: true,
  in_store_only: false,
  gst_exempt: false,
  sold_by_weight: false,
  sort_order: 3,
  image_url: 'https://img/cap.jpg',
  short_code: 'CAP',
  variants: [
    { label: 'Regular', price_inr: 150 },
    { label: 'Large', price_inr: 190 },
  ],
  addon_group_ids: ['g-milk', 'g-syrup'],
};

const NAMES = { 'g-milk': 'Milk choice', 'g-syrup': 'Syrups', 'g-extra': 'Extras' };

function row(rows: DiffRow[], key: string): DiffRow {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
}

describe('menuTabFromParam', () => {
  it('defaults to items and only accepts approvals', () => {
    expect(menuTabFromParam(null)).toBe('items');
    expect(menuTabFromParam('nope')).toBe('items');
    expect(menuTabFromParam('approvals')).toBe('approvals');
  });
});

describe('formatIstDateTime', () => {
  it('shows an instant on the IST wall clock', () => {
    expect(formatIstDateTime('2026-10-19T09:35:00.000Z')).toBe('19 Oct, 3:05 pm');
  });

  it('rolls over midnight and reads 12 am / 12 pm', () => {
    expect(formatIstDateTime('2026-10-19T19:00:00.000Z')).toBe('20 Oct, 12:30 am');
    expect(formatIstDateTime('2026-10-19T06:30:00.000Z')).toBe('19 Oct, 12:00 pm');
  });

  it('is a dash for a missing or bad value', () => {
    expect(formatIstDateTime(null)).toBe('—');
    expect(formatIstDateTime('')).toBe('—');
    expect(formatIstDateTime('not a date')).toBe('—');
  });
});

describe('formatPrice', () => {
  it('prefixes the rupee sign and groups digits the Indian way', () => {
    expect(formatPrice(0)).toBe('₹0');
    expect(formatPrice(150)).toBe('₹150');
    expect(formatPrice(2400)).toBe('₹2,400');
    expect(formatPrice(120000)).toBe('₹1,20,000');
  });

  it('marks a per-kg price', () => {
    expect(formatPrice(2400, true)).toBe('₹2,400/kg');
  });
});

describe('labels and tones', () => {
  it('reads a category like the item form does', () => {
    expect(categoryLabel('Coffee')).toBe('Hot — Coffee');
    expect(categoryLabel('Cold Brews')).toBe('Cold Brews');
    expect(categoryLabel('Something New')).toBe('Something New');
  });

  it('tones actions and statuses', () => {
    expect(actionTone('create')).toBe('good');
    expect(actionTone('update')).toBe('warn');
    expect(actionTone('delete')).toBe('bad');
    expect(statusTone('approved')).toBe('good');
    expect(statusTone('rejected')).toBe('bad');
    expect(statusTone('pending')).toBe('warn');
    expect(statusTone('cancelled')).toBe('neutral');
  });
});

describe('formatFieldValue', () => {
  it('words booleans per field', () => {
    expect(formatFieldValue('is_veg', true)).toBe('Veg');
    expect(formatFieldValue('is_veg', false)).toBe('Non-veg');
    expect(formatFieldValue('gst_exempt', true)).toBe('Yes');
    expect(formatFieldValue('in_store_only', false)).toBe('No');
  });

  it('shows empty text and a cleared short code as None', () => {
    expect(formatFieldValue('description', '')).toBe('None');
    expect(formatFieldValue('short_code', null)).toBe('None');
    expect(formatFieldValue('short_code', 'CAP')).toBe('CAP');
  });

  it('is null when the request says nothing about the field', () => {
    expect(formatFieldValue('name', undefined)).toBeNull();
  });

  it('formats sort order and category', () => {
    expect(formatFieldValue('sort_order', 0)).toBe('0');
    expect(formatFieldValue('category', 'Coffee')).toBe('Hot — Coffee');
  });
});

describe('diffVariants', () => {
  it('marks same, changed, added and removed sizes', () => {
    const rows = diffVariants(
      [
        { label: 'Small', price_inr: 100 },
        { label: 'Regular', price_inr: 150 },
        { label: 'Large', price_inr: 190 },
      ],
      [
        { label: 'Regular', price_inr: 160 },
        { label: 'Large', price_inr: 190 },
        { label: 'Jumbo', price_inr: 250 },
      ],
    );
    expect(rows).toEqual([
      { label: 'Regular', before: 150, after: 160, status: 'changed' },
      { label: 'Large', before: 190, after: 190, status: 'same' },
      { label: 'Jumbo', before: null, after: 250, status: 'added' },
      { label: 'Small', before: 100, after: null, status: 'removed' },
    ]);
  });

  it('pairs a repeated label off in order', () => {
    const rows = diffVariants(
      [{ label: 'Regular', price_inr: 100 }],
      [
        { label: 'Regular', price_inr: 100 },
        { label: 'Regular', price_inr: 120 },
      ],
    );
    expect(rows.map((r) => r.status)).toEqual(['same', 'added']);
  });

  it('treats a missing side as empty', () => {
    expect(diffVariants(undefined, [{ label: 'Regular', price_inr: 90 }])).toEqual([
      { label: 'Regular', before: null, after: 90, status: 'added' },
    ]);
    expect(diffVariants([{ label: 'Regular', price_inr: 90 }], null)).toEqual([
      { label: 'Regular', before: 90, after: null, status: 'removed' },
    ]);
  });
});

describe('diffAddonGroups', () => {
  it('splits kept, added and removed groups into names', () => {
    expect(diffAddonGroups(['g-milk', 'g-syrup'], ['g-syrup', 'g-extra'], NAMES)).toEqual({
      kept: ['Syrups'],
      added: ['Extras'],
      removed: ['Milk choice'],
    });
  });

  it('names a group that no longer exists neutrally', () => {
    expect(addonGroupName('gone', NAMES)).toBe('Unknown group');
    expect(diffAddonGroups([], ['gone'], NAMES).added).toEqual(['Unknown group']);
  });
});

describe('pendingByItemId', () => {
  it('flags items with a pending edit or delete', () => {
    const map = pendingByItemId([
      request({ id: 'a', menu_item_id: 'item-1', action: 'update' }),
      request({ id: 'b', menu_item_id: 'item-2', action: 'delete' }),
    ]);
    expect(map).toEqual({ 'item-1': 'update', 'item-2': 'delete' });
  });

  it('ignores creates, decided requests and requests without an item', () => {
    const map = pendingByItemId([
      request({ id: 'a', menu_item_id: null, action: 'create' }),
      request({ id: 'b', menu_item_id: 'item-2', action: 'update', status: 'approved' }),
      request({ id: 'c', menu_item_id: 'item-3', action: 'update', status: 'cancelled' }),
      request({ id: 'd', menu_item_id: null, action: 'update' }),
    ]);
    expect(map).toEqual({});
  });

  it('lets a delete win over an edit for the same item', () => {
    const edit = request({ id: 'a', menu_item_id: 'item-1', action: 'update' });
    const del = request({ id: 'b', menu_item_id: 'item-1', action: 'delete' });
    expect(pendingByItemId([edit, del])['item-1']).toBe('delete');
    expect(pendingByItemId([del, edit])['item-1']).toBe('delete');
  });
});

describe('buildRequestDiff: update', () => {
  const update = request({
    action: 'update',
    snapshot: FULL,
    payload: {
      name: 'Cappuccino Classic',
      is_veg: false,
      variants: [
        { label: 'Regular', price_inr: 160 },
        { label: 'Large', price_inr: 190 },
      ],
      addon_group_ids: ['g-syrup', 'g-extra'],
      image_url: '',
      short_code: null,
    },
  });

  it('lists only the changed fields, in form order, as before → after', () => {
    const d = buildRequestDiff(update, NAMES);
    expect(d.mode).toBe('diff');
    expect(d.rows.map((r) => r.key)).toEqual(['name', 'is_veg', 'image_url', 'short_code', 'variants', 'addon_group_ids']);

    expect(row(d.rows, 'name')).toMatchObject({ label: 'Name', before: 'Cappuccino', after: 'Cappuccino Classic' });
    expect(row(d.rows, 'is_veg')).toMatchObject({ label: 'Veg', before: 'Veg', after: 'Non-veg' });
    expect(row(d.rows, 'short_code')).toMatchObject({ label: 'Short code', before: 'CAP', after: 'None' });
    expect(row(d.rows, 'image_url')).toMatchObject({
      label: 'Photo',
      type: 'image',
      before: 'https://img/cap.jpg',
      after: '',
    });
  });

  it('highlights the changed size and names the add-on groups', () => {
    const d = buildRequestDiff(update, NAMES);
    const variants = row(d.rows, 'variants');
    if (variants.type !== 'variants') throw new Error('expected variants row');
    expect(variants.label).toBe('Sizes & prices');
    expect(variants.rows.map((r) => r.status)).toEqual(['changed', 'same']);

    const addons = row(d.rows, 'addon_group_ids');
    if (addons.type !== 'addons') throw new Error('expected addons row');
    expect(addons.label).toBe('Add-on groups');
    expect(addons.diff).toEqual({ kept: ['Syrups'], added: ['Extras'], removed: ['Milk choice'] });
  });

  it('does not show parent_category', () => {
    const d = buildRequestDiff(
      request({ snapshot: FULL, payload: { category: 'Iced Coffee', parent_category: 'Iced Drinks' } }),
      NAMES,
    );
    expect(d.rows.map((r) => r.key)).toEqual(['category']);
    expect(row(d.rows, 'category')).toMatchObject({ before: 'Hot — Coffee', after: 'Iced Drinks — Iced Coffee' });
  });

  it('still renders when the snapshot is missing', () => {
    const d = buildRequestDiff(request({ snapshot: null, payload: { name: 'New name' } }), NAMES);
    expect(row(d.rows, 'name')).toMatchObject({ before: '—', after: 'New name' });
  });

  it('knows when prices are per kg', () => {
    const toWeight = buildRequestDiff(
      request({ snapshot: FULL, payload: { sold_by_weight: true, variants: [{ label: 'Whole beans', price_inr: 2400 }] } }),
      NAMES,
    );
    expect(toWeight.perKg).toEqual({ before: false, after: true });
    const unchanged = buildRequestDiff(
      request({ snapshot: { ...FULL, sold_by_weight: true }, payload: { name: 'Beans' } }),
      NAMES,
    );
    expect(unchanged.perKg).toEqual({ before: true, after: true });
  });

  it('summarises what an edit touches', () => {
    expect(changedFieldLabels(update.payload)).toEqual([
      'Name',
      'Veg',
      'Photo',
      'Short code',
      'Sizes & prices',
      'Add-on groups',
    ]);
    expect(changedFieldLabels(null)).toEqual([]);
  });
});

describe('buildRequestDiff: create', () => {
  const create = request({ action: 'create', menu_item_id: null, item_name: 'Hazelnut Latte', payload: FULL, snapshot: null });

  it('shows every proposed value with no before', () => {
    const d = buildRequestDiff(create, NAMES);
    expect(d.mode).toBe('proposed');
    expect(d.rows.map((r) => r.key)).toEqual([
      'name',
      'description',
      'category',
      'is_veg',
      'is_available',
      'in_store_only',
      'gst_exempt',
      'sold_by_weight',
      'sort_order',
      'image_url',
      'short_code',
      'variants',
      'addon_group_ids',
    ]);
    expect(row(d.rows, 'name')).toMatchObject({ before: null, after: 'Cappuccino' });
    expect(row(d.rows, 'sort_order')).toMatchObject({ before: null, after: '3' });
  });

  it('lists the proposed sizes and groups as additions', () => {
    const d = buildRequestDiff(create, NAMES);
    const variants = row(d.rows, 'variants');
    if (variants.type !== 'variants') throw new Error('expected variants row');
    expect(variants.rows.every((r) => r.status === 'added')).toBe(true);
    const addons = row(d.rows, 'addon_group_ids');
    if (addons.type !== 'addons') throw new Error('expected addons row');
    expect(addons.diff.added).toEqual(['Milk choice', 'Syrups']);
  });
});

describe('buildRequestDiff: delete', () => {
  const del = request({ action: 'delete', payload: null, snapshot: FULL });

  it('shows what is on the menu now, with no after', () => {
    const d = buildRequestDiff(del, NAMES);
    expect(d.mode).toBe('snapshot');
    expect(row(d.rows, 'name')).toMatchObject({ before: 'Cappuccino', after: null });
    const variants = row(d.rows, 'variants');
    if (variants.type !== 'variants') throw new Error('expected variants row');
    expect(variants.rows.every((r) => r.status === 'removed')).toBe(true);
  });

  it('has no rows when the snapshot is missing', () => {
    expect(buildRequestDiff(request({ action: 'delete', payload: null, snapshot: null }), NAMES).rows).toEqual([]);
  });
});
