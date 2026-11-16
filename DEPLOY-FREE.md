# YT Transcript Video — Publish Online for $0 (Beginner Guide)

This guide publishes the app as a **public website, completely free**, using
**GitHub** (free file storage) + **Render** (free hosting). No domain purchase,
no credit card, no paid plan, no trial.

**Final result:** a public URL like
`https://yt-transcript-video.onrender.com` that works from any device — your
computer does **not** need to stay on.

---

## Why Render (and not Cloudflare)

The transcript feature needs two things Cloudflare Workers cannot provide:

1. **`jsdom`** — the BotGuard PoToken minter (required for caption access since
   2025) uses `jsdom`, which cannot run inside Workers (no full DOM engine).
2. **`youtubei.js` transcript flow** — the library *does* have an official
   `youtubei.js/cf-worker` entry (Workers is a supported runtime), but its
   `/next`-based `get_transcript` flow was tested directly and returns
   **HTTP 400 "Precondition check failed"**; YouTube moved transcripts to a new
   "elements" UI framework that the library's parser (v18.3.0) cannot read.
   The ANDROID client parse fails with "Transcript expected
   PlaylistCollaborationView…" errors. This is a library-side breakage, not a
   hosting choice.

So Workers would mean **losing transcript extraction** — the core feature.
Render runs the app exactly as it runs locally (a long-lived Node process),
which also suits the PoToken minter being cached in memory for ~12 h.

**Render free tier facts (verified from render.com/docs/free, Nov 2026):**
genuinely $0, **no payment method required** — if you ever exceed limits the
service *suspends* rather than billing you. Includes 750 instance-hours/month
(one service runs 24/7 with room to spare), free HTTPS/TLS, and free custom
domains if you ever buy one.

---

## Part 1 — Put the code on GitHub (free)

1. Open **https://github.com** and click **Sign up** (or sign in).
2. After signing in, click the **+** icon (top-right) → **New repository**.
3. Repository name: `yt-transcript-video` · Visibility: **Private** is fine
   (Render can read it) · Click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. From the folder `Documents\Default Project\yt-transcript-video`, upload
   **everything except** these (do not upload them):
   - the `node_modules` folder
   - the `.run` folder (if present)
   - any `.env` file (only `.env.example` should be uploaded)
   - `worker\verify.mjs` and `wrangler` leftovers are harmless but unnecessary
6. Click **Commit changes**.

> Tip: keep the folder structure intact — `public/`, `scripts/`, `deploy/`
> must stay as folders with the same files inside.

## Part 2 — Create the free Render service

1. Open **https://dashboard.render.com/register** and sign up
   (you can use your GitHub account — no card is ever asked for).
2. In the dashboard, click **New +** → **Blueprint**.
3. If asked, click **Connect GitHub** / authorize Render (read-only repo
   access; you can limit it to just this repo).
4. Select the `yt-transcript-video` repository.
5. Render reads the included `render.yaml` automatically. It will show:
   - **Plan: Free** ← confirm this is selected
   - Start command: `node start-all.js`
   - Health check: `/api/health`
   - **No environment variables need to be entered** (none are required).
6. Click **Apply** / **Create Services** and wait for the build
   (~2–5 minutes: `npm install`, then the service starts).

## Part 3 — Get and share your public URL

1. When the service shows **Live**, the dashboard shows your URL at the top,
   e.g. `https://yt-transcript-video.onrender.com`.
2. Click it — the app opens with HTTPS. Paste a YouTube URL and extract a
   transcript to confirm it works.
3. **Share that link with friends.** It works from phones, other PCs —
   anywhere, with your computer off.
4. Optional: rename the service in **Settings → Name** to change the URL slug
   (availability of `yt-transcript-video` is not guaranteed; any free name
   works).

## Part 4 — Zero-cost protection checklist

Before/during Part 2, confirm each of these in the Render dashboard:

- [ ] The plan shown is **Free** (not "Starter"/paid)
- [ ] No **credit card / payment method** screen appears (Render free signup
      never asks for one)
- [ ] No paid add-ons enabled (no Postgres, no cron, no metrics — the app
      needs none of them: it has **no database**)
- [ ] No billing or auto-recharge settings touched

If at any point a provider demands payment details, **stop** — this app was
specifically built to avoid that.

---

## Honest limitations of the free tier

| Limitation | What it means |
| --- | --- |
| **Spin-down after 15 min idle** | The first visitor after a quiet period waits ~1 minute while the service wakes up (Render shows its loading page). Then everything works normally. |
| **750 instance-hours/month** | Enough for one service running 24/7 (≈744 h). A second free web service could exceed it, but one is all you need. |
| **YouTube datacenter IP risk** | Render's servers share IPs with other traffic; YouTube may occasionally bot-check requests from datacenter IPs. The app degrades gracefully: it falls back to the ANDROID InnerTube client and shows clear error messages when YouTube refuses. Availability can vary over time — this is a YouTube-side restriction, not a hosting bug. |
| **Translation rate limits** | YouTube rate-limits `tlang` translation requests aggressively from cloud IPs (429s were observed even from a home IP during testing). Original-language transcripts are unaffected. |
| **"Service-initiated traffic" threshold** | Render counts outbound API traffic; a free service that makes *extreme* outbound API volume can be suspended. Normal transcript usage is nowhere near this. |
| **Your URL is `*.onrender.com`** | A real custom domain (like `yttranscriptvideo.com`) still costs money at a registrar. Render connects custom domains free with auto-TLS *if* you ever buy one — see `README-DEPLOYMENT.md`. |

## Features that are "N/A" by design

The app is **stateless and anonymous** — there is intentionally no login,
no user accounts, no CAPTCHA, no database, and no settings storage. Nothing
about users is stored anywhere, so there is nothing to migrate, secure, or
expose. All secret-free: no API keys are required at all.

## Troubleshooting

- **Build fails** → make sure `package.json` and `package-lock.json` were
  uploaded, and `node_modules` was *not*.
- **"Health check failed"** during deploy → wait and retry; the first boot
  includes `npm install`.
- **Cold start slow** → that's the free-tier spin-down; wait ~1 minute.
- **Transcript errors on Render** → see the "YouTube datacenter IP risk" row
  above; try again later or from the same link later in the day.
- **Redeploy after changing files** → commit to the GitHub repo; Render
  auto-redeploys on every push.
