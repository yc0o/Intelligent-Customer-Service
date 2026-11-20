'use strict';

const crypto = require('node:crypto');
const { db, getSettings, setSetting, addEvent, nowIso, getSetting } = require('./db');
const { hash } = require('./seed');
const ai = require('./ai');
const { pushStaff, pushVisitor, subscribe, stats: sseStats } = require('./sse');
const { buildStats, dayKey, todayKey, lastDays } = require('./stats');

/* ------------------------------- 基础设施 ------------------------------- */

function apiError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(apiError(413, 'payload_too_large', '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(apiError(400, 'bad_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const routes = [];
function on(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, rx, keys, handler });
}

function tokenOf(req, url) {
  return req.headers['x-token'] || url.searchParams.get('token') || '';
}

function currentUser(req, url) {
  const token = tokenOf(req, url);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.role IN ('agent','admin')`
    )
    .get(token);
  return row || null;
}

function currentVisitor(req, url) {
  const token = tokenOf(req, url);
  if (!token) return null;
  return db.prepare('SELECT * FROM visitors WHERE token = ?').get(token) || null;
}

function requireStaff(ctx, roles = ['agent', 'admin']) {
  if (!ctx.user) throw apiError(401, 'unauthenticated', '请先登录');
  if (!roles.includes(ctx.user.role)) throw apiError(403, 'forbidden', '无权访问该资源');
  return ctx.user;
}

/* ------------------------------- 序列化 ------------------------------- */

function mapUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, color: u.color, title: u.title };
}

function mapVisitor(v) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    phone: v.phone,
    level: v.level,
    tags: v.tags ? v.tags.split(',').filter(Boolean) : [],
    source: v.source,
    device: v.device,
    city: v.city,
    remark: v.remark,
    visits: v.visits,
    createdAt: v.created_at,
    lastSeen: v.last_seen
  };
}

function mapMsg(m) {
  let meta = {};
  try {
    meta = JSON.parse(m.meta || '{}');
  } catch { /* ignore */ }
  return {
    id: m.id,
    from: m.from_type,
    fromId: m.from_id,
    content: m.content,
    confidence: m.confidence,
    kbId: m.kb_id,
    meta,
    at: m.created_at
  };
}

function mapConv(c, extra = {}) {
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    mode: c.mode,
    agentId: c.agent_id,
    agentName: c.agent_name || extra.agentName || null,
    agentColor: c.agent_color || extra.agentColor || null,
    visitorId: c.visitor_id,
    visitorName: c.visitor_name || extra.visitorName || null,
    visitorLevel: c.visitor_level || extra.visitorLevel || null,
    startedAt: c.started_at,
    queueAt: c.queue_at,
    assignedAt: c.assigned_at,
    closedAt: c.closed_at,
    lastMessageAt: c.last_message_at,
    lastMessage: c.last_message || extra.lastMessage || '',
    topic: c.topic,
    summary: c.summary,
    transferCount: c.transfer_count,
    satisfaction: c.satisfaction,
    satisfactionTags: c.satisfaction_tags,
    satisfactionComment: c.satisfaction_comment,
    ratedAt: c.rated_at,
    durationMin: c.closed_at ? Math.max(0, Math.round((new Date(c.closed_at) - new Date(c.started_at)) / 60000)) : null
  };
}

function getConvRow(id) {
  return db
    .prepare(
      `SELECT c.*, v.name AS visitor_name, v.level AS visitor_level,
              u.name AS agent_name, u.color AS agent_color
       FROM conversations c
       JOIN visitors v ON v.id = c.visitor_id
       LEFT JOIN users u ON u.id = c.agent_id
       WHERE c.id = ?`
    )
    .get(Number(id));
}

function insertMessage(convId, from, content, opts = {}) {
  const at = opts.at || nowIso();
  const info = db
    .prepare(
      `INSERT INTO messages(conversation_id, from_type, from_id, content, confidence, kb_id, meta, created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(
      convId,
      from,
      opts.fromId || null,
      content,
      opts.confidence == null ? null : opts.confidence,
      opts.kbId == null ? null : opts.kbId,
      JSON.stringify(opts.meta || {}),
      at
    );
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, convId);
  return mapMsg({
    id: Number(info.lastInsertRowid),
    from_type: from,
    from_id: opts.fromId || null,
    content,
    confidence: opts.confidence,
    kb_id: opts.kbId,
    meta: JSON.stringify(opts.meta || {}),
    created_at: at
  });
}

function convMessages(convId) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(convId).map(mapMsg);
}

/* ------------------------------- 排队与分配 ------------------------------- */

function onlineAgents() {
  return db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'active') AS load
       FROM users u WHERE u.role = 'agent' AND u.status = 'online'`
    )
    .all();
}

function queuePosition(conv) {
  const rows = db
    .prepare("SELECT id FROM conversations WHERE status = 'waiting' AND queue_at <= ? ORDER BY queue_at, id")
    .all(conv.queue_at || conv.started_at);
  const idx = rows.findIndex((r) => r.id === conv.id);
  return idx >= 0 ? idx + 1 : rows.length + 1;
}

function pickAgent(settings) {
  const max = Number(settings.max_concurrent) || 4;
  const candidates = onlineAgents().filter((a) => Number(a.load) < max);
  candidates.sort((a, b) => Number(a.load) - Number(b.load) || a.id - b.id);
  return candidates[0] || null;
}

function assignConversation(convId, agent, by = 'auto') {
  const conv = getConvRow(convId);
  if (!conv) return null;
  db.prepare(
    `UPDATE conversations
     SET status = 'active', mode = 'human', agent_id = ?, assigned_at = ?, queue_at = NULL
     WHERE id = ?`
  ).run(agent.id, nowIso(), convId);
  addEvent(convId, 'assign', by === 'auto' ? 'system' : `agent:${agent.id}`, agent.name);
  insertMessage(convId, 'system', `客服 ${agent.name} 已接入会话`, { meta: { type: 'assign', agentId: agent.id } });
  pushVisitor(conv.visitor_id, 'refresh', { convId });
  pushStaff('refresh', { scope: 'queue', convId });
  return agent;
}

function assignNext() {
  const settings = getSettings();
  if (!settings.auto_assign) return 0;
  let count = 0;
  const waiting = db.prepare("SELECT * FROM conversations WHERE status = 'waiting' ORDER BY queue_at, id").all();
  for (const conv of waiting) {
    const agent = pickAgent(settings);
    if (!agent) break;
    assignConversation(conv.id, agent, 'auto');
    count += 1;
  }
  return count;
}

function buildSummary(conv, visitor) {
  const ctx = JSON.parse(conv.context_json || '{}');
  const visitorMsgs = db
    .prepare("SELECT content FROM messages WHERE conversation_id = ? AND from_type = 'visitor' ORDER BY id DESC LIMIT 4")
    .all(conv.id)
    .map((m) => m.content)
    .reverse();
  const rounds = db
    .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND from_type = 'bot'")
    .get(conv.id).n;
  const lines = [
    `${visitor.name}（${visitor.level}）咨询「${ctx.topic || conv.topic || '综合问题'}」`,
    `机器人已应答 ${rounds} 轮${ctx.orderNo ? `，已获取订单号 ${ctx.orderNo}` : ''}`,
    `诉求摘要：${visitorMsgs.join(' / ').slice(0, 180) || '—'}`
  ];
  return lines.join('\n');
}

function enterQueue(convId, reason) {
  const conv = getConvRow(convId);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.status !== 'waiting') {
    const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(conv.visitor_id);
    db.prepare(
      `UPDATE conversations
       SET status = 'waiting', mode = 'queue', agent_id = NULL, queue_at = ?,
           summary = ?, transfer_count = transfer_count + 1, low_streak = 0
       WHERE id = ?`
    ).run(nowIso(), buildSummary(conv, visitor), convId);
    addEvent(convId, 'transfer_human', 'bot', reason || '转人工');
    insertMessage(convId, 'system', '正在为你转接人工客服…', { meta: { type: 'queue' } });
    if (conv.agent_id) pushStaff('refresh', { scope: 'queue', convId });
  }

  assignNext();

  const after = getConvRow(convId);
  if (after.status === 'waiting') {
    const position = queuePosition(after);
    const online = onlineAgents().length;
    const notice = online
      ? `已为你排入人工队列，前面还有 ${Math.max(position - 1, 0)} 位，请稍候。`
      : getSetting('queue_notice', '当前人工客服不在线，已记录你的需求，客服上线后立即接入。');
    insertMessage(convId, 'system', notice, { meta: { type: 'queue', position } });
    pushVisitor(after.visitor_id, 'refresh', { convId });
    pushStaff('refresh', { scope: 'queue', convId });
  }
  return getConvRow(convId);
}

/* ------------------------------- 机器人应答 ------------------------------- */

function botReply(conv, visitor, text) {
  const settings = getSettings();
  let ctx = {};
  try {
    ctx = JSON.parse(conv.context_json || '{}');
  } catch { /* ignore */ }
  const result = ai.analyze(text, ctx);
  const out = [];

  if (result.orderNo) ctx.orderNo = result.orderNo;

  const saveCtx = (patch = {}) => {
    ctx = { ...ctx, ...patch, lastQuery: text };
    db.prepare('UPDATE conversations SET context_json = ?, ai_rounds = ai_rounds + 1 WHERE id = ?').run(
      JSON.stringify(ctx),
      conv.id
    );
  };

  const reply = (content, opts = {}) => {
    const msg = insertMessage(conv.id, 'bot', content, {
      confidence: opts.confidence,
      kbId: opts.kbId,
      meta: { question: text, ...(opts.meta || {}) }
    });
    out.push(msg);
    return msg;
  };

  // 1. 明确要求人工
  if (result.intent.human) {
    reply('好的，正在为你转接人工客服。', { meta: { intent: 'human' } });
    saveCtx();
    return { messages: out, action: 'queue', reason: '用户主动要求转人工' };
  }

  // 2. 问候 / 致谢
  if (result.intent.greeting) {
    reply('你好，我在的。直接把问题发给我就行，比如“退款多久到账”“能开发票吗”；需要真人同事也可以说“转人工”。', {
      confidence: 1,
      meta: { intent: 'greeting' }
    });
    db.prepare('UPDATE conversations SET low_streak = 0 WHERE id = ?').run(conv.id);
    return { messages: out, action: 'none' };
  }
  if (result.intent.thanks) {
    reply('不客气，还有其他问题随时找我。', { confidence: 1, meta: { intent: 'thanks' } });
    db.prepare('UPDATE conversations SET low_streak = 0 WHERE id = ?').run(conv.id);
    return { messages: out, action: 'none' };
  }

  // 3. 只发了订单号
  if (result.orderNo && text.trim().length <= result.orderNo.length + 6) {
    reply(`已记录你的订单号 ${result.orderNo}。需要我帮你查物流、退款进度，还是修改地址？`, {
      confidence: 0.9,
      meta: { orderNo: result.orderNo }
    });
    saveCtx({ topic: ctx.topic || '订单查询' });
    db.prepare('UPDATE conversations SET low_streak = 0 WHERE id = ?').run(conv.id);
    return { messages: out, action: 'none' };
  }

  // 4. 负面情绪 + 低置信度 -> 直接转人工
  const confident = result.best && result.confidence >= settings.confidence_threshold;
  if (result.intent.negative && (!confident || result.confidence < 0.6)) {
    reply('抱歉给你带来不好的体验，我先为你转接人工客服优先处理。', {
      confidence: result.confidence,
      kbId: result.best ? result.best.id : null,
      meta: { low: true, negative: true }
    });
    saveCtx();
    return { messages: out, action: 'queue', reason: '负面情绪且置信度不足' };
  }

  // 5. 命中知识库
  if (confident) {
    db.prepare('UPDATE knowledge SET hits = hits + 1 WHERE id = ?').run(result.best.id);
    let content = result.best.answer;
    if (ctx.orderNo && /订单|物流|退款/.test(result.best.category + result.best.question)) {
      content += `\n（已记录你的订单号 ${ctx.orderNo}，可据此为你核对具体进度）`;
    }
    reply(content, {
      confidence: result.confidence,
      kbId: result.best.id,
      meta: {
        label: result.best.question,
        category: result.best.category,
        suggestions: result.suggestions,
        viaContext: result.viaContext,
        orderNo: ctx.orderNo || ''
      }
    });
    saveCtx({ topic: result.best.question, kbId: result.best.id, category: result.best.category });
    db.prepare('UPDATE conversations SET low_streak = 0, topic = ? WHERE id = ?').run(result.best.question, conv.id);
    return { messages: out, action: 'none' };
  }

  // 6. 低置信度：先澄清，连续两次转人工
  const streak = Number(conv.low_streak || 0) + 1;
  db.prepare('UPDATE conversations SET low_streak = ? WHERE id = ?').run(streak, conv.id);
  saveCtx();

  if (streak >= 2) {
    reply('我连续两次没能准确理解你的问题，已为你转接人工客服，请稍候。', {
      confidence: result.confidence,
      meta: { low: true, escalated: true }
    });
    return { messages: out, action: 'queue', reason: '连续低置信度' };
  }

  const hint = result.suggestions.length
    ? `抱歉，我还没完全理解你的问题。你是想问下面哪一种？\n${result.suggestions.map((s, i) => `${i + 1}. ${s.question}`).join('\n')}\n如果都不是，可以点击下方「转人工」。`
    : '抱歉，这个问题我暂时没有找到答案。你可以换个说法，或点击下方「转人工」由人工客服处理。';
  reply(hint, {
    confidence: result.confidence,
    meta: { low: true, suggestions: result.suggestions, canHuman: true }
  });
  return { messages: out, action: 'none' };
}

/* ------------------------------- 访客接口 ------------------------------- */

function deviceOf(ua = '') {
  const s = String(ua);
  const os = /iPhone/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Macintosh/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : '未知设备';
  const browser = /MicroMessenger/.test(s) ? '微信' : /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '浏览器';
  return `${os} · ${browser}`;
}

function newConversation(visitor, settings) {
  const info = db
    .prepare(
      `INSERT INTO conversations(visitor_id, status, mode, started_at, last_message_at, topic, context_json)
       VALUES(?, 'active', 'bot', ?, ?, '', '{}')`
    )
    .run(visitor.id, nowIso(), nowIso());
  const convId = Number(info.lastInsertRowid);
  insertMessage(convId, 'bot', settings.welcome, { confidence: 1, meta: { type: 'welcome' } });
  addEvent(convId, 'start', 'visitor', '访客发起会话');
  db.prepare('UPDATE visitors SET last_seen = ?, visits = visits + 1 WHERE id = ?').run(nowIso(), visitor.id);
  return convId;
}

function activeConversation(visitorId) {
  return db
    .prepare("SELECT * FROM conversations WHERE visitor_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1")
    .get(visitorId);
}

function visitorState(visitor) {
  const settings = getSettings();
  const conv = activeConversation(visitor.id);
  const lastConv = conv || db
    .prepare('SELECT * FROM conversations WHERE visitor_id = ? ORDER BY id DESC LIMIT 1')
    .get(visitor.id);
  const convId = lastConv ? lastConv.id : null;
  const messages = convId ? convMessages(convId) : [];
  const agent = lastConv && lastConv.agent_id
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(lastConv.agent_id)
    : null;

  let queue = null;
  if (lastConv && lastConv.status === 'waiting') {
    const pos = queuePosition(lastConv);
    queue = { position: pos, ahead: Math.max(pos - 1, 0), onlineAgents: onlineAgents().length };
  }

  const quick = ['退款怎么申请', '退款多久到账', '物流到哪了', '能开发票吗', '修改收货地址'];

  return {
    visitor: mapVisitor(visitor),
    conversation: lastConv ? mapConv(getConvRow(lastConv.id)) : null,
    agent: agent ? { name: agent.name, color: agent.color, title: agent.title } : null,
    messages,
    queue,
    quickQuestions: quick,
    needRating: Boolean(lastConv && lastConv.status === 'closed' && !lastConv.satisfaction),
    settings: {
      brand: settings.brand_name,
      welcome: settings.welcome,
      workHours: settings.work_hours,
      ratingPrompt: settings.rating_prompt
    }
  };
}

on('POST', '/auth/login', async (ctx) => {
  const { username, password } = ctx.body || {};
  if (!username || !password) throw apiError(400, 'invalid_input', '请输入账号和密码');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || user.password !== hash(String(password))) {
    throw apiError(401, 'bad_credentials', '账号或密码不正确');
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, role, created_at) VALUES(?,?,?,?)').run(
    token,
    user.id,
    user.role,
    nowIso()
  );
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
  if (user.role === 'agent') assignNext();
  pushStaff('refresh', { scope: 'queue' });
  return { token, user: mapUser({ ...user, status: 'online' }) };
});

on('POST', '/auth/logout', async (ctx) => {
  const token = tokenOf(ctx.req, ctx.url);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  if (ctx.user) {
    db.prepare("UPDATE users SET status = 'offline' WHERE id = ?").run(ctx.user.id);
    pushStaff('refresh', {});
  }
  return { ok: true };
});

on('GET', '/auth/me', async (ctx) => {
  const user = requireStaff(ctx);
  const today = todayKey();
  const handled = db
    .prepare("SELECT COUNT(*) n FROM conversations WHERE agent_id = ? AND status = 'closed'")
    .get(user.id).n;
  const active = db
    .prepare("SELECT COUNT(*) n FROM conversations WHERE agent_id = ? AND status = 'active'")
    .get(user.id).n;
  const rated = db
    .prepare('SELECT AVG(satisfaction) v, COUNT(*) n FROM conversations WHERE agent_id = ? AND satisfaction IS NOT NULL')
    .get(user.id);
  return {
    user: mapUser(user),
    stats: {
      handled,
      active,
      avgCsat: rated.v ? Number(Number(rated.v).toFixed(2)) : 0,
      ratingCount: rated.n,
      today: today
    }
  };
});

on('GET', '/meta', async () => {
  const s = getSettings();
  return {
    brand: s.brand_name,
    workHours: s.work_hours,
    confidenceThreshold: s.confidence_threshold,
    welcome: s.welcome
  };
});

on('GET', '/health', async () => ({
  ok: true,
  time: nowIso(),
  db: 'sqlite',
  sse: sseStats()
}));

/* 访客 */

on('POST', '/visitor/session', async (ctx) => {
  const settings = getSettings();
  const ua = ctx.req.headers['user-agent'] || '';
  const name = (ctx.body && ctx.body.name ? String(ctx.body.name) : '').slice(0, 20) || `访客${Math.floor(1000 + Math.random() * 9000)}`;
  const token = `v_${crypto.randomBytes(12).toString('hex')}`;
  const t = nowIso();
  const info = db
    .prepare(
      `INSERT INTO visitors(token, name, phone, level, tags, source, device, city, remark, visits, created_at, last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(token, name, '', '普通会员', '', ctx.body && ctx.body.source ? String(ctx.body.source) : '官网聊天入口', deviceOf(ua), '—', '', 1, t, t);
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(Number(info.lastInsertRowid));
  newConversation(visitor, settings);
  return { token, ...visitorState(visitor) };
});

on('GET', '/visitor/state', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  db.prepare('UPDATE visitors SET last_seen = ? WHERE id = ?').run(nowIso(), visitor.id);
  return visitorState(visitor);
});

on('POST', '/visitor/message', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  const text = String((ctx.body && ctx.body.content) || '').trim().slice(0, 1000);
  if (!text) throw apiError(400, 'empty_message', '请输入内容');

  let conv = activeConversation(visitor.id);
  if (!conv) {
    newConversation(visitor, getSettings());
    conv = activeConversation(visitor.id);
  }
  const msg = insertMessage(conv.id, 'visitor', text);
  const out = [msg];

  if (conv.mode === 'human' && conv.agent_id) {
    pushStaff('refresh', { scope: 'message', convId: conv.id });
    pushVisitor(visitor.id, 'refresh', { convId: conv.id });
    return { messages: out, action: 'agent' };
  }
  if (conv.status === 'waiting') {
    pushStaff('refresh', { scope: 'queue', convId: conv.id });
    pushVisitor(visitor.id, 'refresh', { convId: conv.id });
    return { messages: out, action: 'queue' };
  }

  const result = botReply(conv, visitor, text);
  out.push(...result.messages);
  if (result.action === 'queue') {
    const updated = enterQueue(conv.id, result.reason);
    if (updated.status === 'active') {
      const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv.id);
      out.push(mapMsg(last));
    } else {
      const tail = db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND from_type = 'system' ORDER BY id DESC LIMIT 2")
        .all(conv.id)
        .reverse()
        .map(mapMsg);
      out.push(...tail);
    }
  } else {
    pushStaff('refresh', { scope: 'message', convId: conv.id });
  }
  pushVisitor(visitor.id, 'refresh', { convId: conv.id });
  return { messages: out, action: result.action, conversation: mapConv(getConvRow(conv.id)) };
});

on('POST', '/visitor/request-human', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  let conv = activeConversation(visitor.id);
  if (!conv) {
    newConversation(visitor, getSettings());
    conv = activeConversation(visitor.id);
  }
  if (conv.status === 'waiting' || (conv.status === 'active' && conv.mode === 'human')) {
    return visitorState(visitor);
  }
  insertMessage(conv.id, 'system', '你选择了转人工', { meta: { type: 'intent_human' } });
  enterQueue(conv.id, '访客点击转人工');
  return visitorState(visitor);
});

on('POST', '/visitor/close', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  const conv = activeConversation(visitor.id);
  if (!conv) return visitorState(visitor);
  const settings = getSettings();
  db.prepare("UPDATE conversations SET status = 'closed', closed_at = ?, closed_by = 'visitor' WHERE id = ?").run(
    nowIso(),
    conv.id
  );
  addEvent(conv.id, 'close', 'visitor', '访客结束会话');
  insertMessage(conv.id, 'system', '本次会话已结束，感谢你的咨询。', { meta: { type: 'rating' } });
  pushStaff('refresh', { convId: conv.id });
  pushVisitor(visitor.id, 'refresh', { convId: conv.id });
  return visitorState(visitor);
});

on('POST', '/visitor/rate', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  const score = Number(ctx.body && ctx.body.score);
  if (!(score >= 1 && score <= 5)) throw apiError(400, 'invalid_score', '评分需在 1-5 之间');
  const last = db.prepare('SELECT * FROM conversations WHERE visitor_id = ? ORDER BY id DESC LIMIT 1').get(visitor.id);
  if (!last) throw apiError(404, 'not_found', '没有可评价的会话');
  if (last.satisfaction) return { ok: true, duplicated: true };
  const tags = Array.isArray(ctx.body.tags) ? ctx.body.tags.join(',') : String(ctx.body.tags || '');
  const comment = String(ctx.body.comment || '').slice(0, 300);
  db.prepare(
    `UPDATE conversations SET satisfaction = ?, satisfaction_tags = ?, satisfaction_comment = ?, rated_at = ?
     WHERE id = ?`
  ).run(score, tags, comment, nowIso(), last.id);
  addEvent(last.id, 'rating', 'visitor', `${score} 星 ${tags}`.trim());
  insertMessage(last.id, 'system', `感谢你的评价（${'★'.repeat(score)}），我们会继续改进。`, { meta: { type: 'rated' } });
  pushStaff('refresh', { convId: last.id });
  pushVisitor(visitor.id, 'refresh', { convId: last.id });
  return visitorState(visitor);
});

on('POST', '/visitor/new', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) throw apiError(401, 'unauthenticated', '访客身份已失效');
  const active = activeConversation(visitor.id);
  if (!active) newConversation(visitor, getSettings());
  return visitorState(visitor);
});

on('POST', '/visitor/typing', async (ctx) => {
  const visitor = currentVisitor(ctx.req, ctx.url);
  if (!visitor) return { ok: true };
  const conv = activeConversation(visitor.id);
  if (conv) pushStaff('typing', { convId: conv.id, from: 'visitor', name: visitor.name });
  return { ok: true };
});

/* 客服 */

on('GET', '/agent/overview', async (ctx) => {
  const user = requireStaff(ctx, ['agent']);
  const settings = getSettings();
  const queue = db
    .prepare(
      `SELECT c.*, v.name AS visitor_name, v.level AS visitor_level,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM conversations c JOIN visitors v ON v.id = c.visitor_id
       WHERE c.status = 'waiting' ORDER BY c.queue_at, c.id`
    )
    .all()
    .map((c) => ({ ...mapConv(c), waitedSec: Math.round((Date.now() - new Date(c.queue_at || c.started_at)) / 1000) }));

  const mine = db
    .prepare(
      `SELECT c.*, v.name AS visitor_name, v.level AS visitor_level,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM conversations c JOIN visitors v ON v.id = c.visitor_id
       WHERE c.agent_id = ? AND c.status = 'active' ORDER BY c.last_message_at DESC`
    )
    .all(user.id)
    .map((c) => mapConv(c, { agentName: user.name, agentColor: user.color }));

  const today = todayKey();
  const todayHandled = db
    .prepare("SELECT COUNT(*) n FROM conversations WHERE agent_id = ? AND closed_at IS NOT NULL")
    .get(user.id).n;

  return {
    me: mapUser(user),
    queue,
    mine,
    counts: {
      queue: queue.length,
      mine: mine.length,
      onlineAgents: onlineAgents().length,
      maxConcurrent: settings.max_concurrent
    },
    load: mine.length,
    todayHandled
  };
});

on('GET', '/agent/conversations', async (ctx) => {
  const user = requireStaff(ctx);
  const scope = ctx.url.searchParams.get('scope') || 'mine';
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const params = [];
  let where = '1=1';
  if (user.role === 'agent') {
    if (scope === 'queue') where += " AND c.status = 'waiting'";
    else where += ` AND c.agent_id = ${Number(user.id)} AND c.status = 'active'`;
  } else if (scope === 'queue') where += " AND c.status = 'waiting'";
  if (q) {
    where += ` AND (v.name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))`;
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT c.*, v.name AS visitor_name, v.level AS visitor_level,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM conversations c JOIN visitors v ON v.id = c.visitor_id
       WHERE ${where} ORDER BY c.last_message_at DESC LIMIT 50`
    )
    .all(...params);
  return rows.map(mapConv);
});

on('GET', '/agent/conversation/:id', async (ctx) => {
  const user = requireStaff(ctx);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (user.role === 'agent' && conv.agent_id !== user.id && conv.status !== 'waiting') {
    throw apiError(403, 'forbidden', '该会话不属于你');
  }
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(conv.visitor_id);
  const historyCount = db
    .prepare('SELECT COUNT(*) n FROM conversations WHERE visitor_id = ?')
    .get(visitor.id).n;
  const historyCsat = db
    .prepare('SELECT AVG(satisfaction) v FROM conversations WHERE visitor_id = ? AND satisfaction IS NOT NULL')
    .get(visitor.id);
  const msgs = convMessages(conv.id);
  const lastVisitor = [...msgs].reverse().find((m) => m.from === 'visitor');
  const assist = lastVisitor ? ai.searchKnowledge(lastVisitor.content, 3) : [];
  const events = db
    .prepare('SELECT * FROM events WHERE conversation_id = ? ORDER BY id')
    .all(conv.id)
    .map((e) => ({ id: e.id, type: e.type, actor: e.actor, detail: e.detail, at: e.created_at }));

  return {
    conversation: mapConv(conv),
    visitor: {
      ...mapVisitor(visitor),
      historyCount,
      historyCsat: historyCsat.v ? Number(Number(historyCsat.v).toFixed(1)) : 0
    },
    messages: msgs,
    events,
    assist,
    agents: db
      .prepare(
        `SELECT u.id, u.name, u.color, u.status, u.title,
           (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'active') AS load
         FROM users u WHERE u.role = 'agent' ORDER BY (u.status = 'online') DESC, u.id`
      )
      .all()
      .map((a) => ({ id: a.id, name: a.name, color: a.color, status: a.status, title: a.title, load: Number(a.load) }))
  };
});

on('POST', '/agent/conversation/:id/claim', async (ctx) => {
  const user = requireStaff(ctx, ['agent']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.agent_id === user.id) return { conversation: mapConv(conv) };
  if (conv.status === 'active' && conv.agent_id) throw apiError(409, 'taken', '该会话已被其他客服接入');
  assignConversation(conv.id, user, 'manual');
  return { conversation: mapConv(getConvRow(conv.id)) };
});

on('POST', '/agent/conversation/:id/message', async (ctx) => {
  const user = requireStaff(ctx, ['agent']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.agent_id !== user.id) throw apiError(403, 'forbidden', '请先接入该会话');
  if (conv.status !== 'active') throw apiError(409, 'not_active', '会话已结束');
  const content = String((ctx.body && ctx.body.content) || '').trim().slice(0, 1000);
  if (!content) throw apiError(400, 'empty_message', '请输入内容');
  const msg = insertMessage(conv.id, 'agent', content, { fromId: user.id });
  pushVisitor(conv.visitor_id, 'refresh', { convId: conv.id });
  pushStaff('refresh', { scope: 'message', convId: conv.id });
  return { message: msg };
});

on('POST', '/agent/conversation/:id/transfer', async (ctx) => {
  const user = requireStaff(ctx, ['agent']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.agent_id !== user.id) throw apiError(403, 'forbidden', '只能转接自己的会话');
  const toId = Number(ctx.body && ctx.body.toAgentId);
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(toId);
  if (!target) throw apiError(400, 'invalid_agent', '目标客服不存在');
  if (target.id === user.id) throw apiError(400, 'same_agent', '不能转接给自己');
  const reason = String((ctx.body && ctx.body.reason) || '').slice(0, 100);

  db.prepare(
    `UPDATE conversations SET agent_id = ?, assigned_at = ?, transfer_count = transfer_count + 1 WHERE id = ?`
  ).run(target.id, nowIso(), conv.id);
  addEvent(conv.id, 'transfer_agent', `agent:${user.id}`, `转接给 ${target.name}${reason ? `：${reason}` : ''}`);
  insertMessage(conv.id, 'system', `已为你转接至客服 ${target.name}${reason ? `（${reason}）` : ''}`, {
    meta: { type: 'transfer_agent', to: target.name }
  });
  pushVisitor(conv.visitor_id, 'refresh', { convId: conv.id });
  pushStaff('refresh', { convId: conv.id });
  return { ok: true, agent: { id: target.id, name: target.name } };
});

on('POST', '/agent/conversation/:id/close', async (ctx) => {
  const user = requireStaff(ctx, ['agent']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.agent_id !== user.id) throw apiError(403, 'forbidden', '只能结束自己的会话');
  const settings = getSettings();
  db.prepare(
    `UPDATE conversations SET status = 'closed', closed_at = ?, closed_by = 'agent', summary = ? WHERE id = ?`
  ).run(nowIso(), conv.summary || '', conv.id);
  addEvent(conv.id, 'close', `agent:${user.id}`, '客服结束会话');
  insertMessage(conv.id, 'system', '本次会话已结束，感谢你的咨询。', { meta: { type: 'rating' } });
  pushVisitor(conv.visitor_id, 'refresh', { convId: conv.id });
  pushStaff('refresh', { convId: conv.id });
  return { ok: true };
});

on('POST', '/agent/status', async (ctx) => {
  const user = requireStaff(ctx, ['agent', 'admin']);
  const status = String((ctx.body && ctx.body.status) || '');
  if (!['online', 'busy', 'offline'].includes(status)) throw apiError(400, 'invalid_status', '状态不合法');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
  if (status === 'online') assignNext();
  pushStaff('refresh', {});
  return { status };
});

on('GET', '/agent/kb', async (ctx) => {
  requireStaff(ctx);
  const q = (ctx.url.searchParams.get('q') || '').trim();
  if (!q) {
    return db
      .prepare('SELECT id, question, answer, category, hits FROM knowledge WHERE enabled = 1 ORDER BY hits DESC LIMIT 12')
      .all();
  }
  return ai.searchKnowledge(q, 8);
});

on('GET', '/agent/quick-replies', async (ctx) => {
  requireStaff(ctx);
  return db.prepare('SELECT * FROM quick_replies ORDER BY id').all().map((q) => ({
    id: q.id,
    title: q.title,
    content: q.content,
    category: q.category
  }));
});

on('GET', '/agent/visitor/:id', async (ctx) => {
  const user = requireStaff(ctx);
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(Number(ctx.params.id));
  if (!visitor) throw apiError(404, 'not_found', '客户不存在');
  const convs = db
    .prepare('SELECT * FROM conversations WHERE visitor_id = ? ORDER BY id DESC LIMIT 10')
    .all(visitor.id)
    .map((c) => mapConv(c));
  if (user.role === 'agent') {
    const allowed = convs.some((c) => c.agentId === user.id || c.status === 'waiting');
    if (!allowed) throw apiError(403, 'forbidden', '无权查看该客户');
  }
  return { visitor: mapVisitor(visitor), conversations: convs };
});

/* 管理员 */

on('GET', '/admin/stats', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const days = Math.min(Math.max(Number(ctx.url.searchParams.get('days')) || 7, 1), 30);
  const data = buildStats(days);
  data.coverage = sseStats();
  return data;
});

on('GET', '/admin/conversations', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const p = ctx.url.searchParams;
  const where = ['1=1'];
  const params = [];
  const status = p.get('status');
  if (status && status !== 'all') {
    where.push('c.status = ?');
    params.push(status);
  }
  const agentId = p.get('agentId');
  if (agentId && agentId !== 'all') {
    if (agentId === 'bot') where.push('c.agent_id IS NULL');
    else {
      where.push('c.agent_id = ?');
      params.push(Number(agentId));
    }
  }
  const csat = p.get('csat');
  if (csat === 'rated') where.push('c.satisfaction IS NOT NULL');
  if (csat === 'unrated') where.push('c.satisfaction IS NULL');
  if (csat === 'low') where.push('c.satisfaction <= 3');
  const from = p.get('from');
  const to = p.get('to');
  if (from) {
    where.push('c.started_at >= ?');
    params.push(new Date(`${from}T00:00:00+08:00`).toISOString());
  }
  if (to) {
    where.push('c.started_at <= ?');
    params.push(new Date(`${to}T23:59:59+08:00`).toISOString());
  }
  const q = (p.get('q') || '').trim();
  if (q) {
    where.push('(v.name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))');
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT c.*, v.name AS visitor_name, v.level AS visitor_level, u.name AS agent_name, u.color AS agent_color
       FROM conversations c JOIN visitors v ON v.id = c.visitor_id LEFT JOIN users u ON u.id = c.agent_id
       WHERE ${where.join(' AND ')} ORDER BY c.started_at DESC LIMIT 200`
    )
    .all(...params);
  return { total: rows.length, items: rows.map((c) => mapConv(c)) };
});

on('GET', '/admin/conversation/:id', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(conv.visitor_id);
  const events = db
    .prepare('SELECT * FROM events WHERE conversation_id = ? ORDER BY id')
    .all(conv.id)
    .map((e) => ({ id: e.id, type: e.type, actor: e.actor, detail: e.detail, at: e.created_at }));
  const historyCount = db
    .prepare('SELECT COUNT(*) n FROM conversations WHERE visitor_id = ?')
    .get(visitor.id).n;
  return {
    conversation: mapConv(conv),
    visitor: { ...mapVisitor(visitor), historyCount },
    messages: convMessages(conv.id),
    events
  };
});

on('POST', '/admin/conversation/:id/close', async (ctx) => {
  const user = requireStaff(ctx, ['admin']);
  const conv = getConvRow(ctx.params.id);
  if (!conv) throw apiError(404, 'not_found', '会话不存在');
  if (conv.status === 'closed') return { ok: true };
  db.prepare("UPDATE conversations SET status = 'closed', closed_at = ?, closed_by = 'admin' WHERE id = ?").run(
    nowIso(),
    conv.id
  );
  addEvent(conv.id, 'close', `admin:${user.id}`, '管理员强制结束');
  insertMessage(conv.id, 'system', '会话已被管理员结束', { meta: { type: 'closed_admin' } });
  pushVisitor(conv.visitor_id, 'refresh', { convId: conv.id });
  pushStaff('refresh', { convId: conv.id });
  return { ok: true };
});

on('GET', '/admin/kb', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM knowledge WHERE question LIKE ? OR keywords LIKE ? ORDER BY id').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM knowledge ORDER BY id').all();
  return rows.map((k) => ({
    id: k.id,
    question: k.question,
    answer: k.answer,
    variants: k.variants,
    keywords: k.keywords,
    category: k.category,
    hits: k.hits,
    enabled: Boolean(k.enabled),
    updatedAt: k.updated_at
  }));
});

on('POST', '/admin/kb', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const b = ctx.body || {};
  if (!b.question || !b.answer) throw apiError(400, 'invalid_input', '问题和答案不能为空');
  const t = nowIso();
  const info = db
    .prepare(
      `INSERT INTO knowledge(question, answer, variants, keywords, category, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?)`
    )
    .run(String(b.question).trim(), String(b.answer).trim(), String(b.variants || ''), String(b.keywords || ''), String(b.category || '通用'), t, t);
  pushStaff('refresh', { scope: 'kb' });
  return { id: Number(info.lastInsertRowid) };
});

on('PUT', '/admin/kb/:id', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const id = Number(ctx.params.id);
  const cur = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
  if (!cur) throw apiError(404, 'not_found', '知识条目不存在');
  const b = ctx.body || {};
  db.prepare(
    `UPDATE knowledge SET question = ?, answer = ?, variants = ?, keywords = ?, category = ?, enabled = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    b.question != null ? String(b.question) : cur.question,
    b.answer != null ? String(b.answer) : cur.answer,
    b.variants != null ? String(b.variants) : cur.variants,
    b.keywords != null ? String(b.keywords) : cur.keywords,
    b.category != null ? String(b.category) : cur.category,
    b.enabled == null ? cur.enabled : b.enabled ? 1 : 0,
    nowIso(),
    id
  );
  pushStaff('refresh', { scope: 'kb' });
  return { ok: true };
});

on('DELETE', '/admin/kb/:id', async (ctx) => {
  requireStaff(ctx, ['admin']);
  db.prepare('DELETE FROM knowledge WHERE id = ?').run(Number(ctx.params.id));
  pushStaff('refresh', { scope: 'kb' });
  return { ok: true };
});

on('GET', '/admin/agents', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const rows = db
    .prepare(
      `SELECT u.*,
        (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'active') AS load,
        (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'closed') AS handled,
        (SELECT AVG(satisfaction) FROM conversations c WHERE c.agent_id = u.id AND c.satisfaction IS NOT NULL) AS csat
       FROM users u ORDER BY u.role DESC, u.id`
    )
    .all();
  return rows.map((u) => ({
    ...mapUser(u),
    load: Number(u.load),
    handled: Number(u.handled),
    avgCsat: u.csat ? Number(Number(u.csat).toFixed(2)) : 0
  }));
});

on('POST', '/admin/agents', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const b = ctx.body || {};
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim();
  const password = String(b.password || '').trim();
  if (!username || !name || password.length < 6) throw apiError(400, 'invalid_input', '账号、姓名必填，密码至少 6 位');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw apiError(409, 'duplicated', '账号已存在');
  }
  const info = db
    .prepare(
      `INSERT INTO users(username, name, role, password, status, color, title, created_at)
       VALUES(?,?, 'agent', ?, 'offline', ?, ?, ?)`
    )
    .run(username, name, hash(password), b.color || '#f2612c', String(b.title || '客服'), nowIso());
  pushStaff('refresh', {});
  return { id: Number(info.lastInsertRowid) };
});

on('PUT', '/admin/agents/:id', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const id = Number(ctx.params.id);
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!cur) throw apiError(404, 'not_found', '账号不存在');
  const b = ctx.body || {};
  db.prepare('UPDATE users SET name = ?, title = ?, status = ? WHERE id = ?').run(
    b.name != null ? String(b.name) : cur.name,
    b.title != null ? String(b.title) : cur.title,
    b.status != null ? String(b.status) : cur.status,
    id
  );
  pushStaff('refresh', {});
  return { ok: true };
});

on('GET', '/admin/quick-replies', async (ctx) => {
  requireStaff(ctx, ['admin', 'agent']);
  return db.prepare('SELECT * FROM quick_replies ORDER BY id').all();
});

on('POST', '/admin/quick-replies', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const b = ctx.body || {};
  if (!b.title || !b.content) throw apiError(400, 'invalid_input', '标题和内容不能为空');
  const info = db
    .prepare('INSERT INTO quick_replies(title, content, category) VALUES(?,?,?)')
    .run(String(b.title), String(b.content), String(b.category || '通用'));
  return { id: Number(info.lastInsertRowid) };
});

on('GET', '/admin/settings', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const s = getSettings();
  return {
    brand_name: s.brand_name,
    welcome: s.welcome,
    confidence_threshold: s.confidence_threshold,
    max_concurrent: s.max_concurrent,
    auto_assign: s.auto_assign,
    queue_notice: s.queue_notice,
    work_hours: s.work_hours,
    rating_prompt: s.rating_prompt
  };
});

on('PUT', '/admin/settings', async (ctx) => {
  requireStaff(ctx, ['admin']);
  const allowed = ['brand_name', 'welcome', 'confidence_threshold', 'max_concurrent', 'auto_assign', 'queue_notice', 'work_hours', 'rating_prompt'];
  const b = ctx.body || {};
  for (const k of allowed) {
    if (b[k] !== undefined) setSetting(k, typeof b[k] === 'boolean' ? (b[k] ? '1' : '0') : b[k]);
  }
  pushStaff('refresh', {});
  return getSettings();
});

/* ------------------------------- 统一入口 ------------------------------- */

async function handleApi(req, res, url) {
  const pathname = url.pathname.replace(/^\/api/, '') || '/';

  if (pathname === '/stream' || pathname === '/visitor/stream') {
    if (pathname === '/stream') {
      const user = currentUser(req, url);
      if (!user) {
        json(res, 401, { ok: false, error: { code: 'unauthenticated', message: '请先登录' } });
        return;
      }
      subscribe(res, { kind: 'staff', userId: user.id, role: user.role });
    } else {
      const visitor = currentVisitor(req, url);
      if (!visitor) {
        json(res, 401, { ok: false, error: { code: 'unauthenticated', message: '访客身份已失效' } });
        return;
      }
      subscribe(res, { kind: 'visitor', visitorId: visitor.id });
    }
    return;
  }

  try {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const ctx = { req, res, url, body, params, user: currentUser(req, url), visitor: null };
      const data = await r.handler(ctx);
      json(res, 200, { ok: true, data });
      return;
    }
    json(res, 404, { ok: false, error: { code: 'not_found', message: `接口不存在: ${pathname}` } });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    json(res, status, { ok: false, error: { code: err.code || 'internal_error', message: err.message || '服务器内部错误' } });
  }
}

module.exports = { handleApi, assignNext, ticketStats: buildStats, dayKey, lastDays };
