import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { data, dataSecure, root, temp } from './index.js';

test('dirs sit in the app root', () => {
  expect(root).toBe(process.cwd());
  expect(data).toBe(join(root, 'data'));
  expect(dataSecure).toBe(join(root, 'data_secure'));
});

test('temp is a fresh dir under the os temp dir', () => {
  expect(dirname(temp)).toBe(tmpdir());
  expect(statSync(temp).isDirectory()).toBe(true);
});

test('temp is removed on exit', () => {
  const script = `import { writeFileSync } from 'node:fs';
    import { temp } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    writeFileSync(temp + '/file', 'x');
    console.log(temp);`;
  const dir = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  expect(dir).not.toBe('');
  expect(existsSync(dir)).toBe(false);
});
