# VPS deployment

The fitness app runs on the same Hostinger VPS as AaryaShree IMS and the Rent system, **fully separate** from both:
its own deploy user, directories, database, volumes, secrets, image and backup timers. It reuses the IMS deployment
design (restricted SSH gate, pre-deploy backup, migrations, health check through Caddy, automatic rollback).

```
Internet ──443/80──▶ shared Caddy (Rent's /opt/edge, network "edge")
                        ├── (Rent, IMS sites)            unchanged
                        ├── fitness-test.amogh.systems ─▶ fit-app-staging     (project fitness-staging, /opt/fitness-staging)
                        └── fitness.amogh.systems ──────▶ fit-app-production  (project fitness, /opt/fitness)
each project:  fit-app ─(internal network)─ fit-db (PostgreSQL 17, no published port)
               volumes: <project>_pgdata, <project>_media (evidence images)
```

| | Staging | Production |
| --- | --- | --- |
| URL | https://fitness-test.amogh.systems | https://fitness.amogh.systems |
| Directory | `/opt/fitness-staging` | `/opt/fitness` |
| Compose project | `fitness-staging` | `fitness` |
| Deploys | automatic after every merge to `main` (once enabled) | manual only (Actions → deploy → production) |
| Backups | 03:15 IST nightly, restore test Sundays 04:15 IST | same |

What is shared with the other apps, and how it's touched (by `bootstrap-fitness.sh` only):

- **The Caddy edge:** one new site file `/opt/edge/sites/fitness-<env>.caddy`, placed only after `caddy validate` passes.
- **The sshd `AllowUsers` line:** `deploy-fitness` is appended, validated with `sshd -t` and rolled back on failure.
- **The Docker engine.**

Nothing of IMS or Rent is otherwise read or changed. Memory: about 770 MB per environment at most (DB 384 MB, app 384 MB).

## One-time setup (you, per environment — start with staging)

1. **DNS:** `fitness-test` and `fitness` A records → the VPS IP (already done).
2. **Deploy key** (on your Mac):
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/fitness_deploy -C deploy-fitness -N ''
   ```
3. **Bootstrap** (your admin key, the same one you use for IMS/Rent):
   ```
   scp -i ~/.ssh/rent_admin -r deploy admin@<VPS IP>:/tmp/fitness-deploy
   ssh -i ~/.ssh/rent_admin admin@<VPS IP> \
     sudo bash /tmp/fitness-deploy/bootstrap-fitness.sh --env staging --domain fitness-test.amogh.systems --deploy-key "$(cat ~/.ssh/fitness_deploy.pub)"
   ```
   It creates `deploy-fitness`, `/opt/fitness-staging` with random secrets in `.env` (copy them into your password
   manager: `sudo cat /opt/fitness-staging/.env`) and the Caddy site.
4. **Image access:** `sudo -iu deploy-fitness docker login ghcr.io -u <github user>` with a GitHub token that has
   only `read:packages`.
5. **GitHub → fitness-app → Settings:**
   - Secrets (Actions): `VPS_HOST` = the VPS IP; `VPS_FIT_SSH_KEY` = contents of `~/.ssh/fitness_deploy`;
     `VPS_KNOWN_HOSTS` = output of `ssh-keyscan -t ed25519 <VPS IP>`.
   - Variables: `FIT_STAGING_DOMAIN` = `fitness-test.amogh.systems`; `FIT_PRODUCTION_DOMAIN` = `fitness.amogh.systems`;
     `FIT_STAGING_ENABLED` = `true`.
   - Environments: create `staging` and `production`; on `production` add yourself as a required reviewer.
6. **First deploy:** Actions → deploy → Run workflow → staging.
7. **First account and Calamari:**
   ```
   sudo -iu deploy-fitness /opt/fitness-staging/cli.sh create-super-admin <username> "<Your name>"
   sudo -iu deploy-fitness /opt/fitness-staging/cli.sh create-challenge calamari-2026 config/challenges/calamari-2026.json <username>
   ```
   The first prints a temporary password (changed at first sign-in). Calamari is created as a draft: check its
   Settings in the app, then Publish, create accounts (People) and invite.
8. **Screenshot reading (optional):** `sudo -iu deploy-fitness /opt/fitness-staging/set-key.sh anthropic`, then paste
   the key. It is stored only in that environment's `.env`. Without it every screenshot goes to manual review.

Production is the same with `--env production --domain fitness.amogh.systems` and `/opt/fitness`, then
Actions → deploy → production.

## Deploying

| What | How |
| --- | --- |
| Build | every merge to `main` builds `ghcr.io/…/fitness-app:<sha>` (`build.yml`) |
| Staging | the deploy workflow runs automatically after a successful build (when `FIT_STAGING_ENABLED` is `true`) |
| Production | only manually: Actions → deploy → environment `production` (optional SHA) |
| Guards | the SHA must be on `main`, CI must be green for it, and the image must exist |
| On the server | `fitness-ssh-gate` installs the `deploy/` files of **that same commit**, then `deploy.sh`: pull → pre-deploy backup → migrations (failure stops here) → switch → health through Caddy → **automatic rollback** if unhealthy |
| Roll back | run the deploy workflow with the previous good SHA |

The deploy key can run exactly two commands: `deploy <env> <sha>` and `status <env>`. There is no shell.

## Tested before it touches the VPS

The CI job `stack` (`.github/scripts/stack-test.sh`) runs the real `deploy/` files on a GitHub runner on every push:
deploy through the gate; HTTPS, redirect and security headers; first Super Admin, sign-in and Calamari from its settings
file; `fit_app` has no DDL; the audit log is append-only; PostgreSQL isn't published; backup, restore test and
`restore.sh`; a deliberately broken image rolled back automatically; a redeploy that keeps the data.
