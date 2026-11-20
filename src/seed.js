'use strict';

const crypto = require('node:crypto');
const { db, nowIso, DEFAULT_SETTINGS, addEvent } = require('./db');

function hash(password) {
  return crypto.createHash('sha256').update(`xigu::${password}`).digest('hex');
}

function iso(minsAgo) {
  return new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
}

function rndToken(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

const KNOWLEDGE = [
  {
    question: '如何申请退货退款？',
    answer:
      '签收后 7 天内可在「我的订单 - 申请售后」中选择退货退款，填写退货原因并上传凭证即可。审核通过后按页面提示寄回商品，仓库签收并质检通过后自动退款。',
    variants: '退货怎么操作|我要退货|怎么退|退款流程|申请退款|不想要了能退吗|7天无理由退货',
    keywords: '退货,退款,售后,七天无理由,申请售后',
    category: '售后退款'
  },
  {
    question: '退款多久能到账？',
    answer:
      '仓库签收并质检通过后 1-3 个工作日内发起退款：原路退回（微信/支付宝）一般 1-2 个工作日到账，银行卡 3-7 个工作日。可在「我的订单 - 退款详情」查看进度。',
    variants: '退款什么时候到账|钱什么时候退|退款到账时间|退的钱在哪|多久退款',
    keywords: '退款,到账,多久,几天,原路退回',
    category: '售后退款'
  },
  {
    question: '退货运费由谁承担？',
    answer:
      '商品质量问题、发错货、少件漏发，运费由我们承担，可在售后页选择「商家承担运费」并使用上门取件；非质量问题的 7 天无理由退货，寄回运费由买家承担。若订单带有「退货包运费」标识，则由平台补贴。',
    variants: '运费谁出|退货邮费谁承担|退货运费怎么算|寄回运费',
    keywords: '运费,邮费,谁承担,寄回,退货包运费',
    category: '售后退款'
  },
  {
    question: '怎么修改收货地址？',
    answer:
      '订单未发货时，在「我的订单 - 订单详情 - 修改地址」可直接修改，仅限一次；已发货订单请联系客服协助拦截，拦截成功率取决于物流节点，不一定成功。',
    variants: '地址写错了|改地址|收货地址填错|能改收货地址吗',
    keywords: '地址,修改,收货,拦截',
    category: '订单'
  },
  {
    question: '下单后多久发货？',
    answer:
      '现货商品在付款后 48 小时内发出，预售商品以商品页标注时间为准。发货后物流信息会在 2-6 小时内更新，偏远地区可能延迟。',
    variants: '什么时候发货|多久能发货|发货时间|还没发货|催发货',
    keywords: '发货,多久,时间,现货,预售,物流',
    category: '物流'
  },
  {
    question: '怎么查询物流信息？',
    answer:
      '进入「我的订单」点击对应订单即可看到物流轨迹；也可在聊天中直接把订单号发给我，我帮你查询最新节点。',
    variants: '物流到哪了|查快递|我的包裹在哪|物流信息|快递单号',
    keywords: '物流,快递,查询,包裹,单号',
    category: '物流'
  },
  {
    question: '可以开发票吗？',
    answer:
      '支持开具电子普通发票和增值税专用发票。订单确认收货后在「订单详情 - 申请开票」提交，电子发票一般 24 小时内发送到预留邮箱，专票需 3-5 个工作日。',
    variants: '怎么开发票|要发票|开票|增值税专票|电子发票',
    keywords: '发票,开票,专票,电子发票,抬头',
    category: '发票'
  },
  {
    question: '优惠券为什么用不了？',
    answer:
      '常见原因有三类：未达到门槛金额、商品不在活动范围（特价/联名款通常不参与）、优惠券已过期或与其他活动互斥。你可以在结算页点击优惠券查看「不可用原因」。',
    variants: '优惠券不能用|为什么用不了券|优惠券失效|券怎么用',
    keywords: '优惠券,用不了,失效,门槛,活动',
    category: '营销'
  },
  {
    question: '会员积分怎么获取和兑换？',
    answer:
      '消费 1 元累计 1 积分，评价晒单额外 +20 积分。积分可在「我的 - 积分商城」兑换优惠券与实物礼品，积分有效期为获得后次年年底。',
    variants: '积分怎么用|积分兑换|怎么得积分|积分会过期吗',
    keywords: '积分,兑换,会员,过期',
    category: '会员'
  },
  {
    question: '忘记密码怎么办？',
    answer:
      '在登录页点击「忘记密码」，用注册手机号接收验证码后重设即可。若手机号已停用，请提供订单号与收货人信息，由人工客服核验身份后协助换绑。',
    variants: '密码忘了|登录不上|找回密码|手机号换了',
    keywords: '密码,忘记,登录,验证码,换绑',
    category: '账号'
  },
  {
    question: '商品是正品吗？有质保吗？',
    answer:
      '平台商品均由品牌方或授权经销商直供，支持专柜验货与假一赔十。数码类商品享受全国联保 1 年，服饰鞋包 30 天内质量问题包退换。',
    variants: '是正品吗|有保修吗|质量保证|假货|质保多久',
    keywords: '正品,质保,保修,联保,假一赔十',
    category: '商品'
  },
  {
    question: '客服工作时间是什么时候？',
    answer:
      '在线人工客服每天 09:00 - 22:00 在线，智能客服 7×24 小时可用。非人工时段可以留言，我们会在次日 09:30 前回复。',
    variants: '你们几点上班|人工客服时间|客服在线时间|晚上有人吗',
    keywords: '工作时间,几点,上班,在线时间,人工',
    category: '通用'
  },
  {
    question: '支付失败怎么办？',
    answer:
      '先确认银行卡限额与余额，再尝试更换支付方式。若提示「订单已关闭」，请在 30 分钟内重新下单；重复扣款会在 1-3 个工作日自动原路退回。',
    variants: '付不了款|支付失败|扣款了但订单没生成|重复扣款',
    keywords: '支付,失败,扣款,限额,订单关闭',
    category: '支付'
  },
  {
    question: '可以换货吗？',
    answer:
      '支持换货：签收 7 天内商品不影响二次销售可申请同款换尺码/颜色；质量问题 15 天内可换货，往返运费由我们承担。换货入口在「我的订单 - 申请售后 - 换货」。',
    variants: '换货|尺码不合适能换吗|换颜色|换一件',
    keywords: '换货,尺码,颜色,更换,15天',
    category: '售后退款'
  }
];

const QUICK_REPLIES = [
  { title: '问候开场', content: '你好，我是溪谷优选客服，很高兴为你服务。请问遇到什么问题了？', category: '通用' },
  { title: '核实订单号', content: '方便提供一下订单号吗？我这边帮你核实具体进度。', category: '通用' },
  { title: '退款进度说明', content: '你的退款已提交，仓库签收质检通过后 1-3 个工作日内原路退回，可在「我的订单-退款详情」查看进度。', category: '售后' },
  { title: '物流延迟安抚', content: '非常抱歉让你久等了。受中转仓积压影响物流有所延迟，我已为你标记加急，预计 1-2 天内更新节点。', category: '物流' },
  { title: '转交专员', content: '这个问题需要专人跟进，我已为你转接，稍等一下。', category: '通用' },
  { title: '结束语', content: '还有其他可以帮你的吗？如果没有，我先为你结束本次会话，祝你生活愉快。', category: '通用' }
];

function seedKnowledge() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO knowledge(question, answer, variants, keywords, category, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?)`
  );
  const t = nowIso();
  for (const k of KNOWLEDGE) {
    stmt.run(k.question, k.answer, k.variants, k.keywords, k.category, t, t);
  }
}

function seedQuickReplies() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM quick_replies').get().n;
  if (count > 0) return;
  const stmt = db.prepare('INSERT INTO quick_replies(title, content, category) VALUES(?,?,?)');
  for (const q of QUICK_REPLIES) stmt.run(q.title, q.content, q.category);
}

function seedSettings() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) stmt.run(k, String(v));
}

function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO users(username, name, role, password, status, color, title, created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  );
  const t = nowIso();
  stmt.run('admin', '林见山', 'admin', hash('admin123'), 'offline', '#111827', '客服中心负责人', t);
  stmt.run('agent1', '林小满', 'agent', hash('agent123'), 'offline', '#f2612c', '资深客服 · 售后组', t);
  stmt.run('agent2', '周予', 'agent', hash('agent123'), 'offline', '#2563eb', '客服 · 订单组', t);
  stmt.run('agent3', '陈默', 'agent', hash('agent123'), 'offline', '#0f9d6e', '客服 · 物流组', t);
}

function insertVisitor(v, minsAgo) {
  const info = db
    .prepare(
      `INSERT INTO visitors(token, name, phone, level, tags, source, device, city, remark, visits, created_at, last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      rndToken('v'),
      v.name,
      v.phone || '',
      v.level || '普通会员',
      v.tags || '',
      v.source || '官网',
      v.device || 'Chrome · Windows',
      v.city || '上海',
      v.remark || '',
      v.visits || 1,
      iso(minsAgo + 30),
      iso(minsAgo)
    );
  return Number(info.lastInsertRowid);
}

function insertConversation(c) {
  const visitorId = insertVisitor(c.visitor, c.startedMins);
  const info = db
    .prepare(
      `INSERT INTO conversations(visitor_id, status, mode, agent_id, started_at, queue_at, assigned_at,
        closed_at, closed_by, last_message_at, topic, context_json, ai_rounds, transfer_count, summary,
        satisfaction, satisfaction_tags, satisfaction_comment, rated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      visitorId,
      c.status,
      c.mode,
      c.agentId || null,
      iso(c.startedMins),
      c.status === 'waiting' ? iso(c.startedMins) : null,
      c.agentId ? iso(c.startedMins - 2) : null,
      c.status === 'closed' ? iso(c.closedMins) : null,
      c.status === 'closed' ? 'agent' : null,
      iso(c.lastMsgMins),
      c.topic || '',
      JSON.stringify(c.context || {}),
      c.aiRounds || 0,
      c.transferCount || 0,
      c.summary || '',
      c.csat || null,
      c.csatTags || '',
      c.csatComment || '',
      c.csat ? iso(c.closedMins) : null
    );
  const convId = Number(info.lastInsertRowid);

  const stmt = db.prepare(
    `INSERT INTO messages(conversation_id, from_type, from_id, content, confidence, kb_id, meta, created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  );
  for (const m of c.messages) {
    stmt.run(
      convId,
      m.from,
      m.from === 'agent' ? c.agentId : null,
      m.text,
      m.confidence == null ? null : m.confidence,
      m.kbId == null ? null : m.kbId,
      JSON.stringify(m.meta || {}),
      iso(m.minsAgo)
    );
  }
  if (c.agentId) addEvent(convId, 'assign', `agent:${c.agentId}`, '会话分配', iso(c.startedMins - 2));
  if (c.transferCount) addEvent(convId, 'transfer_human', 'bot', '置信度不足，自动转人工', iso(c.startedMins - 4));
  if (c.status === 'closed') {
    addEvent(convId, 'close', c.agentId ? `agent:${c.agentId}` : 'bot', '会话结束', iso(c.closedMins));
  }
  return convId;
}

function seedConversations() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  if (count > 0) return;
  const kb = db.prepare('SELECT id, question FROM knowledge ORDER BY id').all();
  const kbId = (i) => (kb[i] ? kb[i].id : null);

  const history = [
    {
      startedMins: 96,
      lastMsgMins: 84,
      closedMins: 84,
      status: 'closed',
      mode: 'bot',
      topic: '退款到账时间',
      aiRounds: 2,
      csat: 5,
      csatTags: '响应快,专业',
      csatComment: '回答很快，说得很清楚。',
      visitor: { name: '沈知微', level: 'VIP2', city: '杭州', phone: '138****2210', device: 'iPhone 15 · Safari', source: '官网帮助中心', visits: 6, tags: '高价值,复购' },
      messages: [
        { from: 'visitor', text: '你好，我上周买的保温杯申请退款了，大概多久到账？', minsAgo: 96 },
        { from: 'bot', text: '仓库签收并质检通过后 1-3 个工作日内发起退款：原路退回（微信/支付宝）一般 1-2 个工作日到账，银行卡 3-7 个工作日。可在「我的订单 - 退款详情」查看进度。', minsAgo: 95, confidence: 0.86, kbId: kbId(1), meta: { label: '退款多久能到账？', category: '售后退款' } },
        { from: 'visitor', text: '那我这个已经显示质检通过了，是今天开始算吗？', minsAgo: 93 },
        { from: 'bot', text: '接着刚才的退款进度：质检通过当天即进入退款队列，按工作日计算，今天提交的话最快明天到账。', minsAgo: 92, confidence: 0.62, kbId: kbId(1), meta: { label: '退款多久能到账？', viaContext: true } },
        { from: 'visitor', text: '好的，清楚了，谢谢', minsAgo: 85 },
        { from: 'bot', text: '不客气，还有其他问题随时找我。', minsAgo: 85, confidence: 0.9, meta: { intent: 'thanks' } }
      ]
    },
    {
      startedMins: 220,
      lastMsgMins: 186,
      closedMins: 186,
      status: 'closed',
      mode: 'human',
      topic: '退货运费争议',
      aiRounds: 1,
      agentId: 2,
      transferCount: 1,
      csat: 4,
      csatTags: '态度好',
      csatComment: '客服帮忙申请了运费补贴。',
      summary: '访客认为退货运费不应由自己承担，情绪偏负面；机器人置信度 0.28 触发自动转人工。',
      visitor: { name: '陆行舟', level: '普通会员', city: '成都', phone: '159****8834', device: '小米 14 · Chrome', source: '商品详情页', visits: 3, tags: '价格敏感' },
      messages: [
        { from: 'visitor', text: '退货还要我自己出运费？这也太不合理了吧', minsAgo: 220 },
        { from: 'bot', text: '抱歉让你有不好的体验。我先确认一下：这笔订单是商品质量问题，还是 7 天无理由退货呢？两种情况的运费承担规则不同。', minsAgo: 219, confidence: 0.28, kbId: null, meta: { label: '运费承担规则', low: true } },
        { from: 'system', text: '已为你转接人工客服，请稍候', minsAgo: 218 },
        { from: 'agent', text: '你好，我是客服小满。刚看了你的订单，是尺码不合适退货对吗？这类情况运费需要你承担，不过我可以帮你申请 8 元运费补贴。', minsAgo: 214 },
        { from: 'visitor', text: '可以，那麻烦你了', minsAgo: 200 },
        { from: 'agent', text: '已提交补贴申请，1 个工作日内打到你的账户余额。退货地址和上门取件时间我发到会话里了。', minsAgo: 190 },
        { from: 'visitor', text: '收到，谢谢', minsAgo: 187 }
      ]
    },
    {
      startedMins: 1560,
      lastMsgMins: 1520,
      closedMins: 1520,
      status: 'closed',
      mode: 'human',
      topic: '发票抬头开错',
      aiRounds: 0,
      agentId: 3,
      transferCount: 1,
      csat: 3,
      csatTags: '未解决',
      csatComment: '说需要 3 天，有点慢。',
      summary: '访客需要重开增值税专票，涉及财务流程，机器人直接建议转人工。',
      visitor: { name: '顾清和', level: '企业采购', city: '苏州', phone: '186****3021', device: 'MacBook · Edge', source: '官网', visits: 12, tags: '企业客户,专票' },
      messages: [
        { from: 'visitor', text: '专票抬头开错了，能重开吗', minsAgo: 1560 },
        { from: 'system', text: '已为你转接人工客服，请稍候', minsAgo: 1558 },
        { from: 'agent', text: '可以重开。请提供订单号和正确的开票信息，我提交财务作废后重新开具。', minsAgo: 1550 },
        { from: 'visitor', text: '订单 2026111800932，抬头改成苏州清和科技股份有限公司，税号 91320500MA1X8K2R3L', minsAgo: 1540 },
        { from: 'agent', text: '已提交，专票重开需要 3-5 个工作日，开好会发到你邮箱。', minsAgo: 1525 }
      ]
    },
    {
      startedMins: 2900,
      lastMsgMins: 2880,
      closedMins: 2880,
      status: 'closed',
      mode: 'bot',
      topic: '物流查询',
      aiRounds: 1,
      csat: 5,
      csatTags: '响应快',
      visitor: { name: '白露', level: '普通会员', city: '广州', phone: '137****6612', device: 'iPhone 13 · 微信内置浏览器', source: '公众号菜单', visits: 2, tags: '' },
      messages: [
        { from: 'visitor', text: '我的快递到哪了', minsAgo: 2900 },
        { from: 'bot', text: '进入「我的订单」点击对应订单即可看到物流轨迹；也可在聊天中直接把订单号发给我，我帮你查询最新节点。', minsAgo: 2899, confidence: 0.81, kbId: kbId(5), meta: { label: '怎么查询物流信息？', category: '物流' } },
        { from: 'visitor', text: '2026111755021', minsAgo: 2895 },
        { from: 'bot', text: '已记录你的订单号 2026111755021。该包裹昨天 18:42 到达广州转运中心，预计明天派送。', minsAgo: 2894, confidence: 0.74, kbId: kbId(5), meta: { label: '怎么查询物流信息？', orderNo: '2026111755021' } },
        { from: 'visitor', text: '好的谢谢', minsAgo: 2881 },
        { from: 'bot', text: '不客气，祝你收货愉快。', minsAgo: 2880, confidence: 0.9, meta: { intent: 'thanks' } }
      ]
    },
    {
      startedMins: 4400,
      lastMsgMins: 4330,
      closedMins: 4330,
      status: 'closed',
      mode: 'human',
      topic: '改收货地址',
      aiRounds: 1,
      agentId: 4,
      transferCount: 1,
      csat: null,
      summary: '访客地址填错且订单已发货，需要人工尝试拦截。',
      visitor: { name: '江照', level: 'VIP1', city: '北京', phone: '135****9908', device: 'iPhone 15 Pro · Safari', source: 'App', visits: 9, tags: '高频咨询' },
      messages: [
        { from: 'visitor', text: '地址填错了，能改吗，已经发货了', minsAgo: 4400 },
        { from: 'bot', text: '已发货订单可以联系客服协助拦截，拦截成功率取决于物流节点。已为你转接人工。', minsAgo: 4399, confidence: 0.33, kbId: kbId(3), meta: { label: '怎么修改收货地址？', low: true } },
        { from: 'system', text: '已为你转接人工客服，请稍候', minsAgo: 4398 },
        { from: 'agent', text: '你好，我是客服陈默。订单号方便发我一下吗？我马上联系网点拦截。', minsAgo: 4392 },
        { from: 'visitor', text: '2026111600331，改成朝阳区建国路 88 号', minsAgo: 4380 },
        { from: 'agent', text: '已提交地址拦截，网点会在派送前联系你确认。如果拦截失败，可以拒收后重新下单。', minsAgo: 4335 }
      ]
    },
    {
      startedMins: 5800,
      lastMsgMins: 5760,
      closedMins: 5760,
      status: 'closed',
      mode: 'bot',
      topic: '优惠券用不了',
      aiRounds: 2,
      csat: 4,
      csatTags: '专业',
      visitor: { name: '温言', level: '普通会员', city: '武汉', phone: '188****4432', device: 'Android · Chrome', source: '官网', visits: 1, tags: '新客' },
      messages: [
        { from: 'visitor', text: '我的券怎么用不了啊', minsAgo: 5800 },
        { from: 'bot', text: '常见原因有三类：未达到门槛金额、商品不在活动范围（特价/联名款通常不参与）、优惠券已过期或与其他活动互斥。你可以在结算页点击优惠券查看「不可用原因」。', minsAgo: 5799, confidence: 0.72, kbId: kbId(7), meta: { label: '优惠券为什么用不了？', category: '营销' } },
        { from: 'visitor', text: '显示不满足使用条件', minsAgo: 5790 },
        { from: 'bot', text: '那说明还没达到门槛金额。这笔订单 168 元，你领的是满 199 减 30，再凑 31 元就可以用了。', minsAgo: 5789, confidence: 0.58, kbId: kbId(7), meta: { label: '优惠券为什么用不了？', viaContext: true } },
        { from: 'visitor', text: '明白了', minsAgo: 5761 }
      ]
    },
    {
      startedMins: 7300,
      lastMsgMins: 7260,
      closedMins: 7260,
      status: 'closed',
      mode: 'human',
      topic: '商品真伪核验',
      aiRounds: 1,
      agentId: 2,
      transferCount: 1,
      csat: 5,
      csatTags: '专业,态度好',
      csatComment: '查了授权链路，很放心。',
      summary: '访客担心买到假货，需要提供品牌授权链路证明。',
      visitor: { name: '苏晚', level: 'VIP2', city: '南京', phone: '133****2201', device: 'iPhone 12 · 微信', source: '公众号菜单', visits: 15, tags: '高价值,美妆' },
      messages: [
        { from: 'visitor', text: '你们这个精华是正品吗，怎么证明', minsAgo: 7300 },
        { from: 'bot', text: '平台商品均由品牌方或授权经销商直供，支持专柜验货与假一赔十。你这单的品牌授权链路我可以让专员发给你。', minsAgo: 7299, confidence: 0.51, kbId: kbId(10), meta: { label: '商品是正品吗？有质保吗？' } },
        { from: 'system', text: '已为你转接人工客服，请稍候', minsAgo: 7298 },
        { from: 'agent', text: '你好，这单是品牌方直供。我把授权书编号和报关单照片发你，收到后可以在品牌官网验真。', minsAgo: 7290 },
        { from: 'visitor', text: '好的，谢谢', minsAgo: 7265 }
      ]
    }
  ];

  history.forEach(insertConversation);

  // 两条排队中的会话：用于演示客服工作台的「排队」与自动分配
  const waiting = [
    {
      startedMins: 7,
      lastMsgMins: 3,
      status: 'waiting',
      mode: 'queue',
      topic: '订单未发货',
      aiRounds: 1,
      transferCount: 1,
      summary: '顾南（普通会员）咨询「订单未发货」；下单已超过 48 小时仍未发出，机器人置信度 47%，转人工核实仓库情况。\n诉求摘要：下单三天了还没发货，能催一下吗 / 好的，麻烦快点',
      visitor: { name: '顾南', level: '普通会员', city: '深圳', phone: '130****7781', device: 'Android · Chrome', source: '商品详情页', visits: 2, tags: '催发货' },
      messages: [
        { from: 'visitor', text: '下单三天了还没发货，能催一下吗', minsAgo: 7 },
        { from: 'bot', text: '现货商品在付款后 48 小时内发出。你这单已超过 48 小时，我帮你转人工核实仓库情况。', minsAgo: 6, confidence: 0.47, kbId: kbId(4), meta: { label: '下单后多久发货？' } },
        { from: 'system', text: '已为你转接人工客服，正在为你排队', minsAgo: 5 },
        { from: 'visitor', text: '好的，麻烦快点', minsAgo: 3 }
      ]
    },
    {
      startedMins: 3,
      lastMsgMins: 1,
      status: 'waiting',
      mode: 'queue',
      topic: '价保补差',
      aiRounds: 1,
      transferCount: 1,
      summary: '裴照（VIP1）咨询「价保补差」；刚下单即降价，询问能否补差价。机器人无对应知识条目（置信度 30%），已转人工核对活动规则。\n诉求摘要：刚买完就降价了，能补差价吗',
      visitor: { name: '裴照', level: 'VIP1', city: '西安', phone: '156****3320', device: 'MacBook · Chrome', source: '官网', visits: 5, tags: '价保' },
      messages: [
        { from: 'visitor', text: '刚买完就降价了，能补差价吗', minsAgo: 3 },
        { from: 'bot', text: '价保规则需要按商品和活动确认，我请人工同事帮你核对，稍等一下。', minsAgo: 2, confidence: 0.3, kbId: null, meta: { label: '价保补差' } },
        { from: 'system', text: '已为你转接人工客服，正在为你排队', minsAgo: 1 }
      ]
    }
  ];

  waiting.forEach(insertConversation);
}

function seedAll() {
  seedSettings();
  seedUsers();
  seedKnowledge();
  seedQuickReplies();
  seedConversations();
}

module.exports = { seedAll, hash };
