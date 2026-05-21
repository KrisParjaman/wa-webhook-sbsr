#!/usr/bin/env bash
set -euo pipefail

SRC="/docker/wa-webhook-sbsr"
DST="/opt/sbsr/biks-platform/clients/sb-sentuh-rasa/wa-bridge"
TS="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$SRC" ]]; then
  echo "source missing: $SRC" >&2
  exit 1
fi

if [[ ! -d "$DST" ]]; then
  echo "destination missing: $DST" >&2
  exit 1
fi

mkdir -p "$DST/.backup"

if [[ -f "$DST/server.js" ]]; then
  cp "$DST/server.js" "$DST/.backup/server.js.$TS.bak"
fi

rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'receipts/' \
  --exclude 'logs/' \
  --exclude 'chats/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'README_SOURCE_OF_TRUTH.txt' \
  "$SRC/" "$DST/"

node --check "$DST/server.js"
echo "sync complete: $SRC -> $DST"
