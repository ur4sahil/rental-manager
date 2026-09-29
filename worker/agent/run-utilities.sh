#!/bin/bash
# Residential utility agent — sweeps ALL portals from this home-network Mac.
# Residential IP is required for reCAPTCHA-scored logins (WG, WSSC). One box
# per portal only (never also on Oracle) or the sessions race and mis-attribute
# balances. Providers overridable via HOUSY_SWEEP_PROVIDERS.
export PATH="/Users/sheebasoin/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NVM_DIR="$HOME/.nvm"
set -a; . "$HOME/.housy-agent.env"; set +a
LOCK="$HOME/housy-agent/util.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "$(date -u +%FT%TZ) another sweep holds the lock; exit"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
cd "$HOME/rental-manager/worker" || exit 1
# Visible Chrome for sign-in AND bill reading: this Mac exists to be a real
# desktop browser on a home IP (reCAPTCHA scores a hidden headless one as a bot).
export HOUSY_HEADED=1
PROVIDERS="${HOUSY_SWEEP_PROVIDERS:-washington_gas pepco wssc bge smeco}"
echo "===== $(date -u +%FT%TZ) residential sweep start (IP $(curl -s https://api.ipify.org)) providers=[$PROVIDERS] ====="
for p in $PROVIDERS; do
  echo "----- $(date -u +%FT%TZ) $p -----"
  # BGE mails a one-time code on each fresh sign-in: let ensure-session wait for
  # it and read it from local Mail (worker/portals/mail-code.js). A still-valid
  # session is reused and sends no code.
  if [ "$p" = "bge" ]; then
    HOUSY_CODE_FILE="$HOME/housy-agent/bge-code.txt" node portals/ensure-session.js "$p" || echo "ensure-session $p exited $?"
  else
    node portals/ensure-session.js "$p" || echo "ensure-session $p exited $?"
  fi
  node portals/sweep.js "$p" || echo "sweep $p exited $?"
done
echo "===== $(date -u +%FT%TZ) residential sweep done ====="
