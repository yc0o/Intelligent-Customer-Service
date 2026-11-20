'use strict';

/**
 * 轻量中文语义匹配引擎（零依赖，可解释）
 * - 归一化 + 中文二元切分 / 英文数字词切分
 * - IDF 加权覆盖率打分，输出 0-1 置信度
 * - 支持多轮上下文：把上一轮问题词以低权重并入查询
 * - 意图规则：问候 / 致谢 / 转人工 / 负面情绪
 * 生产环境可替换为向量检索或大模型，接口保持不变。
 */

const { db } = require('./db');

const STOP_PHRASES = [
  '请问', '你好', '您好', '我想问一下', '我想问', '想问一下', '想问', '帮我看看', '帮我查一下', '帮我',
  '麻烦问一下', '麻烦', '一下', '怎么样', '怎么办', '怎么', '如何', '为什么', '能不能', '可以吗',
  '可以', '是否', '你们', '我们', '这个', '那个', '的话', '谢谢', '在吗'
];

const STOP_TOKENS = new Set(['的吗', '了吗', '呢', '吗', '啊', '呀', '吧', '了', '的']);

const HUMAN_RE = /(转人工|人工客服|真人|找人工|人工服务|转接人工|叫你们客服|要人工)/;
const GREETING_RE = /^(你好|您好|hi|hello|在吗|有人吗|哈喽)[\s!！。~]*$/i;
const THANKS_RE = /(谢谢|多谢|感谢|辛苦了|thx|thanks)/i;
const NEGATIVE_RE = /(投诉|太差|垃圾|骗子|欺骗|生气|气死|曝光|无语|失望|退钱|坑人|态度差|太慢|催了)/;
const ORDER_RE = /(?:订单号?|单号|order)[:：\s]*([A-Za-z0-9]{8,24})|(\b\d{12,20}\b)/;

function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000]/g, ' ')
    .toLowerCase()
    .trim();
}

function stripStopPhrases(text) {
  let out = text;
  for (const p of STOP_PHRASES) out = out.split(p).join(' ');
  return out;
}

function tokenize(text) {
  const terms = new Map();
  const raw = normalize(text);
  if (!raw) return terms;

  const add = (term, weight) => {
    if (!term || STOP_TOKENS.has(term)) return;
    const prev = terms.get(term) || 0;
    if (weight > prev) terms.set(term, weight);
  };

  for (const m of raw.match(/[a-z0-9]+/g) || []) {
    if (m.length >= 2 || /^\d$/.test(m)) add(m, 1.2);
  }
  for (const run of raw.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) {
      add(run, 0.5);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) add(run.slice(i, i + 2), 1);
    for (const ch of run) add(ch, 0.28);
  }
  return terms;
}

function tokenizeQuery(text) {
  return tokenize(stripStopPhrases(normalize(text)));
}

let cache = { stamp: '', docs: [], idf: new Map() };

function loadDocs() {
  const rows = db
    .prepare('SELECT id, question, answer, variants, keywords, category, hits FROM knowledge WHERE enabled = 1')
    .all();
  const stamp = rows.map((r) => `${r.id}:${r.question}:${r.variants}`).join('|');
  if (stamp === cache.stamp) return cache;

  const docs = rows.map((r) => {
    const bag = [r.question, (r.variants || '').replace(/\|/g, ' '), (r.keywords || '').replace(/,/g, ' ')].join(' ');
    const terms = tokenize(bag);
    return {
      ...r,
      terms,
      keywords: (r.keywords || '').split(',').map((s) => normalize(s).trim()).filter(Boolean)
    };
  });

  const df = new Map();
  for (const d of docs) {
    for (const t of d.terms.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  const N = Math.max(docs.length, 1);
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / n));

  cache = { stamp, docs, idf };
  return cache;
}

function isFollowUp(text) {
  const raw = normalize(text);
  if (raw.length <= 10) return true;
  return /(那|这|它|还有|另外|呢|多久|多少钱|怎么算|可以吗|呢？|\?)/.test(raw);
}

function scoreDoc(doc, qTerms, idf) {
  let num = 0;
  let den = 0;
  for (const [t, w] of qTerms) {
    const weight = w * (idf.get(t) || 1.2);
    den += weight;
    if (doc.terms.has(t)) num += weight;
  }
  return den ? num / den : 0;
}

/**
 * @param {string} text 用户本轮消息
 * @param {{topic?:string, kbId?:number, lastQuery?:string}} ctx 会话上下文
 */
function analyze(text, ctx = {}) {
  const raw = normalize(text);
  const intent = {
    human: HUMAN_RE.test(raw),
    greeting: GREETING_RE.test(raw),
    thanks: THANKS_RE.test(raw) && raw.length <= 14,
    negative: NEGATIVE_RE.test(raw)
  };

  const orderMatch = raw.match(ORDER_RE);
  const orderNo = orderMatch ? orderMatch[1] || orderMatch[2] : '';

  const { docs, idf } = loadDocs();
  let qTerms = tokenizeQuery(text);

  const followUp = isFollowUp(text) && Boolean(ctx.lastQuery);
  let ctxTerms = null;
  if (followUp) {
    ctxTerms = tokenizeQuery(ctx.lastQuery);
    for (const [t, w] of ctxTerms) {
      const prev = qTerms.get(t) || 0;
      if (prev < w * 0.5) qTerms.set(t, w * 0.5);
    }
  }

  const scored = docs
    .map((doc) => {
      let score = scoreDoc(doc, qTerms, idf);
      let boost = 0;
      for (const kw of doc.keywords) {
        if (kw && raw.includes(kw)) boost = Math.min(0.24, boost + 0.09);
      }
      return { doc, score: Math.min(1, score + boost) };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  let confidence = best ? Math.max(0, Math.min(0.98, best.score * 0.94)) : 0;

  // 长句但只蹭到 1 个双字词，判为“看似相关实则未命中”，避免答非所问
  const qBigrams = [...qTerms.keys()].filter((t) => t.length >= 2 && /[\u4e00-\u9fa5]/.test(t));
  if (best && qBigrams.length >= 4) {
    const matchedBigrams = qBigrams.filter((t) => best.doc.terms.has(t)).length;
    if (matchedBigrams < 2) confidence = Math.min(confidence, 0.31);
  }

  let viaContext = false;
  if (followUp && best && ctxTerms) {
    const own = scoreDoc(best.doc, tokenizeQuery(text), idf);
    viaContext = own < best.score - 0.02 || best.doc.id === ctx.kbId;
  }

  return {
    intent,
    orderNo,
    followUp,
    viaContext,
    confidence: Number(confidence.toFixed(3)),
    best: best ? {
      id: best.doc.id,
      question: best.doc.question,
      answer: best.doc.answer,
      category: best.doc.category,
      hits: best.doc.hits
    } : null,
    suggestions: scored
      .filter((s) => s.doc.id !== (best ? best.doc.id : -1) && s.score > 0.12)
      .slice(0, 3)
      .map((s) => ({ id: s.doc.id, question: s.doc.question, score: Number(s.score.toFixed(3)) })),
    topScores: scored.slice(0, 3).map((s) => ({ id: s.doc.id, score: Number(s.score.toFixed(3)) }))
  };
}

function searchKnowledge(query, limit = 5) {
  const { docs, idf } = loadDocs();
  const qTerms = tokenizeQuery(query);
  return docs
    .map((doc) => ({ doc, score: Number(scoreDoc(doc, qTerms, idf).toFixed(3)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({ id: doc.id, question: doc.question, answer: doc.answer, category: doc.category, score }));
}

module.exports = { analyze, searchKnowledge, tokenizeQuery, normalize };
