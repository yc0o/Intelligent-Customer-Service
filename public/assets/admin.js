(function () {
  'use strict';

  CS.store.setScope('staff');

  const { api, store, esc, fmtDate, fmtFull, dur, durMin, toast, connectSSE, debounce, openModal, confirmDialog, qs, initials, stars, statusMap, agentStatusMap } = CS;

  let me = null;
  let view = 'overview';
  let days = 7;
  let stats = null;
  let agents = [];
  let kbList = [];
  let settings = null;
  let refreshTimer = null;

  const VIEW_META = {
    overview: { title: '运营概览', sub: '客服中心的实时运行状态与近期趋势' },
    records: { title: '会话记录', sub: '全量会话检索、质检回溯与客户信息' },
    kb: { title: '知识库', sub: '智能问答的答案来源，支持相似问法与关键词扩写' },
    team: { title: '客服团队', sub: '账号、在线状态与实时接待负载' },
    rules: { title: '规则配置', sub: '转人工策略、分配参数与访客侧文案' }
  };

  /* ---------------- 初始化 ---------------- */

  async function init() {
    if (!store.token) { location.replace('/login'); return; }
    try {
      const res = await api('/auth/me');
      me = res.user;
    } catch {
      store.token = '';
      location.replace('/login');
      return;
    }
    if (me.role !== 'admin') { location.replace('/agent'); return; }

    qs('#sideName').textContent = me.name;
    qs('#sideRole').textContent = me.title || '管理员';
    qs('#sideAvatar').textContent = initials(me.name);
    qs('#sideAvatar').style.background = me.color;

    bind();
    await switchView('overview');

    connectSSE('/stream', {
      refresh: debounce(() => {
        if (view === 'overview') loadOverview(true);
      }, 600)
    });
    refreshTimer = setInterval(() => {
      if (view === 'overview') loadOverview(true);
    }, 20000);
  }

  function bind() {
    qs('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) switchView(btn.dataset.view);
    });

    qs('#btnLogout').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
      store.token = '';
      location.replace('/login');
    });
  }

  async function switchView(next) {
    view = next;
    qs('#nav').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === next));
    Object.keys(VIEW_META).forEach((k) => qs(`#view-${k}`).classList.toggle('hidden', k !== next));
    qs('#pageTitle').textContent = VIEW_META[next].title;
    qs('#pageSub').textContent = VIEW_META[next].sub;
    renderActions();

    if (next === 'overview') await loadOverview();
    if (next === 'records') { await loadAgents(); await loadRecords(); }
    if (next === 'kb') await loadKb();
    if (next === 'team') { await loadAgents(); renderTeam(); }
    if (next === 'rules') await loadRules();
  }

  function renderActions() {
    const box = qs('#pageActions');
    if (view === 'overview') {
      box.innerHTML = `<div class="seg" id="rangeSeg">
        ${[7, 14, 30].map((d) => `<button data-d="${d}" class="${d === days ? 'on' : ''}">近 ${d} 天</button>`).join('')}
      </div>`;
      qs('#rangeSeg').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-d]');
        if (!btn) return;
        days = Number(btn.dataset.d);
        renderActions();
        loadOverview();
      });
    } else if (view === 'records') {
      box.innerHTML = '<button class="btn btn-sm" id="btnReload">刷新数据</button>';
      qs('#btnReload').onclick = () => loadRecords();
    } else if (view === 'kb') {
      box.innerHTML = '<button class="btn btn-primary btn-sm" id="btnNewKb">+ 新增知识</button>';
      qs('#btnNewKb').onclick = () => openKbModal(null);
    } else if (view === 'team') {
      box.innerHTML = '<button class="btn btn-primary btn-sm" id="btnNewAgent">+ 新增客服</button>';
      qs('#btnNewAgent').onclick = openAgentModal;
    } else {
      box.innerHTML = '';
    }
  }

  /* ---------------- 概览 ---------------- */

  async function loadOverview(silent) {
    try {
      stats = await api(`/admin/stats?days=${days}`);
      renderKpi();
      renderTrend();
      renderCsat();
      renderRank();
      renderGaps();
    } catch (e) {
      if (!silent) toast(e.message, 'err');
    }
  }

  function renderKpi() {
    const k = stats.kpi;
    const items = [
      { label: '会话总量', value: k.total || '—', unit: '起', foot: `今日 <i>${k.today}</i> 起 · 排队 ${k.waiting}` },
      { label: '人工转接率', value: k.total ? k.humanRate : '—', unit: '%', foot: `累计转接 <i>${k.transferCount}</i> 次` },
      { label: '机器人解决率', value: k.total ? k.botResolvedRate : '—', unit: '%', foot: '未进人工即结束' },
      { label: '平均首次响应', value: k.avgFirstResp ? (k.avgFirstResp >= 120 ? (k.avgFirstResp / 60).toFixed(1) : k.avgFirstResp) : '—', unit: k.avgFirstResp >= 120 ? '分钟' : '秒', foot: '从接入到首条回复' },
      { label: '平均会话时长', value: k.avgDuration || '—', unit: '分钟', foot: '已结束会话' },
      { label: '满意度', value: k.csat ? k.csat.toFixed(1) : '—', unit: '/ 5', foot: `评价率 <i>${k.ratedRate}%</i>` }
    ];
    qs('#kpiGrid').innerHTML = items.map((i) => `
      <div class="kpi">
        <span>${i.label}</span>
        <b>${i.value}<small>${i.unit}</small></b>
        <em>${i.foot}</em>
      </div>`).join('');
  }

  function niceMax(v) {
    const base = Math.max(4, v);
    return Math.ceil(base / 4) * 4;
  }

  function renderTrend() {
    const series = stats.series;
    const W = 720;
    const H = 232;
    const padL = 32;
    const padR = 6;
    const padT = 12;
    const padB = 26;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const max = Math.max(4, ...series.map((s) => s.total));
    const step = niceMax(max);
    const slot = innerW / Math.max(series.length, 1);
    const bw = Math.min(30, slot * 0.44);
    const baseY = padT + innerH;

    let grid = '';
    for (let i = 0; i <= 4; i += 1) {
      const y = padT + (innerH * i) / 4;
      const v = Math.round((step * (4 - i)) / 4);
      grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#eef1f6" stroke-width="1"/>`;
      grid += `<text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#aab2bf">${v}</text>`;
    }

    let bars = '';
    series.forEach((s, i) => {
      const cx = padL + slot * (i + 0.5);
      const humanH = (s.human / step) * innerH;
      const botH = (s.bot / step) * innerH;
      const otherH = Math.max(0, (s.total / step) * innerH - humanH - botH);
      const x = cx - bw / 2;

      if (otherH > 0.4) {
        bars += `<rect x="${x.toFixed(1)}" y="${(baseY - humanH - botH - otherH).toFixed(1)}" width="${bw.toFixed(1)}" height="${otherH.toFixed(1)}" fill="#e3e8f0" rx="2"><title>${s.label} 进行中/未结束 ${Math.max(0, s.total - s.human - s.bot)}</title></rect>`;
      }
      if (botH > 0.4) {
        bars += `<rect x="${x.toFixed(1)}" y="${(baseY - humanH - botH).toFixed(1)}" width="${bw.toFixed(1)}" height="${botH.toFixed(1)}" fill="#e8582a" rx="2"><title>${s.label} 机器人解决 ${s.bot}</title></rect>`;
      }
      if (humanH > 0.4) {
        bars += `<rect x="${x.toFixed(1)}" y="${(baseY - humanH).toFixed(1)}" width="${bw.toFixed(1)}" height="${humanH.toFixed(1)}" fill="#1f2a3c" rx="2"><title>${s.label} 人工接待 ${s.human}</title></rect>`;
      }
      if (s.total === 0) {
        bars += `<circle cx="${cx.toFixed(1)}" cy="${(baseY - 4).toFixed(1)}" r="2" fill="#e3e8f0"/>`;
      }
      bars += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#8a94a4">${s.label}</text>`;
      if (s.total) {
        bars += `<text x="${cx.toFixed(1)}" y="${(baseY - (s.total / step) * innerH - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#4b5666">${s.total}</text>`;
      }
    });

    qs('#trendChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="会话趋势">${grid}${bars}</svg>`;
  }

  function renderCsat() {
    const dist = stats.csatDist || [0, 0, 0, 0, 0];
    const total = dist.reduce((a, b) => a + b, 0);
    const avg = stats.kpi.csat;
    qs('#csatMeta').textContent = total ? `${total} 条评价` : '暂无评价';

    const top = `<div class="csat-top">
      <b>${avg ? avg.toFixed(2) : '—'}</b>
      <span>${total ? `/ 5 · 共 ${total} 条评价` : '等待第一份评价'}</span>
    </div>`;

    const rows = [5, 4, 3, 2, 1].map((score) => {
      const n = dist[score - 1];
      const pct = total ? (n / total) * 100 : 0;
      return `<div class="csat-row">
        <span class="lb">${score} 星</span>
        <span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="n">${n} 条 · ${total ? Math.round(pct) : 0}%</span>
      </div>`;
    }).join('');

    qs('#csatChart').innerHTML = top + rows;
  }

  function renderRank() {
    const list = stats.agentRank || [];
    if (!list.length) {
      qs('#agentRank').innerHTML = '<p class="tiny muted">暂无数据</p>';
      return;
    }
    const max = Math.max(...list.map((a) => a.handled), 1);
    qs('#agentRank').innerHTML = list.map((a, i) => `
      <div class="rank-row">
        <span class="rank-idx">${i + 1}</span>
        <span class="avatar avatar-sm" style="background:${a.color}">${esc(initials(a.name))}</span>
        <div class="rank-name">
          <b>${esc(a.name)}</b>
          <span>${agentStatusMap[a.status] ? agentStatusMap[a.status].text : a.status} · 在接 ${a.active}</span>
        </div>
        <span class="rank-bar"><i style="width:${((a.handled / max) * 100).toFixed(0)}%;background:${a.color}"></i></span>
        <span class="rank-val">${a.handled} 起 ${a.avgCsat ? `<small>· ${a.avgCsat.toFixed(1)} 分</small>` : ''}</span>
      </div>`).join('');
  }

  function renderGaps() {
    const gaps = stats.gaps || [];
    if (!gaps.length) {
      qs('#kbGaps').innerHTML = '<p class="tiny muted">近期没有低置信度提问，知识库覆盖良好。</p>';
      return;
    }
    qs('#kbGaps').innerHTML = gaps.map((g) => `
      <div class="gap-row">
        <div class="gap-q">${esc(g.question)}<span>最近一次 ${fmtDate(g.lastAt)} · 最低置信度 ${Math.round(g.confidence * 100)}%</span></div>
        <span class="gap-count">${g.count} 次</span>
        <button class="btn btn-xs" data-gap="${esc(g.question)}">补知识</button>
      </div>`).join('');

    qs('#kbGaps').querySelectorAll('[data-gap]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await switchView('kb');
        openKbModal(null, btn.dataset.gap);
      });
    });
  }

  /* ---------------- 会话记录 ---------------- */

  async function loadAgents() {
    if (agents.length) return;
    try {
      agents = await api('/admin/agents');
      const sel = qs('#fAgent');
      sel.innerHTML = '<option value="all">全部接待</option><option value="bot">仅机器人</option>' +
        agents.filter((a) => a.role === 'agent')
          .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadRecords() {
    const p = new URLSearchParams({
      q: qs('#fq').value.trim(),
      status: qs('#fStatus').value,
      agentId: qs('#fAgent').value,
      csat: qs('#fCsat').value,
      from: qs('#fFrom').value,
      to: qs('#fTo').value
    });
    try {
      const res = await api(`/admin/conversations?${p.toString()}`);
      renderRecords(res.items);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function renderRecords(items) {
    const body = qs('#recordBody');
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty" style="padding:40px"><p>没有符合条件的会话</p></div></td></tr>';
      return;
    }
    body.innerHTML = items.map((c) => {
      const st = statusMap[c.status] || { text: c.status, cls: 'badge' };
      return `<tr data-rec="${c.id}">
        <td><b class="mono">#${c.id}</b></td>
        <td>
          <div class="rec-meta"><span class="avatar avatar-sm" style="width:24px;height:24px;font-size:9.5px;background:#4b5666">${esc(initials(c.visitorName))}</span><span class="strong">${esc(c.visitorName || '访客')}</span></div>
          <div class="rec-sub">${esc(c.visitorLevel || '')} · ${esc(c.topic || '综合咨询')}</div>
        </td>
        <td>${c.agentName ? `<span class="badge badge-blue">${esc(c.agentName)}</span>` : '<span class="badge">机器人</span>'}</td>
        <td><span class="badge ${st.cls || ''}">${st.text}</span></td>
        <td class="mono">${c.durationMin != null ? durMin(c.durationMin) : '—'}</td>
        <td>${c.satisfaction ? `<span class="stars-sm">${stars(c.satisfaction)}</span>` : '<span class="muted tiny">未评价</span>'}</td>
        <td class="mono tiny">${fmtDate(c.startedAt)}</td>
        <td><button class="btn btn-xs" data-rec-btn="${c.id}">查看</button></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-rec], [data-rec-btn]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const id = el.dataset.rec || el.dataset.recBtn;
        if (id) openRecord(Number(id));
        e.stopPropagation();
      });
    });
  }

  async function openRecord(id) {
    let d;
    try { d = await api(`/admin/conversation/${id}`); } catch (e) { toast(e.message, 'err'); return; }
    const c = d.conversation;
    const v = d.visitor;
    const st = statusMap[c.status] || { text: c.status };

    const transcript = d.messages.map((m) => {
      if (m.from === 'system') return `<div class="tr-sys">${esc(m.content)}</div>`;
      const who = m.from === 'visitor' ? '访客' : m.from === 'agent' ? '客服' : 'AI';
      const cls = m.from === 'agent' ? 'agent' : m.from === 'visitor' ? 'out' : '';
      return `<div class="tr-row ${cls}">
        <span class="tr-who">${who}</span>
        <div class="tr-bubble">${esc(m.content)}<span class="tr-time">${fmtDate(m.at)}</span></div>
      </div>`;
    }).join('') || '<p class="tiny muted">暂无消息</p>';

    const timeline = (d.events || []).map((e) => `
      <div class="tl-item">
        <b>${esc(eventLabel(e.type))}${e.detail ? ` · ${esc(e.detail)}` : ''}</b>
        <span>${fmtFull(e.at)}</span>
      </div>`).join('') || '<p class="tiny muted">暂无事件</p>';

    const modal = openModal({
      title: `会话 #${c.id} · ${esc(v.name)}`,
      wide: true,
      content: `
        <div class="rec-head-grid">
          <div class="rec-box"><span>会话状态</span><b>${st.text}</b></div>
          <div class="rec-box"><span>接待客服</span><b>${c.agentName ? esc(c.agentName) : '机器人'}</b></div>
          <div class="rec-box"><span>会话时长</span><b>${c.durationMin != null ? durMin(c.durationMin) : '进行中'}</b></div>
          <div class="rec-box"><span>满意度</span><b>${c.satisfaction ? `${c.satisfaction} 星` : '未评价'}</b></div>
        </div>

        <div class="row gap-8 wrap" style="margin-bottom:14px">
          <span class="badge badge-outline">${esc(v.level || '普通会员')}</span>
          ${(v.tags || []).map((t) => `<span class="badge badge-outline">${esc(t)}</span>`).join('')}
          <span class="badge badge-outline">${esc(v.source || '官网')}</span>
          <span class="badge badge-outline">${esc(v.device || '未知设备')}</span>
        </div>

        <div style="font-size:11px;color:var(--ink-4);letter-spacing:.06em;margin-bottom:6px">对话记录</div>
        <div class="transcript">${transcript}</div>

        ${c.satisfactionComment ? `<div class="rule-note" style="margin-top:12px"><b>访客评价</b><p>${'★'.repeat(c.satisfaction)} ${esc(c.satisfactionComment)}${c.satisfactionTags ? `（${esc(c.satisfactionTags)}）` : ''}</p></div>` : ''}

        <div style="font-size:11px;color:var(--ink-4);letter-spacing:.06em;margin:16px 0 6px">处理轨迹</div>
        <div class="timeline">${timeline}</div>

        <div class="rec-foot">
          <span>访客 ID ${v.id}</span><span>·</span><span>历史会话 ${v.historyCount || 0} 次</span>
          ${c.summary ? `<div class="rec-sum">AI 摘要：${esc(c.summary).replace(/\n/g, ' / ')}</div>` : ''}
        </div>`,
      footer: `${c.status !== 'closed' ? '<button class="btn btn-danger" data-act="close">强制结束会话</button>' : ''}
               <button class="btn" data-act="ok">关闭</button>`
    });

    modal.foot.querySelector('[data-act="ok"]').onclick = modal.close;
    const closeBtn = modal.foot.querySelector('[data-act="close"]');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        const ok = await confirmDialog('强制结束会话？', '该会话将立即结束，访客会看到结束提示。通常仅在客服长时间未响应时使用。', { okText: '结束会话', danger: true });
        if (!ok) return;
        try {
          await api(`/admin/conversation/${c.id}/close`, { method: 'POST', body: {} });
          toast('会话已结束', 'ok');
          modal.close();
          loadRecords();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }

  function eventLabel(type) {
    return {
      start: '会话开始',
      transfer_human: '转人工',
      assign: '接入会话',
      transfer_agent: '客服转接',
      close: '结束会话',
      rating: '访客评价'
    }[type] || type;
  }

  /* ---------------- 知识库 ---------------- */

  async function loadKb() {
    try {
      kbList = await api(`/admin/kb?q=${encodeURIComponent(qs('#kbQ') ? qs('#kbQ').value.trim() : '')}`);
      renderKb();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderKb() {
    qs('#kbCount').textContent = `共 ${kbList.length} 条`;
    const body = qs('#kbBody');
    if (!kbList.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="empty" style="padding:40px"><p>暂无知识条目</p></div></td></tr>';
      return;
    }
    body.innerHTML = kbList.map((k) => `
      <tr>
        <td>
          <div class="strong">${esc(k.question)}</div>
          <div class="rec-sub truncate" style="max-width:420px">${esc(k.keywords || '—')}</div>
        </td>
        <td><span class="badge badge-outline">${esc(k.category)}</span></td>
        <td class="mono">${k.hits}</td>
        <td><span class="badge ${k.enabled ? 'badge-green' : ''}">${k.enabled ? '启用' : '停用'}</span></td>
        <td class="tiny muted mono">${(k.updatedAt || '').slice(0, 10)}</td>
        <td>
          <div class="row gap-4" style="justify-content:flex-end">
            <button class="btn btn-xs" data-edit="${k.id}">编辑</button>
            <button class="btn btn-xs" data-toggle="${k.id}">${k.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-xs btn-danger" data-del="${k.id}">删除</button>
          </div>
        </td>
      </tr>`).join('');

    body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const item = kbList.find((k) => k.id === Number(b.dataset.edit));
      openKbModal(item);
    }));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const item = kbList.find((k) => k.id === Number(b.dataset.toggle));
      try {
        await api(`/admin/kb/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
        toast(item.enabled ? '已停用' : '已启用', 'ok');
        loadKb();
      } catch (e) { toast(e.message, 'err'); }
    }));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const item = kbList.find((k) => k.id === Number(b.dataset.del));
      const ok = await confirmDialog('删除这条知识？', `「${item.question}」删除后机器人将不再命中该答案，历史命中数据会保留。`, { okText: '删除', danger: true });
      if (!ok) return;
      try {
        await api(`/admin/kb/${item.id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        loadKb();
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  function openKbModal(item, prefillQuestion) {
    const isEdit = Boolean(item);
    const m = openModal({
      title: isEdit ? '编辑知识条目' : '新增知识条目',
      wide: true,
      content: `
        <div class="field" style="margin-bottom:14px">
          <label>标准问题</label>
          <input class="input" id="kbQuestion" value="${esc(item ? item.question : prefillQuestion || '')}" placeholder="例如：退款多久能到账？" />
        </div>
        <div class="field" style="margin-bottom:14px">
          <label>答案</label>
          <textarea class="textarea" id="kbAnswer" style="min-height:120px" placeholder="给出可执行的步骤与时限">${esc(item ? item.answer : '')}</textarea>
        </div>
        <div class="grid-2" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div class="field">
            <label>相似问法（用 | 分隔）</label>
            <input class="input" id="kbVariants" value="${esc(item ? item.variants : '')}" placeholder="退款什么时候到账|多久退款" />
          </div>
          <div class="field">
            <label>关键词（用英文逗号分隔）</label>
            <input class="input" id="kbKeywords" value="${esc(item ? item.keywords : '')}" placeholder="退款,到账,多久" />
          </div>
        </div>
        <div class="field" style="max-width:200px">
          <label>分类</label>
          <input class="input" id="kbCategory" value="${esc(item ? item.category : '通用')}" />
        </div>
        <p class="tiny muted" style="margin-top:12px">相似问法与关键词会一起参与匹配，建议覆盖访客的常见口语表达。</p>`,
      footer: `<button class="btn" data-act="cancel">取消</button><button class="btn btn-primary" data-act="ok">${isEdit ? '保存' : '创建'}</button>`
    });
    m.foot.querySelector('[data-act="cancel"]').onclick = m.close;
    m.foot.querySelector('[data-act="ok"]').onclick = async () => {
      const body = {
        question: qs('#kbQuestion', m.modal).value.trim(),
        answer: qs('#kbAnswer', m.modal).value.trim(),
        variants: qs('#kbVariants', m.modal).value.trim(),
        keywords: qs('#kbKeywords', m.modal).value.trim(),
        category: qs('#kbCategory', m.modal).value.trim() || '通用'
      };
      if (!body.question || !body.answer) { toast('问题和答案不能为空', 'err'); return; }
      try {
        if (isEdit) await api(`/admin/kb/${item.id}`, { method: 'PUT', body });
        else await api('/admin/kb', { method: 'POST', body });
        m.close();
        toast(isEdit ? '已保存' : '已创建', 'ok');
        loadKb();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ---------------- 团队 ---------------- */

  function renderTeam() {
    const list = agents.filter((a) => a.role === 'agent');
    qs('#teamGrid').innerHTML = list.map((a) => {
      const st = agentStatusMap[a.status] || agentStatusMap.offline;
      return `<div class="agent-card">
        <div class="ac-head">
          <span class="avatar" style="background:${a.color}">${esc(initials(a.name))}</span>
          <div class="ac-name">
            <b>${esc(a.name)}</b>
            <span>${esc(a.title || '客服')} · ${esc(a.username)}</span>
          </div>
          <span class="badge ${a.status === 'online' ? 'badge-green' : a.status === 'busy' ? 'badge-amber' : ''}">
            <span class="dot ${st.dot}"></span>${st.text}
          </span>
        </div>
        <div class="ac-stats">
          <div class="ac-stat"><b>${a.active}</b><span>正在接待</span></div>
          <div class="ac-stat"><b>${a.handled}</b><span>累计接待</span></div>
          <div class="ac-stat"><b>${a.avgCsat ? a.avgCsat.toFixed(1) : '—'}</b><span>平均评分</span></div>
        </div>
        <div class="ac-foot">
          <span class="tiny muted">${a.role === 'admin' ? '管理员 · 不参与分配' : '客服 · 参与自动分配'}</span>
          <button class="btn btn-xs" data-agent="${a.id}">调整状态</button>
        </div>
      </div>`;
    }).join('') || '<p class="tiny muted">暂无客服账号</p>';

    qs('#teamGrid').querySelectorAll('[data-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = agents.find((x) => x.id === Number(btn.dataset.agent));
        const m = openModal({
          title: `调整 ${a.name} 的状态`,
          content: `<div class="field"><label>账号状态</label>
            <select class="select" id="agentStatus">
              <option value="online" ${a.status === 'online' ? 'selected' : ''}>在线（参与分配）</option>
              <option value="busy" ${a.status === 'busy' ? 'selected' : ''}>忙碌（不接新会话）</option>
              <option value="offline" ${a.status === 'offline' ? 'selected' : ''}>离线（退出队列）</option>
            </select></div>
            <p class="tiny muted" style="margin-top:10px">状态调整会立即生效；离线不会中断已接入的会话。</p>`,
          footer: '<button class="btn" data-act="cancel">取消</button><button class="btn btn-primary" data-act="ok">保存</button>'
        });
        m.foot.querySelector('[data-act="cancel"]').onclick = m.close;
        m.foot.querySelector('[data-act="ok"]').onclick = async () => {
          try {
            await api(`/admin/agents/${a.id}`, { method: 'PUT', body: { status: qs('#agentStatus', m.modal).value } });
            m.close();
            toast('已更新', 'ok');
            agents = [];
            await loadAgents();
            renderTeam();
          } catch (e) { toast(e.message, 'err'); }
        };
      });
    });
  }

  function openAgentModal() {
    const colors = ['#f2612c', '#2563eb', '#0f9d6e', '#7c3aed', '#0891b2'];
    const m = openModal({
      title: '新增客服账号',
      content: `
        <div class="field" style="margin-bottom:14px"><label>姓名</label><input class="input" id="agName" placeholder="例如：许清" /></div>
        <div class="field" style="margin-bottom:14px"><label>登录账号</label><input class="input" id="agUser" placeholder="英文或数字，例如 agent4" /></div>
        <div class="field" style="margin-bottom:14px"><label>初始密码</label><input class="input" id="agPass" type="text" placeholder="至少 6 位" /></div>
        <div class="field" style="margin-bottom:14px"><label>岗位</label><input class="input" id="agTitle" placeholder="例如：客服 · 售后组" /></div>
        <div class="field"><label>头像颜色</label>
          <select class="select" id="agColor">${colors.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>`,
      footer: '<button class="btn" data-act="cancel">取消</button><button class="btn btn-primary" data-act="ok">创建</button>'
    });
    m.foot.querySelector('[data-act="cancel"]').onclick = m.close;
    m.foot.querySelector('[data-act="ok"]').onclick = async () => {
      try {
        await api('/admin/agents', {
          method: 'POST',
          body: {
            name: qs('#agName', m.modal).value.trim(),
            username: qs('#agUser', m.modal).value.trim(),
            password: qs('#agPass', m.modal).value.trim(),
            title: qs('#agTitle', m.modal).value.trim() || '客服',
            color: qs('#agColor', m.modal).value
          }
        });
        m.close();
        toast('已创建客服账号', 'ok');
        agents = [];
        await loadAgents();
        renderTeam();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ---------------- 规则 ---------------- */

  async function loadRules() {
    try {
      settings = await api('/admin/settings');
      const f = qs('#rulesForm');
      ['brand_name', 'welcome', 'max_concurrent', 'queue_notice', 'work_hours', 'rating_prompt'].forEach((k) => {
        if (f[k]) f[k].value = settings[k];
      });
      const range = qs('#thresholdRange');
      range.value = settings.confidence_threshold;
      qs('#thresholdVal').textContent = Number(settings.confidence_threshold).toFixed(2);
      range.oninput = () => { qs('#thresholdVal').textContent = Number(range.value).toFixed(2); };
      qs('#autoAssign').checked = Boolean(settings.auto_assign);
      qs('#rulesHint').textContent = '';
    } catch (e) { toast(e.message, 'err'); }
  }

  qs('#rulesForm') && qs('#rulesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: {
          brand_name: f.brand_name.value,
          welcome: f.welcome.value,
          confidence_threshold: Number(qs('#thresholdRange').value),
          max_concurrent: Number(f.max_concurrent.value),
          auto_assign: qs('#autoAssign').checked,
          queue_notice: f.queue_notice.value,
          work_hours: f.work_hours.value,
          rating_prompt: f.rating_prompt.value
        }
      });
      qs('#rulesHint').textContent = '已保存并生效';
      toast('配置已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------------- 绑定筛选 ---------------- */

  qs('#btnSearch') && qs('#btnSearch').addEventListener('click', loadRecords);
  qs('#btnReset') && qs('#btnReset').addEventListener('click', () => {
    qs('#fq').value = '';
    qs('#fStatus').value = 'all';
    qs('#fAgent').value = 'all';
    qs('#fCsat').value = 'all';
    qs('#fFrom').value = '';
    qs('#fTo').value = '';
    loadRecords();
  });
  qs('#fq') && qs('#fq').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
  qs('#kbQ') && qs('#kbQ').addEventListener('input', debounce(loadKb, 280));

  init();
})();
