#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Two deliberate invocations are required:
#   DEPLOY_MODE=backup ./scripts/deploy-inventory-release.sh
#   DEPLOY_MODE=release RELEASE_GATE_FILE=... ./scripts/deploy-inventory-release.sh
# The backup must first be restored and verified outside production. The
# release gate is a non-secret JSON receipt, completed only after that test.

readonly PROJECT_DIR="${PROJECT_DIR:-/opt/inventory-management-mvp}"
readonly PROJECT_NAME="${PROJECT_NAME:-inventory-management-mvp}"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.1panel.yml}"
readonly ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
readonly PANEL_ENV_FILE="${PANEL_ENV_FILE:-$PROJECT_DIR/1panel.env}"
readonly BACKUP_ROOT="${BACKUP_ROOT:-/opt/1panel/backup/inventory-management-mvp/releases}"
readonly LOCK_DIR="${LOCK_DIR:-/tmp/inventory-management-update.lock}"
readonly DB_CONTAINER="${DB_CONTAINER:-inventory-management-mvp-postgres-1}"
readonly API_CONTAINER="${API_CONTAINER:-inventory-management-mvp-api-1}"
readonly WEB_CONTAINER="${WEB_CONTAINER:-inventory-management-mvp-web-1}"
readonly API_IMAGE="ghcr.io/hubo0926/inventory-management-mvp-api@sha256:079266c8128dc457d9768e1bd0fc93b66e3c5383c3a68dd6241917a9f4425e46"
readonly WEB_IMAGE="ghcr.io/hubo0926/inventory-management-mvp-web@sha256:567ec986b0465baec73b5682c50701b1a58e17cafd3d8ae71784f214bfb4045b"
readonly RELEASE_VERSION="1.9.0"
readonly RELEASE_LIMIT_SECONDS=300

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "STOP: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
sha256_file() { sha256sum -- "$1" | awk '{print $1}'; }
compose() {
  docker compose --env-file "$ENV_FILE" -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

for tool in docker python3 sha256sum tar curl sort grep; do need "$tool"; done
[[ -f "$COMPOSE_FILE" && -f "$ENV_FILE" && -f "$PANEL_ENV_FILE" ]] || die "required production files are missing"
[[ "$(docker inspect -f '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || true)" == running ]] || die "inventory PostgreSQL container is not running"
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB_CONTAINER" 2>/dev/null || true)" == healthy ]] || die "inventory PostgreSQL is not healthy"
[[ "$(docker inspect -f '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || true)" == running ]] || die "inventory API container is not running"
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CONTAINER" 2>/dev/null || true)" == healthy ]] || die "inventory API is not healthy"
[[ "$(docker inspect -f '{{.State.Status}}' "$WEB_CONTAINER" 2>/dev/null || true)" == running ]] || die "inventory Web container is not running"
[[ ! -d "$LOCK_DIR" ]] || die "another inventory update holds the shared update lock"
mkdir "$LOCK_DIR" 2>/dev/null || die "could not acquire the shared update lock"
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

compose config --quiet || die "production Compose configuration does not parse"

compose_port_json="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$WEB_CONTAINER")"
python3 - "$compose_port_json" <<'PY' || die "current Web port mapping differs from the reviewed 0.0.0.0:8080 mapping"
import json, sys
bindings = json.loads(sys.argv[1] or "{}")
entries = [(ip, item.get("HostPort")) for port, values in bindings.items()
           for item in (values or []) for ip in [item.get("HostIp", "")]]
if entries != [("0.0.0.0", "8080")]:
    raise SystemExit(1)
PY

db_image_id="$(docker inspect -f '{{.Image}}' "$DB_CONTAINER")"
db_container_id="$(docker inspect -f '{{.Id}}' "$DB_CONTAINER")"
api_image_id="$(docker inspect -f '{{.Image}}' "$API_CONTAINER")"
web_image_id="$(docker inspect -f '{{.Image}}' "$WEB_CONTAINER")"
api_image_ref="$(docker inspect -f '{{.Config.Image}}' "$API_CONTAINER")"
web_image_ref="$(docker inspect -f '{{.Config.Image}}' "$WEB_CONTAINER")"
db_image_ref="$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")"
[[ "$db_image_ref" == postgres:16-alpine ]] || die "inventory database image differs from the reviewed PostgreSQL 16 baseline"
[[ "$api_image_ref" == ghcr.io/hubo0926/inventory-management-mvp-api:1.8.0 ]] || die "inventory API is not on the reviewed v1.8.0 baseline"
[[ "$web_image_ref" == ghcr.io/hubo0926/inventory-management-mvp-web:1.8.0 ]] || die "inventory Web is not on the reviewed v1.8.0 baseline"
services="$(compose config --services | sort)"
for service in api web postgres; do
  grep -Fxq "$service" <<< "$services" || die "production Compose is missing expected service $service"
done
uploads_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' "$API_CONTAINER")"
[[ -n "$uploads_volume" ]] || die "could not identify the existing uploads volume"
uploads_mount="$(docker volume inspect -f '{{.Mountpoint}}' "$uploads_volume")"
[[ -d "$uploads_mount" ]] || die "uploads volume mount is unavailable"

MODE="${DEPLOY_MODE:-}"
case "$MODE" in
  backup)
    stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
    backup_dir="$BACKUP_ROOT/$stamp"
    mkdir -p -- "$BACKUP_ROOT"
    mkdir -m 700 "$backup_dir" || die "backup directory already exists"
    log "Creating a database-consistent logical backup and uploads/config snapshot in $backup_dir"
    docker exec "$DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/inventory.dump"
    [[ -s "$backup_dir/inventory.dump" ]] || die "database archive is empty"
    docker exec -i "$DB_CONTAINER" pg_restore --list < "$backup_dir/inventory.dump" >/dev/null || die "pg_restore archive listing failed"
    tar -czf "$backup_dir/uploads.tar.gz" -C "$uploads_mount" .
    tar -czf "$backup_dir/deployment-config.tar.gz" -C "$PROJECT_DIR" \
      "$(basename "$COMPOSE_FILE")" "$(basename "$ENV_FILE")" "$(basename "$PANEL_ENV_FILE")"
    tar -tzf "$backup_dir/uploads.tar.gz" >/dev/null || die "uploads archive verification failed"
    tar -tzf "$backup_dir/deployment-config.tar.gz" >/dev/null || die "config archive verification failed"
    chmod 600 "$backup_dir/inventory.dump" "$backup_dir/uploads.tar.gz" "$backup_dir/deployment-config.tar.gz"
    python3 - "$backup_dir" "$DB_CONTAINER" "$API_CONTAINER" "$WEB_CONTAINER" \
      "$db_image_id" "$db_container_id" "$api_image_id" "$web_image_id" "$api_image_ref" "$web_image_ref" \
      "$uploads_volume" "$compose_port_json" "$COMPOSE_FILE" "$ENV_FILE" "$PANEL_ENV_FILE" <<'PY'
import hashlib, json, os, sys, time
root, db, api, web, db_id, db_cid, api_id, web_id, api_ref, web_ref, volume, ports, compose, env, panel_env = sys.argv[1:]
def sha(name):
    h=hashlib.sha256()
    with open(os.path.join(root,name),'rb') as f:
        for block in iter(lambda:f.read(1024*1024), b''): h.update(block)
    return h.hexdigest()
manifest={"created_at_utc":time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
 "restore_verified":False,"config_reviewed":False,
 "files":{name:sha(name) for name in ("inventory.dump","uploads.tar.gz","deployment-config.tar.gz")},
 "config_sha256":{"compose":hashlib.sha256(open(compose,'rb').read()).hexdigest(),
 "env":hashlib.sha256(open(env,'rb').read()).hexdigest(),
 "panel_env":hashlib.sha256(open(panel_env,'rb').read()).hexdigest()},
 "runtime":{"db_container":db,"db_container_id":db_cid,"db_image_id":db_id,"api_container":api,"api_image_id":api_id,
 "api_image_ref":api_ref,"web_container":web,"web_image_id":web_id,"web_image_ref":web_ref,
 "uploads_volume":volume,"web_port_bindings":json.loads(ports or "{}")}}
with open(os.path.join(root,"release-gate.json"),"w",encoding="utf-8") as f:
    json.dump(manifest,f,indent=2); f.write("\n")
os.chmod(os.path.join(root,"release-gate.json"),0o600)
PY
    log "Backup archives verified. SHA-256:"
    sha256sum "$backup_dir/inventory.dump" "$backup_dir/uploads.tar.gz" "$backup_dir/deployment-config.tar.gz"
    log "No services were changed. Restore the dump in isolated Docker Desktop; upload its restore-receipt.json beside these artifacts, then set config_reviewed in release-gate.json only after reviewing the saved config."
    exit 0
    ;;
  release) ;;
  *) die "set DEPLOY_MODE=backup first, then DEPLOY_MODE=release after isolated restore and config review" ;;
esac

GATE_FILE="${RELEASE_GATE_FILE:-}"
[[ -n "$GATE_FILE" && -f "$GATE_FILE" ]] || die "release gate receipt is required"
gate_dir="$(dirname -- "$GATE_FILE")"
[[ -f "$gate_dir/restore-receipt.json" ]] || die "isolated restore receipt is missing"
python3 - "$GATE_FILE" "$gate_dir/restore-receipt.json" "$PROJECT_DIR" "$BACKUP_ROOT" <<'PY' || die "release gate is incomplete, stale, or backup/restore hashes do not match"
import datetime, hashlib, json, os, sys
gate_path, receipt_path, project, backup_root = sys.argv[1:]
with open(gate_path,encoding='utf-8') as f: g=json.load(f)
with open(receipt_path,encoding='utf-8') as f: r=json.load(f)
if g.get('config_reviewed') is not True or r.get('passed') is not True or r.get('database')!='inventory': raise SystemExit(1)
if int(r.get('public_table_count',0))<1 or not str(r.get('postgres_server_version_num','')).startswith('16'): raise SystemExit(1)
if os.path.commonpath([os.path.abspath(gate_path),os.path.abspath(backup_root)])!=os.path.abspath(backup_root): raise SystemExit(1)
created=datetime.datetime.fromisoformat(g['created_at_utc'].replace('Z','+00:00'))
restored=datetime.datetime.fromisoformat(r['verified_at_utc'].replace('Z','+00:00'))
if (datetime.datetime.now(datetime.timezone.utc)-created).total_seconds()>86400 or (datetime.datetime.now(datetime.timezone.utc)-restored).total_seconds()>86400: raise SystemExit(1)
root=os.path.dirname(os.path.abspath(gate_path))
for name,expected in g.get('files',{}).items():
    path=os.path.join(root,name)
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    if h.hexdigest()!=expected: raise SystemExit(1)
    if r.get('archive_sha256',{}).get(name)!=expected: raise SystemExit(1)
for key,path in [('compose','docker-compose.1panel.yml'),('env','.env'),('panel_env','1panel.env')]:
    expected=g.get('config_sha256',{}).get(key)
    if not expected: raise SystemExit(1)
    h=hashlib.sha256(open(os.path.join(project,path),'rb').read()).hexdigest()
    if h!=expected: raise SystemExit(1)
PY

docker exec -i "$DB_CONTAINER" pg_restore --list < "$gate_dir/inventory.dump" >/dev/null || die "release backup is not a readable PostgreSQL archive"
tar -tzf "$gate_dir/uploads.tar.gz" >/dev/null || die "release uploads archive is not readable"
tar -tzf "$gate_dir/deployment-config.tar.gz" >/dev/null || die "release config archive is not readable"

[[ "$(docker inspect -f '{{.Image}}' "$DB_CONTAINER")" == "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"]["db_image_id"])' "$GATE_FILE")" ]] || die "inventory database image changed since backup; re-review required"
[[ "$(docker inspect -f '{{.Id}}' "$DB_CONTAINER")" == "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"]["db_container_id"])' "$GATE_FILE")" ]] || die "inventory database container changed since backup; re-review required"
[[ "$(docker inspect -f '{{.Image}}' "$API_CONTAINER")" == "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"]["api_image_id"])' "$GATE_FILE")" ]] || die "inventory API image changed since backup; re-review required"
[[ "$(docker inspect -f '{{.Image}}' "$WEB_CONTAINER")" == "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"]["web_image_id"])' "$GATE_FILE")" ]] || die "inventory Web image changed since backup; re-review required"

start_epoch=0
overlay="$(mktemp "$PROJECT_DIR/.release-overlay.XXXXXX.yml")"
feature_enabled=0
release_mutated=0
old_app_version="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" | awk -F= '$1=="APP_VERSION"{print substr($0,index($0,"=")+1)}')"
[[ -n "$old_app_version" ]] || old_app_version="1.8.0"
old_api_ref="$(docker inspect -f '{{.Config.Image}}' "$API_CONTAINER")"
old_web_ref="$(docker inspect -f '{{.Config.Image}}' "$WEB_CONTAINER")"
cleanup_release() {
  local status=$?
  trap - EXIT
  if (( status != 0 && release_mutated )); then
    set +e
    if (( feature_enabled )); then
      log "Failure after feature activation: keeping compatible v1.9.0 and disabling the batch entrypoint"
      write_overlay false "$API_IMAGE" "$WEB_IMAGE" "$RELEASE_VERSION"
      release_compose up -d --no-deps --force-recreate api
    else
      log "Failure before feature activation: restoring the previous API/Web image references"
      write_overlay false "$old_api_ref" "$old_web_ref" "$old_app_version"
      release_compose up -d --no-deps api web
    fi
    set -e
  fi
  rm -f -- "$overlay"
  cleanup
  return "$status"
}
trap cleanup_release EXIT
write_overlay() {
  local enabled="$1" api_image="$2" web_image="$3" app_version="$4"
  cat > "$overlay" <<EOF
services:
  api:
    image: $api_image
    environment:
      APP_VERSION: "$app_version"
      BATCH_INBOUND_ENABLED: "$enabled"
  web:
    image: $web_image
EOF
}
release_compose() { docker compose --env-file "$ENV_FILE" -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$overlay" "$@"; }
check_window() {
  (( start_epoch > 0 )) || return 0
  (( $(date +%s)-start_epoch <= RELEASE_LIMIT_SECONDS )) || die "API/Web service-switch window exceeded 5 minutes"
}
healthy() {
  local name="$1"; local end=$(( $(date +%s)+150 ))
  while (( $(date +%s)<end )); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || true)" == healthy ]] && return 0
    sleep 3
    check_window
  done
  return 1
}

write_overlay false "$API_IMAGE" "$WEB_IMAGE" "$RELEASE_VERSION"
release_compose config --quiet || die "release override failed Compose validation"
phase=images
log "Pulling pinned v1.9.0 images before any service is replaced"
release_compose pull api web
phase=compatibility-ddl
log "Preparing additive compatibility DDL (batch feature remains disabled)"
release_compose run -T --rm --no-deps api node dist/database/prepare-batch-inbound.js
check_window
phase=migrations
log "Running the database migration once"
release_compose run -T --rm --no-deps api node dist/database/run-migrations.js
check_window
phase=api-web
log "Replacing only inventory API and Web; PostgreSQL and other stacks are not dependencies of this command"
release_mutated=1
start_epoch="$(date +%s)"
release_compose up -d --no-deps api web
healthy "$API_CONTAINER" || die "v1.9.0 API health check failed"
[[ "$(docker inspect -f '{{.Config.Image}}' "$API_CONTAINER")" == "$API_IMAGE" ]] || die "API is not running the pinned v1.9.0 image"
[[ "$(docker inspect -f '{{.Config.Image}}' "$WEB_CONTAINER")" == "$WEB_IMAGE" ]] || die "Web is not running the pinned v1.9.0 image"
curl -fsS --max-time 5 http://127.0.0.1:8080/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" and d.get("features",{}).get("batchInbound") is False else 1)' || die "compatibility API health or disabled-feature check failed"
check_window
phase=legacy-backfill
log "Backfilling historical posted inbound lines in bounded batches"
release_compose run -T --rm --no-deps api node dist/database/prepare-batch-inbound.js --backfill-legacy
check_window
phase=feature-enable
log "Enabling batch inbound only after migration, health and backfill pass"
write_overlay true "$API_IMAGE" "$WEB_IMAGE" "$RELEASE_VERSION"
release_compose config --quiet || die "feature-enabled override failed Compose validation"
feature_enabled=1
release_compose up -d --no-deps --force-recreate api
healthy "$API_CONTAINER" || die "feature-enabled API health check failed; keep v1.9.0 compatibility image and disable feature after review"
curl -fsS --max-time 5 http://127.0.0.1:8080/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("status")=="ok" and d.get("features",{}).get("batchInbound") is True else 1)' || die "batch inbound feature flag is not healthy"
phase=verification
check_window
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB_CONTAINER")" == healthy ]] || die "inventory database health check failed"
[[ "$(docker inspect -f '{{.Id}}' "$DB_CONTAINER")" == "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"]["db_container_id"])' "$GATE_FILE")" ]] || die "inventory database container changed during release"
[[ "$(docker inspect -f '{{.State.Status}}' "$WEB_CONTAINER")" == running ]] || die "inventory Web container is not running"
log "v1.9.0 deployed. API image id=$(docker inspect -f '{{.Image}}' "$API_CONTAINER"); Web image id=$(docker inspect -f '{{.Image}}' "$WEB_CONTAINER"). Verify site/API and related stacks in 1Panel."
