import { describe, expect, it } from 'vitest';
import { parseCustomerCsv } from '@/lib/petpooja/customers';

// All names/phones/emails below are invented (PII rule: never real customer data).
// Row 3's "Restaurant Address" field is quoted and contains a literal
// embedded newline, matching the real title block shape.
const CSV_TEXT = [
  'Name:,"Customer Report"',
  '"Restaurant Name:",Test Cafe',
  '"Restaurant Address:","123 Test Street, Test City\n"',
  '',
  'Name,Favourite,Phone,Email,"Date of Birth","Date of Anniversary","Primary Address","Primary Locality","Do not send any Updates","GST No","From Where",Created,Tags',
  "Test Customer,No,'9876500001,,,,,,No,,POS,\"1 Jan 2024\",",
  "Favourite Customer,Yes,'9876500002,test@example.com,\"25 Sep 2000\",,,,No,,POS,\"2 Jun 2024\",",
  ",No,'08069454407,,,,,,No,,POS,\"3 Jun 2024\",", // 11-digit landline -> skip
  ",No,'127,,,,,,No,,POS,\"4 Jun 2024\",", // too short -> skip
].join('\n');

describe('parseCustomerCsv', () => {
  it('skips the title block (incl. a quoted field with an embedded newline) and finds the header', () => {
    const { customers } = parseCustomerCsv(CSV_TEXT);
    expect(customers).toHaveLength(2);
  });

  it('strips the leading apostrophe from Phone and normalizes it', () => {
    const { customers } = parseCustomerCsv(CSV_TEXT);
    expect(customers[0].phone).toBe('+919876500001');
    expect(customers[1].phone).toBe('+919876500002');
  });

  it('parses Favourite, email, and DOB', () => {
    const { customers } = parseCustomerCsv(CSV_TEXT);
    const [plain, fav] = customers;
    expect(plain.name).toBe('Test Customer');
    expect(plain.is_favourite).toBe(false);
    expect(plain.date_of_birth).toBeNull();

    expect(fav.name).toBe('Favourite Customer');
    expect(fav.is_favourite).toBe(true);
    expect(fav.email).toBe('test@example.com');
    expect(fav.date_of_birth).toBe('2000-09-25');
  });

  it('parses Created as petpooja_created_on', () => {
    const { customers } = parseCustomerCsv(CSV_TEXT);
    expect(customers[0].petpooja_created_on).toBe('2024-01-01');
    expect(customers[1].petpooja_created_on).toBe('2024-06-02');
  });

  it('skips 11-digit landlines and too-short numbers, with reasons', () => {
    const { skipped } = parseCustomerCsv(CSV_TEXT);
    const byReason = Object.fromEntries(skipped.map((s) => [s.reason, s.count]));
    expect(byReason.landline).toBe(1);
    expect(byReason.invalid_phone).toBe(1);
  });

  it('returns no customers and a no_header_row skip for text with no header line', () => {
    const { customers, skipped } = parseCustomerCsv('just,some,garbage\ntext,here,too');
    expect(customers).toEqual([]);
    expect(skipped).toEqual([{ reason: 'no_header_row', count: 1 }]);
  });
});
