# Operations

All commands run on the VPS as `deploy-fitness` in the environment's directory
(`sudo -iu deploy-fitness`, then `cd /opt/fitness` or `/opt/fitness-staging`).

| Task | Command |
| --- | --- |
| Status (image, backups) | GitHub: Actions → deploy (the last step prints it), or `cat IMAGE_TAG status/backup status/restore` |
| Health | `curl -s https://fitness.amogh.systems/healthz` (database, migrations, last backup, screenshot reading, scheduler) |
| First Super Admin | `./cli.sh create-super-admin <username> "<name>"` |
| Create a challenge from a settings file | `./cli.sh create-challenge <slug> config/challenges/<file>.json <admin username>` |
| Check a settings file | `./cli.sh validate-config config/challenges/<file>.json` |
| Apply a settings file as new rules (audited, versioned) | `./cli.sh apply-config <slug> config/challenges/<file>.json <admin username> "<reason>" [first day, after the start]` |
| Screenshot reading on/off | `./set-key.sh anthropic` (paste the key; empty = off) |
| Backup now | `./backup.sh` (nightly at 03:15 IST anyway) |
| Restore test now | `./restore-test.sh` (Sundays 04:15 IST anyway) |
| Logs | `docker compose --project-directory . -f compose.yaml logs --tail 200 fit-app` (with `IMAGE_TAG=$(cat IMAGE_TAG)`) |

## Backups

- **Nightly** (`fitness-backup@<env>.timer`, 03:15 IST): database dump (`pg_dump -Fc`, verified with `pg_restore --list`)
  and the evidence images (tar of the media volume, verified). Kept 14 days; weekly copies (Sunday) 8 weeks; monthly
  (2nd) 12 months. `/healthz` shows the last result.
- **Before every deploy:** a verified dump in `backups/predeploy/` (last 10 kept).
- **Weekly restore test** (`fitness-restore-test@<env>.timer`, Sunday 04:15 IST): the newest dump is restored into a
  throwaway PostgreSQL with no network, and every evidence file the database refers to must be in the image archive.
- **Off-site (recommended):** encrypted with restic, sent with rclone (e.g. to Google Drive). Install `restic` and
  `rclone`, then create `offsite.env`, `offsite.pass` (keep a copy of the password in your password manager) and
  `rclone.conf` in the environment directory as described at the top of `offsite.sh`. `backup.sh` then runs it nightly.

## Restore

| Situation | Action |
| --- | --- |
| A deploy fails its health check | nothing to do: `deploy.sh` switches back to the previous image automatically |
| A release is healthy but wrong | Actions → deploy → same environment, SHA = the previous good commit |
| A migration failed during deploy | nothing switched; the running app is untouched. Fix forward with a new migration. |
| Bad data after a release or a mistaken action | `./restore.sh backups/predeploy/predeploy-<sha>-….dump --yes` (or a nightly dump). A safety dump of the current state is taken first and the restore is one transaction. |
| Evidence images lost | `./restore.sh <dump> --media backups/nightly/media-<…>.tar.gz --yes` |
| VPS lost | new VPS → shared edge + `bootstrap-fitness.sh` → restore the latest off-site copy (`restic restore latest`) → `./restore.sh` |

Never: drop or truncate the database, delete the volumes (`docker compose down -v`), or edit an applied migration.
Corrections to challenge data are made in the app (audited), not in SQL.
