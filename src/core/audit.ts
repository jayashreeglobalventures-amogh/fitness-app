// Append-only audit trail (the table refuses UPDATE and DELETE; migration 0000). Every administrative or
// sensitive action writes one row in the same transaction as the change it describes.
import type { Queryable } from './db.js';

export interface AuditEntry {
  actorUserId: number | null;
  action: string;
  entity: string;
  entityId: string | number;
  challengeId?: number | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export async function writeAudit(db: Queryable, at: Date, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (at, actor_user_id, challenge_id, action, entity, entity_id, reason, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [at, e.actorUserId, e.challengeId ?? null, e.action, e.entity, String(e.entityId), e.reason ?? null,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.ip ?? null],
  );
}
