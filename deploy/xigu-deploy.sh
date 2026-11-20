#!/usr/bin/env bash
# 溪谷优选客服平台部署脚本：拉取 → 语法校验 → 重启 → 健康检查，任一步失败自动回滚
set -euo pipefail

APP=/opt/xigu/app
DATA=/var/lib/xigu
SERVICE=xigu
BRANCH=main
LOG=/var/log/xigu-deploy.log

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') deploy start ====="

cd "$APP"
PREV=$(git rev-parse HEAD)
git fetch --quiet origin "$BRANCH"
TARGET=$(git rev-parse "origin/$BRANCH")

if [ "$PREV" = "$TARGET" ]; then
  echo "already at ${TARGET:0:7}, nothing to do"
  echo "$TARGET" > "$DATA/deployed-sha"
  exit 0
fi
echo "update ${PREV:0:7} -> ${TARGET:0:7}"

restore() {
  echo "rollback to ${PREV:0:7}"
  git reset --hard --quiet "$PREV"
  systemctl restart "$SERVICE" || true
  echo "$PREV" > "$DATA/deployed-sha"
}

git reset --hard --quiet "$TARGET"

syntax_ok() {
  export PATH=/usr/local/bin:$PATH
  for f in server.js $(find src scripts -name '*.js'); do node --check "$f" || return 1; done
  for f in public/assets/*.js; do node --check "$f" || return 1; done
  return 0
}

if ! syntax_ok; then
  echo "syntax check FAILED"
  restore
  exit 1
fi
echo "syntax ok"

systemctl restart "$SERVICE"
for i in $(seq 1 20); do
  if curl -fsS --noproxy '*' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
    echo "$TARGET" > "$DATA/deployed-sha"
    echo "deploy ok at $(date '+%F %T')"
    exit 0
  fi
  sleep 1
done

echo "health check FAILED"
restore
exit 1
