# NexDrop — Oracle Cloud Free Tier Deployment Guide

End-to-end, copy-paste guide to host NexDrop on a free Oracle Cloud VM: from
creating the account, through the VM, firewall, TLS, domain, and going live.

> **Looking for a click-deploy path instead?** See
> [DEPLOYMENT-RENDER.md](DEPLOYMENT-RENDER.md) — relay on Render's free tier
> + frontend on Cloudflare Pages, no VM or SSH. Faster to set up, but Render
> free sleeps after 15 min of idle (one-time ~30s cold start). The Oracle
> guide here is best if you want always-on with no cold starts.

> **Scope.** This deploys the **Remote (relay) mode** as a public website: one
> small VM runs the relay, and Caddy serves the built frontend and proxies the
> relay over `wss://` — all on one domain.
>
> **LAN mode is not part of this deployment.** LAN mode needs the local agent
> running on each user's own machine, and a browser on an `https://` site cannot
> open an insecure `ws://localhost:4001` connection (mixed-content block). LAN
> mode stays a "run NexDrop locally" feature; the hosted site is Remote-only.

---

## Final architecture

```
                            ┌────────────────────────── Oracle Free VM ──────────────────────────┐
Browser ── https/wss ──►    │  Caddy :443 (TLS, Let's Encrypt)                                    │
 (nexdrop.duckdns.org)      │   ├─ /ws*  → reverse_proxy → relay  (127.0.0.1:4002, systemd)       │
                            │   └─ /*    → file_server  → built frontend (/var/www/nexdrop)       │
                            └────────────────────────────────────────────────────────────────────┘
   Two browsers pair by share code through the relay; file CONTENTS are E2E
   encrypted (ECDH + AES-256-GCM) — the relay only forwards ciphertext.
```

- One domain, one TLS cert, one DNS record.
- Relay bound to loopback; only ports 80/443 are exposed.

---

## Table of Contents

1. [Part 1 — Get a domain (free & cheap options)](#part-1--get-a-domain)
2. [Part 2 — Create an Oracle Cloud account](#part-2--create-an-oracle-cloud-account)
3. [Part 3 — Create the VM instance](#part-3--create-the-vm-instance)
4. [Part 4 — Open the firewall (two layers!)](#part-4--open-the-firewall-two-layers)
5. [Part 5 — Connect & prepare the server](#part-5--connect--prepare-the-server)
6. [Part 6 — Install Node, Caddy, and the code](#part-6--install-node-caddy-and-the-code)
7. [Part 7 — Configure & run the relay (systemd)](#part-7--configure--run-the-relay-systemd)
8. [Part 8 — Build & deploy the frontend](#part-8--build--deploy-the-frontend)
9. [Part 9 — Point your domain & configure Caddy (TLS)](#part-9--point-your-domain--configure-caddy-tls)
10. [Part 10 — Verify it works](#part-10--verify-it-works)
11. [Part 11 — Harden & operate](#part-11--harden--operate)
12. [Troubleshooting](#troubleshooting)

---

## Part 1 — Get a domain

**There is no such thing as a free `.com` or `.in`** — those are paid TLDs
(~₹100–₹1000/yr). "Free" gets you a **subdomain** on someone else's domain. Pick
one of these:

| Option | What you get | Cost | TLS (Let's Encrypt) | Best for |
|---|---|---|---|---|
| **DuckDNS** (recommended) | `nexdrop.duckdns.org` | Free | ✅ (HTTP-01, port 80) | Fastest path to a working HTTPS site |
| **afraid.org (FreeDNS)** | `nexdrop.mooo.com` etc. | Free | ✅ | More subdomain choices |
| **is-a.dev / js.org** | `nexdrop.is-a.dev` | Free (GitHub PR) | ✅ | Dev/open-source projects |
| **Cloudflare Registrar** | real `nexdrop.com` | At-cost (~$10/yr .com) | ✅ | Cheapest *real* domain, no markup |
| **Namecheap / Porkbun** | real `.in` / `.xyz` | ~₹100–800/yr (.xyz often $1 first yr) | ✅ | A real branded domain |
| **GitHub Student Pack** | free `.me` for 1 year (via Namecheap) | Free if student | ✅ | Students |

> ⚠️ **Avoid Freenom** (`.tk`, `.ml`, `.ga`, `.cf`, `.gq`). Free registrations are
> effectively dead and the registrar is unreliable — domains get reclaimed.

This guide uses **DuckDNS** as the example (zero cost, works immediately). You'll
set its IP **after** you have the VM's public IP (Part 9).

**Set up DuckDNS now (you'll fill in the IP later):**

1. Go to <https://www.duckdns.org>, sign in with GitHub/Google.
2. Create a subdomain, e.g. `nexdrop` → you now own `nexdrop.duckdns.org`.
3. Note your DuckDNS **token** (shown at the top) — used to update the IP.

If you bought a real domain instead, you'll just create an **A record** pointing
at the VM IP in that registrar's DNS panel (Part 9).

---

## Part 2 — Create an Oracle Cloud account

1. Go to <https://www.oracle.com/cloud/free/> → **Start for free**.
2. Fill in country, name, email; verify the email.
3. **Identity verification requires a credit/debit card.** Always Free resources
   are **not charged** — a small temporary authorization hold (~₹1 / $1) may
   appear and is reversed. You won't be charged unless you explicitly upgrade to
   Pay As You Go.
4. **Home region** — choose carefully; **it cannot be changed later**. Pick a
   region geographically close to your users that still has Always-Free ARM
   capacity (see the capacity note in Part 3). India users: Mumbai/Hyderabad.
5. Finish signup and sign in to the **OCI Console** (<https://cloud.oracle.com>).

---

## Part 3 — Create the VM instance

### 3.1 Generate an SSH key (on your local machine)

```bash
# macOS/Linux — creates ~/.ssh/nexdrop and ~/.ssh/nexdrop.pub
ssh-keygen -t ed25519 -f ~/.ssh/nexdrop -C "nexdrop-oracle"
cat ~/.ssh/nexdrop.pub        # you'll paste this public key into the console
```

### 3.2 Launch the instance

In the OCI Console: **☰ Menu → Compute → Instances → Create instance**.

- **Name:** `nexdrop-relay`
- **Image & shape → Edit:**
  - **Image:** Canonical **Ubuntu 22.04** (aarch64 for ARM).
  - **Shape:** **Ampere → `VM.Standard.A1.Flex`** → set **1 OCPU / 6 GB RAM**
    (Always Free allows up to 4 OCPU / 24 GB total across A1 instances; 1/6 is
    plenty for the relay + frontend build).
- **Networking:** keep "Create new VCN" with a public subnet, **Assign a public
  IPv4 address = Yes**.
- **Add SSH keys:** choose **Paste public keys** and paste the contents of
  `~/.ssh/nexdrop.pub`.
- **Create.**

> 🟠 **"Out of host capacity" for A1?** This is the #1 Oracle Free-Tier
> annoyance — ARM capacity is often exhausted in popular regions. Options:
> - Retry every few hours / different Availability Domain.
> - Fall back to the **AMD Always-Free** shape **`VM.Standard.E2.1.Micro`**
>   (1 OCPU / **1 GB RAM**, x86). It works for the relay, but 1 GB is tight for
>   `vite build` — in that case **build the frontend locally and upload `dist/`**
>   (Part 8 alt) and add swap (Part 5.4).

When the instance is **Running**, copy its **Public IP address** (e.g.
`140.238.x.x`).

---

## Part 4 — Open the firewall (two layers!)

Oracle blocks inbound traffic at **two** independent layers. You must open **80**
and **443** in **both**, or your site is unreachable. This trips up almost
everyone.

### 4.1 Layer 1 — VCN Security List (cloud firewall)

OCI Console: **☰ → Networking → Virtual Cloud Networks → [your VCN] → Subnets →
[public subnet] → Security Lists → Default Security List → Add Ingress Rules.**

Add two rules:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(SSH port 22 is already allowed by the default rule.)

### 4.2 Layer 2 — the instance's own iptables

Oracle's Ubuntu image ships with an `iptables` ruleset that **REJECTs everything
except SSH**. Opening the Security List is not enough — you must also allow
80/443 on the VM. SSH in first (Part 5), then:

```bash
# See current rules and the REJECT line's position
sudo iptables -L INPUT --line-numbers

# Insert ACCEPT rules ABOVE the REJECT-all rule (position 6 on the stock image)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT

# Persist across reboots
sudo netfilter-persistent save
```

> If `netfilter-persistent` isn't installed: `sudo apt-get install -y iptables-persistent`
> (answer "Yes" to save current rules), then re-run the save.
>
> Verify the new rules sit **before** the `REJECT ... reject-with icmp-host-prohibited`
> line in `sudo iptables -L INPUT --line-numbers`. If they're below it, delete and
> re-insert at a lower number.

---

## Part 5 — Connect & prepare the server

### 5.1 SSH in

```bash
ssh -i ~/.ssh/nexdrop ubuntu@140.238.x.x      # use YOUR public IP
```

### 5.2 Update the OS

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### 5.3 Create an unprivileged service user

The relay runs as a dedicated non-root user (least privilege).

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin nexdrop
```

### 5.4 (Only on the 1 GB E2.1.Micro) add swap

Skip on A1/6 GB. On the 1 GB micro, swap prevents OOM during `npm`/builds:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Part 6 — Install Node, Caddy, and the code

### 6.1 Node.js 20 (NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v        # expect v20.x
```

### 6.2 Caddy (official apt repo)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### 6.3 Clone & build

```bash
sudo mkdir -p /opt/nexdrop && sudo chown "$USER" /opt/nexdrop
git clone <YOUR_REPO_URL> /opt/nexdrop
cd /opt/nexdrop/backend
npm ci
npm run build          # tsc → dist/  (produces dist/relay.js)
```

---

## Part 7 — Configure & run the relay (systemd)

### 7.1 Environment file (no secrets in git)

```bash
cp /opt/nexdrop/deploy/.env.production.example /opt/nexdrop/backend/.env
sudo nano /opt/nexdrop/backend/.env
```

Set these (replace the domain with **yours**):

```env
NODE_ENV=production
RELAY_PORT=4002
RELAY_BIND_HOST=127.0.0.1
RELAY_ALLOWED_ORIGIN=https://nexdrop.duckdns.org
RELAY_TRUST_PROXY=true
RELAY_MAX_FILE_SIZE=5368709120
RELAY_MAX_CONN_PER_IP=5
RELAY_MAX_MSG_PER_SEC=20
RELAY_MAX_FAILED_JOINS=10
RELAY_FAILED_JOIN_WINDOW_MS=60000
RELAY_ROOM_TTL_MS=600000
RELAY_ROOM_ABSOLUTE_TTL_MS=1800000
```

> `RELAY_ALLOWED_ORIGIN` **must exactly match** the URL the site is served from,
> or the relay refuses the WebSocket upgrade. `RELAY_TRUST_PROXY=true` is correct
> *because* Caddy sits in front and sets `X-Forwarded-For`.

Lock it down:

```bash
sudo chown -R nexdrop:nexdrop /opt/nexdrop
sudo chmod 600 /opt/nexdrop/backend/.env
```

### 7.2 Install the systemd unit

The repo ships a hardened unit at `deploy/relay.service`:

```bash
sudo cp /opt/nexdrop/deploy/relay.service /etc/systemd/system/nexdrop-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now nexdrop-relay
sudo systemctl status nexdrop-relay      # expect: active (running)
```

Tail logs:

```bash
journalctl -u nexdrop-relay -f
# expect the banner + [Relay] Listening on ws://127.0.0.1:4002
```

---

## Part 8 — Build & deploy the frontend

The frontend is a static SPA; build it with your **public** relay URL baked in,
then serve the output with Caddy.

```bash
cd /opt/nexdrop/frontend
# Bake the production endpoints (VITE_* are compiled in at build time)
cat > .env.production <<'EOF'
VITE_RELAY_URL=wss://nexdrop.duckdns.org/ws
VITE_AGENT_WS_URL=ws://localhost:4001
EOF

npm ci
npm run build                      # tsc -b && vite build → dist/

# Publish the static files where Caddy will serve them
sudo mkdir -p /var/www/nexdrop
sudo cp -r dist/* /var/www/nexdrop/
sudo chown -R caddy:caddy /var/www/nexdrop
```

> `VITE_RELAY_URL` points at `wss://<domain>/ws` — Caddy will route that path to
> the relay (Part 9). `VITE_AGENT_WS_URL` is harmless here (LAN mode is unused on
> the hosted site).

**Alt for the 1 GB micro (avoid building on the VM):** build locally and upload:

```bash
# On your laptop, inside frontend/
VITE_RELAY_URL=wss://nexdrop.duckdns.org/ws npm run build
scp -i ~/.ssh/nexdrop -r dist/* ubuntu@140.238.x.x:/tmp/nexdrop-dist/
# then on the VM:
sudo mkdir -p /var/www/nexdrop && sudo cp -r /tmp/nexdrop-dist/* /var/www/nexdrop/
sudo chown -R caddy:caddy /var/www/nexdrop
```

---

## Part 9 — Point your domain & configure Caddy (TLS)

### 9.1 Point the domain at the VM

- **DuckDNS:** open <https://www.duckdns.org>, set your subdomain's **current IP**
  to the VM's public IP, **Update**. (Or from the VM:
  `curl "https://www.duckdns.org/update?domains=nexdrop&token=YOUR_TOKEN&ip=140.238.x.x"`.)
- **Real domain:** in your registrar's DNS, add an **A record**: host `@` (or
  `nexdrop`) → `140.238.x.x`, TTL low (e.g. 300s).

Verify propagation:

```bash
dig +short nexdrop.duckdns.org      # should print your VM IP
```

### 9.2 Caddyfile (serves frontend + proxies the relay, auto-TLS)

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the contents with (swap in **your** domain):

```caddy
nexdrop.duckdns.org {
	encode gzip

	# WebSocket relay — anything under /ws goes to the loopback relay.
	@ws path /ws /ws/*
	handle @ws {
		reverse_proxy 127.0.0.1:4002 {
			flush_interval -1
		}
	}

	# Everything else: the static SPA (with client-side routing fallback).
	handle {
		root * /var/www/nexdrop
		try_files {path} /index.html
		file_server
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}

	log {
		output file /var/log/caddy/nexdrop.log
		format json
	}
}
```

Create the log dir and reload:

```bash
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

Caddy now fetches a Let's Encrypt certificate automatically (needs port 80
reachable for the HTTP-01 challenge — which you opened in Part 4). Watch it:

```bash
journalctl -u caddy -f      # look for "certificate obtained successfully"
```

---

## Part 10 — Verify it works

1. **Relay reachable through Caddy** — visiting the WS path over plain HTTPS
   returns the relay's text (the WS upgrade only happens from the app):
   ```bash
   curl https://nexdrop.duckdns.org/ws      # → "NexDrop relay running"
   ```
2. **Site loads:** open `https://nexdrop.duckdns.org/remote` in a browser — you
   should get a 10-char share code (not "Generating…").
3. **End-to-end:** open the site on a second device/network, paste the code,
   **Connect**, and send a file. On the VM:
   ```bash
   journalctl -u nexdrop-relay -f
   # [Relay] peer paired (1 active)
   # [Relay] transfer begin: ... / transfer end: ...
   ```
4. In browser devtools → Network → WS, confirm a `101 Switching Protocols` to
   `wss://nexdrop.duckdns.org/ws`.

---

## Part 11 — Harden & operate

### Lock down SSH (key-only)

```bash
sudo nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl restart ssh
```

### Automatic security updates + brute-force protection

```bash
sudo apt-get install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades     # enable
```

### Operations cheatsheet

```bash
# Update NexDrop to the latest code:
cd /opt/nexdrop && git pull
cd backend  && npm ci && npm run build && sudo systemctl restart nexdrop-relay
cd ../frontend && npm ci && npm run build && sudo cp -r dist/* /var/www/nexdrop/

# Tune relay limits: edit /opt/nexdrop/backend/.env then:
sudo systemctl restart nexdrop-relay

# Logs:
journalctl -u nexdrop-relay -f          # relay
journalctl -u caddy -f                  # TLS / proxy
sudo tail -f /var/log/caddy/nexdrop.log # access log (no bodies)
```

### What's protected

Loopback-bound relay (never directly exposed) · Origin allow-list (CSWSH) ·
per-IP connection cap · per-connection message-rate limit · failed-join rate
limit · 16 KiB control-frame cap · global 5 GiB byte cap with hard abort · idle +
absolute room TTLs · TLS everywhere · the relay stores nothing and writes no
files. File contents are end-to-end encrypted; the relay sees only ciphertext.

### Free-tier limits to expect

Always-Free egress is ~**480 Mbps** and **10 TB/month** outbound — fine for a
personal relay (1 GB transfer ≈ 17 s at the cap). One transfer per room at a
time, so a single small VM serves many sequential pairs.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Site/`curl` times out | Firewall: re-check **both** the VCN Security List **and** `sudo iptables -L INPUT --line-numbers` (Part 4). Both layers must allow 80/443. |
| Caddy can't get a cert | Port **80** not reachable, or DNS not pointing at the VM yet. `dig +short <domain>` must show the VM IP; `journalctl -u caddy`. |
| Share code stuck "Generating…" | Relay not running or wrong URL. `systemctl status nexdrop-relay`; `curl https://<domain>/ws` should say "NexDrop relay running". |
| Relay error / upgrade refused | `RELAY_ALLOWED_ORIGIN` doesn't exactly match the site origin (scheme + host). Fix `.env`, `systemctl restart nexdrop-relay`. |
| "Out of host capacity" creating VM | A1 capacity exhausted — retry later / other AD, or use `VM.Standard.E2.1.Micro` (Part 3 note). |
| `vite build` killed (OOM) on micro | Add swap (Part 5.4) or build locally and upload `dist/` (Part 8 alt). |
| LAN tab doesn't work on the site | Expected — the hosted `https://` site can't reach a local `ws://localhost:4001` agent (mixed content). LAN mode is for running NexDrop locally. |

---

This guide reuses [deploy/relay.service](deploy/relay.service) and
[deploy/.env.production.example](deploy/.env.production.example) as-is. The
Caddyfile **inline above** serves the frontend **and** the relay on one domain
(`/ws` path). The separate [deploy/Caddyfile](deploy/Caddyfile) is a **relay-only**
variant for the alternative topology where you host the frontend on a static
host (Netlify / Vercel / Cloudflare Pages) and run only the relay on the VM —
see [deploy/README.md](deploy/README.md). For the wire protocol, see
[docs/RELAY_PROTOCOL.md](docs/RELAY_PROTOCOL.md).
