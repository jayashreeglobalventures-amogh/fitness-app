#!/bin/sh
# Runs once, when the pgdata volume is first initialised.
# fit_owner: owns the schema, runs migrations. fit_app: data only, no DDL (append-only tables refuse edits anyway).
set -eu
psql -v ON_ERROR_STOP=1 -U postgres -d fitness \
  -v owner_pw="$FIT_OWNER_PASSWORD" -v app_pw="$FIT_APP_PASSWORD" <<'SQL'
CREATE ROLE fit_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE fit_app LOGIN PASSWORD :'app_pw';
ALTER DATABASE fitness OWNER TO fit_owner;
REVOKE ALL ON DATABASE fitness FROM PUBLIC;
GRANT CONNECT ON DATABASE fitness TO fit_app;
ALTER SCHEMA public OWNER TO fit_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fit_app;
CREATE SCHEMA drizzle AUTHORIZATION fit_owner;
GRANT USAGE ON SCHEMA drizzle TO fit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fit_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fit_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fit_owner IN SCHEMA drizzle GRANT SELECT ON TABLES TO fit_app;
SQL
