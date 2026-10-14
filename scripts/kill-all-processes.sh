#!/usr/bin/env bash
# Kill all project-aggregation related processes
# Does NOT delete any files or data

set -Eeuo pipefail

echo "=== Killing all project-aggregation processes ==="
echo ""

echo "Step 1: Stopping systemd services..."
sudo systemctl stop project-aggregation.service 2>/dev/null || true
sudo systemctl stop project-aggregation-updater.service 2>/dev/null || true
sudo systemctl stop project-aggregation-update-worker.service 2>/dev/null || true
sudo systemctl stop project-aggregation-hub.service 2>/dev/null || true

echo "Step 2: Killing Python processes..."
sudo pkill -9 -f 'python.*project-aggregation' || true
sudo pkill -9 -f 'python.*aster' || true
sudo pkill -9 -f 'python.*greeks' || true

echo "Step 3: Killing Node processes..."
sudo pkill -9 -f 'node.*project-aggregation' || true

echo "Step 4: Killing installer processes..."
sudo pkill -9 -f 'install.*project-aggregation' || true
sudo pkill -9 -f 'bash.*install-all' || true

echo "Step 5: Waiting for cleanup..."
sleep 2

echo "Step 6: Verifying..."
remaining=$(ps aux | grep -E 'project-aggregation|python.*aster|python.*greeks' | grep -v grep | grep -v kill-all || true)
if [[ -n "$remaining" ]]; then
    echo "Remaining processes:"
    echo "$remaining"
else
    echo "✓ All processes stopped"
fi

echo ""
echo "Ports status:"
sudo lsof -i :3100 -t 2>/dev/null || echo "✓ Port 3100 free"

echo ""
echo "=== Cleanup complete ==="
echo "You can now run the installer manually."
