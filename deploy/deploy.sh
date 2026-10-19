#!/usr/bin/env bash
# Runs ON the server, from /opt/hioc. Two modes:
#
#   deploy.sh < image.tar.gz   load a `docker save | gzip` of a new build (the
#                              deploy workflow pipes one in over SSH), make it
#                              :current, restart the app, and roll back by
#                              itself if the new container never turns healthy.
#   deploy.sh rollback         put :previous back as :current and restart.
#   deploy.sh heal             restart the app if Docker reports it unhealthy.
#                              Docker only restarts a container that exits, not
#                              one that hangs; hioc-cron runs this every minute.
#
# The app holds no state of its own (everything is in Supabase), so swapping
# the container is the whole deploy.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

wait_healthy() {
  local id status
  id=$(docker compose ps -q app)
  for _ in $(seq 1 40); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "app did not become healthy (last status: $status)" >&2
  return 1
}

restart_app() {
  # caddy first, so the very first deploy brings the whole stack up; on later
  # deploys it's already running and this is a no-op apart from the reload.
  docker compose up -d caddy
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true
  docker compose up -d --no-deps --force-recreate app
}

if [ "${1:-}" = heal ]; then
  id=$(docker compose ps -q app)
  if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = unhealthy ]; then
    echo "$(date -u +%FT%TZ) app unhealthy, restarting" >> /var/log/hioc-cron.log
    docker compose restart app
  fi
  exit 0
fi

if [ "${1:-}" = rollback ]; then
  docker image inspect hioc-web:previous >/dev/null
  docker tag hioc-web:previous hioc-web:current
  restart_app
  wait_healthy
  echo "rolled back to the previous build"
  exit 0
fi

loaded=$(gunzip | docker load | sed -n 's/^Loaded image: //p' | tail -n 1)
if [ -z "$loaded" ]; then
  echo "no image arrived on stdin" >&2
  exit 1
fi

if docker image inspect hioc-web:current >/dev/null 2>&1; then
  docker tag hioc-web:current hioc-web:previous
fi
if [ "$loaded" != hioc-web:current ]; then
  docker tag "$loaded" hioc-web:current
  docker rmi "$loaded" >/dev/null # drop the per-commit tag; :current still points at it
fi
restart_app

if ! wait_healthy; then
  if docker image inspect hioc-web:previous >/dev/null 2>&1; then
    echo "rolling back to the previous build" >&2
    docker tag hioc-web:previous hioc-web:current
    restart_app
    wait_healthy || true
  fi
  exit 1
fi

# Builds that are neither :current nor :previous are now untagged; free the disk.
docker image prune -f >/dev/null
echo "deployed $loaded"
