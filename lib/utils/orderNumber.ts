/**
 * Formats the numeric `order_number` column (Postgres identity column
 * starting at 1001, see supabase/schema.sql) into the customer-facing
 * "HIOC-001001" style order code used on the confirmation page.
 */
export function formatOrderNumber(orderNumber: number): string {
  return `HIOC-${String(orderNumber).padStart(6, '0')}`;
}
