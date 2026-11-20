// Process entry point: node dist/src/server.js (production) / tsx src/server.ts (development).
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './core/db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, pool });
await app.listen({ host: config.host, port: config.port });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}
