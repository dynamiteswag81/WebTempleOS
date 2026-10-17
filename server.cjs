// Serve WebTempleOS:  node server.cjs [port]   then open http://localhost:8090/
// Static files from the repo root, with the headers that make the page
// cross-origin isolated (SharedArrayBuffer, i.e. shared wasm memory).
// build/ must hold Kernel.BIN, layout.json and C.img (see HANDOFF.md).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = +(process.argv[2] || process.env.PORT || 8090);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm',
};
const allowed = ['web', 'runtime', 'compiler', 'build'];

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') { res.writeHead(302, { Location: '/web/' }); return res.end(); }
  if (p === '/web/') p = '/web/index.html';
  const file = path.normalize(path.join(root, p));
  const top = path.relative(root, file).split(path.sep)[0];
  const send = (code, body, type = 'text/plain') => {
    res.writeHead(code, {
      'Content-Type': type, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  };
  if (!file.startsWith(root) || !allowed.includes(top)) return send(404, 'not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(404, 'not found');
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(), 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => console.log(`WebTempleOS: http://localhost:${port}/`));
