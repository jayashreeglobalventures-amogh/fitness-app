// Local trial run without Docker: an embedded PostgreSQL 17 in .local/ (kept between runs), migrations, a first
// Super Admin and the Calamari draft (first run only), then the server on http://localhost:3300.
// Usage: npm run build:web && npm run dev:local
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { createPool, withTx } from '../src/core/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { createChallenge } from '../src/modules/challenges/challenges.js';
import { createSuperAdmin } from '../src/modules/identity/users.js';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, '.local', 'pgdata');
const port = 54329;
const fresh = !existsSync(dir);
mkdirSync(path.dirname(dir), { recursive: true });
const epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'local', persistent: true, onLog: () => undefined });
if (fresh) await epg.initialise();
await epg.start();
const adminUrl = `postgres://postgres:local@localhost:${port}/fitness`;
if (fresh) {
  await epg.createDatabase('fitness');
  const c = new pg.Client({ connectionString: adminUrl }); await c.connect();
  await c.query(`CREATE ROLE fit_app LOGIN PASSWORD 'local'`);
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fit_app;
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fit_app;
                 GRANT USAGE ON SCHEMA public TO fit_app; CREATE SCHEMA IF NOT EXISTS drizzle; GRANT USAGE ON SCHEMA drizzle TO fit_app;
                 ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT SELECT ON TABLES TO fit_app;`);
  await c.end();
}
await runMigrations(adminUrl);
const pool = createPool(`postgres://fit_app:local@localhost:${port}/fitness`);
if (fresh) {
  const sa = await withTx(pool, (tx) => createSuperAdmin(tx, 'admin', 'Admin', new Date()));
  const calamari = JSON.parse(readFileSync(path.join(root, 'config/challenges/calamari-2026.json'), 'utf8'));
  await withTx(pool, (tx) => createChallenge(tx, sa.userId, 'calamari-2026', calamari, new Date()));
  console.log(`\nFirst run: Super Admin "admin", temporary password: ${sa.tempPassword}\nCalamari was created as a draft.\n`);
}
const app = await buildApp({
  pool, logger: false,
  config: { databaseUrl: '', host: '127.0.0.1', port: 3300, publicOrigin: 'http://localhost:3300', mediaDir: path.join(root, '.local', 'media'), cookieSecure: false, trustProxy: false, logLevel: 'info' },
});
await app.listen({ host: '127.0.0.1', port: 3300 });
console.log('Fitness app on http://localhost:3300  (Ctrl+C to stop)');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => pool.end()).then(() => epg.stop()).then(() => process.exit(0)); });
