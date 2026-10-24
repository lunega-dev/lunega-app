import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { workspaces } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  test: {
    projects: workspaces,
  },
});
