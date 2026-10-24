import { readFileSync } from 'node:fs';

const SUFFIX = '_FILE';

// For every NAME_FILE env var with a value, read that file and expose its
// contents as NAME. NAME_FILE wins over a plain NAME. One trailing newline is
// stripped. Error messages carry the variable name and path only, never file
// content.
export function loadFileSecrets(env: Record<string, string | undefined> = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.endsWith(SUFFIX) || key.length === SUFFIX.length) continue;
    const path = env[key];
    if (!path) continue;

    let value: string;
    try {
      value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`${key}: cannot read secret file ${path}`);
    }
    if (value === '') {
      throw new Error(`${key}: cannot read secret file ${path}`);
    }
    env[key.slice(0, -SUFFIX.length)] = value;
  }
}
