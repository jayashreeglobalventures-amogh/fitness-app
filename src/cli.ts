// Server-side admin commands (run on the VPS through deploy/cli.sh, or locally with npm run cli).
//   create-super-admin <username> "<display name>"   first account; prints a temporary password once
//   create-challenge <slug> <config.json> <username>  creates a DRAFT challenge from a settings file, as that admin
//   apply-config <slug> <config.json> <username> "<reason>" [YYYY-MM-DD]
//                                                     saves a settings file as the challenge's new rules (audited, versioned;
//                                                     after the start, give the first day the new rules apply)
//   validate-config <config.json>                     checks a settings file without saving anything
import { readFileSync } from 'node:fs';
import { createPool, withTx } from './core/db.js';
import { createChallenge, updateConfig } from './modules/challenges/challenges.js';
import { validateConfig } from './modules/challenges/config.js';
import { createSuperAdmin } from './modules/identity/users.js';

const [cmd, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  if (cmd === 'validate-config') {
    const r = validateConfig(JSON.parse(readFileSync(args[0] ?? '', 'utf8')));
    console.log(JSON.stringify({ ok: r.ok, errors: r.errors, warnings: r.warnings, periods: r.periods }, null, 2));
    return r.ok ? 0 : 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); return 2; }
  const pool = createPool(url, 2);
  try {
    if (cmd === 'create-super-admin') {
      const [username, displayName] = args;
      if (!username || !displayName) { console.error('usage: create-super-admin <username> "<display name>"'); return 2; }
      const u = await withTx(pool, (tx) => createSuperAdmin(tx, username, displayName, new Date()));
      console.log(`Super Admin "${u.username}" created. Temporary password (shown once): ${u.tempPassword}`);
      return 0;
    }
    if (cmd === 'create-challenge') {
      const [slug, file, username] = args;
      if (!slug || !file || !username) { console.error('usage: create-challenge <slug> <config.json> <admin username>'); return 2; }
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const r = await withTx(pool, async (tx) => {
        const { rows } = await tx.query(`SELECT user_id FROM users WHERE username = $1 AND status = 'ACTIVE'`, [username.toLowerCase()]);
        if (!rows[0]) throw new Error(`No active user "${username}"`);
        return createChallenge(tx, Number(rows[0].user_id), slug, config, new Date());
      });
      console.log(`Draft challenge ${r.challengeId} created.${r.warnings.length ? ' Warnings:\n- ' + r.warnings.map((w) => `${w.path}: ${w.message}`).join('\n- ') : ''}`);
      return 0;
    }
    if (cmd === 'apply-config') {
      const [slug, file, username, reason, effectiveFrom] = args;
      if (!slug || !file || !username || !reason) { console.error('usage: apply-config <slug> <config.json> <admin username> "<reason>" [first day YYYY-MM-DD]'); return 2; }
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const r = await withTx(pool, async (tx) => {
        const u = (await tx.query(`SELECT user_id FROM users WHERE username = $1 AND status = 'ACTIVE'`, [username.toLowerCase()])).rows[0];
        if (!u) throw new Error(`No active user "${username}"`);
        const ch = (await tx.query(`SELECT challenge_id FROM challenges WHERE slug = $1`, [slug])).rows[0];
        if (!ch) throw new Error(`No challenge "${slug}"`);
        return updateConfig(tx, Number(u.user_id), Number(ch.challenge_id), { config, reason, effectiveFrom }, new Date());
      });
      console.log(`Rules saved as version ${r.versionNo}.${r.warnings.length ? ' Warnings:\n- ' + r.warnings.map((w) => `${w.path}: ${w.message}`).join('\n- ') : ''}`);
      return 0;
    }
    console.error('commands: create-super-admin, create-challenge, apply-config, validate-config');
    return 2;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code), (e: unknown) => { console.error((e as Error).message); process.exit(1); });
