#!/usr/bin/env node
'use strict';
/**
 * scripts/serve-e2e.cjs — the static server the emulator journeys expect on
 * http://localhost:8791 (tests/e2e/*.py), serving the repo root.
 *
 *   npm run serve:e2e     (with: npm run emulators, npm run seed:e2e, then a journey)
 *
 * Why not npx serve or python -m http.server (2026-11-10):
 *   - serve's clean-URL redirect (login.html?emulator=1 to /login) drops the
 *     query, so emulator mode is never armed and every sign-in fails;
 *   - http.server answers a POST with 501, so a sign-in form submitted a
 *     moment before its module attaches becomes an error page;
 *   - a no-store server makes the 50 kbps journey re-download every module and
 *     time out. This one revalidates (304) as a normal static host does.
 * Listens on 127.0.0.1 only.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const port = Number(process.argv[3] || 8791);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  let f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch {}
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const lm = st.mtime.toUTCString();
    // Revalidate like a normal static host: a 304 when unchanged (the 50 kbps journeys rely on it).
    if (req.headers['if-modified-since'] === lm) { res.writeHead(304, { 'Last-Modified': lm, 'Cache-Control': 'no-cache' }); return res.end(); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Last-Modified': lm, 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
}).listen(port, '127.0.0.1', () => console.log('static on', port));
