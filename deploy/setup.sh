#!/usr/bin/env bash
#
# Provisions the Lyra harvester on a fresh or shared Ubuntu ARM host.
#
# Safe to run on a box already running other projects:
#   - creates a dedicated 'lyra' system user, touches no existing user
#   - installs only under /opt/lyra
#   - opens no ports, changes no firewall rules, touches no web server config
#   - installs Node only if absent, and never downgrades an existing install
#
# Idempotent. Re-running updates the code and restarts the service.
set -euo pipefail

REPO="https://github.com/lyra-protocol/lyra-core.git"
ROOT=/opt/lyra
NODE_MAJOR=24

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "checking for an existing Node ${NODE_MAJOR}+"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
  echo "node $(node -v) already present, leaving it alone"
else
  echo "installing Node ${NODE_MAJOR} from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

say "creating isolated service user"
id -u lyra >/dev/null 2>&1 || sudo useradd --system --home "$ROOT" --shell /usr/sbin/nologin lyra
sudo mkdir -p "$ROOT/data"

say "fetching code"
if [ -d "$ROOT/lyra-core/.git" ]; then
  sudo git -C "$ROOT/lyra-core" fetch --quiet origin main
  sudo git -C "$ROOT/lyra-core" reset --quiet --hard origin/main
else
  sudo git clone --quiet "$REPO" "$ROOT/lyra-core"
fi

say "building"
sudo npm --prefix "$ROOT/lyra-core" ci --silent
sudo npm --prefix "$ROOT/lyra-core" run build --silent

say "permissions"
sudo chown -R lyra:lyra "$ROOT"

say "installing service"
sudo cp "$ROOT/lyra-core/deploy/lyra-harvester.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lyra-harvester

say "status"
sudo systemctl --no-pager --lines=15 status lyra-harvester || true
echo
echo "logs:    sudo tail -f /opt/lyra/data/harvest.log"
echo "db:      /opt/lyra/data/venue.db"
echo "stop:    sudo systemctl stop lyra-harvester"
