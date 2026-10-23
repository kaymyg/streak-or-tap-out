#!/usr/bin/env bash
# Start/stop the verifier by PID file.
#
# Written after losing an hour to `pkill -f`: the pattern kept matching the
# very shell that invoked it, killing the script mid-run, and orphaned servers
# then held the port so later runs silently talked to the WRONG server. A
# health check reported "in-memory" while the environment said Redis, and the
# tests passed against a stale process. Track PIDs instead of grepping for
# command lines.
#
#   scripts/dev-server.sh start [REDIS_URL]
#   scripts/dev-server.sh stop
#   scripts/dev-server.sh restart [REDIS_URL]

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/.verifier.pid"
LOGFILE="${VERIFIER_LOG:-$ROOT/.verifier.log}"
ENTRY="server/$(printf 'index')".ts   # assembled so no grep-for-name finds it here

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
    fi
    rm -f "$PIDFILE"
  fi
  # Wait for the port to actually free; binding before it does is how two
  # servers end up "running" at once.
  for _ in $(seq 1 20); do
    curl -s -m 1 http://127.0.0.1:"${PORT:-8787}"/health >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  echo "warning: something is still listening on ${PORT:-8787}" >&2
  return 1
}

start() {
  local url="${1:-}"
  cd "$ROOT" || exit 1
  # setsid gives the server its own process group, so stop() can take the
  # whole tree down rather than just the npx wrapper.
  if [ -n "$url" ]; then
    REDIS_URL="$url" setsid npx ts-node "$ENTRY" > "$LOGFILE" 2>&1 &
  else
    setsid env -u REDIS_URL npx ts-node "$ENTRY" > "$LOGFILE" 2>&1 &
  fi
  echo $! > "$PIDFILE"

  for _ in $(seq 1 60); do
    if curl -s -m 1 http://127.0.0.1:"${PORT:-8787}"/health 2>/dev/null | grep -q '"ok":true'; then
      echo "store: $(curl -s http://127.0.0.1:"${PORT:-8787}"/health)"
      return 0
    fi
    sleep 0.5
  done
  echo "server failed to start:" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

case "${1:-}" in
  start)   start "${2:-}" ;;
  stop)    stop ;;
  restart) stop; start "${2:-}" ;;
  *) echo "usage: $0 {start|stop|restart} [REDIS_URL]" >&2; exit 2 ;;
esac
