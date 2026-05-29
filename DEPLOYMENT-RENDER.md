# Deploying NexDrop on Render (free, click-deploy)

> **Companion to [DEPLOYMENT.md](DEPLOYMENT.md).** Pick this guide if you want
> the smallest possible deployment: no VM, no SSH, no Caddy, no DNS for the
> relay. The Oracle guide is better if you need always-on without cold starts.

Render's free tier hosts the **Remote relay**. The **frontend** goes on
**Cloudflare Pages** (also free, no cold-start). End-to-end zero ongoing cost
if you use a Render subdomain like `nexdrop-relay.onrender.com` and a Pages
subdomain like `nexdrop.pages.dev`.

**LAN mode is not deployable** — it requires a local Node agent on each user's
machine (mDNS multicast + TCP server can't run in a cloud sandbox). See
[backend/README.md](backend/README.md) for the LAN agent.

---

## What you'll have at the end

```
Browser ── wss://nexdrop-relay.onrender.com ──► Render Edge (TLS) ──► relay
       ── https://nexdrop.pages.dev ──────────► Cloudflare Pages (frontend)
```

- TLS termination handled by Render's edge (free, auto-renewed)
- Origin allow-list enforced on every WebSocket upgrade (CWE-352)
- Frontend served from Cloudflare's global CDN

---

## Free-tier trade-offs (read first)

| Limit | Render free | Notes |
|---|---|---|
| **Idle sleep** | After 15 min of no requests | First connection after sleep waits ~30–60s for cold start |
| **Egress** | 100 GB/month | ≈ 20× 5 GB transfers, or 100× 1 GB transfers |
| **Build minutes** | 500/month | Each push uses ~2–3 min; plenty for a personal repo |
| **RAM** | 512 MB | Enough — relay holds chunks in flight only, with backpressure |
| **CPU** | 0.1 vCPU (shared) | Egress is the bottleneck, not CPU |
| **Custom domain** | Supported on free | Optional; subdomain works fine |
| **Auto-deploy on push** | Yes | Push to `main` → rebuild + redeploy |

**Cold start is the only real pain point.** Two workarounds at the end of this
guide ([uptime ping](#optional-prevent-cold-starts-with-an-uptime-ping)) keep
the relay warm.

---

## Prerequisites

- The repo pushed to **GitHub** (Render reads from GitHub/GitLab/Bitbucket)
- A **Render** account (free, https://render.com — sign up with GitHub)
- A **Cloudflare** account for the frontend (free, https://dash.cloudflare.com)

---

## Part 1 — Deploy the relay on Render

### 1.1 Push the repo to GitHub

```bash
cd /path/to/NexDrop
git remote -v                       # confirm origin points to GitHub
git push origin main
```

The repo includes [render.yaml](render.yaml) at the root — Render reads it as
a **Blueprint** and provisions the service automatically.

### 1.2 Create the Blueprint service

1. Go to **https://dashboard.render.com/select-repo?type=blueprint**.
2. Click **Connect GitHub** (or use the GitLab/Bitbucket option) and authorize
   Render to read the NexDrop repo. Grant access to that single repo only.
3. Click **Connect** next to the NexDrop repo.
4. Render reads `render.yaml` and shows: *"This blueprint will create 1 service: nexdrop-relay"*.
5. Click **Apply**.

Render starts building. The first build takes ~3–5 min: `npm ci` then
`npm run build` (TypeScript → `dist/`).

### 1.3 Set the one required env var

`RELAY_ALLOWED_ORIGIN` is **not** baked into the blueprint (because each user's
frontend lives at a different URL). Set it manually:

1. While the build runs, click into the **nexdrop-relay** service.
2. Open the **Environment** tab.
3. Click **Add Environment Variable**:
   - **Key:** `RELAY_ALLOWED_ORIGIN`
   - **Value:** `https://nexdrop.pages.dev` *(or whatever Cloudflare Pages
     hands you in Part 2 — temporarily use a placeholder, you'll update it)*
4. Click **Save Changes**. Render restarts the service.

> ⚠️ **Do not leave this unset.** With no `RELAY_ALLOWED_ORIGIN`, the relay
> defaults to `http://localhost:5173` and rejects every production upgrade.
> This is intentional — it prevents Cross-Site WebSocket Hijacking (CWE-352).

### 1.4 Verify the relay is up

Render assigns a URL like `https://nexdrop-relay.onrender.com`. Copy it from
the service page.

```bash
curl https://nexdrop-relay.onrender.com/
# → NexDrop relay running
```

Tail logs on the **Logs** tab. You should see the banner:

```
╔══════════════════════════════════════════════════╗
║            NexDrop Relay — Ready                  ║
╠══════════════════════════════════════════════════╣
║  Listen   : 0.0.0.0:10000                         ║
║  Max file : 5120 MiB                              ║
║  Origins  : https://nexdrop.pages.dev             ║
╚══════════════════════════════════════════════════╝
```

The port shown is Render's internal port — externally everything reaches the
service on **443** via Render's edge.

---

## Part 2 — Deploy the frontend on Cloudflare Pages

> Two dedicated frontend guides also exist if you'd rather follow a focused
> walkthrough:
>
> - [DEPLOYMENT-CLOUDFLARE-PAGES.md](DEPLOYMENT-CLOUDFLARE-PAGES.md) — same as below, with more detail
> - [DEPLOYMENT-GITHUB-PAGES.md](DEPLOYMENT-GITHUB-PAGES.md) — alternative free static host (GitHub Actions auto-deploy)

### 2.1 Push (if not already) and connect

1. Go to **https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git**.
2. Authorize Cloudflare to read the NexDrop repo.
3. Pick the NexDrop repo, click **Begin setup**.

### 2.2 Configure the build

| Field | Value |
|---|---|
| **Project name** | `nexdrop` *(becomes `nexdrop.pages.dev`)* |
| **Production branch** | `main` |
| **Framework preset** | `Vite` |
| **Build command** | `npm ci && npm run build` |
| **Build output directory** | `dist` |
| **Root directory (advanced)** | `frontend` |
| **Environment variable** | `VITE_RELAY_URL` = `wss://nexdrop-relay.onrender.com` |

Click **Save and Deploy**. First build takes ~2 min. The site appears at
`https://nexdrop.pages.dev`.

> `VITE_*` env vars are **baked in at build time**. To change the relay URL
> later you must trigger a rebuild (push a commit or click **Retry deployment**).

### 2.3 Update Render with the real origin

Back on Render → **nexdrop-relay** → **Environment** → edit
`RELAY_ALLOWED_ORIGIN` to your actual Pages URL (e.g.
`https://nexdrop.pages.dev`). Save — the relay restarts in ~10s.

---

## Part 3 — Test end-to-end

1. Open `https://nexdrop.pages.dev/remote` in two browsers on different
   networks (e.g. desktop + phone on cellular).
2. Browser A shows a 10-character share code; type it into browser B.
3. In devtools → **Network → WS** you should see:
   - `wss://nexdrop-relay.onrender.com` upgrading with **101 Switching
     Protocols**
   - Header status flipping `Connecting…` → `Waiting for peer` → `Peer connected`.
4. Drag a file into A; accept on B. File downloads to B's Downloads folder.

> First connection after the relay has been idle 15+ min waits ~30–60s while
> Render wakes the container. Subsequent connections are instant.

---

## Optional — Prevent cold starts with an uptime ping

Render free tier puts the service to sleep after 15 minutes of no HTTP
traffic. A scheduled GET to `/` every ~10 minutes keeps it warm. The relay's
GET handler (`NexDrop relay running`) is designed for exactly this — it does
not allocate, does not log per-request, and ignores all headers.

**Pick one:**

### Option A: cron-job.org (free, web UI)

1. Sign up at **https://cron-job.org**.
2. Create a job:
   - **URL:** `https://nexdrop-relay.onrender.com/`
   - **Schedule:** every 10 minutes
   - **Request method:** GET
   - **Notifications on failure:** optional but recommended
3. Save. The relay stays warm 24/7.

### Option B: GitHub Actions (free, in your repo)

Create `.github/workflows/keepalive.yml`:

```yaml
name: Relay keepalive
on:
  schedule:
    - cron: "*/10 * * * *"   # every 10 minutes
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS --retry 3 --max-time 30 https://nexdrop-relay.onrender.com/
```

GitHub Actions schedules drift up to ~15 min under load, so use 10-min cron
rather than 14-min to stay under Render's idle timeout.

> **Trade-off:** Keeping the service hot uses ~144 pings/day × 30 days ≈
> 4,300 free-tier minutes/month. Render's free plan allows 750 hours/month of
> service uptime regardless of pings (24h × 31d = 744h), so this is fine for
> a single service.

---

## Custom domain (optional)

If you own a domain (e.g. `nexdrop.example`) you can:

- Map `nexdrop.example` → Cloudflare Pages (in Pages → Custom domains).
- Map `relay.nexdrop.example` → Render service (in Render → Settings → Custom
  Domains, then add the CNAME in Cloudflare DNS).

Then update:
- `RELAY_ALLOWED_ORIGIN` on Render → `https://nexdrop.example`
- `VITE_RELAY_URL` on Cloudflare Pages → `wss://relay.nexdrop.example`, then
  trigger a redeploy.

Render auto-issues a Let's Encrypt cert for the custom domain.

---

## Operations

| Action | How |
|---|---|
| **Update relay** | `git push origin main` — Render auto-builds and rolls |
| **Update frontend** | `git push origin main` — Cloudflare Pages auto-builds |
| **Tail relay logs** | Render dashboard → service → **Logs** |
| **Restart relay** | Render dashboard → service → **Manual Deploy → Clear cache & deploy** |
| **Tune limits** | Edit env vars on Render; service auto-restarts. See `RELAY_*` table in [backend/README.md](backend/README.md). |
| **Roll back** | Render dashboard → **Deploys** → click any prior deploy → **Rollback** |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **WebSocket fails with 1006 immediately** | Origin mismatch | Confirm `RELAY_ALLOWED_ORIGIN` on Render matches the exact `https://…` origin shown in the browser address bar (no trailing slash) |
| **First connection waits 30–60s** | Service was sleeping | Expected on free tier. Set up the uptime ping above. |
| **Build fails with `Cannot find module`** | TypeScript path missing | Confirm `rootDir: backend` is in `render.yaml` and `dist/relay.js` exists after local `npm run build` |
| **Relay logs say `[Relay] origin rejected`** | Origin allow-list mismatch | Same as row 1 — exact match required |
| **Transfer hangs at ~70%** | Render free-tier 100s HTTP timeout for *idle* connections; WS keepalives prevent this. If it happens, check WS ping frames in devtools | The relay sends ping every 30s — verify ws library is up to date |
| **"Out of memory" in logs** | Backpressure misconfigured or huge concurrent transfers | Free tier has 512 MB. Lower `RELAY_BACKPRESSURE_HIGH` to `4194304` (4 MiB) |
| **Connection refused at deploy time** | Service still building | Wait for **Logs** to show the banner before testing |

---

## What about LAN mode?

LAN mode needs the local Node agent on each user's machine — it can't run on
Render (no mDNS multicast, no peer routability across the internet). The
hosted frontend at `https://nexdrop.pages.dev` will also block mixed-content
to `ws://localhost:4001` if a user tries to use LAN mode from the deployed
site.

For LAN use, users should:
1. Clone the repo locally.
2. `cd backend && npm install && npm run dev` (starts the agent).
3. `cd frontend && npm install && npm run dev` (visit `http://localhost:5173`).

See [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md).

---

## Cleanup

- **Delete the Render service:** Render dashboard → service → **Settings → Delete Service**.
- **Delete the Pages project:** Cloudflare → Workers & Pages → project → **Settings → Delete**.
- **Revoke GitHub access:** GitHub Settings → Applications → Render / Cloudflare → Revoke.

Both providers' free tiers carry no card on file by default, so deleting the
service stops everything cleanly.
