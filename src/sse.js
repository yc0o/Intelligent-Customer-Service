'use strict';

/** 极简 SSE 推送中心：客服端按角色广播，访客端按访客广播 */

const clients = new Set();

function subscribe(res, meta) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  const client = { res, ...meta };
  clients.add(client);
  res.on('close', () => clients.delete(client));
  return client;
}

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function pushStaff(event, data) {
  for (const c of clients) if (c.kind === 'staff') send(c, event, data);
}

function pushVisitor(visitorId, event, data) {
  for (const c of clients) if (c.kind === 'visitor' && Number(c.visitorId) === Number(visitorId)) send(c, event, data);
}

function stats() {
  let staff = 0;
  let visitor = 0;
  for (const c of clients) {
    if (c.kind === 'staff') staff += 1;
    else visitor += 1;
  }
  return { staff, visitor };
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}, 25000).unref();

module.exports = { subscribe, pushStaff, pushVisitor, stats };
