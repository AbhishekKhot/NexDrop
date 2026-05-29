# Deploying the NexDrop frontend on Cloudflare Pages

> **Frontend-only guide.** This deploys the static `frontend/dist/` SPA to
> Cloudflare Pages. The relay (the live backend) is deployed separately on
> Render — see [DEPLOYMENT-RENDER.md](DEPLOYMENT-RENDER.md).

Cloudflare Pages is the recommended free static host for the NexDrop frontend:

- **Unlimited bandwidth** on the free plan (no egress cap)
- **Global CDN** with edge caching in 300+ cities
- **Auto-builds** on every push to `main`
- **Preview deploys** for every PR branch
- **Free TLS** + free custom domains
- **No card on file** by default — completely free for personal use

---

## What you'll have at the end

```
Browser ── https://nexdrop.pages.dev ──► Cloudflare edge (TLS) ──► static SPA
       ── wss://<your-relay-host> ────────────────────────────────► your relay
```

`nexdrop.pages.dev` is whatever subdomain you pick during setup (or your own
custom domain).

---

## Prerequisites

- The repo pushed to **GitHub** (Cloudflare also supports GitLab)
- A **Cloudflare** account (free, https://dash.cloudflare.com)
- Your **relay URL** ready — you'll bake it into the frontend build as
  `VITE_RELAY_URL`. If you haven't deployed the relay yet, do that first.

---

## Part 1 — Connect the repo

1. Push the repo to GitHub: `git push origin main`.
2. Go to **https://dash.cloudflare.com → Workers & Pages → Create → Pages →
   Connect to Git**.
3. Click **Connect GitHub**, then authorize Cloudflare for **only the NexDrop
   repo** (Cloudflare prompts for repo-level scope — minimum-privilege).
4. Pick the NexDrop repo → **Begin setup**.

---

## Part 2 — Configure the build

Fill in the form exactly as shown:

| Field | Value |
|---|---|
| **Project name** | `nexdrop` *(becomes `https://nexdrop.pages.dev`)* |
| **Production branch** | `main` |
| **Framework preset** | `Vite` |
| **Build command** | `npm ci && npm run build` |
| **Build output directory** | `dist` |
| **Root directory** *(under "Advanced")* | `frontend` |

**Environment variables** *(Pages → Settings → Environment variables → Production)*:

| Key | Value |
|---|---|
| `VITE_RELAY_URL` | `wss://your-relay-host.example.com` *(your deployed relay's `wss://` URL)* |
| `NODE_VERSION` | `20` *(Pages defaults to Node 18; pin 20 to match what backend uses)* |

Click **Save and Deploy**. The first build takes ~2 min:

```
$ cd frontend
$ npm ci                              # → installs ~250 packages
$ npm run build                       # → tsc -b && vite build → frontend/dist/
✓ built in 4.2s
Deploy successful — https://nexdrop.pages.dev is live
```

---

## Part 3 — Tell the relay about the new origin

The relay's `RELAY_ALLOWED_ORIGIN` must include the exact Pages URL
(scheme + host, no path, no trailing slash). Without this, the relay refuses
the WebSocket upgrade (CWE-352 / CSWSH).

**If your relay is on Render:** Dashboard → service → Environment →
`RELAY_ALLOWED_ORIGIN` = `https://nexdrop.pages.dev` → Save.

**If your relay is on a VM with Caddy:** edit
`/opt/nexdrop/backend/.env` on the VM:

```env
RELAY_ALLOWED_ORIGIN=https://nexdrop.pages.dev
```

Then `sudo systemctl restart nexdrop-relay`.

For multiple environments (preview deploys, custom domain, staging) provide a
comma-separated list:

```env
RELAY_ALLOWED_ORIGIN=https://nexdrop.pages.dev,https://nexdrop.example.com
```

---

## Part 4 — Verify

1. Open `https://nexdrop.pages.dev` in two browsers on different networks.
2. The first one auto-generates a 10-char share code (visible under the
   "Connect to Remote Peer" input).
3. Paste it into the second browser's input and click **Connect**.
4. The header status flips `Connecting…` → `Waiting for peer` → `Peer connected`.
5. Drop a file in browser A; accept on browser B; file downloads.

Devtools → Network → WS should show `wss://your-relay-host` with status
**101 Switching Protocols**.

---

## Custom domain (optional)

You already have a domain on Cloudflare (or you can grab one from Cloudflare
Registrar at cost).

1. **Pages → your project → Custom domains → Set up a domain**.
2. Enter `nexdrop.example.com`. Cloudflare adds the CNAME automatically
   (since DNS is also on Cloudflare).
3. Wait 30s for cert issuance.
4. Update the relay's `RELAY_ALLOWED_ORIGIN` to include the new origin (see
   Part 3).
5. **Optional but recommended:** trigger a redeploy *after* setting the
   custom domain so any absolute-URL meta tags pick it up.

For a non-Cloudflare-managed domain, Pages will show the CNAME target — add
it at your registrar's DNS panel.

---

## How updates work

Cloudflare Pages auto-deploys on every push to `main`. To change `VITE_RELAY_URL`
later:

1. **Pages → Settings → Environment variables** → edit value → Save.
2. **Deployments → Retry deployment** on the latest production deploy
   (env-var changes alone don't trigger a build).

Preview deploys for PR branches are created automatically and get unique URLs
like `https://abc123.nexdrop.pages.dev` — but they share the same env vars by
default. If you want different env per environment, set them under both
"Production" and "Preview" with different values.

---

## Build cache & performance

Pages caches `node_modules` between builds keyed off `package-lock.json`. To
force a clean build (rare — useful only after suspected cache corruption):

**Deployments → most-recent → Retry → "Clear build cache"** *(under the
three-dot menu)*.

Typical build numbers for this repo:

| Phase | Time | Notes |
|---|---|---|
| `npm ci` | ~30s (cold) / ~10s (warm) | 250 packages |
| `tsc -b && vite build` | ~6s | ~700 KB JS, ~50 KB CSS gzipped |
| Deploy to edge | ~5s | Propagation typically instant globally |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails: `Cannot find module 'vite'` | Wrong root directory | Confirm **Root directory** = `frontend` (Advanced settings) |
| Build fails: `Node 18` errors | Pages default Node version | Add env var `NODE_VERSION=20` (case-sensitive) |
| Frontend loads but WS closes immediately (1006) | Origin not in allow-list | Update `RELAY_ALLOWED_ORIGIN` on the relay to include the Pages URL exactly |
| Frontend loads but WS errors with mixed-content block | Page is `https://`, relay is `ws://` | Relay must be `wss://`. Deploy it behind TLS (Render edge / Caddy / Cloudflare Tunnel) |
| Old `VITE_RELAY_URL` baked in after env change | Env vars only apply to *next* build | Deployments → Retry deployment to rebuild |
| 404 on direct `/<route>` navigation | SPA needs a fallback to `index.html` | Add a `frontend/public/_redirects` file with `/* /index.html 200` (Cloudflare honors this) |
| Build OOMs | Free Pages build runner has 8 GB RAM | Should be fine for this repo (build uses <500 MB). If it ever fails, run `npm run build` locally and use `wrangler pages deploy dist` instead |

> **SPA fallback:** the current build doesn't include `_redirects` because the
> Remote app is single-route. If you re-enable LAN (with `/lan` etc.) and want
> direct deep-linking, add `frontend/public/_redirects` containing:
> `/* /index.html 200`

---

## Cleanup

- **Delete project:** Pages → project → Settings → Delete project.
- **Revoke GitHub access:** GitHub Settings → Applications → Cloudflare → Revoke.
