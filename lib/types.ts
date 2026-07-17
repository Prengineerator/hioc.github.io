// TypeScript mirror of the Supabase schema (supabase/schema.sql).
// Keep this in exact sync with that file — do not let the two drift.

export type OrderStatus = 'received' | 'preparing' | 'ready' | 'completed';
export type AddonSelectionType = 'single' | 'multi';

export interface MenuItemVariant {
  id: string;
  menu_item_id: string;
  label: string;
  price_inr: number;
  sort_order: number;
}

export interface AddonOption {
  id: string;
  addon_group_id: string;
  name: string;
  price_inr: number;
  sort_order: number;
}

export interface AddonGroup {
  id: string;
  name: string;
  display_name: string;
  selection_type: AddonSelectionType;
  min_select: number;
  max_select: number;
  sort_order: number;
  options: AddonOption[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: string;
  parent_category: string;
  is_veg: boolean;
  is_available: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  variants: MenuItemVariant[];
  addon_groups: AddonGroup[];
}

export interface Order {
  id: string;
  order_number: number;
  customer_name: string;
  customer_phone: string;
  pickup_time: string;
  status: OrderStatus;
  subtotal_inr: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface OrderItemAddon {
  id: string;
  order_item_id: string;
  addon_option_id: string | null;
  group_name_snapshot: string;
  option_name_snapshot: string;
  price_inr_snapshot: number;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  variant_id: string | null;
  name_snapshot: string;
  variant_label_snapshot: string;
  price_inr_snapshot: number;
  quantity: number;
  line_total_inr: number;
  addons: OrderItemAddon[];
}
