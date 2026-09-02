#!/usr/bin/env bash
set -Eeuo pipefail

# This script is installed as a forced SSH command on the production host.
# GitHub Actions sends a short-lived package token on stdin and may only select
# the immutable commit image to deploy.

readonly COMPOSE_DIR="${PAPERCLIP_COMPOSE_DIR:-/root/paperclip/docker}"
readonly COMPOSE_SERVICE="${PAPERCLIP_COMPOSE_SERVICE:-server}"
readonly DATABASE_CONTAINER="${PAPERCLIP_DATABASE_CONTAINER:-docker-db-1}"
readonly HEALTH_URL="${PAPERCLIP_HEALTH_URL:-https://paperclip.comcapllc.com/api/health}"
readonly IMAGE_REPOSITORY="${PAPERCLIP_IMAGE_REPOSITORY:-ghcr.io/comcap-holdings-llc/paperclip}"
readonly COMPOSE_IMAGE="${PAPERCLIP_COMPOSE_IMAGE:-ghcr.io/paperclipai/paperclip:latest}"
readonly BACKUP_DIR="${PAPERCLIP_DEPLOY_BACKUP_DIR:-/root/paperclip/backups/pre-deploy}"
readonly LOCK_FILE="${PAPERCLIP_DEPLOY_LOCK_FILE:-/run/lock/paperclip-production-deploy.lock}"

log() {
  printf '[paperclip-deploy] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

requested_command="${SSH_ORIGINAL_COMMAND:-}"
if [ -z "$requested_command" ] && [ "$#" -eq 2 ]; then
  requested_command="$1 $2"
fi

if [[ ! "$requested_command" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  fail "expected: deploy <40-character lowercase commit SHA>"
fi

readonly DEPLOY_SHA="${BASH_REMATCH[1]}"
readonly SOURCE_IMAGE="${IMAGE_REPOSITORY}:sha-${DEPLOY_SHA:0:7}"

command -v curl >/dev/null || fail "curl is required"
command -v docker >/dev/null || fail "docker is required"
command -v flock >/dev/null || fail "flock is required"
command -v python3 >/dev/null || fail "python3 is required"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another production deployment is active"

registry_token=""
IFS= read -r registry_token || true
[ -n "$registry_token" ] || fail "a GitHub package token is required on stdin"

docker_config="$(mktemp -d)"
backup_tmp=""
cleanup() {
  registry_token=""
  [ -z "$backup_tmp" ] || rm -f "$backup_tmp"
  rm -rf "$docker_config"
}
trap cleanup EXIT

printf '%s\n' "$registry_token" | DOCKER_CONFIG="$docker_config" docker login ghcr.io \
  --username github-actions --password-stdin >/dev/null
registry_token=""

log "pulling immutable image $SOURCE_IMAGE"
DOCKER_CONFIG="$docker_config" docker pull "$SOURCE_IMAGE"

image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$SOURCE_IMAGE")"
[ "$image_revision" = "$DEPLOY_SHA" ] || fail "image revision $image_revision does not match $DEPLOY_SHA"

old_image_id="$(docker image inspect --format '{{.Id}}' "$COMPOSE_IMAGE")"
old_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$old_image_id")"

mkdir -p "$BACKUP_DIR"
backup_path="${BACKUP_DIR}/paperclip-$(date -u +%Y%m%dT%H%M%SZ)-${old_revision:0:12}.dump"
backup_tmp="${backup_path}.tmp"
log "creating pre-deploy database backup $backup_path"
docker exec "$DATABASE_CONTAINER" pg_dump -U paperclip -d paperclip --format=custom >"$backup_tmp"
test -s "$backup_tmp" || fail "database backup is empty"
mv "$backup_tmp" "$backup_path"
backup_tmp=""

docker tag "$SOURCE_IMAGE" "$COMPOSE_IMAGE"
log "recreating $COMPOSE_SERVICE at $DEPLOY_SHA"
(
  cd "$COMPOSE_DIR"
  docker compose up -d --no-deps --force-recreate "$COMPOSE_SERVICE"
)

healthy=false
for attempt in $(seq 1 30); do
  if health_payload="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" &&
    python3 -c 'import json,sys; data=json.load(sys.stdin); raise SystemExit(0 if data.get("status") == "ok" and data.get("commit") == sys.argv[1] else 1)' \
      "$DEPLOY_SHA" <<<"$health_payload"; then
    healthy=true
    break
  fi
  sleep 2
done

if [ "$healthy" = true ]; then
  log "deployment healthy at $DEPLOY_SHA"
  exit 0
fi

log "health verification failed; restoring $old_revision" >&2
docker tag "$old_image_id" "$COMPOSE_IMAGE"
(
  cd "$COMPOSE_DIR"
  docker compose up -d --no-deps --force-recreate "$COMPOSE_SERVICE"
)
fail "deployment rolled back to $old_revision"
