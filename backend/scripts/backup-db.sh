#!/usr/bin/env bash
# Local/self-hosted database backup -- a baseline safety net, not a production backup strategy.
# For a real deployment, prefer a managed Postgres provider's built-in automated backups (RDS,
# Supabase, Neon, Cloud SQL, etc.) over cron + pg_dump; this app doesn't have a chosen hosting
# target yet, so this script is what's committable today. If self-hosting Postgres in production
# is ever the actual plan, schedule this via the platform's own cron/scheduled-job mechanism and
# ship BACKUP_DIR's contents off-host (S3, etc.) rather than leaving backups on the same disk as
# the database they're protecting.
#
# Usage: DATABASE_URL=postgresql://... ./backup-db.sh [BACKUP_DIR]
# Reads DATABASE_URL from the environment (same variable the app itself uses, see app/config.py).

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set -- refusing to guess a connection string." >&2
  exit 1
fi

BACKUP_DIR="${1:-$(dirname "$0")/../backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/app_db_${TIMESTAMP}.sql.gz"

echo "Backing up $(echo "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#') -> $OUT_FILE"
pg_dump "$DATABASE_URL" | gzip > "$OUT_FILE"
echo "Done: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
