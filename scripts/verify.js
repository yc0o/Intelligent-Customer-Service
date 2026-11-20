'use strict';

/**
 * 端到端冒烟测试：覆盖访客问答 → 转人工 → 排队 → 分配 → 接管回复 → 转接 → 结束 → 评价 → 统计
 * 用法：先启动服务（npm start），再执行 npm run verify
 * 说明：会在数据库中产生一条测试会话，可用 npm run reset 恢复演示数据。
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, extra = '') {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}

function bad(name, detail) {
  failed += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}  \x1b[31m${detail}\x1b[0m`);
}

function assert(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail || '断言失败');
  return Boolean(cond);
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-token'] = token;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok && payload && payload.ok, data: payload && payload.data, error: payload && payload.error };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n溪谷优选 · 智能客服平台 端到端验证');
  console.log(`目标服务：${BASE}\n`);

  /* 1. 健康检查 */
  const health = await call('GET', '/health');
  assert('服务健康检查', health.ok && health.data.ok, `sqlite / sse ${JSON.stringify(health.data && health.data.sse)}`);

  /* 2. 访客会话 */
  const session = await call('POST', '/visitor/session', { body: { name: '验收访客' } });
  const vTok = session.data && session.data.token;
  assert('访客创建会话并收到欢迎语', Boolean(vTok) && session.data.messages.length > 0,
    session.data ? `会话 #${session.data.conversation.id}` : '无返回');
  if (!vTok) return finish();

  /* 3. 知识库命中 */
  const q1 = await call('POST', '/visitor/message', { token: vTok, body: { content: '退款多久能到账' } });
  const kbMsg = q1.data && q1.data.messages.find((m) => m.from === 'bot');
  assert('机器人命中知识库并给出答案', Boolean(kbMsg && kbMsg.kbId) && (kbMsg.confidence || 0) >= 0.34,
    kbMsg ? `置信度 ${Math.round(kbMsg.confidence * 100)}% · ${kbMsg.meta.label}` : '无回答');

  /* 4. 多轮上下文 */
  const q2 = await call('POST', '/visitor/message', { token: vTok, body: { content: '那运费谁出' } });
  const ctxMsg = q2.data && q2.data.messages.find((m) => m.from === 'bot');
  assert('多轮上下文跟随（追问运费）', Boolean(ctxMsg && ctxMsg.kbId) && /运费/.test(ctxMsg.content),
    ctxMsg ? ctxMsg.meta.label : '无回答');

  /* 5. 低置信度两次 → 自动转人工 */
  await call('POST', '/visitor/message', { token: vTok, body: { content: '你们公司在哪栋楼' } });
  const low2 = await call('POST', '/visitor/message', { token: vTok, body: { content: '今天食堂吃什么' } });
  assert('连续低置信度自动转人工', low2.data && low2.data.action === 'queue', `action=${low2.data && low2.data.action}`);
  const stateQueue = await call('GET', '/visitor/state', { token: vTok });
  assert('访客进入排队并拿到排位', Boolean(stateQueue.data.queue) && stateQueue.data.queue.position >= 1,
    stateQueue.data.queue ? `第 ${stateQueue.data.queue.position} 位` : '无排队信息');

  /* 6. 访客令牌越权 */
  const forbidden = await call('GET', '/agent/overview', { token: vTok });
  assert('访客令牌无法访问客服接口', forbidden.status === 401, `HTTP ${forbidden.status}`);

  /* 7. 客服上线 → 自动分配 */
  const a1 = await call('POST', '/auth/login', { body: { username: 'agent1', password: 'agent123' } });
  const a1Tok = a1.data && a1.data.token;
  assert('客服登录成功并切换在线', Boolean(a1Tok) && a1.data.user.status === 'online', a1.data && a1.data.user.name);

  let target = null;
  for (let i = 0; i < 12; i += 1) {
    const ov = await call('GET', '/agent/overview', { token: a1Tok });
    const mine = (ov.data && ov.data.mine) || [];
    target = mine.find((c) => c.visitorName === '验收访客');
    if (target) break;
    await sleep(400);
  }
  assert('排队会话自动分配给在线客服', Boolean(target), target ? `会话 #${target.id} → ${target.agentName}` : '未分配');
  if (!target) return finish();

  /* 8. 工作台详情：客户资料 + AI 摘要 + 坐席辅助 */
  const detail = await call('GET', `/agent/conversation/${target.id}`, { token: a1Tok });
  const d = detail.data || {};
  assert('工作台可查看客户资料', d.visitor && d.visitor.name === '验收访客', d.visitor && `${d.visitor.level} / ${d.visitor.device}`);
  assert('转人工时生成 AI 会话摘要', Boolean(d.conversation && d.conversation.summary), (d.conversation && d.conversation.summary || '').split('\n')[0]);
  assert('历史消息完整同步给客服', (d.messages || []).length >= 6, `${(d.messages || []).length} 条消息`);
  assert('坐席辅助给出推荐答案', (d.assist || []).length > 0, `${(d.assist || []).length} 条建议`);

  /* 9. 客服回复 → 访客可见 */
  const reply = await call('POST', `/agent/conversation/${target.id}/message`, {
    token: a1Tok,
    body: { content: '你好，我是林小满，刚看了你的订单，正在为你核实仓库情况。' }
  });
  assert('客服发送消息成功', reply.ok, reply.data && reply.data.message.content.slice(0, 12));
  const vState = await call('GET', '/visitor/state', { token: vTok });
  const gotAgent = (vState.data.messages || []).some((m) => m.from === 'agent');
  assert('访客实时收到人工回复', gotAgent, `会话状态 ${vState.data.conversation.mode}`);

  /* 10. 客服权限边界 */
  const adminDenied = await call('GET', '/admin/stats', { token: a1Tok });
  assert('客服令牌无法访问管理后台', adminDenied.status === 403, `HTTP ${adminDenied.status}`);

  /* 11. 转接给第二个客服 */
  const a2 = await call('POST', '/auth/login', { body: { username: 'agent2', password: 'agent123' } });
  const a2Tok = a2.data && a2.data.token;
  const a2Id = a2.data && a2.data.user.id;
  const transfer = await call('POST', `/agent/conversation/${target.id}/transfer`, {
    token: a1Tok,
    body: { toAgentId: a2Id, reason: '物流组跟进' }
  });
  assert('会话转接给其他客服', transfer.ok, transfer.data && transfer.data.agent.name);
  const afterTransfer = await call('GET', `/agent/conversation/${target.id}`, { token: a2Tok });
  assert('转接后新客服可接管会话', afterTransfer.ok && afterTransfer.data.conversation.agentId === a2Id,
    afterTransfer.data && afterTransfer.data.conversation.agentName);
  const oldAgentSend = await call('POST', `/agent/conversation/${target.id}/message`, { token: a1Tok, body: { content: '越权测试' } });
  assert('原客服失去该会话的发言权限', oldAgentSend.status === 403, `HTTP ${oldAgentSend.status}`);

  /* 12. 结束会话 + 满意度 */
  const closed = await call('POST', `/agent/conversation/${target.id}/close`, { token: a2Tok, body: {} });
  assert('客服结束会话', closed.ok);
  const rate = await call('POST', '/visitor/rate', { token: vTok, body: { score: 5, tags: ['响应快', '专业'], comment: '处理很及时' } });
  assert('访客提交满意度评价', rate.ok && rate.data.conversation.satisfaction === 5, '5 星');
  const dup = await call('POST', '/visitor/rate', { token: vTok, body: { score: 1 } });
  assert('重复评价被拦截', dup.ok && dup.data.duplicated === true);

  /* 13. 管理员统计与检索 */
  const admin = await call('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  const aTok = admin.data && admin.data.token;
  assert('管理员登录成功', Boolean(aTok), admin.data && admin.data.user.name);

  const stats = await call('GET', '/admin/stats?days=7', { token: aTok });
  const kpi = (stats.data && stats.data.kpi) || {};
  assert('管理后台统计可用', stats.ok && kpi.total > 0,
    `会话 ${kpi.total} · 转人工率 ${kpi.humanRate}% · 满意度 ${kpi.csat}`);
  assert('趋势与满意度分布有数据', (stats.data.series || []).length === 7 && (stats.data.csatDist || []).some((n) => n > 0));

  const search = await call('GET', '/admin/conversations?q=' + encodeURIComponent('验收访客'), { token: aTok });
  assert('聊天记录可检索', search.ok && search.data.total >= 1, `${search.data.total} 条结果`);

  const record = await call('GET', `/admin/conversation/${target.id}`, { token: aTok });
  assert('管理员可回溯完整会话与处理轨迹', record.ok && record.data.messages.length > 0 && record.data.events.length > 0,
    `${record.data.events.length} 个事件节点`);

  const closeAgain = await call('POST', `/admin/conversation/${target.id}/close`, { token: aTok, body: {} });
  assert('管理员可对异常会话强制结束（幂等）', closeAgain.ok);

  /* 14. 知识库写入后立即可命中 */
  const created = await call('POST', '/admin/kb', {
    token: aTok,
    body: {
      question: '验收专用：如何联系门店店长？',
      answer: '可在「我的-门店服务」中查看店长联系方式，或在聊天中留言，店长会在 2 小时内回电。',
      variants: '找店长|门店电话',
      keywords: '店长,门店,电话',
      category: '验收'
    }
  });
  assert('管理员新增知识条目', created.ok, `#${created.data && created.data.id}`);
  const hit = await call('POST', '/visitor/message', { token: vTok, body: { content: '怎么联系门店店长' } });
  const hitMsg = hit.data && hit.data.messages.find((m) => m.from === 'bot');
  assert('新增知识无需重启即可命中', Boolean(hitMsg && hitMsg.kbId === (created.data && created.data.id)),
    hitMsg ? `置信度 ${Math.round(hitMsg.confidence * 100)}%` : '无回答');
  await call('DELETE', `/admin/kb/${created.data.id}`, { token: aTok });

  finish();
}

function finish() {
  console.log('');
  console.log(`  结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? `\x1b[31m${failed} 失败\x1b[0m` : '0 失败'}`);
  if (failed) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n验证脚本异常：', err.message);
  console.log('请确认服务已启动（npm start）并且 BASE_URL 正确。\n');
  process.exit(1);
});
