import type { Config } from './config.js';

// An env var name the app may own: not launcher's or Node's, not one a
// container always has, and not NAME_FILE, which is how the value arrives.
const NAME = /^(?!LUNEGA_|NODE_)(?!(PATH|PORT|HOME|HOSTNAME)$)(?!.*_FILE$)[A-Z][A-Z0-9_]{0,63}$/;
const MAX = 32;

// Refuses a `secrets` that isn't a list of valid names, and a declared name
// without a value. `fileSecrets` says whether @lunega/secrets has turned the
// NAME_FILE variables into NAME. Messages carry names only, never a value.
export function checkSecrets(
  config: Config,
  fileSecrets: boolean,
  env: Record<string, string | undefined> = process.env,
): void {
  const names: unknown = config.secrets;
  if (names === undefined) return;
  if (!Array.isArray(names)) throw new Error('secrets: must be a list of names');
  if (names.length > MAX) throw new Error(`secrets: ${names.length} names, at most ${MAX}`);
  const seen = new Set<string>();
  for (const name of names as unknown[]) {
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new Error(`secrets: invalid name ${JSON.stringify(name)}, must match ${NAME}`);
    }
    if (seen.has(name)) throw new Error(`secrets: ${name} is there twice`);
    // The handler's env has both, and one would hide the other.
    if (Object.hasOwn(config.bindings ?? {}, name)) throw new Error(`secrets: ${name} is also a binding`);
    seen.add(name);
  }

  // An empty value is no value.
  const missing = [...seen].filter((name) => !env[name]);
  if (missing.length === 0) return;
  let message = `secrets: no value for ${missing.join(', ')}`;
  // Under launcher the value is a file, and only @lunega/secrets reads it.
  const files = missing.map((name) => `${name}_FILE`).filter((file) => env[file]);
  if (!fileSecrets && files.length > 0) {
    message += ` (${files.join(', ')} set, which needs @lunega/secrets, and it is not installed)`;
  }
  throw new Error(message);
}
