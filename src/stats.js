'use strict';

const { db, getSettings } = require('./db');

const TZ = 8 * 3600 * 1000;

function dayKey(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + TZ).toISOString().slice(0, 10);
}

function todayKey() {
  return dayKey(new Date().toISOString());
}

function lastDays(n) {
  const keys = [];
  const base = new Date(`${todayKey()}T00:00:00.000Z`).getTime();
  for (let i = n - 1; i >= 0; i -= 1) {
    keys.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function avg(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function buildStats(days = 7) {
  const settings = getSettings();
  const keys = lastDays(days);
  const since = new Date(`${keys[0]}T00:00:00+08:00`).toISOString();

  const convs = db
    .prepare(
      `SELECT c.*, v.name AS visitor_name
       FROM conversations c JOIN visitors v ON v.id = c.visitor_id
       WHERE c.started_at >= ? ORDER BY c.id`
    )
    .all(since);

  const inRange = convs.filter((c) => dayKey(c.started_at) >= keys[0]);
  const today = inRange.filter((c) => dayKey(c.started_at) === todayKey());

  const ids = inRange.map((c) => c.id);
  let msgs = [];
  if (ids.length) {
    msgs = db
      .prepare(`SELECT * FROM messages WHERE conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids);
  }
  const byConv = new Map();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id).push(m);
  }

  const closed = inRange.filter((c) => c.status === 'closed');
  const botOnly = closed.filter((c) => !c.agent_id);
  const human = inRange.filter((c) => c.agent_id);
  const rated = closed.filter((c) => c.satisfaction);

  const firstResp = [];
  for (const c of human) {
    const list = byConv.get(c.id) || [];
    const firstAgent = list.find((m) => m.from_type === 'agent');
    if (firstAgent) {
      const base = c.assigned_at || c.started_at;
      const sec = (new Date(firstAgent.created_at) - new Date(base)) / 1000;
      if (sec >= 0 && sec < 86400) firstResp.push(sec);
    }
  }

  const durations = closed
    .filter((c) => c.closed_at)
    .map((c) => (new Date(c.closed_at) - new Date(c.started_at)) / 60000)
    .filter((v) => v >= 0 && v < 1440);

  const csatDist = [0, 0, 0, 0, 0];
  for (const c of rated) if (c.satisfaction >= 1 && c.satisfaction <= 5) csatDist[c.satisfaction - 1] += 1;

  const series = keys.map((k) => {
    const list = inRange.filter((c) => dayKey(c.started_at) === k);
    return {
      date: k,
      label: `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`,
      total: list.length,
      human: list.filter((c) => c.agent_id).length,
      bot: list.filter((c) => c.status === 'closed' && !c.agent_id).length
    };
  });

  const agents = db.prepare("SELECT id, name, color, status FROM users WHERE role = 'agent' ORDER BY id").all();
  const agentRank = agents
    .map((a) => {
      const mine = human.filter((c) => c.agent_id === a.id);
      const mineRated = mine.filter((c) => c.satisfaction);
      const resp = [];
      for (const c of mine) {
        const list = byConv.get(c.id) || [];
        const fa = list.find((m) => m.from_type === 'agent');
        if (fa) resp.push((new Date(fa.created_at) - new Date(c.assigned_at || c.started_at)) / 1000);
      }
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        status: a.status,
        handled: mine.length,
        active: db.prepare("SELECT COUNT(*) n FROM conversations WHERE agent_id = ? AND status = 'active'").get(a.id).n,
        avgCsat: Number(avg(mineRated.map((c) => c.satisfaction)).toFixed(2)),
        avgFirstResp: Math.round(avg(resp)),
        ratingCount: mineRated.length
      };
    })
    .sort((x, y) => y.handled - x.handled || y.avgCsat - x.avgCsat);

  const kbTop = db
    .prepare('SELECT id, question, category, hits FROM knowledge ORDER BY hits DESC, id ASC LIMIT 6')
    .all();

  // 知识缺口：低置信度机器人回答对应的访客提问
  const gapMap = new Map();
  for (const c of inRange) {
    const list = byConv.get(c.id) || [];
    let lastVisitor = '';
    for (const m of list) {
      if (m.from_type === 'visitor') lastVisitor = m.content;
      if (m.from_type === 'bot' && m.confidence != null && m.confidence < settings.confidence_threshold) {
        const q = (lastVisitor || '').slice(0, 60);
        if (!q) continue;
        const key = q;
        const cur = gapMap.get(key) || { question: q, count: 0, lastAt: m.created_at, confidence: m.confidence };
        cur.count += 1;
        cur.lastAt = m.created_at > cur.lastAt ? m.created_at : cur.lastAt;
        cur.confidence = Math.min(cur.confidence, m.confidence);
        gapMap.set(key, cur);
      }
    }
  }
  const gaps = [...gapMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);

  return {
    range: { days, from: keys[0], to: keys[keys.length - 1] },
    kpi: {
      total: inRange.length,
      today: today.length,
      waiting: inRange.filter((c) => c.status === 'waiting').length,
      active: inRange.filter((c) => c.status === 'active').length,
      humanRate: inRange.length ? Math.round((human.length / inRange.length) * 100) : 0,
      botResolvedRate: closed.length ? Math.round((botOnly.length / closed.length) * 100) : 0,
      avgFirstResp: Math.round(avg(firstResp)),
      avgDuration: Math.round(avg(durations)),
      csat: Number(avg(rated.map((c) => c.satisfaction)).toFixed(2)),
      ratedRate: closed.length ? Math.round((rated.length / closed.length) * 100) : 0,
      transferCount: inRange.reduce((a, c) => a + (c.transfer_count || 0), 0)
    },
    series,
    csatDist,
    agentRank,
    kbTop,
    gaps,
    coverage: { staff: 0, visitor: 0 }
  };
}

module.exports = { buildStats, dayKey, todayKey, lastDays };
