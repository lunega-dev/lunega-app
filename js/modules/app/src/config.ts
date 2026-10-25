import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Config {
  /** Folder served as files, relative to the app root. */
  static?: string;
  /** Module whose default export handles what no file matched. */
  handler?: string;
  /** For @lunega/analytics: `false` turns it off, `inject: false` keeps the
   * tracker out of the HTML (see AnalyticsOptions there). */
  analytics?: false | { websiteId?: string; inject?: boolean; collectUrl?: string };
}

const FILES = ['lunega.config.js', 'lunega.config.mjs'];

// lunega.config.js wins over a "lunega" field in package.json.
export async function loadConfig(root: string): Promise<Config> {
  for (const file of FILES) {
    const path = join(root, file);
    if (existsSync(path)) {
      const mod = (await import(pathToFileURL(path).href)) as { default?: Config };
      return mod.default ?? {};
    }
  }
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    const json = JSON.parse(readFileSync(pkg, 'utf8')) as { lunega?: Config };
    return json.lunega ?? {};
  }
  return {};
}
