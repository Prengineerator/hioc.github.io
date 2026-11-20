import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// supabase/2026-11-shop-amazon-shipping.sql adds Amazon Shipping columns to
// shop_orders. The unit tests mock Supabase, so pin the file's shape here.

const sql = readFileSync(path.resolve(__dirname, '../supabase/2026-11-shop-amazon-shipping.sql'), 'utf8');
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('shop Amazon Shipping migration', () => {
  it('adds exactly the agreed columns, idempotently', () => {
    for (const col of [
      'carrier             text',
      'amazon_shipment_id  text',
      'amazon_service_name text',
      'amazon_charge_inr   numeric(10, 2)',
      'amazon_status       text',
      'amazon_booking_at   timestamptz',
    ]) {
      expect(code).toContain(`add column if not exists ${col}`);
    }
  });

  it('limits carrier to shiprocket/amazon and the charge to >= 0', () => {
    expect(code).toMatch(/carrier is null or carrier in \('shiprocket', 'amazon'\)/);
    expect(code).toMatch(/amazon_charge_inr is null or amazon_charge_inr >= 0/);
  });

  it('has a partial unique index on amazon_shipment_id', () => {
    expect(code).toMatch(/create unique index if not exists \w+\s+on shop_orders \(amazon_shipment_id\) where amazon_shipment_id is not null/);
  });

  it('is additive: no drops, renames, new statuses, policies or grants', () => {
    expect(code).not.toMatch(/\bdrop\b|\brename\b|\bdelete\b|\bupdate\b\s+shop_orders|create policy|\bgrant\b/i);
    expect(code).not.toMatch(/shop_orders_status_check/);
  });

  it('ends with a Verify section', () => {
    expect(sql).toMatch(/-- Verify/);
  });
});
