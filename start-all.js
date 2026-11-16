'use strict';
/**
 * YT Transcript Video — process manager
 * Starts the API backend (port 8000) and the frontend server (port 3000)
 * together, streams their output, and shuts both down on Ctrl+C.
 *
 * Usage:  node start-all.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const runDir = path.join(__dirname, '.run');
const children = [];

/**
 * Port resolution.
 *
 * Locally: backend on API_PORT (8000), frontend on FRONTEND_PORT (3000).
 * On single-port hosts (Render injects PORT): the *frontend* takes the
 * externally exposed PORT, and the backend stays on an internal port the
 * host never sees. This matters because server.js and frontend.js both
 * honor PORT for standalone runs — without these explicit overrides the
 * backend would grab the host port and the frontend would drift to
 * port+1, leaving the UI unreachable (found via a Render simulation test).
 */
const HOST_PORT = parseInt(process.env.PORT || '', 10) || 0;
const apiPort = parseInt(process.env.API_PORT || '8000', 10);
const webPort = HOST_PORT || parseInt(process.env.FRONTEND_PORT || '3000', 10);

const backendEnv = { ...process.env, API_PORT: String(apiPort) };
delete backendEnv.PORT; // backend must never compete for the host port

const frontendEnv = {
  ...process.env,
  FRONTEND_PORT: String(webPort),
  BACKEND_HOST: process.env.BACKEND_HOST || '127.0.0.1',
  BACKEND_PORT: String(apiPort)
};

function start(name, file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('exit', (code) => {
    console.log(`[start-all] ${name} exited with code ${code}`);
  });
  children.push(child);
  // Record PIDs so stop-app.bat can stop exactly these processes.
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, `${name}.pid`), String(child.pid));
  } catch { /* best effort */ }
  return child;
}

function shutdown() {
  console.log('\n[start-all] Shutting down…');
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch { /* best effort */ }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
});

console.log(`[start-all] Starting YT Transcript Video (backend :${apiPort}, frontend :${webPort})…`);
start('backend', 'server.js', backendEnv);
start('frontend', 'frontend.js', frontendEnv);
