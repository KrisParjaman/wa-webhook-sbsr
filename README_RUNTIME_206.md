# SBSR Runtime Notes on 206.189.34.228

This directory is the active source of truth for the SBSR WhatsApp bridge on `206.189.34.228`.

## Active Runtime

- PM2 process name: `wa-bridge-sbsr`
- PM2 script path: `/docker/wa-webhook-sbsr/server.js`
- PM2 cwd: `/docker/wa-webhook-sbsr`
- App port: `3001`
- Final OpenClaw gateway port: `18789`

## Why This Differs from `srv1356751`

The Hostinger server `srv1356751` uses an older OpenClaw bridge flow that authenticates through `POST /login` and then upgrades to WebSocket on port `45920`.

Server `206.189.34.228` uses a newer OpenClaw control/gateway stack on port `18789`. That gateway is healthy, but it does not expose the legacy `POST /login` endpoint expected by the old bridge flow. To keep the SBSR bridge behavior aligned while preserving the newer infra stack, the bridge runtime here uses:

- the same SBSR bridge app path pattern as `srv1356751`
- OpenClaw gateway at `127.0.0.1:18789`
- a direct WebSocket auth fallback when `/login` is unavailable

Do not change the gateway away from `18789` unless you re-verify `/health` and OpenClaw auth end-to-end.

## Backup Paths

- Full bridge backup before hardening:
  - `/root/backup-wa-bridge-all-20260511-143436.tgz`
- Previous `/docker` env backup from runtime cutover:
  - `/docker/wa-webhook-sbsr/.env.pre-opt-sync-20260511-143903`

## Rollback

To restore the pre-hardening bridge files:

```bash
tar -xzf /root/backup-wa-bridge-all-20260511-143436.tgz -C /
pm2 delete wa-bridge-sbsr || true
cd /opt/sbsr/biks-platform/clients/sb-sentuh-rasa/wa-bridge
pm2 start server.js --name wa-bridge-sbsr
pm2 save
```

If you want to keep the `/docker` runtime path but restore only bridge code from backup, unpack selectively first and verify before restarting PM2.

## Verify

```bash
pm2 describe wa-bridge-sbsr
curl -s http://127.0.0.1:3001/health
docker ps
node --check /docker/wa-webhook-sbsr/server.js
```
