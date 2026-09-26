import { describe, expect, it, vi } from 'vitest';

// The "yours to pick" email (lib/inventory/notify.ts): says which request,
// who asked, every line with its unit, the note, and links to the Stock
// screen — and escapes anything a person typed.

vi.mock('@/lib/url', () => ({ absoluteUrl: (p: string) => `https://hioc.in${p}` }));
vi.mock('@/lib/staff/emails', async () => {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    escapeHtml: esc,
    staffEmailShell: (title: string, body: string) => `<h1>${esc(title)}</h1>${body}`,
    sendStaffEmail: vi.fn(),
  };
});

const { renderStockAssignedEmail } = await import('@/lib/inventory/notify');

describe('renderStockAssignedEmail', () => {
  const email = renderStockAssignedEmail({
    requestId: 'r1',
    requestNumber: 7,
    note: 'Before <5pm>',
    assignedByName: 'Boss',
    lines: [
      { name: 'Full-cream milk', qty: 10, unit: 'l' },
      { name: 'Espresso beans', qty: 1000, unit: 'g' },
    ],
  });

  it('names the request in the subject', () => {
    expect(email.subject).toBe('Stock request #7 is yours to pick');
  });

  it('lists every line with its unit, and links to the Stock screen', () => {
    expect(email.text).toContain('- Full-cream milk — 10 L');
    expect(email.text).toContain('- Espresso beans — 1000 g');
    expect(email.text).toContain('https://hioc.in/staff/inventory');
    expect(email.html).toContain('href="https://hioc.in/staff/inventory"');
  });

  it('escapes what people typed', () => {
    expect(email.html).toContain('Before &lt;5pm&gt;');
    expect(email.html).not.toContain('<5pm>');
  });
});
