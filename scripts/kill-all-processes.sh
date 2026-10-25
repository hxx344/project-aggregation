#!/usr/bin/env bash
# Stop all project-aggregation services. Does NOT delete any files or data.
# Only the project's own systemd units are stopped: systemd sends SIGTERM to every
# process in each unit's cgroup (so installer rollback traps still run) and escalates
# to SIGKILL after the unit's stop timeout. Unrelated processes are never matched by name.

set -Eeuo pipefail

UNITS=(project-aggregation.service project-aggregation-api.service project-aggregation-updater.service project-aggregation-update-worker.service)

echo "=== Stopping project-aggregation services ==="
echo ""

for unit in "${UNITS[@]}"; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    echo "Stopping $unit..."
    sudo systemctl stop "$unit" || echo "Warning: failed to stop $unit"
  fi
done

echo ""
echo "Verifying..."
remaining=0
for unit in "${UNITS[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    echo "Still active: $unit"
    remaining=1
  fi
done
[[ $remaining -eq 0 ]] && echo "✓ All project-aggregation units stopped"

if command -v flock >/dev/null 2>&1 && ! sudo flock -n /run/lock/project-aggregation-install.lock true 2>/dev/null; then
  echo "An installer still holds /run/lock/project-aggregation-install.lock; wait for it to finish or roll back."
fi

echo ""
echo "Port 3100:"
if listeners=$(sudo lsof -nP -iTCP:3100 -sTCP:LISTEN 2>/dev/null) && [[ -n "$listeners" ]]; then
  echo "$listeners"
  echo "Port 3100 is still in use by the process(es) above; inspect them before stopping anything manually."
else
  echo "✓ Port 3100 free"
fi

echo ""
echo "=== Done ==="
echo "You can now run the installer manually."
