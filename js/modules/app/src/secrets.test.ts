import { describe, expect, test } from 'vitest';
import type { Config } from './config.js';
import { checkSecrets } from './secrets.js';

const check = (secrets: unknown, env: Record<string, string | undefined> = {}, fileSecrets = true) =>
  checkSecrets({ secrets } as Config, fileSecrets, env);

describe('names', () => {
  test('nothing declared is fine', () => {
    expect(() => checkSecrets({}, false, {})).not.toThrow();
    expect(() => check([])).not.toThrow();
  });

  test('anything but a list is refused', () => {
    for (const secrets of ['API_KEY', { API_KEY: true }, null, 1]) {
      expect(() => check(secrets)).toThrow('secrets: must be a list of names');
    }
  });

  test('a name that is not a free env var name is refused', () => {
    const invalid = [
      'api_key',
      '1KEY',
      'MY-KEY',
      '',
      'LUNEGA_KEY',
      'NODE_ENV',
      'PATH',
      'PORT',
      'HOME',
      'HOSTNAME',
      'API_KEY_FILE',
      'A'.repeat(65),
      1,
      null,
    ];
    for (const name of invalid) {
      expect(() => check([name], { [String(name)]: 'x' })).toThrow(`secrets: invalid name ${JSON.stringify(name)}`);
    }
  });

  test('one that only looks like a reserved one is fine', () => {
    const names = ['A', 'PATHS', 'PORT_2', 'HOME_URL', 'MY_NODE_KEY', 'FILE', 'API_KEY_FILES', 'A'.repeat(64)];
    expect(() => check(names, Object.fromEntries(names.map((name) => [name, 'x'])))).not.toThrow();
  });

  test('a name twice is refused', () => {
    expect(() => check(['A', 'B', 'A'], { A: 'x', B: 'x' })).toThrow('secrets: A is there twice');
  });

  test('more than 32 are refused', () => {
    const names = Array.from({ length: 33 }, (_, i) => `KEY_${i}`);
    const env = Object.fromEntries(names.map((name) => [name, 'x']));
    expect(() => check(names, env)).toThrow('secrets: 33 names, at most 32');
    expect(() => check(names.slice(1), env)).not.toThrow();
  });

  test('the name of a binding is refused, with or without a value', () => {
    const config: Config = { secrets: ['DB'], bindings: { DB: { type: 'db' } } };
    expect(() => checkSecrets(config, true, {})).toThrow('secrets: DB is also a binding');
    expect(() => checkSecrets(config, true, { DB: 'x' })).toThrow('secrets: DB is also a binding');
  });
});

describe('values', () => {
  test('every declared name with a value is fine', () => {
    expect(() => check(['A', 'B'], { A: 'x', B: 'y' })).not.toThrow();
  });

  test('every name without one is in the error, an empty one too', () => {
    expect(() => check(['A', 'B', 'C'], { B: 'y', C: '' })).toThrow(new Error('secrets: no value for A, C'));
  });

  test('NAME_FILE without @lunega/secrets says so', () => {
    const env = { A_FILE: '/run/secrets/A', C: 'z' };
    expect(() => check(['A', 'B', 'C'], env, false)).toThrow(
      new Error('secrets: no value for A, B (A_FILE set, which needs @lunega/secrets, and it is not installed)'),
    );
    expect(() => check(['A', 'B', 'C'], env, true)).toThrow(new Error('secrets: no value for A, B'));
  });

  test('the error has names, never a value', () => {
    const env = { A: 's3cret', B_FILE: '/run/secrets/B' };
    let message = '';
    try {
      check(['A', 'B'], env, false);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('B');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('/run/secrets');
  });
});
