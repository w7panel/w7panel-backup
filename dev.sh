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
  kill "$KUBE_PROXY_PID" "$VITE_PID" 2>/dev/null || true
}

kubectl --kubeconfig "$KUBECONFIG_PATH" proxy --address=127.0.0.1 --port="$KUBE_PROXY_PORT" --accept-hosts='^localhost$,^127\.0\.0\.1$' &
KUBE_PROXY_PID=$!
./node_modules/.bin/vite --host 0.0.0.0 --port "$PORT" "${VITE_ARGS[@]}" &
VITE_PID=$!

trap cleanup EXIT INT TERM

echo "W7Panel Backup 本地开发环境已启动"
echo "UI:       http://127.0.0.1:${PORT}"
echo "K8s proxy: http://127.0.0.1:${KUBE_PROXY_PORT}（使用 ${KUBECONFIG_PATH}）"

wait "$KUBE_PROXY_PID" "$VITE_PID"
