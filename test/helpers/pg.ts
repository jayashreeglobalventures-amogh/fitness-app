// A throwaway embedded PostgreSQL 17 per test file, with one fresh migrated database per call (AaryaShree IMS pattern).
// The app connects as fit_app (no DDL, like production) - see deploy/initdb/01-roles.sh.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export interface TestPg {
  freshDb(): Promise<{ adminUrl: string; appUrl: string }>;
  stop(): Promise<void>;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port')))); });
});

export async function startPg(): Promise<TestPg> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fit-test-pg-'));
  const port = await freePort();
  const epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'test', persistent: false, onLog: () => undefined });
  await epg.initialise();
  await epg.start();
  await sql(`postgres://postgres:test@localhost:${port}/postgres`, `CREATE ROLE fit_app LOGIN PASSWORD 'test'`);
  let n = 0;
  return {
    async freshDb() {
      const name = `t${++n}`;
      await epg.createDatabase(name);
      const adminUrl = `postgres://postgres:test@localhost:${port}/${name}`;
      await runMigrations(adminUrl);
      await sql(adminUrl, `GRANT USAGE ON SCHEMA public, drizzle TO fit_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fit_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fit_app;
        GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO fit_app;`);
      return { adminUrl, appUrl: adminUrl.replace('://postgres:test@', '://fit_app:test@') };
    },
    async stop() {
      await epg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function sql(url: string, text: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(text, params); } finally { await c.end(); }
}
