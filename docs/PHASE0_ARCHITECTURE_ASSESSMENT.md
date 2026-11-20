# Phase 0 — Repository and Architecture Assessment

Fitness Challenge Platform (first challenge: Calamari, 22 Nov – 31 Dec 2026)
Status: **DRAFT for owner approval** — no application code has been written.
Date: 20 Nov 2026
Reference inspected: `github.com/jayashreeglobalventures-amogh/AaryaShree` @ `955282b` (286 commits, migration 0042),
cloned read-only into a scratch folder. Nothing in AaryaShree was changed.

---

## 1. AaryaShree IMS — what was inspected

| Area | What IMS actually does | Evidence |
|---|---|---|
| Runtime / language | Node 24, TypeScript ~6.0 strict (`noUncheckedIndexedAccess`), ESM (`NodeNext`) | `package.json`, `tsconfig.json` |
| Backend | Fastify 5, one `buildApp({config, pool, now})` factory; `server.ts` only wires env → app | `src/app.ts`, `src/server.ts` |
| API style | **RPC allowlist**: `POST /api/rpc/:name` → registry entry `{fn, role, write}`. Anything unregistered is unreachable. Plus a few REST routes (webhooks, storefront API, media) | `src/rpc/registry.ts` |
| Response shape | `{success, data, message}` / `{success:false, errorCode, message}`; `Failure` thrown inside a tx rolls it back | `src/core/response.ts` |
| DB access | Raw parameterised SQL through `pg`; **no ORM querying**. Drizzle is used *only* as the migration runner | `src/core/db.ts`, `src/db/migrate.ts` |
| Transactions | Every RPC = one transaction; write RPCs take a per-tenant advisory lock (`pg_advisory_xact_lock`) with 30 s timeout | `registry.ts`, `db.ts` |
| Migrations | Hand-written numbered SQL files (`0000_…0042_`), Drizzle journal, forward-only, "never edit an applied migration" | `src/db/migrations/` |
| Multi-tenancy | `business_id` on every row + **PostgreSQL RLS** via `set_config('ims.business_id', …, true)` per transaction; fails closed | migration `0005_row_level_security.sql` |
| DB roles | `ims_owner` (DDL, migrations) and `ims_app` (DML only, RLS applies). Superuser only for backup/restore | `deploy/initdb/01-roles.sh` |
| Auth | Username + password (argon2id, min 10 chars); random 32-byte session token in HttpOnly cookie, **only SHA-256 stored**; 7-day idle / 30-day max; lockout 5 fails / 15 min per username+IP; timing equalised; temp passwords + forced change; revoke-all on password change | `src/auth/users.ts` |
| Passwordless variant | Website customers: 6-digit email code (hashed, 10 min, attempt + hourly caps), via Resend | `services/websiteCustomers.ts` |
| Roles | `PLATFORM_ADMIN` / `OWNER` / `STAFF` + per-user extra permissions array; enforced in the RPC registry | `users.ts`, `registry.ts` |
| CSRF | POST must carry `Origin == PUBLIC_ORIGIN` or `Sec-Fetch-Site: same-origin`; webhooks exempt but HMAC-verified on raw body | `app.ts` |
| Security headers | CSP `default-src 'self'`, nosniff, DENY framing, `no-store` default | `app.ts` |
| Audit | Append-only `audit_log` (actor, action, entity, id, old/new JSON); app role cannot update/delete it (tested in CI) | `users.ts`, `runtime.ts` |
| Secrets | `.env` on VPS only; per-tenant integration secrets encrypted AES-256-GCM with `IMS_SECRETS_KEY` | `src/core/secrets.ts` |
| File storage | Local volume `MEDIA_DIR` (`/media`), **content-addressed** `b/<tenant>/sha256/xx/<sha>`; MIME sniffed from bytes; HEIC → JPEG; served only through authenticated routes that look up ownership in PG; path-traversal guard; DB holds metadata only | `services/images.ts`, `app.ts` `/media/*` |
| Uploads | Base64 inside RPC body (15 MB body limit) for photos; chunked raw upload for large video | `app.ts` |
| AI | `@anthropic-ai/sdk`, structured JSON output, typed retryable/non-retryable errors, test seam `setXCallerForTests`, background retry worker; key per tenant, never logged | `services/social/claude.ts` |
| Logging | `logger: false`; `console.error` with tags. **Not structured** | `app.ts` |
| Validation | Hand-written per function (no schema library) | services |
| Frontend | Legacy Apps Script HTML/JS (~12k lines in `web/*.html`) assembled server-side, `google.script.run` shim → `/api/rpc` | `src/web/page.ts`, `web/gas-shim.js` |
| Tests | Vitest 5; **embedded PostgreSQL 17 per test file**, fresh migrated DB per test, app connects as `ims_app` so RLS is exercised; injectable clock `now()`; fakes for external APIs; differential tests vs legacy | `test/helpers/pg.ts` |
| Health | `/healthz`: DB ping + migration count + backup status file | `app.ts` |
| Docker | Multi-stage `node:24-trixie-slim`, `npm ci --ignore-scripts`, non-root, HEALTHCHECK; built in CI only, never on the VPS | `Dockerfile` |
| CI | `ci.yml`: typecheck, tests, build **and a full stack rehearsal** (real deploy scripts, Caddy HTTPS, backup/restore, deliberate broken image → auto-rollback) | `.github/workflows/ci.yml`, `.github/scripts/stack-test.sh` |
| Registry | `build.yml` pushes `ghcr.io/…/aaryashree-ims:<sha>` on merge to main | `build.yml` |
| Deploy | `deploy.yml`: staging auto after build, production **manual only**; guards (on main, CI green, image exists); SSH with a restricted key whose forced command (`ims-ssh-gate`) allows only `deploy <env> <sha>` / `status <env>` | `deploy.yml`, `deploy/ssh-gate.sh` |
| On-server deploy | pull → DB up → **pre-deploy pg_dump (verified)** → migrations (failure stops, nothing switched) → switch tag, keep `PREVIOUS_TAG` → health via Caddy → **automatic rollback** | `deploy/deploy.sh` |
| Backups | systemd timers: nightly dump + media tar, weekly/monthly rotation, weekly **automated restore test**, optional off-site (restic) | `deploy/backup.sh`, `restore-test.sh`, `offsite.sh` |
| VPS layout | Hostinger KVM2, shared Caddy edge (owned by Rent, `/opt/edge`, network `edge`); each app = own compose project, own DB volume, PG not published; per-env dirs `/opt/ims`, `/opt/ims-staging` | `docs/VPS_DEPLOYMENT.md` |

## 2. Authentication flow (IMS) and how it maps to Fitness

IMS: `POST /auth/login` → argon2id verify → insert `sessions(session_hash=sha256(token))` → HttpOnly/Secure/SameSite=Lax cookie →
each request `resolveSession()` slides expiry and returns `SessionUser {userId, role, businessId, permissions}` → RPC registry checks role.

**Reuse as-is:** session table + hashed tokens, cookie flags, idle/max expiry, lockout table, timing equalisation, revoke-all,
temp password + forced change, audit on every auth event, same-origin CSRF check.

**Must change for Fitness:**
- Identity key is a **verified mobile number** (E.164), not a username. Users are global (no tenant).
- Roles are **per challenge** (`challenge_roles`), plus a small set of platform roles. `SessionUser` carries only identity; authorization
  is resolved per request against the challenge in the URL.
- Mobile verification needs an OTP channel. See decision D1 — in India SMS OTP requires DLT sender/template registration (days to weeks).

## 3. Database and migration strategy

Reuse the IMS approach exactly: PostgreSQL 17, hand-written numbered SQL migrations run by the Drizzle migrator, forward-only,
`fit_owner` (DDL) / `fit_app` (DML, no DDL) roles, raw parameterised SQL through `pg`, one transaction per request,
advisory locks for serialised writes (per challenge instead of per business).

Adapt the RLS pattern to **health data** (the most sensitive data here): health tables get a policy keyed on
`set_config('fit.user_id')` plus an explicit, time-limited `health_access_grants` table. A forgotten filter in application
code then returns nothing instead of leaking measurements. Append-only tables (`audit_log`, `scoring_events`,
`ledger_entries`, `verification_results`) get `REVOKE UPDATE, DELETE` from `fit_app`, tested in CI like IMS does.

## 4. Frontend — finding and recommendation

IMS's frontend is a **compatibility layer**: legacy Apps Script HTML kept so the migration could be verified screen-for-screen
(differential tests). It was not chosen as a design; there is no component system, no build step, no type sharing.
Copying it would mean hand-writing ~15 new mobile screens, a guided Challenge Builder and dashboards in untyped inline scripts.

**Recommendation:** a small **Vite + React + TypeScript** single-page app, installed as a **PWA** (camera/gallery upload,
home-screen install, later Web Push), built in CI and **served by the same Fastify container** — so it keeps the IMS
operating model: one image, same origin, same cookie sessions, same CSRF check, same CSP, no CDN.
Request/response types are shared from the backend schemas.
Reasons: mobile-first participant UX, many stateful screens, typed contracts, future native app can reuse the API.
Alternative if you prefer zero new framework: vanilla TS modules with no framework (works, but slower to build and harder to keep consistent).
→ Decision D2.

## 5. Docker and deployment model (reuse almost 1:1)

```
Internet ─443─▶ shared Caddy (/opt/edge, network "edge")      ← one new site file per env, added after `caddy validate`
                  ├─ (Rent)        unchanged
                  ├─ ims / ims-test unchanged
                  ├─ fitness-test.<domain> ─▶ fit-app-staging    (/opt/fitness-staging, project fitness-staging)
                  └─ fitness.<domain>      ─▶ fit-app-production (/opt/fitness,         project fitness)
each project: fit-app ─(internal net)─ fit-db (postgres:17.x-alpine, no published port), volumes pgdata + media
```

Copied from IMS with renames: Dockerfile, compose.yaml, initdb roles script, deploy.sh / lib.sh / backup.sh / restore.sh /
restore-test.sh / offsite.sh, systemd timers, `fitness-ssh-gate` + `deploy-fitness` user, `ci.yml` (incl. stack rehearsal),
`build.yml` → `ghcr.io/jayashreeglobalventures-amogh/fitness-app:<sha>`, `deploy.yml` (staging auto, production manual).

Shared-infrastructure touch points (need your explicit OK at deploy time, nothing touched before):
1. one new Caddy site file in `/opt/edge/sites/` (validated first, exactly as IMS did);
2. appending `deploy-fitness` to sshd `AllowUsers` (validated with `sshd -t`, rolled back on failure);
3. DNS A records.
RAM budget: ~600 MB per environment (DB 384 MB, app 256 MB; no HEIC-in-container peak needed if the client converts) — to be checked against current VPS usage.

## 6. File storage

Reuse IMS: local `/media` volume, content-addressed SHA-256 keys under `u/<userId>/…` and `c/<challengeId>/…`,
MIME sniffed from magic bytes (JPEG/PNG/WebP/HEIC only, HEIC → JPEG), metadata + ownership in PostgreSQL,
served only via authenticated routes that check ownership/role (`private, no-store`), path-traversal guard, trash + 30-day purge,
included in nightly media backup. Upload as `multipart/form-data` (not base64-in-JSON) to save mobile data.
Step screenshots: **original bytes are kept immutable** (evidence), plus a downscaled copy for review UI. EXIF stripped from anything shown to other users.

## 7. Security and access-control model

- **Authentication:** IMS session model (§2).
- **Authorization:** every route declares a required permission (`challenge:submissions.review`, `finance:payments.verify`, …);
  a Fastify `preHandler` resolves the caller's roles **for that challenge** and refuses otherwise. Unlisted routes are unreachable (IMS allowlist idea).
- **Role → permission matrix** in code, unit-tested; e.g. Finance Admin has no `health:*`; Super Admin has no implicit `health:*`.
- **Conflict of interest:** an admin who is also a participant can never review/approve their own submission, exemption, rest-day correction or payment.
- **Health data:** separate tables, RLS, consent records, field-level visibility, time-limited audited support grants; health fields never selected by general profile/leaderboard/community/notification queries (tested by asserting JSON responses contain no health keys).
- **Append-only** scoring, ledger, verification, audit tables at the DB-grant level.
- **Rate limits** (`@fastify/rate-limit`) on login/OTP/upload; CSRF same-origin; CSP; secrets AES-GCM; webhook HMAC on raw body + idempotency table.
- **Logging:** turn on Fastify's pino logger (JSON) with redaction of cookies, auth headers, mobile numbers and any `health*` field — a deliberate change from IMS (`logger:false`).

## 8. Proposed Fitness Platform architecture

Modular monolith, one image:

```
src/
  app.ts, server.ts, config.ts
  core/        db (tx, locks, RLS context), clock, errors, audit, idempotency, ids, logger, secrets
  http/        auth hooks, permission preHandler, schema registry (TypeBox → JSON Schema → OpenAPI)
  modules/
    identity/      users, sessions, OTP, recovery
    profile/       profile, photos, privacy settings
    health/        consents, measurements (history), goals, access grants
    challenges/    challenges, versions (effective-dated JSON config, validated), templates, builder API
    roster/        invitations, participants, lifecycle states, teams
    checkin/       daily records, submissions, evidence files
    verification/  pipeline, OCR provider interface, review queue, appeals
    restdays/, exemptions/ (requests, votes, decisions), bonus/
    scoring/       PURE engine: (config version, roster timeline, day outcomes) → expected events; reconciler writes diffs as append/reversal events
    finance/       ledger (double-entry), payments (manual UPI, gateway interface), periods, settlement
    leaderboard/   ranking, adherence, eligibility, tie analysis
    notifications/ in-app centre, channel interface (push/WhatsApp later), schedules
    community/     (phase 6)   ai/ (provider abstraction; OCR first)
  jobs/        scheduler: day-close at 00:00 IST, rest-day cutoff 10:00 IST, week-close Sunday, reminders
web/           Vite React PWA (built into dist/web)
```

Key design points:
- **Challenge config** = validated JSON document per `challenge_version` with `effective_from`; engine reads the version in force *on each day*. Calamari is a row of data, not code.
- **Scoring is a pure, deterministic function** with a fixed clock, so it is exhaustively unit-testable. Every derived event has a deterministic idempotency key, e.g. `daily:{participant}:{date}`, `pstreak:{participant}:{milestone}:{seq}`. Re-running produces the same keys → no duplicates. When inputs change (an override), the reconciler compares expected vs stored and appends reversal/adjustment events — never deletes.
- **Day finalisation:** at 00:00 IST a job closes the day (no submission ⇒ MISSED unless rest/exemption). Days with pending verification stay provisional; scoring for that day and dependent sequences is recomputed when the decision lands.
- **Ledger** is separate from scoring: double-entry lines that always sum to zero per transaction; balances are queries, never stored totals.

## 9. Entity relationship design (initial)

```
users(id, mobile_e164 UNIQUE, mobile_verified_at, password_hash?, status, created_at)
user_profiles(user_id PK→users, full_name, display_name, email, dob, gender, location, about, photo_file_id)
user_privacy_settings(user_id, field, visibility[PRIVATE|CHALLENGE_MEMBERS|PUBLIC])  PK(user_id, field)
user_consents(id, user_id, kind[HEALTH_PROCESSING|HEALTH_SHARING|AI_COACHING|WHATSAPP], granted_at, revoked_at, version)
health_measurements(id, user_id, metric, value_si numeric, unit_entered, measured_on, recorded_at, deleted_at)   -- RLS; history, never overwritten
health_profile(user_id, fitness_level, activity_level, considerations_encrypted)                                -- RLS
user_fitness_goals(user_id, goal)
health_access_grants(id, owner_user_id, grantee_user_id, challenge_id?, scope, reason, granted_by, expires_at, revoked_at)
sessions, login_attempts, otp_codes                                         -- IMS pattern
files(id, owner_user_id, purpose, storage_key, sha256, mime, bytes, created_at, trashed_at)

challenges(id, slug, name, category, status[DRAFT|PUBLISHED|ACTIVE|CLOSED|SETTLED|ARCHIVED], timezone, starts_on, ends_on, template_id?)
challenge_versions(id, challenge_id, version_no, config jsonb, effective_from date, created_by, reason, created_at)  UNIQUE(challenge_id, version_no)
challenge_templates(id, name, config jsonb)
challenge_periods(challenge_id, period_no, starts_on, ends_on, kind[WEEK])      -- generated from config, Calamari: 6 rows
challenge_roles(challenge_id, user_id, role[SUPER_ADMIN|CHALLENGE_ADMIN|FINANCE_ADMIN])   platform_roles(user_id, role)
invitations(id, challenge_id, mobile_e164, user_id?, status[INVITED|ACCEPTED|DECLINED|EXPIRED|REVOKED], token_hash, expires_at, …)
participants(id, challenge_id, user_id, status[ACTIVE|SUSPENDED|WITHDRAWN|REMOVED|DISQUALIFIED|COMPLETED], joined_effective, left_effective,
             rules_accepted_version, rules_accepted_at)  UNIQUE(challenge_id, user_id)
participant_status_history(id, participant_id, from, to, effective_on, reason, actor, financial_outcome)
teams(id, challenge_id, name)  team_members(team_id, participant_id, from_date, to_date)

day_records(participant_id, day date, status[NOT_SUBMITTED|SUBMITTED|PENDING_VERIFICATION|ACHIEVED|MISSED_TARGET|MISSED_DEADLINE|EXCUSED|REST], finalized_at)  PK(participant_id, day)
submissions(id, participant_id, day, file_id, received_at, client_ref UNIQUE(idempotency), supersedes_id, state)
verification_results(id, submission_id, method[AI|OCR|ADMIN], provider, model, extracted_date, extracted_value, source_app, confidence, flags jsonb, outcome, reviewer_id, reason, created_at)  -- append-only
rest_days(id, participant_id, day, declared_at, source[PARTICIPANT|ADMIN_CORRECTION], cancelled_at, audit_id)
exemption_requests(id, participant_id, days daterange, reason, evidence_file_id, status, decided_by, decided_at, decision_reason)
exemption_votes(request_id, voter_participant_id, vote, cast_at)  PK(request_id, voter_participant_id)
bonus_activities(id, challenge_id, weekend_key, activity, target, evidence_rule)  bonus_submissions(id, bonus_activity_id, participant_id, file_id, status, reviewer_id)

scoring_events(id, challenge_id, participant_id, rule, day, points, idem_key UNIQUE, reverses_event_id?, config_version_id, source jsonb, created_at)  -- append-only
team_streak_history(id, team_id, streak_before, broken_on, responsible participant_ids, restart_on)
personal_streak_snapshots (derived, rebuildable cache)

ledger_accounts(id, challenge_id, kind[CASH_COLLECTED|MAIN_POOL|FINE_POOL|PRIZE_POOL|PAYOUTS|REFUNDS|RECEIVABLE], participant_id?, period_no?)
ledger_transactions(id, challenge_id, type[CONTRIBUTION|FINE_DEDUCTION|UNSPENT_FINE_TRANSFER|MAIN_TO_PRIZE|PAYOUT|REFUND|CORRECTION], period_no, idem_key UNIQUE, origin_ref, actor, created_at)
ledger_lines(transaction_id, account_id, amount_paise bigint)    -- CHECK: lines per transaction sum to 0; amounts in integer paise
payments(id, participant_id, period_no, method[UPI_MANUAL|GATEWAY], amount_paise, utr, proof_file_id, status[SUBMITTED|VERIFIED|REJECTED|FAILED|REFUNDED], verified_by, …)
gateway_events(provider, provider_event_id UNIQUE, payload, received_at, processed_at)
settlements(id, challenge_id, status[DRAFT|PROPOSED|APPROVED|PUBLISHED], snapshot jsonb, approved_by, approved_at)  settlement_lines, payout_records, settlement_adjustments
tie_decisions(id, settlement_id, participants, options jsonb, chosen, reason, decided_by)

notifications(id, user_id, category, priority, title, body, deep_link, read_at, created_at)  notification_deliveries(id, notification_id, channel, status, attempts, last_error)
notification_preferences(user_id, category, channel, enabled, quiet_from, quiet_to)
audit_log(id, at, actor_user_id, challenge_id?, action, entity, entity_id, reason, before jsonb, after jsonb, ip)   -- append-only
idempotency_keys(key, scope, response, created_at)
community_* and moderation_* (phase 6)
```

Money is stored in **integer paise**; points as integers; days as `date` in the challenge timezone; instants as `timestamptz`.

## 10. Phased implementation plan

| Phase | Scope | Exit criterion |
|---|---|---|
| **1 Foundation** | Repo skeleton cloned from IMS conventions; Docker, CI (typecheck/test/build), migrations, roles; identity + sessions; profile; consent + health tables with RLS; challenge/version/config schema + validator; roles/permissions; invitations + roster; Calamari created **via config API**; minimal PWA shell (login, accept invite, rules acceptance) | Tests green; Calamari config validates; permission matrix tests |
| **2 Daily participation** | Day records, screenshot upload, verification pipeline (manual-first, AI provider behind interface), review queue, rest days (10:00 cutoff), exemptions + voting, participant dashboard + calendar | Clock-controlled tests for midnight/10:00/IST boundaries |
| **3 Scoring** | Pure engine + reconciler, every rule in PRD §8, adherence | Exhaustive rule tests + property tests (idempotence, recompute stability) |
| **4 Finance** | Periods, expected contributions, manual UPI submit/verify, fine deductions, week-close transfers, ledger invariants, statements | Ledger always balances; reconciliation tests |
| **5 Leaderboard & settlement** | Ranking, tie analysis, eligibility, settlement workflow, approval, publish, payout records; admin dashboards; audit viewer | Settlement e2e test |
| **Deploy** | Staging on VPS (needs your approval of domain + shared-infra changes), then production by manual dispatch | Stack rehearsal in CI green |
| 6 / 7 | Community, push/WhatsApp, AI coach/generator, analytics | — |

**Proposed re-ordering:** scoring (3) and finance (4) only need *recorded facts* to exist; they don't need to be live on day 1.
So Phases 1–2 are the critical path for the challenge start; 3–5 can run on the data captured from day 1 (recompute is
deterministic). Leaderboard can show "provisional" from Phase 3.

## 11. Risks, dependencies and unresolved decisions

### R0 — Timeline (most important)
Calamari starts **Sunday 22 Nov 2026, in two days**. A correctly built, tested and staged Phase 1+2 is not realistic by then
without cutting the corners the brief forbids. Rest days must be declared before 10:00 on the day, screenshots before midnight,
and Week-1 contributions are due Sunday — those facts must be captured with trustworthy timestamps from day 1.
**Recommendation:** run Week 1 (or until Phase 2 is live) on an *interim capture* process you control
(e.g. a timestamped form, or admin-recorded entries), then import those records through the audited admin-correction path,
each import row referencing its original timestamp. Alternative: move the start date. → **D0**

### Owner decisions recorded (20 Nov 2026)
- **Product scope:** this is a general *fitness app*; challenges are one tab ("Challenges"). More tabs will be added later, so the
  shell/navigation must be tab-extensible. Calamari is just the first challenge; every rule above is Calamari's *configuration*.
  Admins create later challenges with their own settings/rules from a **Challenge Settings** screen.
- **Login (D1):** username + password. Admin creates the account and shares a temporary password; user must change it at
  first sign-in (exact IMS model). No OTP / SMS. Mobile number is a profile field (not a login identity, not verified by OTP).
- **Domains (D4):** `fitness.amogh.systems` (production) and `fitness-test.amogh.systems` (staging) — DNS created by owner.
- **Payments (D7):** no payment gateway. Money moves outside the app. In the app, Finance/Admin uploads the UPI QR (and UPI ID)
  per challenge; participants see it; Finance/Admin confirms each payment manually. The app tracks all calculations
  (contributions, fine pools, fines, transfers, prize pool, settlement) in the ledger. Gateway work is dropped from scope.
- **AI screenshot reading (D6):** pending owner's go-ahead after the cost estimate; manual review works without it.

### Decisions needed before / during Phase 1
| # | Decision | My default if you agree |
|---|---|---|
| D0 | Start-date handling (above) | Interim capture + audited import |
| D1 | Login / mobile verification. SMS OTP in India needs DLT registration + provider (MSG91/Twilio…), WhatsApp OTP needs Business API approval | Phase 1: mobile + password (IMS model); invite link sent by admin over WhatsApp proves possession of the number; OTP provider added when registered |
| D2 | Frontend stack | Vite + React + TS PWA served by Fastify (§4) |
| D3 | API style: IMS RPC allowlist vs typed REST | Typed REST + OpenAPI (PRD asks for mobile-ready documented APIs); keep the IMS "unlisted = unreachable" rule |
| D4 | Domains | `fitness.amogh.systems` / `fitness-test.amogh.systems`? |
| D5 | Separate GHCR image name + deploy user + `/opt/fitness*` dirs on the shared VPS; one Caddy site file; sshd `AllowUsers` append | As described in §5, applied only with your go-ahead |
| D6 | AI/OCR provider for screenshots | Claude vision via the Anthropic API behind a provider interface, with manual review always available; needs an API key owned by you |
| D7 | UPI recipient (UPI ID / QR) | Entered by Super Admin in challenge config; never in code |

### Business-rule ambiguities (PRD §24 list + ones found while designing)
Defaults follow the PRD; **items marked ❓ need your ruling** — I will not invent them.

1. *Rest/exemption between two misses* (miss, rest, miss): rest pauses sequences, so these are two consecutive missed **eligible** days ⇒ −15. (PRD default)
2. *Rest/exemption during comeback*: pauses recovery progress; does not reset. (PRD default)
3. *Several participants break the team streak the same day*: each responsible participant gets −15; one team-streak break recorded listing all of them. (PRD default)
4. *Late joiner*: eligible days start at approved effective date; no retroactive points/penalties; counts toward team days from that date. (PRD default)
5. *Withdrawal*: excluded from team days from the effective date; history kept; financial outcome per configured policy — ❓ **Calamari withdrawal/removal refund policy?**
6. *Removal after team streak computed*: effective date may not be earlier than today unless Super Admin overrides with reason; past team days are not recomputed. ❓ confirm no retroactive removal.
7. *Upload just before midnight, processed later*: the deadline is judged on **server receipt time** of the complete upload (`received_at`), not processing time. ❓ any grace period (e.g. 5 min for slow networks)? Default: none.
8. *Resubmission after rejection*: ❓ allowed only before that day's deadline, or via appeal after? Default: resubmission until deadline; afterwards only an appeal reviewed by Admin.
9. *Duplicate payment webhook*: unique `provider_event_id`; second delivery is acknowledged and ignored. (PRD default)
10. *Fine exceeding fine pool*: deduct only the available balance; the shortfall is not charged and is recorded as `uncollectable` info only. (PRD default)
11. *High points, < 80 % adherence*: shown on leaderboard but not prize-eligible. ❓ **Top-three bonus: do ineligible people get skipped (4th eligible becomes "3rd") or is that share forfeited/redistributed?**
12. *Tie with different adherence*: resolved by tie-break #2 (adherence). Unresolved after all 5 criteria ⇒ Admin decision with recorded reason. (PRD default)
13. *Settlement changed after approval*: approved settlement is immutable; a change = adjustment settlement that needs a new approval. (PRD default)
14. *Rule edited after participants joined*: new version, effective from a future date only; ❓ do financial/scoring changes require participants to re-accept rules? Default: yes for financial changes.
15. *Consent revoked during AI generation*: consent re-checked before the result is stored or shown; result discarded if revoked. (default)

Additional ambiguities found:

16. ❓ **"Responsible for breaking a team streak"** — if the team streak is already 0 (broken yesterday), does today's misser also get −15? If yes, every missed day costs −15 extra. Default proposal: penalty only when the streak was ≥ 1 at the start of that day.
17. ❓ **Two-consecutive-misses penalty on longer runs** — 3 or 4 consecutive misses: −15 once, at every 2nd miss (day 2, 4, …), or on every miss after the first? Default proposal: once per run of ≥ 2 consecutive missed eligible days.
18. ❓ **Comeback "exactly two"** — does a run of 3+ misses followed by 3 successes earn a comeback? PRD says "exactly", so default: no.
19. ❓ **Team streak milestone recipients** — +10 to every active participant on the team on that day? (default) Including someone who was on a rest day that day? Default: yes.
20. ❓ **Weekend definition** — weeks run Sun–Sat, so a Sat+Sun weekend spans two weeks; 22 Nov is a lone Sunday. Proposal: weekend = Saturday + following Sunday; 22 Nov counts as part of a weekend with Sat 21 Nov (i.e. only Sunday). Need your rule.
21. ❓ **Where unused fine balance goes** — both fines *and* unused balances go to the prize pool, so every rupee contributed ends up in the prize pool regardless of misses (5 × ₹1,000 + ₹714 = ₹5,714 per participant). Fines then change nobody's money except via prize eligibility. Is that intended, or should unused fine balance be refunded / credited to the participant?
22. ❓ **Exemption voting for Calamari** — who votes (all active participants except requester?), minimum votes, approval threshold (> 50 %?), voting deadline (e.g. 24 h), Admin override?
23. ❓ **Unpaid contribution** — if a participant hasn't paid for a week, fine deductions are recorded against an expected (receivable) fine pool. Late-payment policy and grace period for Calamari?
24. ❓ **Missed-day counting for fines vs penalties**: a "missed eligible day" includes *submitted but verified below 7,000*? Default: yes — any eligible day without achieved target.
25. Admins who participate cannot review/approve anything about themselves (default, proposed).
26. Rest day declared but steps also submitted: rest day stands (no points); participant may cancel a rest declaration before 10:00. ❓ confirm.

## 12. Reuse vs independent implementation

| Reuse from IMS (copy + rename, keep behaviour) | Adapt | Build new |
|---|---|---|
| Dockerfile, compose, initdb roles, deploy/backup/restore/restore-test/offsite scripts, ssh gate, systemd timers | Auth: username → mobile; global users; per-challenge roles | Challenge engine + config versioning |
| CI workflow incl. stack rehearsal & rollback test; GHCR build; manual prod deploy | RLS: tenant isolation → health-data isolation | Scoring engine + reconciler |
| `withTx`, advisory locks, `Failure` rollback, response helpers, injectable clock | File storage: base64 RPC → multipart; per-user keys | Double-entry ledger + settlement |
| Sessions/cookies/lockout/argon2/CSRF/security headers/secrets encryption | API: RPC allowlist → typed REST w/ allowlist rule | Verification pipeline + review queue |
| Content-addressed media, MIME sniffing, HEIC conversion, authenticated media routes | Logging: off → structured pino w/ redaction | PWA frontend |
| Anthropic SDK pattern (typed errors, test seam, retry worker) | | Notifications centre, exemption voting |
| Vitest + embedded PG + app-role connection + fakes | | |

**No runtime dependency on IMS**: separate repo, image, DB, volumes, secrets, deploy user and domain. Only the Caddy edge and
Docker engine are shared, as IMS already shares them with Rent.

## 13. Differences between the PRD and the IMS architecture
- PRD wants per-challenge RBAC with four roles; IMS has tenant-wide Owner/Staff. → new authorization layer.
- PRD wants verified mobile identity; IMS has usernames. → D1.
- PRD wants documented mobile-ready APIs; IMS has a browser-only RPC. → D3.
- PRD wants structured logs and error tracking; IMS logs to console. → pino + redaction; error tracking tool TBD (self-hosted or none initially).
- PRD wants push/WhatsApp; IMS only sends email (Resend). → later phases.
- PRD's privacy model (field-level visibility, consent, grants) has no IMS counterpart.
