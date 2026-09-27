#!/usr/bin/env bash
# Quick start for NoteMate: chess board + Stockfish engine server + ChessMind chatbot, all on this machine.
#
#   ./start.sh            start (reuses the models already exported)
#   ./start.sh --refresh  first pull the newest checkpoint of the running Vast training run and re-export it
#   ./start.sh stop       stop the servers
#
# App: http://localhost:4173   Engines: http://localhost:4174 (set "Engine server" to this in the app for Stockfish Full)
set -euo pipefail

cd "$(dirname "$0")"
NOTEMATE="$PWD"
CHESSMIND="${CHESSMIND_DIR:-$HOME/ChessMind}"
RUN="${CHESSMIND_RUN:-medium-100m-live}"        # Vast run name; its pulled copy lives in runs/$RUN-vast
MODEL="$RUN-vast"                               # exported model id (listed first in the app = default)
APP_PORT=4173
ENGINE_PORT=4174
LOG_DIR="$NOTEMATE/.logs"
mkdir -p "$LOG_DIR"

stop_servers() {
  for port in "$APP_PORT" "$ENGINE_PORT"; do
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      echo "stopped server on :$port"
    fi
  done
  pkill -f "node scripts/host.mjs" 2>/dev/null || true
}

if [ "${1:-}" = "stop" ]; then
  stop_servers
  exit 0
fi

if [ "${1:-}" = "--refresh" ]; then
  if [ ! -x "$CHESSMIND/.venv/bin/python" ]; then
    echo "ChessMind venv not found at $CHESSMIND/.venv (set CHESSMIND_DIR)"; exit 1
  fi
  echo "==> pulling the newest checkpoint of Vast run '$RUN'"
  (cd "$CHESSMIND" && .venv/bin/python scripts/vast_train.py pull "$RUN") || echo "pull failed; keeping the existing checkpoint"
  if [ -f "$CHESSMIND/runs/$MODEL/ckpt.pt" ]; then
    echo "==> exporting $MODEL to ONNX (int8)"
    (cd "$CHESSMIND" && .venv/bin/python scripts/export_onnx.py --run "runs/$MODEL" --out "export/onnx/$MODEL/" --int8)
  fi
fi

if [ ! -d node_modules ]; then
  echo "==> installing npm packages"
  npm install --silent
fi

stop_servers
echo "==> building and starting NoteMate (log: .logs/host.log)"
nohup npm run host > "$LOG_DIR/host.log" 2>&1 &

for _ in $(seq 1 120); do
  if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/" 2>/dev/null | grep -q 200 \
    && curl -s -o /dev/null "http://localhost:$ENGINE_PORT/stockfish-19-lite-single.js" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -s -o /dev/null "http://localhost:$APP_PORT/"; then
  echo "NoteMate did not come up; last log lines:"; tail -20 "$LOG_DIR/host.log"; exit 1
fi

models=$(node -e "try{const m=require('./public/chessmind/models.json');console.log(m.map(x=>x.id+(x.step?' (step '+x.step+')':'')).join(', '))}catch(e){console.log('none')}")
echo
echo "NoteMate is running"
echo "  app:        http://localhost:$APP_PORT"
echo "  engines:    http://localhost:$ENGINE_PORT   (put this in the app's Engine server field for Stockfish Full)"
echo "  chatbot:    $models  (first one is the default)"
echo "  stop with:  ./start.sh stop"
open "http://localhost:$APP_PORT" 2>/dev/null || true
