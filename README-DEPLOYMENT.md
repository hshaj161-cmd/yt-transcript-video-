# YT Transcript Video — Deployment & Domain Guide

> **Want the free path?** See **`DEPLOY-FREE.md`** for the beginner step-by-step
> guide to publish at **$0** on Render's free tier (no domain purchase, no
> credit card) — the recommended way to get a public URL today.

This document explains how to take the app from `http://localhost:3000` to
`https://yttranscriptvideo.com`. **The domain is not yet purchased and nothing
below has been executed against real DNS or hosting — every step is prepared
configuration, ready to run once you buy the domain.**

## Hosting evaluation — Cloudflare verdict

Cloudflare (Pages/Workers) was investigated first and **ruled out with tested
evidence**:

- The BotGuard PoToken minter needs `jsdom` → impossible in Workers.
- `youtubei.js` has an official `cf-worker` entry, but its `get_transcript`
  flow returns **HTTP 400 "Precondition check failed"** against today's
  YouTube (transcripts moved to a new "elements" framework the v18.3.0 parser
  can't read; the ANDROID `/next` parse fails with
  "Transcript expected PlaylistCollaborationView…").

Forcing Workers would sacrifice transcript extraction, so a long-lived Node
host was chosen instead. Details in `DEPLOY-FREE.md`.

---

## 1. Architecture summary

```
Browser ──> http://localhost:3000        frontend.js   (static UI + /api proxy)
                     │ proxies /api/*
                     ▼
              http://localhost:8000      server.js     (API: analyze, transcript, thumbnails)
                     │
                     ▼
              YouTube public data (watch page, InnerTube, timedtext+PoToken, i.ytimg.com)
```

- **No database exists** — the app is stateless; nothing is stored server-side
  (transcripts are fetched live, history lives nowhere). Nothing to migrate.
- **No login/auth system exists** — the tool is anonymous by design; there are
  no cookies or sessions to secure. If you later add accounts, put auth behind
  `Secure`/`HttpOnly`/`SameSite=Lax` cookies at the reverse proxy.
- **No build step** — the frontend is plain HTML/CSS/JS served as-is; the
  "production build" is simply `npm install` + `node start-all.js`.

## 2. Environment variables

See `.env.example`. Summary:

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `API_PORT` | `8000` | server.js | API backend port |
| `FRONTEND_PORT` | `3000` | frontend.js | Static frontend port |
| `BACKEND_PORT` | `8000` | frontend.js | Proxy target for `/api` |
| `BACKEND_HOST` | `127.0.0.1` | frontend.js | Proxy target host |
| `PORT` | — | both | Host-injected port (Render/Heroku) overrides the above |
| `ALLOWED_ORIGINS` | *(built-in list)* | server.js | Extra CORS origins, comma-separated |

Built-in CORS allowlist: `http://localhost:3000`,
`https://yttranscriptvideo.com`, `https://www.yttranscriptvideo.com`
(+ anything you add via `ALLOWED_ORIGINS`). The bundled frontend doesn't need
CORS at all because `/api` is same-origin through the proxy.

## 3. Local Windows usage

| Action | Command |
| --- | --- |
| Start everything + open Chrome | double-click **`start-app.bat`** |
| Start without Chrome | `node start-all.js` |
| Stop the app (only this app's processes) | double-click **`stop-app.bat`** |

`start-app.bat` starts the backend first, then the frontend, polls
`http://localhost:3000` until it responds, and only then opens Chrome.
PIDs are recorded in `.run\` so `stop-app.bat` kills exactly those processes
(and, as a safe fallback, only `node` processes whose command line points at
this project's `server.js`/`frontend.js`).

## 4. Hosting provider — evaluation

| Provider | Verdict | Reason |
| --- | --- | --- |
| **Render** ✅ chosen | Suitable | Long-running Node process, custom domains + free auto-TLS, `render.yaml` blueprint included. One service runs both processes via `start-all.js`. |
| Vercel | ❌ not used | Serverless model: every cold start would re-run the BotGuard PoToken bootstrap (~seconds, cached in memory only), and long transcript fetches fit poorly in serverless functions. |
| Railway / Fly.io | ✅ also works | Same unified-process model; use `node start-all.js` as the start command. |
| Netlify | ❌ not used | Static hosting only; can't host the Node API. |

**Configured:** Render (`render.yaml` in this folder). For the free-tier
click-by-click walkthrough (GitHub upload → Render Blueprint → public URL),
see **`DEPLOY-FREE.md`**.

### Deploying to Render

1. Push the `yt-transcript-video` folder to a GitHub repository.
2. Render dashboard → **New + → Blueprint** → select the repo.
3. Render reads `render.yaml`: builds with `npm install`, starts
   `node start-all.js`, health check `/api/health`.
4. You get `https://yt-transcript-video.onrender.com` with HTTPS immediately.
5. Set env vars in the dashboard if needed (defaults work).

## 5. Domain connection (after purchasing yttranscriptvideo.com)

**Render (recommended path):**
1. Render dashboard → your service → **Custom Domains → Add**:
   - `yttranscriptvideo.com`
   - `www.yttranscriptvideo.com`
2. At your registrar's DNS panel, add the records Render shows:
   - `A` record: `@` → the Render load-balancer IP it displays
   - `CNAME` record: `www` → `yt-transcript-video.onrender.com`
3. Wait for DNS propagation (minutes to 48h; usually < 1h).
4. Render issues **free automatic TLS certificates** (Let's Encrypt) for both
   hostnames and auto-renews them. Force-HTTPS toggle is available per domain.

**Self-hosted server (VPS) alternative:**
1. DNS: `A` record `@` → server IP; `CNAME` `www` → `yttranscriptvideo.com`.
2. Open ports 80/443, run `node start-all.js` (optionally as a systemd service).
3. Install Caddy and run `caddy run --config deploy/Caddyfile` — it obtains and
   renews Let's Encrypt certificates automatically. **Or** use nginx with
   `sudo certbot --nginx -d yttranscriptvideo.com -d www.yttranscriptvideo.com`
   (config template in `deploy/nginx.conf`).

## 6. HTTPS / SSL summary

- **Render:** automatic, free, per-domain certificates — nothing to install.
- **Caddy:** automatic Let's Encrypt + renewal.
- **nginx:** via certbot with auto-renewal (`deploy/nginx.conf`).
- HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` headers
  are set by both reverse-proxy configs (and by `frontend.js` directly).

## 7. Production checklist

- [ ] Purchase the domain at a registrar.
- [ ] Choose Render (or VPS) and deploy (`render.yaml` provided).
- [ ] Verify `https://<deployment-url>/api/health` returns `{"ok":true}`.
- [ ] Add custom domains in the host dashboard; add DNS records.
- [ ] Wait for certificate issuance; verify `https://yttranscriptvideo.com`
      and `https://www.yttranscriptvideo.com` load with a padlock.
- [ ] Optionally redirect `www` → apex (Caddyfile redir included).
- [ ] Run `node smoke-test.mjs` against the live URL for an end-to-end check.
