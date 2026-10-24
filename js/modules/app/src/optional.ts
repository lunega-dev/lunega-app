import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports a package the way the app itself would, or returns undefined when
// the app doesn't have it installed.
export async function importOptional<T>(root: string, name: string): Promise<T | undefined> {
  const require = createRequire(join(root, 'package.json'));
  let resolved: string;
  try {
    resolved = require.resolve(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw e;
  }
  return (await import(pathToFileURL(resolved).href)) as T;
}
