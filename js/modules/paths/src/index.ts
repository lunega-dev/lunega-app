import { join } from 'node:path';

// The only places an app writes to. In the container the root is /app and both
// dirs are bind mounts (the rest of the filesystem is read-only); locally they
// are ./data and ./data_secure next to the app.
export const root = process.cwd();
export const data = join(root, 'data');
export const dataSecure = join(root, 'data_secure');
