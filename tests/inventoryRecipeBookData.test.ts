import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIssue, validateRecipeBook } from '@/lib/inventory/recipeBook';
import { loadRecipeBook, resolveBookDir } from '@/lib/inventory/recipeBookFs';

// The REAL recipe book, held to the same rules as the fixtures in
// inventoryRecipeBook.test.ts. It protects the data the chef agent writes:
// a recipe that names a stock item that does not exist, a size label that is
// not on the menu, or a menu item that has since been removed fails here
// before it can fail in the seed SQL.
//
// The book folder is the git-ignored data/inventory/book unless
// INVENTORY_BOOK_DIR points elsewhere (the recipes are private, so a fresh
// checkout has none). With no stock-items.json there is no book to check — this
// skips instead of failing.

const root = process.cwd();
const hasBook = fs.existsSync(path.join(resolveBookDir(root), 'stock-items.json'));

describe('the recipe book in the repo', () => {
  it.skipIf(!hasBook)('has no errors against the menu snapshot', () => {
    const { errors } = validateRecipeBook(loadRecipeBook(root));
    expect(errors, `${errors.length} error(s) in the recipe book:\n${errors.map((e) => `  ${formatIssue(e)}`).join('\n')}`).toEqual([]);
  });
});
