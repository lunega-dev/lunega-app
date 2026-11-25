#!/usr/bin/env node
import { fetchSources } from './fetch.js';
import { portOf, start } from './index.js';

const [command, ...rest] = process.argv.slice(2);

if (command === 'fetch') {
  const flag = rest.indexOf('--source');
  const only = flag === -1 ? undefined : rest[flag + 1];
  if (rest.length !== (only === undefined ? 0 : 2) || (flag !== -1 && !only)) {
    console.error('usage: lunega fetch [--source <owner/repo>]');
    process.exit(2);
  }
  try {
    const written = await fetchSources(process.cwd(), { only });
    for (const into of written) console.log(`fetched ${into}`);
    if (written.length === 0) console.log('no sources in package.json');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
} else if (command !== undefined) {
  console.error(`unknown command: ${command}`);
  process.exit(2);
} else {
  const server = await start();
  console.log(`listening on :${portOf(server)}`);

  // Stop at once on docker stop: no 10 s wait for the kill.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
