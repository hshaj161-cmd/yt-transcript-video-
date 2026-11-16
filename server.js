'use strict';
/**
 * YT Transcript Video — backend (API server)
 * Zero-dependency Node.js (>=18) API server. Default port: 8000.
 *
 * The static frontend runs separately (frontend.js, port 3000) and proxies
 * /api/* here, so the browser always talks to a single origin. Direct
 * cross-origin API access is also supported via configurable CORS.
 *
 * Data sources (all public, no API keys):
 *  - YouTube watch page (ytInitialPlayerResponse)  → metadata + caption track list
 *  - YouTube InnerTube player API (WEB / ANDROID)   → fallback for metadata + captions
 *  - YouTube timedtext API (fmt=json3, PoToken)     → transcript segments (supports tlang translation)
 *  - YouTube oEmbed API                             → fallback metadata
 *  - i.ytimg.com                                    → thumbnails (proxied for clean downloads)
 */

const http = require('http');

const API_PORT = parseInt(process.env.API_PORT || process.env.PORT || '8000', 10);

// CORS: origins allowed to call the API directly from a browser.
// The bundled frontend proxies /api through itself (same-origin), so CORS is
// mainly for third-party tools and split deployments.
const CORS_ORIGINS = new Set(
  [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://yttranscriptvideo.com',
    'https://www.yttranscriptvideo.com',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [])
  ]
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const PLAYER_CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT = 120; // requests / minute / IP
const MAX_BODY_BYTES = 256 * 1024;

// BotGuard / PoToken configuration (required by YouTube's timedtext API since 2025)
const BG_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const MINTER_TTL_MS = 11 * 60 * 60 * 1000; // integrity token TTL is 43200s; refresh early

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

const browserHeaders = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+678; SOCS=CAI'
};

/** Extracts the (balanced) JSON object that follows `marker` inside raw HTML. */
function extractEmbeddedJson(text, marker) {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const open = text.indexOf('{', start + marker.length);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Extracts a YouTube video id from every supported URL shape (or a raw id). */
function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '').toLowerCase();
  const idRegex = /^[a-zA-Z0-9_-]{11}$/;
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && idRegex.test(id) ? id : null;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    if (url.searchParams.get('v') && idRegex.test(url.searchParams.get('v'))) {
      return url.searchParams.get('v');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    for (const key of ['shorts', 'embed', 'live', 'v']) {
      const idx = parts.indexOf(key);
      if (idx !== -1 && parts[idx + 1] && idRegex.test(parts[idx + 1])) return parts[idx + 1];
    }
  }
  return null;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function pickThumb(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
    return `https://i.ytimg.com/vi/ID/hqdefault.jpg`;
  }
  let best = thumbnails[0];
  for (const t of thumbnails) {
    const a = (t.width || 0) * (t.height || 0);
    const b = (best.width || 0) * (best.height || 0);
    if (a > b) best = t;
  }
  return best.url;
}

class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// PoToken (BotGuard) — required by YouTube's timedtext API for WEB captions
// ---------------------------------------------------------------------------

/**
 * YouTube's caption (timedtext) endpoint returns an empty 200 unless the URL
 * carries a Proof-of-Origin token minted by BotGuard and bound to the video ID.
 * We bootstrap a WebPoMinter once (valid ~12h) and mint a per-video token on
 * each transcript request, using the open-source bgutils-js implementation.
 */

let minterPromise = null; // in-flight bootstrap
let cachedMinter = null;  // { minter, expiresAt }
let bootstrapFailedAt = 0;

async function bootstrapMinter() {
  const [{ JSDOM }, bg, webpo, utils] = await Promise.all([
    import('jsdom'),
    import('bgutils-js/botguard'),
    import('bgutils-js/webpo'),
    import('bgutils-js/utils')
  ]);

  // Give BotGuard's interpreter a DOM to run in.
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: utils.USER_AGENT
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin
  });
  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }

  const challenge = await bg.getChallenge({ fetchFunction: fetch, requestKey: BG_REQUEST_KEY });
  const interpreterJavascript =
    challenge.interpreterJavascript &&
    challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJavascript) throw new Error('BotGuard interpreter script unavailable');
  new Function(interpreterJavascript)();

  const botGuardClient = await bg.BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis
  });

  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

  const it = await fetch(utils.buildURL('GenerateIT', true), {
    method: 'POST',
    headers: utils.getHeaders(),
    body: JSON.stringify([BG_REQUEST_KEY, botguardResponse])
  });
  if (!it.ok) throw new Error(`WAA GenerateIT failed (HTTP ${it.status})`);
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await it.json();

  const minter = await webpo.WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput
  );
  return { minter, expiresAt: Date.now() + MINTER_TTL_MS };
}

async function getPoToken(videoId) {
  if (Date.now() < bootstrapFailedAt) {
    throw new ApiError(502, 'POTOKEN', 'Could not initialize the transcript source (BotGuard unavailable). Please try again shortly.');
  }
  try {
    if (!cachedMinter || Date.now() > cachedMinter.expiresAt) {
      if (!minterPromise) {
        minterPromise = bootstrapMinter().finally(() => { minterPromise = null; });
      }
      cachedMinter = await minterPromise;
    }
    return await cachedMinter.minter.mintAsWebsafeString(videoId);
  } catch (err) {
    cachedMinter = null;
    bootstrapFailedAt = Date.now() + 60 * 1000; // cool down 1 minute before retrying bootstrap
    console.error('[potoken] bootstrap/mint failed:', err.message);
    throw new ApiError(502, 'POTOKEN', 'Could not mint the transcript access token. Please try again shortly.');
  }
}

// ---------------------------------------------------------------------------
// YouTube data sources
// ---------------------------------------------------------------------------

const playerCache = new Map(); // videoId -> { ts, playerResponse, source }

function captionTrackName(track) {
  if (!track) return '';
  if (track.name && typeof track.name.simpleText === 'string') return track.name.simpleText;
  if (track.name && Array.isArray(track.name.runs)) {
    return track.name.runs.map((r) => r.text).join('');
  }
  return '';
}

function normalizeTracks(playerResponse) {
  const renderer =
    playerResponse &&
    playerResponse.captions &&
    playerResponse.captions.playerCaptionsTracklistRenderer;
  if (!renderer || !Array.isArray(renderer.captionTracks)) {
    return { tracks: [], translationLanguages: [] };
  }
  const tracks = renderer.captionTracks.map((t) => ({
    languageCode: t.languageCode || t.vssId || 'und',
    name: captionTrackName(t) || t.languageCode || 'Unknown',
    kind: t.kind === 'asr' ? 'auto' : 'manual',
    baseUrl: t.baseUrl || '',
    isTranslatable: !!t.isTranslatable,
    vssId: t.vssId || ''
  }));
  const translationLanguages = Array.isArray(renderer.translationLanguages)
    ? renderer.translationLanguages.map((l) => ({
        code: l.languageCode,
        name: captionTrackName(l) || l.languageCode
      }))
    : [];
  return { tracks, translationLanguages };
}

function playabilityProblem(playerResponse) {
  const status = playerResponse && playerResponse.playabilityStatus;
  if (!status) return null;
  if (status.status === 'OK') return null;
  const reason = (status.reason || '').toLowerCase();
  if (status.status === 'LOGIN_REQUIRED') {
    if (reason.includes('age')) {
      return 'This video is age-restricted and requires sign-in, so its transcript cannot be accessed.';
    }
    return 'This video is private or requires sign-in, so its transcript cannot be accessed.';
  }
  if (reason.includes('removed') || reason.includes('terminated') || reason.includes('not available')) {
    return 'This video is unavailable (it may have been removed or terminated).';
  }
  return `This video cannot be analyzed: ${status.reason || status.status}.`;
}

async function fetchWatchPagePlayerResponse(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`;
  const res = await fetchWithTimeout(url, {
    headers: {
      ...browserHeaders,
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new ApiError(502, 'UPSTREAM', `YouTube returned HTTP ${res.status}.`);
  const html = await res.text();
  const playerResponse = extractEmbeddedJson(html, 'ytInitialPlayerResponse');
  if (playerResponse) {
    const problem = playabilityProblem(playerResponse);
    if (problem && !playerResponse.videoDetails) {
      throw new ApiError(404, 'VIDEO_UNAVAILABLE', problem);
    }
    if (playerResponse.videoDetails || playerResponse.captions) {
      return playerResponse;
    }
  }
  throw new ApiError(502, 'UPSTREAM', 'YouTube did not return video data (bot check).');
}

async function fetchInnertubePlayerResponse(videoId, client) {
  const bodies = {
    web: {
      videoId,
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' }
      }
    },
    android: {
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 30,
          hl: 'en',
          gl: 'US'
        }
      }
    }
  };
  const uas = {
    web: UA,
    android: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
  };
  const res = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'User-Agent': uas[client],
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify(bodies[client])
  });
  if (!res.ok) throw new ApiError(502, 'UPSTREAM', `YouTube API returned HTTP ${res.status}.`);
  const data = await res.json();
  if (!data || (!data.videoDetails && !data.captions)) {
    throw new ApiError(502, 'UPSTREAM', 'YouTube API returned no usable data.');
  }
  return data;
}

/**
 * Gets a usable player response for a video, trying the watch page first and
 * InnerTube clients as fallbacks. Caches successful results for 5 minutes.
 */
async function getPlayerResponse(videoId) {
  const cached = playerCache.get(videoId);
  if (cached && Date.now() - cached.ts < PLAYER_CACHE_TTL_MS) return cached.value;

  const attempts = [
    () => fetchWatchPagePlayerResponse(videoId),
    () => fetchInnertubePlayerResponse(videoId, 'web'),
    () => fetchInnertubePlayerResponse(videoId, 'android')
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const value = await attempt();
      playerCache.set(videoId, { ts: Date.now(), value });
      if (playerCache.size > 200) {
        playerCache.delete(playerCache.keys().next().value);
      }
      return value;
    } catch (err) {
      // Definitive answers (video removed/unavailable) shouldn't be retried.
      if (err.code === 'VIDEO_UNAVAILABLE' && /unavailable|removed|not found|terminated/i.test(err.message)) throw err;
      lastError = err;
    }
  }
  const msg = String(lastError && lastError.message || '');
  if (msg.includes('HTTP 400')) {
    throw new ApiError(404, 'VIDEO_UNAVAILABLE', 'Video not found — check the URL or the video ID.');
  }
  throw lastError || new ApiError(502, 'UPSTREAM', 'Could not reach YouTube.');
}

function extractMetadata(playerResponse, videoId) {
  const details = playerResponse.videoDetails || {};
  const microformat =
    (playerResponse.microformat &&
      playerResponse.microformat.playerMicroformatRenderer) ||
    {};
  const problem = playabilityProblem(playerResponse);
  const { tracks, translationLanguages } = normalizeTracks(playerResponse);

  const durationSeconds = parseInt(details.lengthSeconds, 10) || 0;

  return {
    problem,
    video: {
      videoId,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: details.title || microformat.title || null,
      channel: details.author || microformat.ownerChannelName || null,
      channelId: details.channelId || null,
      durationSeconds,
      durationFormatted: durationSeconds ? formatDuration(durationSeconds) : null,
      isLive: !!details.isLiveContent,
      viewCount: details.viewCount ? parseInt(details.viewCount, 10) : null,
      publishDate: microformat.publishDate || microformat.uploadDate || null,
      category: microformat.category || null,
      thumbnail: pickThumb(details.thumbnail && details.thumbnail.thumbnails)
    },
    captions: {
      available: tracks.length > 0,
      tracks: tracks.map(({ baseUrl, ...rest }) => rest), // never leak raw URLs to the client
      translationLanguages: tracks.some((t) => t.isTranslatable) ? translationLanguages : []
    }
  };
}

/** Fetches and parses a caption track from the timedtext API (json3 format). */
async function fetchTranscriptSegments(videoId, baseUrl, translateTo) {
  const pot = await getPoToken(videoId);
  let url = baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=json3`;
  url += `&c=WEB&pot=${encodeURIComponent(pot)}`;
  if (translateTo) url += `&tlang=${encodeURIComponent(translateTo)}`;

  const request = async () => {
    const res = await fetchWithTimeout(url, {
      headers: {
        ...browserHeaders,
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/'
      }
    });
    return { res, text: await res.text() };
  };

  let { res, text } = await request();

  // A stale minter produces a silent empty 200 — re-mint once and retry.
  if (res.ok && text.trim() === '') {
    cachedMinter = null;
    const pot2 = await getPoToken(videoId);
    const retryUrl = url
      .replace(/([?&])pot=[^&]*/, `$1pot=${encodeURIComponent(pot2)}`)
      .replace(/([?&])tlang=[^&]*/, translateTo ? `$1tlang=${encodeURIComponent(translateTo)}` : '$1');
    ({ res, text } = await fetchWithTimeout(retryUrl, {
      headers: {
        ...browserHeaders,
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/'
      }
    }).then(async (r) => ({ res: r, text: await r.text() })));
  }

  if (res.status === 429 || res.status === 403) {
    throw new ApiError(429, 'RATE_LIMITED', 'YouTube is rate-limiting transcript requests from this machine. Please wait a minute and try again.');
  }
  if (!res.ok) {
    throw new ApiError(502, 'UPSTREAM', `The transcript source returned HTTP ${res.status}.`);
  }
  if (text.trim() === '') {
    throw new ApiError(502, 'UPSTREAM', 'The transcript source returned no data (access blocked for this track).');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(502, 'UPSTREAM', 'The transcript source returned unexpected data.');
  }
  const events = Array.isArray(data.events) ? data.events : [];
  const segments = [];
  for (const event of events) {
    if (!event || !Array.isArray(event.segs) || typeof event.tStartMs !== 'number') continue;
    if (event.aAppend === 1) continue; // karaoke-style append events duplicate text
    const joined = event.segs
      .map((s) => (typeof s.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!joined) continue;
    const text2 = joined;
    const prev = segments[segments.length - 1];
    if (prev && prev.text === text2) continue; // drop exact duplicates
    segments.push({
      start: +(event.tStartMs / 1000).toFixed(3),
      dur: +((event.dDurationMs || 0) / 1000).toFixed(3),
      text: text2
    });
  }
  if (segments.length === 0) {
    throw new ApiError(404, 'NO_TRANSCRIPT', 'This caption track exists but contains no text.');
  }
  return segments;
}

function resolveTrack(playerResponse, languageCode, kind) {
  const { tracks } = normalizeTracks(playerResponse);
  if (tracks.length === 0) {
    throw new ApiError(404, 'NO_TRANSCRIPT', 'This video has no available captions.');
  }
  let track = tracks.find((t) => t.languageCode === languageCode && t.kind === kind);
  if (!track) track = tracks.find((t) => t.languageCode === languageCode);
  if (!track) track = tracks[0];
  if (!track.baseUrl) {
    throw new ApiError(502, 'UPSTREAM', 'The caption track has no retrievable source URL.');
  }
  return track;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const THUMB_QUALITIES = [
  { quality: 'maxresdefault', label: 'Max Resolution', width: 1280, height: 720 },
  { quality: 'sddefault', label: 'Standard Definition', width: 640, height: 480 },
  { quality: 'hqdefault', label: 'High Quality', width: 480, height: 360 },
  { quality: 'mqdefault', label: 'Medium Quality', width: 320, height: 180 },
  { quality: 'default', label: 'Thumbnail', width: 120, height: 90 }
];

async function probeThumbnail(videoId, quality) {
  const url = `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD' }, 8000);
    return { url, ok: res.status === 200 };
  } catch {
    return { url, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const rateBuckets = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return bucket.count <= RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleAnalyze(req, res, body) {
  const videoId = extractVideoId(body && body.url);
  if (!videoId) {
    throw new ApiError(
      400,
      'INVALID_URL',
      'That does not look like a valid YouTube video URL. Supported: youtube.com/watch?v=… , youtu.be/… , youtube.com/shorts/…'
    );
  }
  const playerResponse = await getPlayerResponse(videoId);
  const meta = extractMetadata(playerResponse, videoId);
  if (meta.problem) {
    throw new ApiError(422, 'VIDEO_UNAVAILABLE', meta.problem);
  }
  sendJson(res, 200, meta);
}

async function handleTranscript(req, res, body) {
  const videoId = extractVideoId(body && body.videoId);
  if (!videoId) throw new ApiError(400, 'INVALID_ID', 'Invalid video id.');
  const languageCode = (body.languageCode || '').trim();
  const kind = body.kind === 'auto' ? 'auto' : 'manual';
  const translateTo = (body.translateTo || '').trim() || null;

  const playerResponse = await getPlayerResponse(videoId);
  const track = resolveTrack(playerResponse, languageCode, kind);
  const segments = await fetchTranscriptSegments(videoId, track.baseUrl, translateTo);

  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  sendJson(res, 200, {
    videoId,
    languageCode: track.languageCode,
    languageName: track.name,
    kind: track.kind,
    translatedTo: translateTo,
    hasTimestamps: true,
    segments,
    stats: {
      segments: segments.length,
      words,
      characters: segments.reduce((n, s) => n + s.text.length, 0)
    }
  });
}

async function handleThumbnails(req, res, url) {
  const videoId = extractVideoId(url.searchParams.get('videoId'));
  if (!videoId) throw new ApiError(400, 'INVALID_ID', 'Invalid video id.');
  const probed = await Promise.all(
    THUMB_QUALITIES.map(async (q) => ({ ...q, ...(await probeThumbnail(videoId, q.quality)) }))
  );
  const available = probed.filter((p) => p.ok);
  sendJson(res, 200, {
    videoId,
    items: available.map(({ quality, label, width, height }) => ({
      quality,
      label,
      width,
      height,
      previewUrl: `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`,
      downloadUrl: `/api/thumbnail?videoId=${videoId}&quality=${quality}&download=1`
    }))
  });
}

async function handleThumbnailProxy(res, url) {
  const videoId = extractVideoId(url.searchParams.get('videoId'));
  const quality = url.searchParams.get('quality') || 'hqdefault';
  if (!videoId || !THUMB_QUALITIES.some((q) => q.quality === quality)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Invalid thumbnail request.');
  }
  const upstream = await fetchWithTimeout(`https://i.ytimg.com/vi/${videoId}/${quality}.jpg`);
  if (!upstream.ok) {
    throw new ApiError(404, 'NOT_FOUND', 'Thumbnail not available from YouTube.');
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=3600',
    ...(url.searchParams.get('download') === '1'
      ? { 'Content-Disposition': `attachment; filename="thumbnail-${quality}-${videoId}.jpg"` }
      : {})
  });
  res.end(buf);
}

async function handleHealth(res) {
  sendJson(res, 200, { ok: true, name: 'YT Transcript Video', time: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Sets CORS headers for API responses when the Origin is allowed. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isCorsAllowed(req) {
  return req.headers.origin && CORS_ORIGINS.has(req.headers.origin);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = (req.socket.remoteAddress || 'unknown').replace('::ffff:', '');

  try {
    if (url.pathname.startsWith('/api/')) {
      applyCors(req, res);

      // Preflight
      if (req.method === 'OPTIONS') {
        if (!isCorsAllowed(req)) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (!checkRateLimit(ip)) {
        return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' } });
      }

      if (url.pathname === '/api/health' && req.method === 'GET') {
        return await handleHealth(res);
      }
      if (url.pathname === '/api/analyze' && req.method === 'POST') {
        return await handleAnalyze(req, res, await readJsonBody(req));
      }
      if (url.pathname === '/api/transcript' && req.method === 'POST') {
        return await handleTranscript(req, res, await readJsonBody(req));
      }
      if (url.pathname === '/api/thumbnails' && req.method === 'GET') {
        return await handleThumbnails(req, res, url);
      }
      if (url.pathname === '/api/thumbnail' && req.method === 'GET') {
        return await handleThumbnailProxy(res, url);
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
    }

    // The backend serves the API only; static files are served by frontend.js.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('API server — see /api/health');
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || 'INTERNAL';
    const message =
      status === 500 ? 'Something went wrong on the server. Please try again.' : err.message;
    if (status === 500) console.error('[error]', err);
    if (!res.headersSent) {
      sendJson(res, status, { error: { code, message } });
    } else {
      res.end();
    }
  }
});

function start(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < API_PORT + 10) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      start(port + 1);
    } else {
      console.error('Failed to start API server:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log('');
    console.log('  ▶ YT Transcript Video — API backend running');
    console.log(`  ▶ API:  http://localhost:${port}/api/health`);
    console.log('');
  });
}

start(API_PORT);
