#!/usr/bin/env bash
# NanoClaw nightly backup → leoplanet/nanoclaw-backup (private)
set -euo pipefail

NANOCLAW_DIR="/home/shockr/nanoclaw"
BACKUP_DIR="/home/shockr/nanoclaw-backup"
LOG="$NANOCLAW_DIR/logs/backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== NanoClaw backup started ==="

# ── 1. Code: push any uncommitted customisations to the fork ──────────────────
log "Pushing code to fork..."
cd "$NANOCLAW_DIR"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: auto-backup $(date '+%Y-%m-%d')"
fi
git push origin main 2>&1 | tee -a "$LOG" || log "WARN: code push failed (non-fatal)"

# ── 2. Assemble runtime data into backup repo ─────────────────────────────────
log "Assembling runtime data..."
cd "$BACKUP_DIR"

# .env
cp "$NANOCLAW_DIR/.env" .env

# SQLite DB
mkdir -p store
cp "$NANOCLAW_DIR/store/messages.db" store/messages.db

# Group workspaces (CLAUDE.md + agent memory/files)
mkdir -p groups
for group_dir in "$NANOCLAW_DIR/groups"/telegram_* "$NANOCLAW_DIR/groups"/slack_* "$NANOCLAW_DIR/groups"/discord_* "$NANOCLAW_DIR/groups"/whatsapp_*; do
  [ -d "$group_dir" ] || continue
  group_name=$(basename "$group_dir")
  rsync -a --delete "$group_dir/" "groups/$group_name/"
done
# Always include main and global
for static in main global; do
  [ -d "$NANOCLAW_DIR/groups/$static" ] || continue
  rsync -a --delete "$NANOCLAW_DIR/groups/$static/" "groups/$static/"
done

# Claude auth sessions
if [ -d "$NANOCLAW_DIR/data/sessions" ]; then
  mkdir -p data
  rsync -a --delete "$NANOCLAW_DIR/data/sessions/" data/sessions/
fi

# ── 3. OneCLI PostgreSQL dump ─────────────────────────────────────────────────
log "Dumping OneCLI database..."
mkdir -p onecli
if docker exec onecli-postgres-1 pg_dump -U onecli onecli > onecli/onecli.sql 2>>"$LOG"; then
  log "OneCLI DB dump: OK ($(wc -c < onecli/onecli.sql) bytes)"
else
  log "WARN: OneCLI DB dump failed (non-fatal)"
fi

# ── 4. Commit and push backup repo ───────────────────────────────────────────
log "Committing backup..."
git add -A
if git diff --cached --quiet; then
  log "No changes since last backup — nothing to commit."
else
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
  git commit -m "backup: $TIMESTAMP"
  log "Pushing to GitHub..."
  git push origin main 2>&1 | tee -a "$LOG"
  log "Backup pushed successfully."
fi

log "=== NanoClaw backup complete ==="
