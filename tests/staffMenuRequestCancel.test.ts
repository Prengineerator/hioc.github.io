import { describe, expect, it } from 'vitest';
import { canCancelMenuRequest, parseMenuRequestViewer } from '@/components/staff/menu/requestViewer';

// Which pending menu requests show a Cancel button. The cancel route
// (DELETE /api/menu/requests/[id]) makes the real decision; this only mirrors it
// so staff aren't offered a button that answers 403.

const mine = { requested_by: 'ravi' };
const theirs = { requested_by: 'kiran' };

describe('canCancelMenuRequest', () => {
  it('lets staff cancel their own requests only', () => {
    const staff = { id: 'ravi', role: 'staff' };
    expect(canCancelMenuRequest(mine, staff, true)).toBe(true);
    expect(canCancelMenuRequest(theirs, staff, true)).toBe(false);
  });

  it('lets a manager or the owner cancel anyone\'s', () => {
    expect(canCancelMenuRequest(theirs, { id: 'asha', role: 'manager' }, true)).toBe(true);
    expect(canCancelMenuRequest(theirs, { id: 'owner-1', role: 'owner' }, true)).toBe(true);
  });

  it('offers nothing where the menu can\'t be edited, or while the viewer is unknown', () => {
    expect(canCancelMenuRequest(mine, { id: 'ravi', role: 'staff' }, false)).toBe(false);
    expect(canCancelMenuRequest(theirs, { id: 'asha', role: 'manager' }, false)).toBe(false);
    expect(canCancelMenuRequest(mine, null, true)).toBe(false);
  });

  it('never matches a request with no requester to a viewer', () => {
    expect(canCancelMenuRequest({ requested_by: null }, { id: 'ravi', role: 'staff' }, true)).toBe(false);
  });
});

describe('parseMenuRequestViewer', () => {
  it('reads { id, role } and nothing else', () => {
    expect(parseMenuRequestViewer({ id: 'ravi', role: 'staff', extra: 1 })).toEqual({ id: 'ravi', role: 'staff' });
    expect(parseMenuRequestViewer(undefined)).toBeNull();
    expect(parseMenuRequestViewer(null)).toBeNull();
    expect(parseMenuRequestViewer({ id: 'ravi' })).toBeNull();
    expect(parseMenuRequestViewer({ id: 1, role: 'staff' })).toBeNull();
    expect(parseMenuRequestViewer('ravi')).toBeNull();
  });
});
