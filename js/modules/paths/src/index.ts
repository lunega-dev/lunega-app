import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const root = process.cwd();
export const data = join(root, 'data');
export const dataSecure = join(root, 'data_secure');
export const temp = mkdtempSync(join(tmpdir(), 'lunega-'));
process.once('exit', () => rmSync(temp, { recursive: true, force: true }));
