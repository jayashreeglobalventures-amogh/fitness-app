# Fitness app

A fitness app whose first area is **Challenges**: a reusable challenge engine where every rule of a challenge is
configuration, not code. The first challenge is **Calamari** (22 Nov – 31 Dec 2026), defined in
[`config/challenges/calamari-2026.json`](config/challenges/calamari-2026.json).

Architecture follows AaryaShree IMS (Node.js 24, TypeScript, Fastify, PostgreSQL 17, Docker, GHCR, staging →
manual production) — see [docs/PHASE0_ARCHITECTURE_ASSESSMENT.md](docs/PHASE0_ARCHITECTURE_ASSESSMENT.md).
It is a separate application: its own repository, database, secrets, image and deployment.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 Foundation | Accounts (admin-created, temporary password), profile, roles, challenge settings (versioned), Calamari, invitations, roster, React app shell | **done** |
| 2 Daily participation | Screenshot upload, AI-assisted reading (Claude Opus 5.5), review queue, appeals, rest days, exemptions + voting, dashboards, admin corrections | **done** — defaults in [docs/RULE_DECISIONS.md](docs/RULE_DECISIONS.md) |
| 3 Scoring | Points ledger, streaks, penalties, comebacks, weekend bonus, team streak history, provisional leaderboard; installable PWA (iPhone + Android) | **done** — rulings in [docs/RULE_DECISIONS.md](docs/RULE_DECISIONS.md) |
| 4 Money | UPI ID / QR, report UTR + Finance Admin confirms, double-entry ledger, fine pools, refunds, overdue, reconciliation | **done** — rulings in [docs/RULE_DECISIONS.md](docs/RULE_DECISIONS.md) |
| 5 Leaderboard & settlement | Ranking, ties, prize eligibility, settlement approval | |
| Deploy | Staging `fitness-test.amogh.systems`, production `fitness.amogh.systems` | after owner approval |

## Run it locally

```bash
npm ci
npm run build:web     # the React app, served by the server
npm run dev:local     # embedded PostgreSQL in .local/, migrations, then http://localhost:3300
```

The first run prints a temporary password for the Super Admin `admin` and creates Calamari as a draft.
Screenshots are read by a free on-server reader (Tesseract) or, when `ANTHROPIC_API_KEY` is set, by Claude;
`SCREENSHOT_OCR=off` (with no key) sends every screenshot to an admin. `npx tsx scripts/ocr-probe.ts <image>` shows what
the free reader sees in a screenshot.
`FITNESS_SCHEDULER_ENABLED=true` turns on AI retries and closing exemption votes on time.
`rm -rf .local` starts over.

## Tests and checks

```bash
npm run typecheck     # server + web
npm test              # unit + integration (each integration file starts its own PostgreSQL 17)
npm run build         # server (dist/src) + web (dist/web)
```

## Server commands

```bash
npm run cli -- validate-config config/challenges/calamari-2026.json
DATABASE_URL=... npm run cli -- create-super-admin <username> "<Display name>"
DATABASE_URL=... npm run cli -- create-challenge calamari-2026 config/challenges/calamari-2026.json <admin username>
DATABASE_URL=... npm run cli -- apply-config calamari-2026 config/challenges/calamari-2026.json <admin username> "<reason>" [first day]
```

In the container: `node dist/src/cli.js <command>`; migrations: `node dist/src/db/migrate.js` (with `MIGRATE_DATABASE_URL`).

## Layout

```
src/
  app.ts, server.ts, cli.ts, config.ts
  core/        db (transactions, locks), errors, audit, dates (time zones, weekly periods)
  db/          migrate.ts + migrations/*.sql (hand-written, forward-only)
  modules/
    identity/  users, sessions, lockout, permissions (role → permission matrix)
    profile/   basic profile with per-field visibility (no health data)
    challenges/config.ts   the settings schema + validation (every rule of a challenge)
    challenges/challenges.ts  create, versioned edits, publish, duplicate, archive, admin roles
    roster/    invitations, rules acceptance, roster lock, participant status
    checkin/   day statuses, submissions + review + appeals, rest days, exemptions + voting, admin overview
    verification/  screenshot readers behind one interface: ocr.ts (free, Tesseract), reader.ts (Claude), select.ts
    scoring/   engine.ts (pure rules), ledger.ts (append-only points, reconcile, leaderboard), bonus.ts (weekend activities)
    finance/   engine.ts (pure money rules), finance.ts (double-entry ledger, payments, refunds, statements)
    notifications/  what needs each person's attention, worked out live
web/           React + Vite app (tabs: Home, Challenges, Profile, People)
config/challenges/  challenge settings files
test/          unit + integration tests
```
