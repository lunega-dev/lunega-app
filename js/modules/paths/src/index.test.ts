import { expect, test } from 'vitest';
import { join } from 'node:path';
import { data, dataSecure, root } from './index.js';

test('dirs sit in the app root', () => {
  expect(root).toBe(process.cwd());
  expect(data).toBe(join(root, 'data'));
  expect(dataSecure).toBe(join(root, 'data_secure'));
});
