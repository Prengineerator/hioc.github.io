import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// The GST report's print rules (app/owner/reports/gst/page.tsx). They used to be
// injected with dangerouslySetInnerHTML, which the security scan flags as C-6.
// Now the report's own rules live in app/globals.css under [data-gst-report] and
// only the document-global ones (@page, the white background) stay with the page
// as a plain <style> text child. React escapes <, >, &, ' and " in that text
// during server rendering, which would break a selector such as `a > b`, so the
// page's string must hold none of them.

const root = join(__dirname, '..');
const page = readFileSync(join(root, 'app/owner/reports/gst/page.tsx'), 'utf8');
const globals = readFileSync(join(root, 'app/globals.css'), 'utf8');

describe('GST report print CSS', () => {
  it('uses no dangerouslySetInnerHTML', () => {
    expect(page).not.toContain('dangerouslySetInnerHTML');
  });

  it('keeps the page-level print rules intact through server rendering', () => {
    const match = page.match(/const PRINT_PAGE_CSS =\s*'([^']*)';/);
    expect(match).not.toBeNull();
    const css = match![1];
    expect(css).toContain('@page { size: A4; margin: 12mm; }');
    expect(css).toContain('html, body { background: #fff !important; }');
    expect(renderToString(createElement('style', null, css))).toBe(`<style>${css}</style>`);
    expect(page).toContain('<style>{PRINT_PAGE_CSS}</style>');
  });

  it('has the report rules in globals.css, scoped to [data-gst-report] and print only', () => {
    // The @media print block that holds the report's rules, wherever it sits in the file.
    const start = globals.lastIndexOf('@media print {', globals.indexOf('[data-gst-report] {'));
    expect(start).toBeGreaterThanOrEqual(0);
    const block = globals.slice(start, globals.indexOf('\n}', start));
    for (const rule of [
      '[data-gst-report] { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
      '[data-gst-report] section { box-shadow: none !important; }',
      '[data-gst-report] tr { break-inside: avoid; }',
      '[data-gst-report] details > summary { list-style: none; }',
      '[data-gst-report] section > h2, [data-gst-report] h3 { break-after: avoid; }',
    ]) {
      expect(block).toContain(rule);
    }
    expect(page).toContain('data-gst-report=""');
  });
});
