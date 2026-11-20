#!/usr/bin/env bash
# 备用触发：每 60 秒比对远端 main 与已部署 SHA，有变化则部署。
# 仅在 Jenkins 不可用时启用（systemctl enable --now xigu-watch.timer）。
set -euo pipefail
APP=/opt/xigu/app
DATA=/var/lib/xigu
cd "$APP"
REMOTE=$(timeout 25 git ls-remote origin refs/heads/main | cut -f1 || true)
[ -z "${REMOTE:-}" ] && exit 0
DEPLOYED=$(cat "$DATA/deployed-sha" 2>/dev/null || git rev-parse HEAD)
[ "$REMOTE" = "$DEPLOYED" ] && exit 0
/usr/local/bin/xigu-deploy.sh
