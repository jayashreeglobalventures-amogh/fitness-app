// Background work (enabled with FITNESS_SCHEDULER_ENABLED=true): retry AI readings that failed transiently or were
// interrupted by a restart, close exemption votes whose window has passed, and bring the points ledger up to date.
// Every step is safe to repeat.
import type pg from 'pg';
import { closeDueVotes } from '../modules/checkin/exemptions.js';
import { pendingAi, verifySubmission } from '../modules/checkin/submissions.js';
import { reconcileAll } from '../modules/scoring/ledger.js';
import { reconcileAllMoney } from '../modules/finance/finance.js';

export function startScheduler(pool: pg.Pool, mediaDir: string, log: (msg: string, err?: unknown) => void, everyMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const id of await pendingAi(pool, new Date())) await verifySubmission(pool, mediaDir, id, () => new Date()).catch((e) => log(`verify ${id} failed`, e));
      await closeDueVotes(pool, new Date());
      await reconcileAll(pool, new Date()); // points for days that just closed (midnight), decisions, corrections
      await reconcileAllMoney(pool, new Date()); // contributions due, fines, weeks closing, confirmed payments
    } catch (e) { log('scheduler tick failed', e); } finally { running = false; }
  };
  const t = setInterval(() => void tick(), everyMs);
  void tick();
  return () => clearInterval(t);
}
