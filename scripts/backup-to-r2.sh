#!/usr/bin/env bash
# Copies Juhandu's database to an S3-compatible bucket such as Cloudflare R2. Run it on the Docker host, once a night from cron or launchd.
#
#   backup-to-r2.sh              back up now
#   backup-to-r2.sh latest       print the key of the newest backup
#   backup-to-r2.sh restore OUT  download the newest backup to OUT (a .sqlite file) and check it; the live database is never touched
#
# Settings come from the environment, or from the file named by JUHANDU_BACKUP_ENV (default: backup.env beside the compose file).
#   JUHANDU_R2_ACCOUNT_ID, JUHANDU_R2_ACCESS_KEY_ID, JUHANDU_R2_SECRET_ACCESS_KEY   required
#   JUHANDU_R2_BUCKET        bucket name (default juhandu-backups)
#   JUHANDU_BACKUP_CONTAINER container name (default juhandu-juhandu-1)
#   JUHANDU_BACKUP_DB        database path inside the container (default /data/juhandu.sqlite)
#   JUHANDU_BACKUP_DOCKER    docker command (default docker)
#   JUHANDU_BACKUP_PASSPHRASE  at least 16 characters; the copy is encrypted with it (AES-256, key derived with PBKDF2) before it leaves this machine
#   JUHANDU_BACKUP_ENCRYPT   on (default) or off; with on, a missing passphrase stops the script, so a backup is never uploaded in the clear by accident
# Keep the passphrase somewhere other than this machine as well: without it an encrypted backup cannot be read, by anyone.
# Only the database is copied. Feed logins stay in the data volume's secrets folder, so a restored copy asks for them again.
# The access key is read by curl from standard input, so it never appears in a process listing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
envfile="${JUHANDU_BACKUP_ENV:-$here/../backup.env}"
if [ -f "$envfile" ]; then
  # shellcheck disable=SC1090
  . "$envfile"
fi

: "${JUHANDU_R2_ACCOUNT_ID:?JUHANDU_R2_ACCOUNT_ID is not set}"
: "${JUHANDU_R2_ACCESS_KEY_ID:?JUHANDU_R2_ACCESS_KEY_ID is not set}"
: "${JUHANDU_R2_SECRET_ACCESS_KEY:?JUHANDU_R2_SECRET_ACCESS_KEY is not set}"
bucket="${JUHANDU_R2_BUCKET:-juhandu-backups}"
container="${JUHANDU_BACKUP_CONTAINER:-juhandu-juhandu-1}"
database="${JUHANDU_BACKUP_DB:-/data/juhandu.sqlite}"
docker="${JUHANDU_BACKUP_DOCKER:-docker}"
encrypt="${JUHANDU_BACKUP_ENCRYPT:-on}"
passphrase="${JUHANDU_BACKUP_PASSPHRASE:-}"
case "$encrypt" in
  on) [ "${#passphrase}" -ge 16 ] || { echo "Set JUHANDU_BACKUP_PASSPHRASE to at least 16 characters, or set JUHANDU_BACKUP_ENCRYPT=off to upload unencrypted copies." >&2; exit 1; } ;;
  off) ;;
  *) echo "JUHANDU_BACKUP_ENCRYPT must be on or off." >&2; exit 1 ;;
esac
endpoint="https://${JUHANDU_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
prefix="juhandu/"

work="$(mktemp -d)"
inside=""
cleanup() {
  rm -rf "$work"
  if [ -n "$inside" ]; then "$docker" exec "$container" rm -f "$inside" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# curl with the signing key on standard input. Extra arguments go to curl.
r2() {
  printf 'user = "%s:%s"\n' "$JUHANDU_R2_ACCESS_KEY_ID" "$JUHANDU_R2_SECRET_ACCESS_KEY" |
    curl --config - --fail --silent --show-error --aws-sigv4 "aws:amz:auto:s3" "$@"
}

latest_key() {
  r2 "$endpoint/$bucket?list-type=2&prefix=$prefix" | grep -o '<Key>[^<]*</Key>' | sed -e 's/<Key>//' -e 's/<\/Key>//' | sort | tail -n 1
}

# openssl reads the passphrase from the environment, so it never appears in a process listing.
encrypt_file() {
  JUHANDU_BACKUP_PASSPHRASE="$passphrase" openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:JUHANDU_BACKUP_PASSPHRASE -in "$1" -out "$2"
}

decrypt_file() {
  JUHANDU_BACKUP_PASSPHRASE="$passphrase" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:JUHANDU_BACKUP_PASSPHRASE -in "$1" -out "$2" ||
    { echo "The backup could not be decrypted. Check JUHANDU_BACKUP_PASSPHRASE." >&2; exit 1; }
}

check_database() {
  if command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$1" 'PRAGMA integrity_check;')" = "ok" ] || { echo "The database copy failed its integrity check." >&2; exit 1; }
  fi
}

case "${1:-backup}" in
  latest)
    latest_key
    ;;
  restore)
    out="${2:?Give the file to write, for example restore /tmp/juhandu-restored.sqlite}"
    key="$(latest_key)"
    [ -n "$key" ] || { echo "The bucket holds no backup." >&2; exit 1; }
    r2 -o "$work/restore.download" "$endpoint/$bucket/$key"
    case "$key" in
      *.enc)
        [ "${#passphrase}" -ge 16 ] || { echo "That backup is encrypted. Set JUHANDU_BACKUP_PASSPHRASE to restore it." >&2; exit 1; }
        decrypt_file "$work/restore.download" "$work/restore.gz"
        ;;
      *) mv "$work/restore.download" "$work/restore.gz" ;;
    esac
    gunzip -c "$work/restore.gz" >"$out" || { echo "The backup is damaged." >&2; exit 1; }
    check_database "$out"
    echo "Restored $key to $out"
    ;;
  backup)
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    inside="/tmp/juhandu-backup-$stamp.sqlite"
    # VACUUM INTO writes a consistent copy while the app keeps running.
    "$docker" exec "$container" node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("VACUUM INTO \x27" + process.argv[2].replaceAll("\x27", "") + "\x27");
      db.close();
    ' "$database" "$inside"
    "$docker" cp "$container:$inside" "$work/db.sqlite"
    "$docker" exec "$container" rm -f "$inside"
    inside=""
    check_database "$work/db.sqlite"
    gzip -9 "$work/db.sqlite"
    file="$work/db.sqlite.gz"
    key="${prefix}juhandu-$stamp.sqlite.gz"
    if [ "$encrypt" = "on" ]; then
      encrypt_file "$file" "$work/db.sqlite.gz.enc"
      file="$work/db.sqlite.gz.enc"
      key="$key.enc"
    fi
    size="$(wc -c <"$file" | tr -d ' ')"
    r2 -H "x-amz-content-sha256: $(sha256 "$file")" -T "$file" "$endpoint/$bucket/$key"
    remote="$(r2 --head "$endpoint/$bucket/$key" | tr -d '\r' | awk 'tolower($1)=="content-length:" {print $2}')"
    [ "$remote" = "$size" ] || { echo "The uploaded copy is $remote bytes, expected $size." >&2; exit 1; }
    echo "Backed up $key ($size bytes)"
    ;;
  *)
    echo "Usage: backup-to-r2.sh [backup|latest|restore OUT]" >&2
    exit 2
    ;;
esac
