// Test helper: the markup of the one <button> whose label reads exactly `label`
// (a tile's label span, or a chip's bare text). Throws when there is no such
// button, so an assertion about it can never pass on an empty string.

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buttonFor(html: string, label: string): string {
  const encoded = escape(label.replace(/&/g, '&amp;'));
  const match = html.match(new RegExp(`<button(?:(?!<button)[\\s\\S])*?>${encoded}(?:</span>)?</button>`));
  if (!match) throw new Error(`no button labelled "${label}" in the markup`);
  return match[0];
}
