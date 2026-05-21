# wa-bridge-sbsr

> The WhatsApp Cloud API → OpenClaw gateway for Sentuh Rasa. Lives at `/docker/wa-webhook-sbsr/` on the VPS once Stage 2 deploys.

## Status

Production source is **derived from `/docker/wa-webhook-beeru/`** at deploy time, not committed here. Reasons:
- Beeru's `server.js` is ~52 KB of mature code (admin panel, chat history, contact mgmt, retry/queue) that we want to inherit, not re-write
- Bridge code drifts heavily across the lifecycle of a client; a clean re-baseline is cheaper than a fork
- The repo's job is configuration + workspace; bridge runtime is operational

## Stage 2 deployment (from `docs/05-deployment-plan.md`)

```bash
ssh root@VPS

# 1. Clone Beeru's bridge as the starting point
cp -r /docker/wa-webhook-beeru /docker/wa-webhook-sbsr
cd /docker/wa-webhook-sbsr

# 2. Replace .env with sb-sentuh-rasa values
cp /tmp/sbsr-bridge.env .env   # copy the file from this folder, see env.template below

# 3. Patch port + OpenClaw target in server.js if hardcoded
#    (Beeru's bridge reads from .env, so usually nothing to patch)

# 4. Start under pm2
pm2 start server.js --name wa-bridge-sbsr
pm2 save
```

## Env (copy to `/docker/wa-webhook-sbsr/.env`)

See `env.template` in this directory.

## What needs to differ from Beeru's bridge

| Concern | Beeru | SBSR |
|---|---|---|
| Port | 3001 | **3002** |
| OpenClaw target | 127.0.0.1:52208 | **127.0.0.1:45920** |
| Phone IDs | one (Beeru) | **three** (CS / Finance / Kitchen — bridge differentiates by `phone_number_id`) |
| Admin URL | none | **https://sbsr.biks.ai/admin** (Stage 3+) |
| Receipt path mount | `airoklin-pdf/uploads` | **`sentuhrasa-pdf/uploads`** |

## Stage 2 patch checklist (after copying Beeru's bridge)

- [ ] Update routing logic: when inbound `phone_number_id` matches `WA_PHONE_NUMBER_ID_FINANCE`, treat as Finance approve/reject UI events
- [ ] Same for Kitchen phone (one-way; suppress auto-reply)
- [ ] Wire Biteship webhook handler at `/biteship/status` (forwards to `sentuh-tracking-followup.mjs --webhook`)
- [ ] Add operating-hours gate: outside `SBSR_HOURS_OPEN`–`SBSR_HOURS_CLOSE`, send `sr_off_hours_ack` template instead of forwarding to OpenClaw
- [ ] Verify chat-storage path is `chats-sbsr/` (not `chats/`) so it doesn't collide if the bridge ever mounts the wrong volume

These are tracked in `docs/05-deployment-plan.md` § Stage 2 deployment.
