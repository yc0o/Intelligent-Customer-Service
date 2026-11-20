'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleApi, assignNext } = require('./src/api');
const { seedAll } = require('./src/seed');

seedAll();

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/agent': 'agent.html',
  '/admin': 'admin.html'
};

function serveStatic(req, res, pathname) {
  let rel = PAGES[pathname];
  if (!rel) {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
  }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[fatal]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: '服务器内部错误' } }));
      }
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

const BASE_PORT = Number(process.env.PORT) || 3000;

server.on('listening', () => {
  const port = server.address().port;
  console.log('');
  console.log('  溪谷优选 · 智能客服协同平台');
  console.log('  ─────────────────────────────────────────');
  console.log(`  访客端    http://localhost:${port}/`);
  console.log(`  员工登录  http://localhost:${port}/login`);
  console.log(`  客服工作台 http://localhost:${port}/agent`);
  console.log(`  管理后台  http://localhost:${port}/admin`);
  console.log('');
  console.log('  演示账号  admin / admin123   （管理员）');
  console.log('            agent1 / agent123  （林小满）');
  console.log('            agent2 / agent123  （周予）');
  console.log('            agent3 / agent123  （陈默）');
  console.log('');
});

function listen(port, attempt = 0) {
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      const next = port + 1;
      console.log(`端口 ${port} 已被占用，尝试 ${next} ...`);
      setTimeout(() => listen(next, attempt + 1), 120);
      return;
    }
    console.error('启动失败：', err.message);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port);
}

listen(BASE_PORT);

setInterval(() => {
  try {
    assignNext();
  } catch (err) {
    console.error('[assign]', err.message);
  }
}, 3000).unref();

process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
