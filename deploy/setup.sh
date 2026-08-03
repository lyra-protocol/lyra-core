#!/usr/bin/env bash
#
# Provisions the Lyra harvester on a host that may already be running other
# production services.
#
# The critical safety property: it installs its OWN Node runtime under
# /opt/lyra/node and never touches the system Node. wavo-api on the target box
# runs on /usr/bin/node v20 with native modules (sharp) compiled against that
# ABI — a system-wide Node upgrade would break it. So we do not do one.
#
# Also: no ports opened, no nginx/web-server config touched, no existing user
# modified, everything confined to /opt/lyra.
#
# Idempotent. Re-running updates the code and restarts the service.
set -euo pipefail

REPO="https://github.com/lyra-protocol/lyra-core.git"
ROOT=/opt/lyra
NODE_VERSION=v24.10.0
NODE_ARCH=linux-arm64

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "system node (must be left alone)"
echo "  /usr/bin/node -> $(/usr/bin/node -v 2>/dev/null || echo 'none')"

say "installing a private Node ${NODE_VERSION} for Lyra only"
sudo mkdir -p "$ROOT/data"
if [ ! -x "$ROOT/node/bin/node" ]; then
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.xz" -o "$TMP/node.tar.xz"
  sudo mkdir -p "$ROOT/node"
  sudo tar -xJf "$TMP/node.tar.xz" -C "$ROOT/node" --strip-components=1
  rm -rf "$TMP"
fi
echo "  lyra node -> $("$ROOT/node/bin/node" -v)"
echo "  system node unchanged -> $(/usr/bin/node -v 2>/dev/null || echo 'none')"

say "creating isolated service user"
id -u lyra >/dev/null 2>&1 || sudo useradd --system --home "$ROOT" --shell /usr/sbin/nologin lyra

say "fetching code"
if [ -d "$ROOT/lyra-core/.git" ]; then
  sudo git -C "$ROOT/lyra-core" fetch --quiet origin main
  sudo git -C "$ROOT/lyra-core" reset --quiet --hard origin/main
else
  sudo git clone --quiet "$REPO" "$ROOT/lyra-core"
fi

say "building with the private node"
export PATH="$ROOT/node/bin:$PATH"
sudo env PATH="$PATH" "$ROOT/node/bin/npm" --prefix "$ROOT/lyra-core" ci --silent
sudo env PATH="$PATH" "$ROOT/node/bin/npm" --prefix "$ROOT/lyra-core" run build --silent

say "permissions"
sudo chown -R lyra:lyra "$ROOT"

say "installing service"
sudo cp "$ROOT/lyra-core/deploy/lyra-harvester.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lyra-harvester
sleep 4
sudo systemctl --no-pager --lines=8 status lyra-harvester || true

say "confirming the co-tenant is untouched"
systemctl is-active wavo-api 2>/dev/null | sed 's/^/  wavo-api: /' || true
systemctl is-active nginx 2>/dev/null | sed 's/^/  nginx:    /' || true

echo
echo "logs: sudo tail -f /opt/lyra/data/harvest.log"
