import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSV_TEMPLATES, templateCsv } from '../src/lib/importer';

// templates/*.csv are the files office staff start from; they must match what the app offers.
// Regenerate with: UPDATE_TEMPLATES=1 npx vitest run tests/templates.test.ts
describe('templates/ CSV files', () => {
  for (const kind of ['timed', 'allow', 'hot'] as const) {
    it(`${CSV_TEMPLATES[kind].fileName} matches the in-app template`, async () => {
      const url = new URL(`../templates/${CSV_TEMPLATES[kind].fileName}`, import.meta.url);
      if (process.env.UPDATE_TEMPLATES) (await import('node:fs')).writeFileSync(url, templateCsv(kind));
      expect(readFileSync(url, 'utf8')).toBe(templateCsv(kind));
    });
  }
});
