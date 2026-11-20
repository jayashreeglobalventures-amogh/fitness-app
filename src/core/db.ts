// PostgreSQL access (AaryaShree IMS pattern): raw parameterised SQL through pg, one transaction per request,
// advisory locks to serialise writes that must not interleave (per challenge).
import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

// bigint (int8) columns come back as JS numbers: ids and paise amounts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// date columns stay plain 'YYYY-MM-DD' strings: a calendar day has no time zone.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string, max = 10): pg.Pool {
  // Sessions run in UTC; challenge-local days are computed explicitly with the challenge's own time zone.
  const pool = new pg.Pool({ connectionString, max, options: '-c TimeZone=UTC' });
  pool.on('error', (err) => { console.error('[db] idle connection lost:', err.message); });
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Serialises writes to one challenge (roster, configuration, later scoring and ledger) inside the current transaction. */
export const CHALLENGE_LOCK_CLASS = 0x0f17_0001;
export const USERS_LOCK_CLASS = 0x0f17_0002;
export async function lockChallenge(tx: Queryable, challengeId: number): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [CHALLENGE_LOCK_CLASS, challengeId]);
}
