#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8022}"
KUBE_PROXY_PORT="${KUBE_PROXY_PORT:-8013}"
KUBECONFIG_PATH="${KUBECONFIG:-$HOME/.kube/config}"
VITE_ARGS=("$@")

for ((index = 0; index < ${#VITE_ARGS[@]}; index += 1)); do
  if [[ "${VITE_ARGS[index]}" == "--port" && -n "${VITE_ARGS[index + 1]:-}" ]]; then PORT="${VITE_ARGS[index + 1]}"; fi
  if [[ "${VITE_ARGS[index]}" == --port=* ]]; then PORT="${VITE_ARGS[index]#--port=}"; fi
done

cd "$ROOT_DIR"

cleanup() {
  kill "${PIDS[@]}" 2>/dev/null || true
}

kubectl --kubeconfig "$KUBECONFIG_PATH" proxy --address=127.0.0.1 --port="$KUBE_PROXY_PORT" --accept-hosts='^localhost$,^127\.0\.0\.1$' &
KUBE_PROXY_PID=$!
PIDS=("$KUBE_PROXY_PID")
if [[ "${LOCAL_TEST:-}" == "1" ]]; then
  ready=false
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    if curl -fs -o /dev/null "http://127.0.0.1:${KUBE_PROXY_PORT}/api"; then ready=true; break; fi
    if ! kill -0 "$KUBE_PROXY_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then kill "$KUBE_PROXY_PID" 2>/dev/null || true; echo 'Kubernetes proxy failed to start' >&2; exit 1; fi
  node ./charts/w7panel-backup/controller/server.mjs &
  INDEX_PID=$!
  PIDS+=("$INDEX_PID")
fi
./node_modules/.bin/vite --host 0.0.0.0 --port "$PORT" "${VITE_ARGS[@]}" &
VITE_PID=$!
PIDS+=("$VITE_PID")

trap cleanup EXIT INT TERM

echo "W7Panel Backup 本地开发环境已启动"
echo "UI:       http://127.0.0.1:${PORT}"
echo "K8s proxy: http://127.0.0.1:${KUBE_PROXY_PORT}（使用 ${KUBECONFIG_PATH}）"
if [[ -n "${INDEX_PID:-}" ]]; then echo "Backup index: http://127.0.0.1:${INDEX_PORT:-18023}"; fi

wait "${PIDS[@]}"
