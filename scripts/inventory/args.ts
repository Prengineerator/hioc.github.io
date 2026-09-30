// Tiny flag parser shared by the inventory scripts: `--flag`, `--name value`
// and `--name=value`. No dependency; anything it does not know is reported.

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  /** Unknown flags, and value flags with no value. */
  problems: string[];
}

export function parseArgs(argv: string[], booleans: string[], valued: string[]): ParsedArgs {
  const parsed: ParsedArgs = { flags: new Set(), values: new Map(), problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const name = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    if (booleans.includes(name) && inline === undefined) {
      parsed.flags.add(name);
    } else if (valued.includes(name)) {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) parsed.problems.push(`${name} needs a value`);
      else parsed.values.set(name, value);
    } else {
      parsed.problems.push(`unknown argument ${argv[i]}`);
    }
  }
  return parsed;
}
