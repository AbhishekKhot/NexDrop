# Deploying the NexDrop frontend on GitHub Pages

> **Frontend-only guide.** This deploys the static `frontend/dist/` SPA to
> GitHub Pages via a GitHub Actions workflow. The relay (the live backend) is
> deployed separately — see [DEPLOYMENT.md](DEPLOYMENT.md) (Oracle VM) or
> [DEPLOYMENT-RENDER.md](DEPLOYMENT-RENDER.md) (Render PaaS).

GitHub Pages is the simplest free static host if the repo is already on GitHub:

- **Zero new accounts** — uses the repo you already have
- **Free TLS** + free custom domain support
- **100 GB/month soft bandwidth cap** (generous for a personal project)
- **Auto-deploys** via GitHub Actions on push to `main`
- **No previews** for PRs (one limitation vs Cloudflare Pages)

---

## What you'll have at the end

```
Browser ── https://<user>.github.io/NexDrop ──► GitHub Pages (TLS) ──► static SPA
       ── wss://<your-relay-host> ───────────────────────────────────► your relay
```

If the repo is named `NexDrop` and the GitHub user is `abhishekkhot`, the URL
is `https://abhishekkhot.github.io/NexDrop/`. The trailing path segment
matters — see the **Vite base path** note below.

---

## Prerequisites

- Repo pushed to **GitHub** (public, or private on a paid GitHub plan)
- Your **relay URL** ready (e.g. `wss://nexdrop-relay.onrender.com`)
- Admin access to the repo (to enable Pages and add secrets)

---

## Part 1 — Configure the Vite base path

GitHub Pages serves `user.github.io/NexDrop/` from a **subpath**, not the root.
Without a matching `base` in Vite config, all assets 404. Set the base once:

`frontend/vite.config.ts`:

```ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    // GitHub Pages serves under /<repo-name>/. Set VITE_BASE_PATH=/NexDrop/
    // in the workflow env for prod builds; leaves '/' for local dev.
    base: env.VITE_BASE_PATH || '/',
  };
});
```

If the file doesn't already exist, create it. (If it does exist with other
content, merge in the `base:` field.) For other static hosts (Cloudflare
Pages, Vercel) leave `VITE_BASE_PATH` unset and the default `/` applies.

---

## Part 2 — Add the GitHub Actions workflow

Create `.github/workflows/pages.yml` at the repo root:

```yaml
name: Deploy frontend to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'frontend/**'
      - '.github/workflows/pages.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Cancel an in-flight run if a new push lands.
concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - run: npm ci

      - run: npm run build
        env:
          # VITE_* values are baked into the bundle at build time.
          VITE_RELAY_URL: ${{ secrets.VITE_RELAY_URL }}
          # Match the repo name. For user/org sites (named <user>.github.io)
          # this should be '/' instead.
          VITE_BASE_PATH: /${{ github.event.repository.name }}/

      - uses: actions/upload-pages-artifact@v3
        with:
          path: frontend/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Why pinned action versions?** `actions/*` are published by GitHub but
unpinned versions can change behavior between runs. Major-version pins
(`@v4`) get bug fixes without breaking changes.

---

## Part 3 — Set the relay URL as a repo secret

The relay URL is baked into the build, so it must be available to the workflow:

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `VITE_RELAY_URL`.
3. Value: `wss://your-relay-host.example.com` (your deployed relay's full
   `wss://` URL).
4. Save.

> Secrets are encrypted at rest and never appear in build logs. The value will
> still be visible in the JS bundle after build — that's expected (it's the
> public WebSocket endpoint). Don't put real secrets in `VITE_*` vars.

---

## Part 4 — Enable Pages

1. Repo → **Settings → Pages**.
2. Under **Build and deployment → Source**, pick **GitHub Actions**
   *(not "Deploy from a branch")*.
3. That's it — the workflow you added in Part 2 owns the publish from now on.

---

## Part 5 — Trigger the first deploy

Either push a commit that touches `frontend/` or run the workflow manually:

```bash
# Push-based trigger
git add .github/workflows/pages.yml frontend/vite.config.ts
git commit -m "Add GitHub Pages deploy"
git push origin main
```

Or trigger manually: repo → **Actions → "Deploy frontend to GitHub Pages" →
Run workflow → main → Run**.

The workflow takes ~90 seconds (npm install, build, upload, publish). Watch
it under **Actions**. When the `deploy` job's URL output appears, your site
is live at `https://<user>.github.io/<repo>/`.

---

## Part 6 — Tell the relay about the new origin

The relay's `RELAY_ALLOWED_ORIGIN` must include the exact Pages URL (scheme +
host, no path, no trailing slash). Without this the relay rejects the
WebSocket upgrade (CWE-352).

**Render relay:** Dashboard → service → Environment → set
`RELAY_ALLOWED_ORIGIN=https://<user>.github.io` and save (note: just the host
+ scheme, not the `/NexDrop/` path). Wait ~10s for restart.

**VM relay (Caddy):**

```bash
sudo nano /opt/nexdrop/backend/.env
# → RELAY_ALLOWED_ORIGIN=https://<user>.github.io
sudo systemctl restart nexdrop-relay
```

> **Browser quirk:** the `Origin` header on a WebSocket upgrade from
> `https://abhishekkhot.github.io/NexDrop/` is **`https://abhishekkhot.github.io`**
> (no path). That's what the allow-list checks against.

---

## Part 7 — Verify

1. Open `https://<user>.github.io/<repo>/` in two browsers on different networks.
2. Browser A shows a share code; paste it into B.
3. Header status: `Connecting…` → `Waiting for peer` → `Peer connected`.
4. Drop a file in A; accept on B; downloads.

---

## Custom domain (optional)

If you own a domain:

1. **Repo → Settings → Pages → Custom domain** → enter `nexdrop.example.com` → Save.
2. At your DNS registrar, add a CNAME: `nexdrop` → `<user>.github.io`.
3. Wait for cert provisioning (~1–5 min). GitHub uses Let's Encrypt and
   auto-renews.
4. Tick **Enforce HTTPS** in the same settings panel.
5. Update the relay's `RELAY_ALLOWED_ORIGIN` to include the new origin.
6. Optional: edit `vite.config.ts` to set `base: '/'` for the custom domain
   build path — or keep `/<repo>/` if your custom domain points to the same
   subpath. Re-run the workflow either way so the artifact matches.

> **`CNAME` file gotcha:** GitHub writes a `CNAME` file into the published
> artifact when a custom domain is configured. The `actions/deploy-pages@v4`
> action handles this — you don't need to commit a `CNAME` file yourself.

---

## How updates work

- **Frontend changes:** push to `main` (or trigger workflow_dispatch). Build
  + deploy in ~90s.
- **Change `VITE_RELAY_URL`:** update the repo secret → re-run the workflow
  (env-var changes alone don't auto-rebuild).
- **Change Vite base path:** edit `vite.config.ts` and push.

---

## Trade-offs vs Cloudflare Pages

| | GitHub Pages | Cloudflare Pages |
|---|---|---|
| Bandwidth | 100 GB/mo soft cap | Unlimited |
| Build minutes | Counts against GitHub Actions free tier (2,000 min/mo for private repos; unlimited for public) | 500 build minutes free |
| Preview deploys | ❌ none | ✅ per PR branch |
| CDN | GitHub's (Fastly-based) | Cloudflare's (300+ POPs) |
| Custom domain | ✅ free TLS | ✅ free TLS |
| Setup steps | Workflow + 1 secret + 1 config setting | Web UI, 3 clicks |
| Subpath URL | `/<repo>/` by default | Root |

Pick GitHub Pages if you already manage everything in the repo and don't need
preview deploys. Pick [Cloudflare Pages](DEPLOYMENT-CLOUDFLARE-PAGES.md) if
you want unlimited bandwidth + previews and don't mind a second dashboard.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Site loads but assets 404 (white page, `Failed to load resource: ...index-abc.js`) | `base` path not set | Confirm `VITE_BASE_PATH=/<repo>/` in the workflow `env:` block matches the repo name (case-sensitive) |
| Workflow fails: "Resource not accessible by integration" | Pages source not switched to "GitHub Actions" | Settings → Pages → Build and deployment → Source → **GitHub Actions** |
| WS closes immediately (1006) | Relay rejects the Origin | Update `RELAY_ALLOWED_ORIGIN` to `https://<user>.github.io` (no path, no trailing slash) |
| WS errors with mixed-content block | Page is `https://`, relay is `ws://` | Relay must be `wss://`. Deploy it behind TLS |
| 404 on direct `/remote` navigation | SPA needs a fallback | The current build redirects unknown paths to `/` in `App.tsx`, but GitHub Pages itself returns 404 first. Workaround: add a `frontend/public/404.html` that's a copy of `index.html` (GitHub Pages serves 404.html with a 200 if requested as `/`) — or stick to deep-link-friendly paths |
| New build doesn't deploy after secret change | `paths:` filter only triggers on `frontend/**` changes | Run the workflow manually via Actions → Run workflow |
| `npm ci` fails with `package-lock.json not found` | Lockfile out of sync | Run `npm install` locally in `frontend/`, commit the resulting `package-lock.json` |

---

## Cleanup

- **Disable Pages:** Settings → Pages → Source → "None".
- **Delete the workflow:** remove `.github/workflows/pages.yml`.
- **Revoke the secret:** Settings → Secrets and variables → Actions → delete `VITE_RELAY_URL`.
