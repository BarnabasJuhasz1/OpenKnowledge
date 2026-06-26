#!/usr/bin/env bash
#
# Manage the OpenSearch SSH tunnel as a self-healing systemd *user* service.
#
# Local dev needs an SSH tunnel to the GCP `opensearch` VM, because OpenSearch there
# binds to loopback only and isn't exposed publicly. Running the tunnel by hand means
# re-running it after every terminal close / laptop sleep / network blip. This installs
# it as a systemd user service that starts on login and restarts on failure, so the
# backend's OPENSEARCH_URL=http://localhost:${LOCAL_PORT} just keeps working.
#
# No `autossh` needed: systemd is the supervisor (Restart=always), and SSH keepalives
# (ServerAliveInterval/CountMax) make a dead connection actually exit so it gets restarted.
#
# Usage:
#   scripts/opensearch-tunnel.sh install   # write unit, enable + start (run once)
#   scripts/opensearch-tunnel.sh status    # is it up?
#   scripts/opensearch-tunnel.sh logs      # follow logs (Ctrl-C to stop following)
#   scripts/opensearch-tunnel.sh restart
#   scripts/opensearch-tunnel.sh stop      # stop + disable
#
# Override any of these via env vars (defaults match the current dev setup):
#   INSTANCE=opensearch ZONE=europe-west6-a LOCAL_PORT=19200 REMOTE_PORT=9200 \
#     scripts/opensearch-tunnel.sh install
#
set -euo pipefail

INSTANCE="${INSTANCE:-opensearch}"
ZONE="${ZONE:-europe-west6-a}"
LOCAL_PORT="${LOCAL_PORT:-19200}"
REMOTE_PORT="${REMOTE_PORT:-9200}"
# Extra args to pass to `gcloud compute ssh` before the `--` (e.g. --tunnel-through-iap).
GCLOUD_SSH_ARGS="${GCLOUD_SSH_ARGS:-}"

SERVICE="ok-opensearch-tunnel"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="${UNIT_DIR}/${SERVICE}.service"

die() { echo "error: $*" >&2; exit 1; }

GCLOUD_BIN="$(command -v gcloud || true)"
[ -n "$GCLOUD_BIN" ] || die "gcloud not found on PATH"

cmd_install() {
  mkdir -p "$UNIT_DIR"

  # ExitOnForwardFailure=yes: if the local port can't bind (e.g. a manual tunnel is already
  # up), ssh exits instead of lingering without a forward — systemd then retries cleanly.
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=OpenKnowledge OpenSearch SSH tunnel (localhost:${LOCAL_PORT} -> ${INSTANCE}:${REMOTE_PORT})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${GCLOUD_BIN} compute ssh ${INSTANCE} --zone=${ZONE} ${GCLOUD_SSH_ARGS} -- -N \\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \\
  -L ${LOCAL_PORT}:localhost:${REMOTE_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  echo "wrote ${UNIT_FILE}"
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE}.service"

  # Survive logout / run before login so the tunnel is up whenever the machine is.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null \
      && echo "lingering enabled for $USER (service runs without an active login session)" \
      || echo "note: could not enable lingering (the service will start when you log in)"
  fi

  echo
  cmd_status || true
  echo
  echo "Done. The backend can reach OpenSearch at http://localhost:${LOCAL_PORT}"
  echo "Follow logs with: scripts/opensearch-tunnel.sh logs"
}

cmd_status()  { systemctl --user --no-pager status "${SERVICE}.service"; }
cmd_logs()    { journalctl --user -u "${SERVICE}.service" -f; }
cmd_restart() { systemctl --user restart "${SERVICE}.service"; cmd_status; }
cmd_stop()    { systemctl --user disable --now "${SERVICE}.service"; echo "stopped + disabled"; }

case "${1:-}" in
  install) cmd_install ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  restart) cmd_restart ;;
  stop)    cmd_stop ;;
  *) echo "usage: $0 {install|status|logs|restart|stop}" >&2; exit 2 ;;
esac
