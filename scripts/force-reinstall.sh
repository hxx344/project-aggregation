#!/usr/bin/env bash
# Force clean reinstall of project-aggregation
# WARNING: This will stop all services and kill all related processes

set -Eeuo pipefail

echo "=== Project Aggregation Force Reinstall ==="
echo ""
echo "This will:"
echo "  1. Stop systemd services"
echo "  2. Kill all related processes"
echo "  3. Clean up old installations"
echo "  4. Run fresh install"
echo ""
read -p "Continue? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "Step 1: Stopping systemd services..."
sudo systemctl stop project-aggregation.service 2>/dev/null || true
sudo systemctl stop project-aggregation-updater.service 2>/dev/null || true
sudo systemctl stop project-aggregation-update-worker.service 2>/dev/null || true
sudo systemctl stop project-aggregation-hub.service 2>/dev/null || true

echo "Step 2: Killing all project-aggregation processes..."
# Kill Python processes
sudo pkill -9 -f 'python.*project-aggregation' || true
sudo pkill -9 -f 'python.*aster' || true
sudo pkill -9 -f 'python.*greeks' || true

# Kill Node processes
sudo pkill -9 -f 'node.*project-aggregation' || true

# Kill any installer processes
sudo pkill -9 -f 'install.*project-aggregation' || true
sudo pkill -9 -f 'bash.*install-all' || true

echo "Step 3: Waiting for processes to terminate..."
sleep 2

echo "Step 4: Verifying cleanup..."
remaining=$(ps aux | grep -E 'project-aggregation|aster|greeks' | grep -v grep | grep -v force-reinstall || true)
if [[ -n "$remaining" ]]; then
    echo "Warning: Some processes still running:"
    echo "$remaining"
    echo ""
    read -p "Force kill these too? (yes/no): " force
    if [[ "$force" == "yes" ]]; then
        ps aux | grep -E 'project-aggregation|aster|greeks' | grep -v grep | awk '{print $2}' | xargs -r sudo kill -9 || true
    fi
fi

echo "Step 5: Checking port 3100..."
port_user=$(sudo lsof -i :3100 -t 2>/dev/null || true)
if [[ -n "$port_user" ]]; then
    echo "Port 3100 still in use by PID: $port_user"
    sudo kill -9 $port_user || true
fi

echo "Step 6: Cleaning up incomplete installations..."
sudo rm -rf /opt/project-aggregation/.install.* 2>/dev/null || true

echo ""
echo "✓ Cleanup complete!"
echo ""
echo "Step 7: Starting fresh installation..."
echo ""

# Run the installer
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash

echo ""
echo "=== Installation complete ==="
