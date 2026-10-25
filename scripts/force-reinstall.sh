#!/usr/bin/env bash
# Stop project-aggregation services and run a fresh install. Keeps configuration and data.
# Only the project's own systemd units are stopped (SIGTERM, then systemd's own SIGKILL
# escalation within each unit's cgroup); unrelated processes are never matched by name.

set -Eeuo pipefail

UNITS=(project-aggregation.service project-aggregation-api.service project-aggregation-updater.service project-aggregation-update-worker.service)
INSTALL_LOCK=/run/lock/project-aggregation-install.lock

echo "=== Project Aggregation Force Reinstall ==="
echo ""
echo "This will:"
echo "  1. Stop the project-aggregation systemd services"
echo "  2. Remove work directories left by interrupted installs"
echo "  3. Run a fresh install (configuration and data are kept)"
echo ""
read -r -p "Continue? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "Step 1: Stopping systemd services..."
for unit in "${UNITS[@]}"; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    sudo systemctl stop "$unit" || echo "Warning: failed to stop $unit"
  fi
done
for unit in "${UNITS[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    echo "Error: $unit is still active; inspect it with 'systemctl status $unit' before reinstalling."
    exit 1
  fi
done

echo "Step 2: Cleaning up interrupted installations..."
# Hold the installer lock so a running installer's work directory is never removed.
if [[ -d /opt/project-aggregation ]]; then
  if ! sudo flock -n "$INSTALL_LOCK" true; then
    echo "Error: another installer holds $INSTALL_LOCK; wait for it to finish or roll back."
    exit 1
  fi
  sudo flock -n "$INSTALL_LOCK" find /opt/project-aggregation -maxdepth 1 -type d -name '.install.*' -exec rm -rf -- {} +
fi

echo "Step 3: Checking port 3100..."
if listeners=$(sudo lsof -nP -iTCP:3100 -sTCP:LISTEN 2>/dev/null) && [[ -n "$listeners" ]]; then
  echo "$listeners"
  echo "Error: port 3100 is still in use by the process(es) above; inspect them before reinstalling."
  exit 1
fi

echo ""
echo "✓ Cleanup complete!"
echo ""
echo "Step 4: Starting fresh installation..."
echo ""

curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash

echo ""
echo "=== Installation complete ==="
