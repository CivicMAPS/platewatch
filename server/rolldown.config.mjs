// Bundles the backend (server/main.ts + the shared src/lib modules) into dist-server/server.mjs.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'rolldown';

const raw = {
  name: 'raw',
  resolveId(id, importer) {
    if (!id.endsWith('?raw')) return null;
    return { id: new URL(id.slice(0, -4), `file://${importer}`).pathname + '?raw' };
  },
  load(id) {
    if (!id.endsWith('?raw')) return null;
    return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))};`;
  },
};

export default defineConfig({
  input: 'server/main.ts',
  platform: 'node',
  external: ['pg'],
  plugins: [raw],
  output: { file: 'dist-server/server.mjs', format: 'esm' },
});
