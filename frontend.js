'use strict';
/**
 * YT Transcript Video — frontend server
 * Zero-dependency Node.js (>=18) static file server (default port 3000).
 *
 * Serves the UI from ./public and transparently proxies /api/* to the backend
 * (server.js, default port 8000), so the browser only ever talks to
 * http://localhost:3000 — no CORS complications for the app itself.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || process.env.PORT || '3000', 10);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || process.env.API_PORT || '8000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const isHtml = filePath.endsWith('.html');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // HTML must revalidate (title/meta updates); hashed assets could be cached long.
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// /api reverse proxy → backend
// ---------------------------------------------------------------------------

function proxyApi(req, res) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  const upstream = http.request(
    {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: req.url,
      headers
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );

  upstream.setTimeout(180000); // transcript fetches can take a while
  upstream.on('timeout', () => {
    upstream.destroy(new Error('Backend timeout'));
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        code: 'BACKEND_UNREACHABLE',
        message: `The API backend on port ${BACKEND_PORT} is not running. Start it with start-app.bat (or: node server.js).`
      }
    }));
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    return proxyApi(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url);
  }
  res.writeHead(405, SECURITY_HEADERS);
  res.end('Method not allowed');
});

function start(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < FRONTEND_PORT + 10) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      start(port + 1);
    } else {
      console.error('Failed to start frontend server:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log('');
    console.log('  ▶ YT Transcript Video — frontend running');
    console.log(`  ▶ Open http://localhost:${port} in Chrome`);
    console.log(`  ▶ API proxied to ${BACKEND_HOST}:${BACKEND_PORT}`);
    console.log('');
  });
}

start(FRONTEND_PORT);
