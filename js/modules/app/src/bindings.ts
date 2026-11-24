import { accessSync, constants, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { data, dataSecure, root as appRoot } from '@lunega/paths';
import type { Config } from './config.js';
import { importOptional } from './optional.js';

// What @lunega/db and @lunega/kv both have; they're optional, so no dependency.
interface BindingModule {
  open(name: string, options?: { dir?: string }): Closable;
}
interface Closable {
  close(): void;
}

export interface Bindings {
  /** One object per entry in the config's `bindings`, by name. */
  objects: Record<string, unknown>;
  close(): void;
}

const PACKAGES: Record<string, string> = { db: '@lunega/db', kv: '@lunega/kv' };
// Env var names, so a binding sits in the handler's env like any other.
const NAME = /^[A-Z][A-Z0-9_]*$/;

// Makes sure the folders the config asks for are there, and opens its bindings.
export async function openBindings(
  root: string,
  config: Config,
  env: Record<string, string | undefined> = process.env,
): Promise<Bindings> {
  const entries = Object.entries(config.bindings ?? {});
  const modules = new Map<string, BindingModule>();
  for (const [name, binding] of entries) {
    if (!NAME.test(name)) throw new Error(`bindings: invalid name ${JSON.stringify(name)}, must match ${NAME}`);
    // The handler's env has both, and one would hide the other.
    if (env[name] !== undefined) throw new Error(`bindings: ${name} is already an environment variable`);
    const type: unknown = (binding as { type?: unknown } | null)?.type;
    const pkg = typeof type === 'string' && Object.hasOwn(PACKAGES, type) ? PACKAGES[type] : undefined;
    if (!pkg) throw new Error(`bindings: ${name} has type ${JSON.stringify(type)}, must be "db" or "kv"`);
    if (modules.has(pkg)) continue;
    const mod = await importOptional<BindingModule>(root, pkg);
    if (!mod) throw new Error(`bindings: ${name} needs ${pkg}, which is not installed`);
    modules.set(pkg, mod);
  }

  // The paths of @lunega/paths, under this root.
  const dirs = {
    data: join(root, relative(appRoot, data)),
    dataSecure: join(root, relative(appRoot, dataSecure)),
  };
  if (config.data) ensureWritable('data', dirs.data);
  // Bindings keep their files there.
  if (config.dataSecure || entries.length > 0) ensureWritable('dataSecure', dirs.dataSecure);

  const opened: Closable[] = [];
  const close = () => {
    for (const binding of opened.splice(0)) binding.close();
  };
  const objects: Record<string, unknown> = {};
  try {
    for (const [name, { type }] of entries) {
      const binding = modules.get(PACKAGES[type] as string)!.open(name, { dir: dirs.dataSecure });
      opened.push(binding);
      objects[name] = binding;
    }
  } catch (e) {
    close();
    throw e;
  }
  return { objects, close };
}

// Under launcher the folder is a mount on a read-only root filesystem: it's
// there because package.json's "lunega" block asked for it, or not at all.
function ensureWritable(option: string, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? String(e);
    throw new Error(`${option}: ${dir} is missing or not writable (${code})`, { cause: e });
  }
}
