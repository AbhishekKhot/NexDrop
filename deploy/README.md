# Deploying the NexDrop Remote Relay

> **New to this?** For a complete, beginner-friendly Oracle Cloud walkthrough —
> account creation, domain, firewall, and **hosting the frontend + relay on one
> VM/domain** — follow [../DEPLOYMENT.md](../DEPLOYMENT.md). This page is the
> **concise config reference** for the **relay-only** topology (frontend hosted
> separately on a static host).

The relay is the only server-side component of Remote mode. It pairs two
browsers and pipes end-to-end-encrypted file chunks between them — it never sees
plaintext (see [../docs/RELAY_PROTOCOL.md](../docs/RELAY_PROTOCOL.md)). It is
deployed **independently** of the LAN agent.

This guide targets an **Oracle Cloud Always-Free ARM Ampere** VM, but any small
Linux box works.

---

## What you get

```
Browser ──wss://relay.example.com──► Caddy (:443, TLS) ──► relay (127.0.0.1:4002) ──► Browser
```

- **Caddy** terminates TLS (auto Let's Encrypt) and proxies the WebSocket.
- **relay** runs as a hardened systemd service bound to loopback.
- Only ports **80 + 443** are exposed; 4002 never leaves the host.

---

## Capacity expectations (Always-Free)

- Shape: `VM.Standard.A1.Flex` — up to 4 OCPU / 24 GB RAM (1 OCPU / 6 GB is plenty).
- Egress is the bottleneck, not CPU: Always-Free networking is ~**480 Mbps** and
  **10 TB/month** outbound. A 1 GB transfer ≈ 17 s at the cap; 5 GB ≈ 85 s. One
  transfer at a time per room, so a single small VM serves many sequential pairs.

---

## 1. Provision the VM

1. Create an Always-Free `VM.Standard.A1.Flex` instance, Ubuntu 22.04 (arm64).
2. In the instance's **VCN security list**, add ingress rules for TCP **80** and
   **443** from `0.0.0.0/0`. Do **not** open 4002.
3. SSH in and set the host firewall to match:
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

## 2. Install Node 20 + Caddy

```bash
# Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (official apt repo)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 3. Build the relay

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin nexdrop || true
sudo mkdir -p /opt/nexdrop
sudo chown "$USER" /opt/nexdrop
git clone <your-repo-url> /opt/nexdrop
cd /opt/nexdrop/backend
npm ci
npm run build            # tsc → dist/ (includes dist/relay.js)
```

## 4. Configure environment

```bash
cp /opt/nexdrop/deploy/.env.production.example /opt/nexdrop/backend/.env
sudo nano /opt/nexdrop/backend/.env   # set RELAY_ALLOWED_ORIGIN to your frontend's HTTPS origin
sudo chown nexdrop:nexdrop /opt/nexdrop/backend/.env
sudo chmod 600 /opt/nexdrop/backend/.env
sudo chown -R nexdrop:nexdrop /opt/nexdrop
```

`RELAY_ALLOWED_ORIGIN` **must** be the exact origin your frontend is served
from (e.g. `https://nexdrop.example.com`), or the relay will refuse the upgrade.

## 5. Install the systemd service

```bash
sudo cp /opt/nexdrop/deploy/relay.service /etc/systemd/system/nexdrop-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now nexdrop-relay
sudo systemctl status nexdrop-relay      # should be active (running)
journalctl -u nexdrop-relay -f           # tail logs
```

## 6. Configure Caddy + DNS

1. Point a DNS **A record** (e.g. `relay.example.com`) at the VM's public IP.
2. Install the Caddyfile:
   ```bash
   sudo cp /opt/nexdrop/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile        # replace relay.example.com with your domain
   sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
   sudo systemctl reload caddy
   ```
   Caddy obtains a Let's Encrypt cert automatically on first request.

## 7. Point the frontend at the relay

Build/deploy the frontend (any static host) with:

```env
VITE_RELAY_URL=wss://relay.example.com
```

`VITE_*` is baked in at build time, so rebuild after changing it.

## 8. Verify

- `curl https://relay.example.com/` → `NexDrop relay running`.
- Open the app's Remote page in two browsers on different networks; in devtools
  → Network → WS you should see a `101 Switching Protocols` to
  `wss://relay.example.com`, then a share-code pairing and a transfer.

---

## Optional: container instead of systemd

```bash
cd /opt/nexdrop
docker build -f deploy/Dockerfile.relay -t nexdrop-relay ./backend
docker run -d --restart unless-stopped \
  --env-file backend/.env \
  -p 127.0.0.1:4002:4002 \
  --name nexdrop-relay nexdrop-relay
```

Keep Caddy on the host (or in its own container) proxying to `127.0.0.1:4002`.

---

## Operations

- **Update:** `git -C /opt/nexdrop pull && cd /opt/nexdrop/backend && npm ci && npm run build && sudo systemctl restart nexdrop-relay`.
- **Tune limits:** edit `.env`, then `sudo systemctl restart nexdrop-relay`. See
  the `RELAY_*` table in [../backend/README.md](../backend/README.md).
- **Logs:** `journalctl -u nexdrop-relay` (relay), `/var/log/caddy/relay-access.log` (proxy).
- **Security posture:** loopback bind + Origin allow-list + per-IP/connection
  rate limits + room TTLs + 5 GB cap. The relay stores nothing and writes no
  files. Rotate the host and keep Node/Caddy patched.
