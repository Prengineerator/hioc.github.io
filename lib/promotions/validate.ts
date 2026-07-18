// Shared request-body validation for the owner coupon CRUD routes
// (app/api/coupons, app/api/coupons/[id]). Kept separate from coupons.ts (the
// FND-3 contract stub) so that file stays focused on checkout-time validation.

import type { Announcement, CouponDiscountType, CouponScope } from '@/lib/types';

export interface CouponWritableFields {
  code?: string;
  description?: string;
  discount_type?: CouponDiscountType;
  discount_value?: number;
  min_order_inr?: number;
  max_discount_inr?: number;
  scope?: CouponScope;
  valid_from?: string | null;
  valid_to?: string | null;
  usage_limit?: number;
  per_user_limit?: number;
  is_auto?: boolean;
  active?: boolean;
}

const NONNEG_INT_FIELDS = [
  'min_order_inr',
  'max_discount_inr',
  'usage_limit',
  'per_user_limit',
] as const;

/**
 * Parses + validates a create/update body for a coupon. `partial` allows a
 * subset of fields (PATCH); a create (partial=false) additionally requires
 * code/discount_type/discount_value.
 */
export function parseCouponInput(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): CouponWritableFields | string {
  const out: CouponWritableFields = {};

  if (body.code !== undefined) {
    if (typeof body.code !== 'string' || body.code.trim().length === 0) {
      return 'code must be a non-empty string';
    }
    out.code = body.code.trim().toUpperCase();
  } else if (!partial) {
    return 'code is required';
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return 'description must be a string';
    out.description = body.description.trim().slice(0, 300);
  }

  if (body.discount_type !== undefined) {
    if (body.discount_type !== 'percent' && body.discount_type !== 'flat') {
      return "discount_type must be 'percent' or 'flat'";
    }
    out.discount_type = body.discount_type;
  } else if (!partial) {
    return 'discount_type is required';
  }

  if (body.discount_value !== undefined) {
    if (typeof body.discount_value !== 'number' || !Number.isInteger(body.discount_value) || body.discount_value < 0) {
      return 'discount_value must be a non-negative integer';
    }
    if (
      (out.discount_type ?? body.discount_type) === 'percent' &&
      body.discount_value > 100
    ) {
      return 'discount_value must be at most 100 for a percent coupon';
    }
    out.discount_value = body.discount_value;
  } else if (!partial) {
    return 'discount_value is required';
  }

  for (const field of NONNEG_INT_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return `${field} must be a non-negative integer`;
    }
    (out as Record<string, number>)[field] = value;
  }

  if (body.scope !== undefined) {
    if (typeof body.scope !== 'object' || body.scope === null || Array.isArray(body.scope)) {
      return 'scope must be an object';
    }
    const scope = body.scope as Record<string, unknown>;
    const item_ids = scope.item_ids;
    const category = scope.category;
    if (item_ids !== undefined && (!Array.isArray(item_ids) || item_ids.some((v) => typeof v !== 'string'))) {
      return 'scope.item_ids must be an array of strings';
    }
    if (category !== undefined && (!Array.isArray(category) || category.some((v) => typeof v !== 'string'))) {
      return 'scope.category must be an array of strings';
    }
    out.scope = {
      item_ids: (item_ids as string[] | undefined) ?? [],
      category: (category as string[] | undefined) ?? [],
    };
  }

  for (const field of ['valid_from', 'valid_to'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `${field} must be an ISO timestamp or null`;
    }
    out[field] = new Date(value).toISOString();
  }

  if (body.is_auto !== undefined) {
    if (typeof body.is_auto !== 'boolean') return 'is_auto must be a boolean';
    out.is_auto = body.is_auto;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return 'active must be a boolean';
    out.active = body.active;
  }

  return out;
}

const MAX_ANNOUNCEMENT_TITLE_LENGTH = 150;
const MAX_ANNOUNCEMENT_BODY_LENGTH = 1000;

/**
 * Parses + validates a create/update body for a homepage announcement/banner
 * (LOY-5). `partial` allows a subset of fields (PATCH); a create
 * (partial=false) additionally requires `title`.
 */
export function parseAnnouncementInput(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): Partial<Announcement> | string {
  const out: Partial<Announcement> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return 'title must be a non-empty string';
    }
    out.title = body.title.trim().slice(0, MAX_ANNOUNCEMENT_TITLE_LENGTH);
  } else if (!partial) {
    return 'title is required';
  }

  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return 'body must be a string';
    out.body = body.body.trim().slice(0, MAX_ANNOUNCEMENT_BODY_LENGTH);
  }
  if (body.image_url !== undefined) {
    if (typeof body.image_url !== 'string') return 'image_url must be a string';
    out.image_url = body.image_url.trim();
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return 'active must be a boolean';
    out.active = body.active;
  }
  for (const field of ['starts_at', 'ends_at'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `${field} must be an ISO timestamp or null`;
    }
    out[field] = new Date(value).toISOString();
  }

  return out;
}
