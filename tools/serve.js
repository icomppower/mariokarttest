#!/usr/bin/env node
// Minimal static file server for local play and the Playwright smoke. Zero deps.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[3] || '.');
const port = parseInt(process.argv[2] || '4173', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.md': 'text/markdown', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let path = join(root, normalize(url === '/' ? '/index.html' : url));
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const st = statSync(path);
      if (st.isDirectory()) path = join(path, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + url);
    }
  })
  .listen(port, () => console.log(`dusk-circuit: http://localhost:${port}/  (root ${root})`));
