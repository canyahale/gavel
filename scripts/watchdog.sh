#!/bin/bash
# Gavel bot watchdog — restart the auction bot if it is down or stuck.
# The bot is a plain background process, so a VM restart kills it and
# nothing brings it back. This script is run every few minutes by a cron:
# it restarts the bot when it is missing, or when it is alive but every
# recent log line is a fetch failure (stuck, opening no lots).
# Exit 0 and print one line describing what it did (or that all is well).
set -u
cd ~/workspace/gavel || { echo "watchdog: cannot cd to ~/workspace/gavel"; exit 1; }
BOT_PAT="^node scripts/bot\.js$"

# Rotate the log when it gets big (5 MB), so it never grows without bound
# now that we append instead of truncating.
if [ -f bot.log ] && [ "$(stat -c%s bot.log 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv bot.log "bot.log.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
fi

if ! pgrep -f "$BOT_PAT" >/dev/null 2>&1; then
  echo "watchdog: bot not running — starting it"
  nohup node scripts/bot.js >> bot.log 2>&1 &
  sleep 6
  if pgrep -f "$BOT_PAT" >/dev/null 2>&1; then
    echo "watchdog: bot started, PID $(pgrep -f "$BOT_PAT" | head -1)"
  else
    echo "watchdog: FAILED to start bot"
    exit 1
  fi
  exit 0
fi

# Bot process exists. Check whether it is doing healthy work or stuck.
# Healthy log lines: SETTLE / OPEN lot / INCOME / LEARN / STARTUP / BOT RUNNING.
TAIL="$(tail -20 bot.log 2>/dev/null || true)"
if printf '%s' "$TAIL" | grep -qE "SETTLE|OPEN lot|INCOME|LEARN|STARTUP|BOT RUNNING"; then
  echo "watchdog: bot running and healthy (PID $(pgrep -f "$BOT_PAT" | head -1))"
  exit 0
fi
# No healthy line in the last 20. If they are all fetch failures, it is stuck.
N_FAIL="$(printf '%s' "$TAIL" | grep -c "TICK ERROR: fetch failed" || true)"
N_TOTAL="$(printf '%s' "$TAIL" | grep -c . || true)"
if [ "$N_TOTAL" -ge 5 ] && [ "$N_FAIL" = "$N_TOTAL" ]; then
  OLD_PID="$(pgrep -f "$BOT_PAT" | head -1)"
  echo "watchdog: bot PID $OLD_PID stuck (last $N_TOTAL log lines all fetch-failed) — restarting"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 2
  nohup node scripts/bot.js >> bot.log 2>&1 &
  sleep 6
  if pgrep -f "$BOT_PAT" >/dev/null 2>&1; then
    echo "watchdog: bot restarted, PID $(pgrep -f "$BOT_PAT" | head -1)"
  else
    echo "watchdog: FAILED to restart bot"
    exit 1
  fi
  exit 0
fi
echo "watchdog: bot running, recent log unclear — leaving it alone (PID $(pgrep -f "$BOT_PAT" | head -1))"
exit 0
