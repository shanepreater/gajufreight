#!/bin/sh
# Creates the two schemas and one role per service (ADR 0013): the indexer owns and
# writes `read` only; the API owns `app` and may only read `read`. Runs once, when the
# database volume is first created. Passwords come from infra/local/.env (init-env.sh).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_password="$API_DB_PASSWORD" -v indexer_password="$INDEXER_DB_PASSWORD" <<'SQL'
CREATE ROLE gf_api LOGIN PASSWORD :'api_password';
CREATE ROLE gf_indexer LOGIN PASSWORD :'indexer_password';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA read AUTHORIZATION gf_indexer;
CREATE SCHEMA app AUTHORIZATION gf_api;

GRANT USAGE ON SCHEMA read TO gf_api;
ALTER DEFAULT PRIVILEGES FOR ROLE gf_indexer IN SCHEMA read GRANT SELECT ON TABLES TO gf_api;
SQL
