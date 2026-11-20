// Process entry point: node dist/src/server.js (production) / tsx src/server.ts (development).
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './core/db.js';
import { startScheduler } from './jobs/scheduler.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, pool });
await app.listen({ host: config.host, port: config.port });
const stopScheduler = process.env.FITNESS_SCHEDULER_ENABLED === 'true'
  ? startScheduler(pool, config.mediaDir, (msg, err) => app.log.error({ err }, msg)) : () => undefined;
app.log.info(`screenshot reading: ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (manual review)'}; scheduler: ${process.env.FITNESS_SCHEDULER_ENABLED === 'true' ? 'on' : 'off'}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { stopScheduler(); void app.close().then(() => pool.end()).then(() => process.exit(0)); });
}
