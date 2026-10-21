#!/usr/bin/env bash
set -euo pipefail

# Runs as root (the image does not set USER) so it can fix the ownership of
# the mounted volumes, then drops to an unprivileged user for the actual
# server. Chromium refuses to run as root, so this step is required.

TARGET_USER="pwuser"
TARGET_GROUP="pwuser"

log() {
  echo "[entrypoint] $*"
}

error() {
  echo "[entrypoint] ERROR: $*" >&2
  exit 1
}

# --- Optional UID/GID remapping ---------------------------------------------
# Bind mounts are owned by the host user. Set PUID/PGID to that user's ids
# (id -u / id -g on the host) so the container can write to them.
#
# The image ships an unprivileged `pwuser` account; it is remapped in place
# instead of creating a second account, so the home directory and the file
# ownership of the volumes stay consistent.
resolve_ids() {
  local uid="${PUID:-}"
  local gid="${PGID:-}"

  if [ -z "$uid" ] && [ -z "$gid" ]; then
    return
  fi

  if [ -n "$gid" ]; then
    if ! groupmod -g "$gid" "$TARGET_GROUP" 2>/dev/null; then
      error "could not set GID=$gid for $TARGET_GROUP. That GID is probably already taken inside the image."
    fi
  fi

  if [ -n "$uid" ]; then
    if ! usermod -u "$uid" "$TARGET_USER" 2>/dev/null; then
      error "could not set UID=$uid for $TARGET_USER. That UID is probably already taken inside the image."
    fi
  fi

  log "running as $TARGET_USER (uid=${uid:-unchanged}, gid=${gid:-unchanged})"
}

# --- Ownership fix -----------------------------------------------------------
# `chown -R` on every boot is slow once the profiles directory grows, so the
# ownership is only touched when it is actually wrong.
ensure_writable_dir() {
  local dir="$1"

  mkdir -p "$dir" || error "could not create $dir"

  if [ "$(id -u)" = "0" ]; then
    # Only the top level is checked: a deep recursive chown is the slow part.
    if [ "$(stat -c '%u:%g' "$dir" 2>/dev/null || echo 'x')" != "$(id -u "$TARGET_USER"):$(id -g "$TARGET_GROUP" 2>/dev/null || echo 'y')" ]; then
      log "fixing ownership of $dir"
      chown -R "$TARGET_USER":"$TARGET_GROUP" "$dir" 2>/dev/null || true
    fi
  fi

  if [ "$(id -u)" = "0" ]; then
    gosu "$TARGET_USER" test -w "$dir" || error "$dir is not writable by $TARGET_USER. Check the volume permissions (see docs/DOCKER.md)."
  elif [ ! -w "$dir" ]; then
    error "$dir is not writable by the current user. Check the volume permissions (see docs/DOCKER.md)."
  fi
}

# --- Entrypoint --------------------------------------------------------------
if [ "$#" -eq 0 ]; then
  error "no command given"
fi

# Commands that must run as the unprivileged user without the volume fixes
# (e.g. `docker compose run --rm qwenproxy sh`).
# The server command is `node dist/index.js` and always takes the normal path,
# otherwise the UID/GID remapping would be skipped.
case " $* " in
  *" dist/index.js "*) ;;
  sh|bash|node\ *|npm\ *|npx\ *|env|printenv)
    exec gosu "$TARGET_USER" "$@"
    ;;
esac

resolve_ids

ensure_writable_dir /app/data
ensure_writable_dir /app/qwen_profiles
ensure_writable_dir /tmp/playwright

log "starting: $*"

if [ "$(id -u)" = "0" ]; then
  exec gosu "$TARGET_USER" "$@"
fi

exec "$@"
