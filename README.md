# YT Transcript Video

A modern, full-stack web application for extracting **YouTube video transcripts** and
**high-quality thumbnails** instantly. Works with regular videos **and YouTube Shorts**.

![Stack](https://img.shields.io/badge/backend-Node.js%2018%2B-3ddc84) ![No deps](https://img.shields.io/badge/npm%20dependencies-0-blue)

## Features

- **Analyze any YouTube URL** — `youtube.com/watch?v=…`, `youtu.be/…`,
  `youtube.com/shorts/…`, `youtube.com/live/…`, `embed` links, URLs with extra
  parameters, or a raw 11-character video ID. URLs are validated before any request.
- **Video information** — title, channel name, duration, view count, publish date,
  category and thumbnail.
- **Full transcript extraction** — reads YouTube's own public caption data
  (timedtext API, `json3` format) via the watch page with InnerTube (WEB / ANDROID)
  API fallbacks. Nothing is invented: only the text YouTube actually provides.
- **Language options** — every available caption track is listed, clearly labeled
  as *original* vs *auto-generated*, with an optional *translate to* dropdown
  (YouTube's own translation, only when the source track is translatable).
- **Unicode-correct display** — full support for Urdu, Arabic, Hindi, English,
  Indonesian, Romanian, etc., with automatic RTL layout for RTL languages.
- **Search inside the transcript** with live match count and highlighting.
- **Exports** — Copy, Download TXT (optional timestamps, readable paragraphs),
  SRT and VTT (when timestamps are available), plus Clear.
- **Thumbnail extractor** — probes every resolution YouTube hosts
  (maxres → default), hides missing sizes, and proxies clean
  `Content-Disposition` downloads for each one.
- **Honest UX** — a staged loading animation (Validating → Analyzing → Fetching →
  Retrieving → Preparing) while real work happens; clear error messages for
  invalid URLs, unavailable/private/age-restricted videos, and videos with no
  captions. No fake data is ever shown.

## Getting started

Requires **Node.js 18+**. Two npm dependencies (`bgutils-js`, `jsdom`) are used to
mint YouTube's BotGuard PoToken — required since 2025 for caption access.

```bash
cd yt-transcript-video
npm install        # first time only
```

| Action | Command |
| --- | --- |
| Start everything + open Chrome | double-click **`start-app.bat`** |
| Start everything (no Chrome) | `npm start` (runs `node start-all.js`) |
| Start API only / frontend only | `npm run start:api` / `npm run start:web` |
| Stop the app (only its processes) | double-click **`stop-app.bat`** |

**Architecture:** the API backend runs on **port 8000** (`server.js`); the
frontend runs on **port 3000** (`frontend.js`), serves the UI and transparently
proxies `/api/*` to the backend — so the browser only ever talks to
`http://localhost:3000`. The backend also has a proper CORS allowlist for
direct cross-origin API use. If a port is busy, both servers automatically try
the next ones; set `API_PORT` / `FRONTEND_PORT` (see `.env.example`) to pin them.

Deployment & custom-domain guide: **`README-DEPLOYMENT.md`**.
Free public deployment ($0, no domain): **`DEPLOY-FREE.md`**.

## REST API

| Method | Path              | Description |
| ------ | ----------------- | ----------- |
| GET    | `/api/health`     | Health check |
| POST   | `/api/analyze`    | `{ url }` → video metadata + available caption tracks |
| POST   | `/api/transcript` | `{ videoId, languageCode, kind, translateTo? }` → transcript segments + stats |
| GET    | `/api/thumbnails` | `?videoId=` → all resolutions YouTube actually hosts |
| GET    | `/api/thumbnail`  | `?videoId=&quality=&download=1` → proxied JPEG download |

Example:

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
```

## How transcript retrieval works

1. The server fetches the watch page and parses `ytInitialPlayerResponse`
   (balanced-brace extraction, no fragile regex) to get metadata and the list of
   caption tracks; InnerTube (WEB / ANDROID) clients serve as fallbacks.
2. Since 2025 YouTube requires a **PoToken** on caption requests — the timedtext
   endpoint returns a silent *empty 200* without one. The server mints a
   BotGuard-derived PoToken bound to the video ID using
   [`bgutils-js`](https://github.com/LuanRT/BgUtils) + `jsdom`, bootstrapped once
   per ~12h and cached; requests use `&pot=<token>&c=WEB&fmt=json3`.
3. `&fmt=json3` returns timed segments (duplicates and karaoke-append events are
   dropped), and `&tlang=xx` performs translation.
4. Successful player responses are cached for 5 minutes; per-IP rate limiting
   (120 req/min) protects the server. If YouTube rate-limits caption requests
   (HTTP 429), the app says so clearly instead of showing empty results.

You can verify your setup at any time:

```bash
node smoke-test.mjs   # runs a full end-to-end API test against a running server
```

## Project structure

```
yt-transcript-video/
├── start-app.bat          # start backend + frontend, wait, open Chrome
├── stop-app.bat           # stop only this app's processes
├── start-all.js           # process manager (npm start / production)
├── server.js              # API backend (:8000) incl. PoToken machinery + CORS
├── frontend.js            # static frontend (:3000) + /api reverse proxy
├── package.json           # deps: bgutils-js, jsdom
├── .env.example           # environment variable documentation
├── render.yaml            # Render deployment blueprint
├── DEPLOY-FREE.md         # beginner $0 publish guide (GitHub + Render free)
├── deploy/
│   ├── Caddyfile          # auto-HTTPS reverse proxy for yttranscriptvideo.com
│   └── nginx.conf         # nginx + certbot alternative
├── scripts/
│   ├── start-app.ps1      # start logic used by start-app.bat
│   └── stop-app.ps1       # safe stop logic (PID files + command-line match)
├── smoke-test.mjs         # end-to-end API test (run against a started server)
└── public/
    ├── index.html         # UI (single page)
    ├── favicon.svg        # video + transcript icon
    ├── styles.css         # dark + light themes, YouTube-red accent, responsive
    └── app.js             # frontend logic (analysis, transcript, exports)
```

## Notes & limitations

- Transcripts exist only when YouTube has captions for a video (manual or
  auto-generated). If a video has none, the app says so instead of pretending.
- Age-restricted / private videos require sign-in on YouTube and cannot be read.
- Live streams expose captions only while YouTube provides them; the app surfaces
  upstream errors honestly.
- The app extracts **transcripts and thumbnails only** — it does not download
  video/audio streams.
