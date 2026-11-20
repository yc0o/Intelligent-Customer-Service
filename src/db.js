'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('agent','admin')),
  password    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'offline',
  color       TEXT NOT NULL DEFAULT '#f2612c',
  title       TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  level       TEXT DEFAULT '普通会员',
  tags        TEXT DEFAULT '',
  source      TEXT DEFAULT '官网',
  device      TEXT DEFAULT '',
  city        TEXT DEFAULT '',
  remark      TEXT DEFAULT '',
  visits      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  mode          TEXT NOT NULL DEFAULT 'bot',
  agent_id      INTEGER,
  started_at    TEXT NOT NULL,
  queue_at      TEXT,
  assigned_at   TEXT,
  closed_at     TEXT,
  closed_by     TEXT,
  last_message_at TEXT NOT NULL,
  topic         TEXT DEFAULT '',
  context_json  TEXT DEFAULT '{}',
  low_streak    INTEGER NOT NULL DEFAULT 0,
  ai_rounds     INTEGER NOT NULL DEFAULT 0,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  summary       TEXT DEFAULT '',
  satisfaction  INTEGER,
  satisfaction_tags TEXT DEFAULT '',
  satisfaction_comment TEXT DEFAULT '',
  rated_at      TEXT,
  FOREIGN KEY (visitor_id) REFERENCES visitors(id),
  FOREIGN KEY (agent_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  from_type       TEXT NOT NULL,
  from_id         INTEGER,
  content         TEXT NOT NULL,
  confidence      REAL,
  kb_id           INTEGER,
  meta            TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  variants    TEXT DEFAULT '',
  keywords    TEXT DEFAULT '',
  category    TEXT DEFAULT '通用',
  hits        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  content  TEXT NOT NULL,
  category TEXT DEFAULT '通用'
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  type            TEXT NOT NULL,
  actor           TEXT DEFAULT '',
  detail          TEXT DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status, queue_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id, status);
`;

db.exec(SCHEMA);

const DEFAULT_SETTINGS = {
  brand_name: '溪谷优选',
  welcome: '你好，我是智能客服小满。订单、物流、退换货、发票都可以问我，也可以直接说“转人工”。',
  confidence_threshold: '0.34',
  max_concurrent: '4',
  auto_assign: '1',
  queue_notice: '当前咨询较集中，已为你排入队列，接入后会第一时间回复你。',
  work_hours: '每天 09:00 - 22:00',
  rating_prompt: '本次服务还满意吗？你的评价会帮助我们改进。'
};

function nowIso() {
  return new Date().toISOString();
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  out.confidence_threshold = Number(out.confidence_threshold);
  out.max_concurrent = Number(out.max_concurrent);
  out.auto_assign = out.auto_assign === '1' || out.auto_assign === true;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function addEvent(conversationId, type, actor = '', detail = '', at = nowIso()) {
  db.prepare(
    'INSERT INTO events(conversation_id, type, actor, detail, created_at) VALUES(?,?,?,?,?)'
  ).run(conversationId, type, actor, detail, at);
}

module.exports = {
  db,
  DB_PATH,
  nowIso,
  getSetting,
  getSettings,
  setSetting,
  addEvent,
  DEFAULT_SETTINGS
};
