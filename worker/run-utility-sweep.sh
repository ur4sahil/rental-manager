#!/bin/bash
# Daily utility sweep for EVERY provider (deployed to the LLM box as
# ~/housy-browser/run-utility-sweep.sh; the housy-sweep.timer runs it at 06:30).
# Single-instance via flock so two runs can never race the same portal session.
# For each provider: ensure-session refreshes the login (encryption key on this
# box; ciphertext fetched over the worker API), then sweep reads + records +
# attaches the statement PDF. Providers that need a person to sign in (BGE
# mails a code, Washington Gas runs reCAPTCHA v3) are attempted too:
# ensure-session refuses cleanly and sweep reuses a session a person created in
# the streamed browser. Per-provider failures never fail the whole run.
exec 9>/tmp/housy-utility-sweep.lock
flock -n 9 || { echo "$(date -u +%FT%TZ) another sweep is running, skipping"; exit 0; }
set -a
source "$HOME/.housy-worker.env" 2>/dev/null || true
source "$HOME/.housy-sweep.env"  2>/dev/null || true
export ENCRYPTION_KEY_FILE="$HOME/.housy-enckey"
export HOUSY_SESSION_DIR="$HOME/.housy-sessions"
set +a
cd "$HOME/housy-browser" || exit 1
PROVIDERS="${HOUSY_SWEEP_PROVIDERS:-wssc washington_gas pepco bge smeco}"
for p in $PROVIDERS; do
  echo "===== $(date -u +%FT%TZ) ensure-session $p ====="
  timeout 200 node portals/ensure-session.js "$p" || echo "ensure-session $p exited $?"
  echo "===== $(date -u +%FT%TZ) sweep $p ====="
  timeout 2400 node portals/sweep.js "$p" || echo "sweep $p exited $?"
done
echo "===== $(date -u +%FT%TZ) done ====="
