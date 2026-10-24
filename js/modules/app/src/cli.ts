#!/usr/bin/env node
import { portOf, start } from './index.js';

const server = await start();
console.log(`listening on :${portOf(server)}`);

// Stop at once on docker stop: no 10 s wait for the kill.
const stop = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
