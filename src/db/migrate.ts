// Applies the versioned SQL migrations in src/db/migrations (Drizzle migrator, as in AaryaShree IMS).
// Migrations are reviewed SQL files committed to git; `drizzle-kit push` is never used.
// Usage: MIGRATE_DATABASE_URL=postgres://... tsx src/db/migrate.ts
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

export async function runMigrations(connectionString: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    console.error('MIGRATE_DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url).then(() => console.log('Migrations applied.'), (e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
