// Background work (enabled with FITNESS_SCHEDULER_ENABLED=true): retry AI readings that failed transiently or were
// interrupted by a restart, close exemption votes whose window has passed, bring the points and money ledgers up to
// date, and send new alerts to phones. Every step is safe to repeat. Failures also go to the Super Admin's error log.
import type pg from 'pg';
import { recordError } from '../modules/admin/activity.js';
import { closeDueVotes } from '../modules/checkin/exemptions.js';
import { pendingAi, verifySubmission } from '../modules/checkin/submissions.js';
import { reconcileAll } from '../modules/scoring/ledger.js';
import { reconcileAllMoney } from '../modules/finance/finance.js';
import { sendDue, vapidKeys, webPushSender, type PushSender } from '../modules/notifications/push.js';

export interface SchedulerOptions { everyMs?: number; pushEveryMs?: number; publicOrigin: string; sender?: PushSender }

export function startScheduler(pool: pg.Pool, mediaDir: string, log: (msg: string, err?: unknown) => void, opts: SchedulerOptions): () => void {
  const fail = (msg: string, err: unknown) => {
    log(msg, err);
    void recordError(pool, { source: 'BACKGROUND', path: msg, err });
  };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const id of await pendingAi(pool, new Date())) await verifySubmission(pool, mediaDir, id, () => new Date()).catch((e) => fail(`verify submission ${id}`, e));
      await closeDueVotes(pool, new Date());
      await reconcileAll(pool, new Date()); // points for days that just closed (midnight), decisions, corrections
      await reconcileAllMoney(pool, new Date()); // contributions due, fines, weeks closing, confirmed payments
    } catch (e) { fail('scheduler tick', e); } finally { running = false; }
  };

  // Phone notifications, once a minute (after the ledgers, so new alerts like "points updated" are already there).
  let pushing = false;
  let sender: PushSender | undefined = opts.sender;
  const pushTick = async () => {
    if (pushing) return;
    pushing = true;
    try {
      if (!sender) {
        const subject = opts.publicOrigin.startsWith('https://') ? opts.publicOrigin : 'https://fitness.amogh.systems';
        sender = webPushSender(await vapidKeys(pool, subject));
      }
      await sendDue(pool, sender, new Date());
    } catch (e) { fail('phone notifications', e); } finally { pushing = false; }
  };

  const t = setInterval(() => void tick(), opts.everyMs ?? 30_000);
  const p = setInterval(() => void pushTick(), opts.pushEveryMs ?? 60_000);
  void tick();
  return () => { clearInterval(t); clearInterval(p); };
}
