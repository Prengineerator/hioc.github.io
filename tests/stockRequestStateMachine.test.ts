import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canCancel,
  cancelGuardStatuses,
  cancellableStatuses,
  cancelNeedsReason,
  canPick,
  canReceive,
  FINAL_REQUEST_STATUSES,
  isOpenRequestStatus,
  nextStep,
  OPEN_REQUEST_STATUSES,
  REQUEST_STATUSES,
  STOCK_REQUEST_TRANSITIONS,
  STOCK_ROUTES,
  stepFromStatuses,
  stepWriter,
  stockRequestTransition,
  type RequestActor,
  type RequestFacts,
  type StockRequestStatus,
  type StockRoute,
} from '@/lib/inventory/rules';
import {
  awaitingDispatch,
  canReceiveReturn,
  isInTransit,
  ownerWaiting,
  phaseRows,
  transferPhase,
  type TransferFacts,
} from '@/lib/inventory/warehouse';

// The stock request lifecycle (lib/inventory/rules.ts STOCK_REQUEST_TRANSITIONS):
// the table, the guards and screen groupings read from it, and the database
// half (supabase/2026-11-menu-inventory-state-machine.sql).

const staff: RequestActor = { userId: 'asha', role: 'staff', surface: 'pos' };
const other: RequestActor = { userId: 'meera', role: 'staff', surface: 'pos' };
const manager: RequestActor = { userId: 'boss', role: 'manager', surface: 'pos' };
const owner: RequestActor = { userId: 'owner', role: 'owner', surface: 'web' };

const facts = (status: StockRequestStatus, route: StockRoute, over: Partial<RequestFacts> = {}): RequestFacts => ({
  status,
  route,
  requested_by: 'asha',
  assigned_to: 'vikram',
  picked_by: 'vikram',
  ...over,
});

describe('the transition table', () => {
  it('reads as the lifecycle, route by route', () => {
    const rows = STOCK_REQUEST_TRANSITIONS.map((t) => `${t.step} ${t.from ?? '∅'}→${t.to} [${t.routes.join(',')}] ${t.writer}`);
    expect(rows).toEqual([
      'create ∅→requested [store_room] inventory_create_request',
      'create ∅→requested [from_warehouse] warehouse_create_request',
      'create ∅→picked [to_warehouse] warehouse_create_return',
      'assign requested→assigned [store_room,from_warehouse] app',
      'assign assigned→assigned [store_room,from_warehouse] app',
      'pick assigned→picked [store_room] inventory_pick',
      'pick assigned→picked [from_warehouse] warehouse_dispatch',
      'receive picked→received [store_room,from_warehouse] inventory_receive',
      'receive_return picked→received [to_warehouse] warehouse_receive_return',
      'cancel requested→cancelled [store_room,from_warehouse,to_warehouse] app',
      'cancel assigned→cancelled [store_room,from_warehouse,to_warehouse] app',
      'cancel picked→cancelled [store_room] app',
    ]);
  });

  it('has no way out of a final status, and open = not final', () => {
    for (const s of FINAL_REQUEST_STATUSES) {
      expect(STOCK_REQUEST_TRANSITIONS.some((t) => t.from === s)).toBe(false);
      expect(isOpenRequestStatus(s)).toBe(false);
    }
    expect(OPEN_REQUEST_STATUSES).toEqual(['requested', 'assigned', 'picked']);
    expect([...OPEN_REQUEST_STATUSES, ...FINAL_REQUEST_STATUSES].sort()).toEqual([...REQUEST_STATUSES].sort());
  });

  it('gives each step its from-statuses per route (the writes’ guards)', () => {
    expect(stepFromStatuses('assign', 'store_room')).toEqual(['requested', 'assigned']);
    expect(stepFromStatuses('assign', 'from_warehouse')).toEqual(['requested', 'assigned']);
    expect(stepFromStatuses('assign', 'to_warehouse')).toEqual([]);
    expect(stepFromStatuses('pick', 'to_warehouse')).toEqual([]);
    // An older row with no route is a store-room one.
    expect(stepFromStatuses('cancel', null)).toEqual(['requested', 'assigned', 'picked']);
    expect(stockRequestTransition('pick', 'assigned', undefined)?.writer).toBe('inventory_pick');
  });

  it('walks each route forward to received', () => {
    const walk = (route: StockRoute, start: StockRequestStatus) => {
      const steps: string[] = [];
      let status: StockRequestStatus | null = start;
      while (status) {
        const step = nextStep(status, route);
        if (!step) break;
        steps.push(step);
        status = stockRequestTransition(step, status, route)?.to ?? null;
      }
      return { steps, end: status };
    };
    expect(walk('store_room', 'requested')).toEqual({ steps: ['assign', 'pick', 'receive'], end: 'received' });
    expect(walk('from_warehouse', 'requested')).toEqual({ steps: ['assign', 'pick', 'receive'], end: 'received' });
    expect(walk('to_warehouse', 'picked')).toEqual({ steps: ['receive_return'], end: 'received' });
  });
});

describe('routes never cross', () => {
  it('each step goes through its own route’s function, or none', () => {
    expect(stepWriter('pick', 'store_room')).toBe('inventory_pick');
    expect(stepWriter('pick', 'from_warehouse')).toBe('warehouse_dispatch');
    expect(stepWriter('pick', 'to_warehouse')).toBeNull();
    expect(stepWriter('receive', 'store_room')).toBe('inventory_receive');
    expect(stepWriter('receive', 'from_warehouse')).toBe('inventory_receive');
    expect(stepWriter('receive', 'to_warehouse')).toBeNull();
    expect(stepWriter('receive_return', 'to_warehouse')).toBe('warehouse_receive_return');
    expect(stepWriter('receive_return', 'from_warehouse')).toBeNull();
  });

  it('the guards refuse a return at the store-room steps, whatever its status', () => {
    for (const status of REQUEST_STATUSES) {
      for (const actor of [staff, manager, { ...owner, surface: 'pos' as const }]) {
        expect(canPick(facts(status, 'to_warehouse'), actor).ok).toBe(false);
        expect(canReceive(facts(status, 'to_warehouse', { picked_by: 'x', assigned_to: 'x' }), actor).ok).toBe(false);
      }
    }
  });

  it('only a return is counted in at the warehouse', () => {
    const t = (route: StockRoute): TransferFacts => ({ route, status: 'picked', hasDiscrepancy: false, resolvedAt: null });
    expect(canReceiveReturn(t('to_warehouse'), owner).ok).toBe(true);
    expect(canReceiveReturn(t('from_warehouse'), owner).ok).toBe(false);
    expect(canReceiveReturn(t('store_room'), owner).ok).toBe(false);
    expect(canReceiveReturn({ ...t('to_warehouse'), status: 'received' }, owner).ok).toBe(false);
  });
});

describe('cancel: one rule for the button, the check and the write', () => {
  it('may leave requested/assigned on every route, picked only from the store room', () => {
    expect(cancellableStatuses('store_room')).toEqual(['requested', 'assigned', 'picked']);
    expect(cancellableStatuses('from_warehouse')).toEqual(['requested', 'assigned']);
    expect(cancellableStatuses('to_warehouse')).toEqual(['requested', 'assigned']);
  });

  it('canCancel allows exactly the statuses the write is guarded on, for every actor and route', () => {
    for (const route of STOCK_ROUTES) {
      for (const actor of [staff, other, manager, owner]) {
        const guard = cancelGuardStatuses({ requested_by: 'asha', route }, actor);
        for (const status of REQUEST_STATUSES) {
          expect(canCancel(facts(status, route), actor).ok).toBe(guard.includes(status));
        }
      }
    }
  });

  it('the requester only while still requested; a manager any cancellable status; anyone else nothing', () => {
    expect(cancelGuardStatuses({ requested_by: 'asha', route: 'store_room' }, staff)).toEqual(['requested']);
    expect(cancelGuardStatuses({ requested_by: 'asha', route: 'store_room' }, other)).toEqual([]);
    expect(cancelGuardStatuses({ requested_by: 'asha', route: 'from_warehouse' }, manager)).toEqual(['requested', 'assigned']);
    // A manager who asked for it themselves still gets the manager's reach.
    expect(cancelGuardStatuses({ requested_by: 'boss', route: 'store_room' }, manager)).toEqual(['requested', 'assigned', 'picked']);
  });

  it('a transfer on the road is a 409 (count it in and settle), not a 403', () => {
    expect(canCancel(facts('picked', 'from_warehouse'), manager)).toMatchObject({ ok: false, status: 409 });
    expect(canCancel(facts('picked', 'to_warehouse'), owner)).toMatchObject({ ok: false, status: 409 });
    expect(canCancel(facts('received', 'store_room'), manager)).toMatchObject({ ok: false, status: 409 });
  });

  it('needs a reason except for the requester withdrawing their own unassigned request', () => {
    expect(cancelNeedsReason(facts('requested', 'store_room'), staff)).toBe(false);
    expect(cancelNeedsReason(facts('assigned', 'store_room'), staff)).toBe(true);
    expect(cancelNeedsReason(facts('requested', 'store_room'), manager)).toBe(true);
  });
});

describe('transfer phases (the Warehouse page groups and badge)', () => {
  const t = (route: StockRoute, status: StockRequestStatus, hasDiscrepancy = false, resolvedAt: string | null = null): TransferFacts => ({
    route,
    status,
    hasDiscrepancy,
    resolvedAt,
  });

  it('places every warehouse transfer by the step it is waiting on', () => {
    expect(transferPhase(t('from_warehouse', 'requested'))).toBe('to_assign');
    expect(transferPhase(t('from_warehouse', 'assigned'))).toBe('to_dispatch');
    expect(transferPhase(t('from_warehouse', 'picked'))).toBe('on_road');
    expect(transferPhase(t('from_warehouse', 'received'))).toBe('closed');
    expect(transferPhase(t('from_warehouse', 'received', true))).toBe('to_settle');
    expect(transferPhase(t('from_warehouse', 'received', true, '2026-11-01T00:00:00Z'))).toBe('closed');
    expect(transferPhase(t('from_warehouse', 'cancelled'))).toBe('closed');
    expect(transferPhase(t('to_warehouse', 'picked'))).toBe('to_count_in');
    expect(transferPhase(t('to_warehouse', 'received', true))).toBe('to_settle');
    expect(transferPhase(t('to_warehouse', 'received'))).toBe('closed');
    expect(transferPhase(t('store_room', 'requested'))).toBeNull();
  });

  it('in transit = on the road either way; awaiting dispatch = asked, not sent', () => {
    expect(isInTransit(t('from_warehouse', 'picked'))).toBe(true);
    expect(isInTransit(t('to_warehouse', 'picked'))).toBe(true);
    expect(isInTransit(t('store_room', 'picked'))).toBe(false);
    expect(isInTransit(t('from_warehouse', 'received'))).toBe(false);
    expect(awaitingDispatch(t('from_warehouse', 'requested'))).toBe(true);
    expect(awaitingDispatch(t('from_warehouse', 'assigned'))).toBe(true);
    expect(awaitingDispatch(t('from_warehouse', 'picked'))).toBe(false);
    expect(awaitingDispatch(t('store_room', 'assigned'))).toBe(false);
  });

  it('counts in the database exactly the rows the page groups (the header badge)', () => {
    expect(phaseRows('to_assign')).toEqual([{ route: 'from_warehouse', status: 'requested', unsettled: false }]);
    expect(phaseRows('to_dispatch')).toEqual([{ route: 'from_warehouse', status: 'assigned', unsettled: false }]);
    expect(phaseRows('to_count_in')).toEqual([{ route: 'to_warehouse', status: 'picked', unsettled: false }]);
    expect(phaseRows('to_settle')).toEqual([
      { route: 'from_warehouse', status: 'received', unsettled: true },
      { route: 'to_warehouse', status: 'received', unsettled: true },
    ]);
    expect(
      ownerWaiting([
        t('from_warehouse', 'requested'),
        t('from_warehouse', 'assigned'),
        t('from_warehouse', 'picked'),
        t('to_warehouse', 'picked'),
        t('to_warehouse', 'received', true),
        t('from_warehouse', 'cancelled'),
      ]),
    ).toEqual({ toAssign: 1, toDispatch: 1, toReceive: 1, toSettle: 1, total: 4 });
  });
});

describe('supabase/2026-11-menu-inventory-state-machine.sql', () => {
  const root = path.resolve(__dirname, '..');
  const sql = fs.readFileSync(path.join(root, 'supabase/2026-11-menu-inventory-state-machine.sql'), 'utf8');
  const original = fs.readFileSync(path.join(root, 'supabase/2026-10-inventory.sql'), 'utf8');
  const fn = (text: string, name: string) => {
    const start = text.indexOf(`create or replace function ${name}(`);
    return text.slice(start, text.indexOf('end $$;', start) + 'end $$;'.length);
  };
  // Drops the guard this file adds (its comment and the if-block after it).
  const withoutAdded = (body: string) =>
    body.replace(/\n *-- Added by this file:[\s\S]*?\n *end if;/g, '');

  it('re-creates inventory_pick and inventory_receive as they are, plus only the route check', () => {
    for (const name of ['inventory_pick', 'inventory_receive']) {
      const redefined = fn(sql, name);
      expect(redefined).toContain('Added by this file');
      expect(withoutAdded(redefined)).toBe(fn(original, name));
    }
  });

  it('reads the route through to_jsonb, so it works before the warehouse migration', () => {
    expect(fn(sql, 'inventory_pick')).toContain("coalesce(to_jsonb(r) ->> 'route', 'store_room') <> 'store_room'");
    expect(fn(sql, 'inventory_receive')).toContain("coalesce(to_jsonb(r) ->> 'route', 'store_room') = 'to_warehouse'");
    expect(fn(sql, 'inventory_pick')).not.toMatch(/\br\.route\b/);
  });

  it('nothing after 2026-10-inventory.sql defines either function (so that is the one to copy)', () => {
    const others = fs
      .readdirSync(path.join(root, 'supabase'))
      .filter((f) => f.endsWith('.sql') && f !== '2026-10-inventory.sql' && f !== '2026-11-menu-inventory-state-machine.sql');
    for (const f of others) {
      const text = fs.readFileSync(path.join(root, 'supabase', f), 'utf8');
      expect(text).not.toMatch(/create or replace function (public\.)?inventory_(pick|receive)\(/);
    }
  });

  it('keeps the grants, and adds applied_at once (stamping only approvals made before it)', () => {
    expect(sql).toContain('grant execute on function inventory_pick(uuid, uuid, boolean, jsonb) to service_role;');
    expect(sql).toContain('grant execute on function inventory_receive(uuid, uuid, uuid, jsonb) to service_role;');
    expect(sql).toMatch(/if not exists \([\s\S]*column_name = 'applied_at'[\s\S]*add column applied_at timestamptz;[\s\S]*where status = 'approved';/);
    expect(sql).toContain("check (applied_at is null or status = 'approved')");
  });
});
