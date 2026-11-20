(function () {
  'use strict';

  CS.store.setScope('staff');

  const { api, store, esc, fmtTime, fmtDate, relTime, dur, toast, connectSSE, debounce, confirmDialog, openModal, qs, initials, statusMap, agentStatusMap } = CS;

  let me = null;
  let myStats = null;
  let tab = 'queue';
  let keyword = '';
  let convs = [];
  let overview = { queue: [], mine: [], counts: { queue: 0, mine: 0, maxConcurrent: 4 }, load: 0 };
  let currentId = null;
  let detail = null;
  let visitorHistory = null;
  let quickReplies = [];
  let pTab = 'customer';
  let kbState = { q: '', results: null };
  let typingTimer = null;

  const listEl = qs('#convList');
  const chatEmpty = qs('#chatEmpty');
  const chatView = qs('#chatView');
  const cBody = qs('#cBody');
  const cInput = qs('#cInput');
  const pBody = qs('#pBody');
  const profilePane = qs('#profilePane');

  const palette = ['#e8582a', '#2563eb', '#0f9d6e', '#7c3aed', '#0891b2', '#b45309'];
  const colorOf = (name) => {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return palette[h % palette.length];
  };

  /* ---------------- 启动 ---------------- */

  async function init() {
    if (!store.token) { location.replace('/login'); return; }
    try {
      const res = await api('/auth/me');
      me = res.user;
      myStats = res.stats;
    } catch {
      store.token = '';
      location.replace('/login');
      return;
    }
    if (me.role !== 'agent') { location.replace('/admin'); return; }

    qs('#meName').textContent = me.name;
    qs('#meTitle').textContent = me.title || '客服';
    qs('#meAvatar').textContent = initials(me.name);
    qs('#meAvatar').style.background = me.color;
    setStatusUI(me.status);

    try { quickReplies = await api('/agent/quick-replies'); } catch { quickReplies = []; }

    renderProfile();
    await loadList(true);

    connectSSE('/stream', {
      refresh: debounce(() => onRefresh(), 180),
      typing: onTyping
    });

    setInterval(() => {
      if (tab === 'queue') renderList();
      if (qs('#statusMenu').classList.contains('hidden') === false) return;
      loadList(false);
    }, 12000);
  }

  async function loadList(autoSelect) {
    try {
      const q = encodeURIComponent(keyword.trim());
      const [ov, list] = await Promise.all([
        api('/agent/overview'),
        api(`/agent/conversations?scope=${tab}&q=${q}`)
      ]);
      overview = ov;
      convs = list;
      renderCounts();
      renderList();

      if (autoSelect && tab === 'queue' && !convs.length && overview.mine.length) {
        tab = 'mine';
        qs('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'mine'));
        return loadList(true);
      }
      if (autoSelect && !currentId && convs.length && window.innerWidth > 860) {
        openConversation(convs[0].id, false);
      }
    } catch (e) {
      if (e.code === 'unauthenticated') location.replace('/login');
    }
  }

  async function onRefresh() {
    await loadList(false);
    if (currentId) {
      try {
        await openConversation(currentId, false, true);
      } catch { /* handled inside */ }
    }
  }

  /* ---------------- 列表 ---------------- */

  function renderCounts() {
    const qn = overview.counts.queue;
    const badge = qs('#queueBadge');
    badge.textContent = qn;
    badge.classList.toggle('hidden', qn === 0);
    qs('#loadHint').textContent = `负载 ${overview.counts.mine} / ${overview.counts.maxConcurrent}`;
  }

  function waitedText(c) {
    const sec = c.waitedSec != null ? c.waitedSec : Math.round((Date.now() - new Date(c.queueAt || c.startedAt)) / 1000);
    return sec < 60 ? `${Math.max(1, sec)} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  }

  function renderList() {
    if (!convs.length) {
      listEl.innerHTML = `<div class="empty" style="padding:44px 20px">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5v-3.5H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" stroke="currentColor" stroke-width="1.3"/></svg>
        <p>${keyword ? '没有匹配的会话' : tab === 'queue' ? '暂无排队会话' : '还没有接入会话'}</p>
      </div>`;
      return;
    }
    listEl.innerHTML = convs.map((c) => {
      const active = c.id === currentId ? 'active' : '';
      const isQueue = c.status === 'waiting';
      return `<div class="conv-item ${active}" data-id="${c.id}">
        <div class="conv-row1">
          <span class="avatar avatar-sm" style="background:${colorOf(c.visitorName)}">${esc(initials(c.visitorName))}</span>
          <span class="conv-name">${esc(c.visitorName || '访客')}</span>
          <span class="conv-time">${isQueue ? waitedText(c) : relTime(c.lastMessageAt)}</span>
        </div>
        <div class="conv-preview">${esc(c.lastMessage || '（暂无消息）')}</div>
        <div class="conv-meta">
          ${isQueue
            ? '<span class="badge badge-amber">等待接入</span>'
            : `<span class="badge ${c.mode === 'human' ? 'badge-blue' : 'badge-green'}">${c.mode === 'human' ? '人工中' : '机器人'}</span>`}
          ${c.visitorLevel ? `<span class="badge badge-outline">${esc(c.visitorLevel)}</span>` : ''}
          ${c.topic ? `<span class="tiny muted truncate">${esc(c.topic)}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.conv-item').forEach((el) => {
      el.addEventListener('click', () => openConversation(Number(el.dataset.id), true));
    });
  }

  /* ---------------- 会话详情 ---------------- */

  async function openConversation(id, pushView = true, keepDraft = false) {
    const draft = cInput.value;
    try {
      detail = await api(`/agent/conversation/${id}`);
      currentId = id;
      if (keepDraft) cInput.value = draft;
      visitorHistory = null;
      renderChat();
      renderList();
      if (pushView && window.innerWidth <= 860) document.body.classList.add('view-chat');
      loadVisitorHistory(detail.visitor.id);
    } catch (e) {
      if (e.code === 'forbidden' || e.code === 'not_found') {
        toast(e.message, 'err');
        currentId = null;
        detail = null;
        renderEmpty();
        loadList(false);
      }
    }
  }

  function renderEmpty() {
    chatView.classList.add('hidden');
    chatEmpty.classList.remove('hidden');
    if (window.innerWidth <= 860) document.body.classList.remove('view-chat');
  }

  function renderChat() {
    const c = detail.conversation;
    const v = detail.visitor;
    const mine = c.agentId === me.id;

    chatEmpty.classList.add('hidden');
    chatView.classList.remove('hidden');

    qs('#cAvatar').textContent = initials(v.name);
    qs('#cAvatar').style.background = colorOf(v.name);
    qs('#cName').textContent = v.name;
    qs('#cLevel').textContent = v.level || '普通会员';
    qs('#cLevel').className = `badge ${v.level && v.level.includes('VIP') ? 'badge-orange' : 'badge-outline'}`;
    qs('#cWaiting').classList.toggle('hidden', c.status !== 'waiting');
    qs('#cSub').textContent = `${v.source || '官网'} · ${v.device || '未知设备'} · 第 ${v.visits} 次来访`;

    qs('#btnTransfer').disabled = !mine || c.status !== 'active';
    qs('#btnEnd').disabled = !mine || c.status !== 'active';

    // AI 摘要
    const sumEl = qs('#cSummary');
    if (c.summary) {
      sumEl.classList.remove('hidden');
      qs('#cSummaryText').textContent = c.summary;
    } else if (c.status === 'waiting') {
      sumEl.classList.remove('hidden');
      qs('#cSummaryText').textContent = '访客正在排队等待接入，接入后可查看完整对话记录。';
    } else {
      sumEl.classList.add('hidden');
    }

    // 消息
    cBody.innerHTML = (detail.messages || []).map(msgRow).join('') || '<div class="m-sys"><span>暂无消息</span></div>';
    scrollChat();

    // 接入栏
    const claimBar = qs('#claimBar');
    if (c.status === 'waiting') {
      claimBar.classList.remove('hidden');
      qs('#claimBar').querySelector('b').textContent = mine ? '这是你的会话' : '该会话在排队中';
      qs('#btnClaim').textContent = mine ? '继续处理' : '接入会话';
      qs('#btnClaim').onclick = claimCurrent;
    } else {
      claimBar.classList.add('hidden');
    }

    const disabled = !mine || c.status !== 'active';
    cInput.disabled = disabled;
    qs('#btnSendMsg').disabled = disabled;
    cInput.placeholder = disabled
      ? c.status === 'closed' ? '会话已结束' : '接入会话后可回复'
      : '输入回复，Enter 发送 / Shift + Enter 换行';

    if (pTab === 'customer') renderProfile();
  }

  function msgRow(m) {
    if (m.from === 'system') return `<div class="m-sys"><span>${esc(m.content)}</span></div>`;
    const out = m.from === 'agent';
    const isBot = m.from === 'bot';
    const name = out ? me.name : isBot ? '智能客服' : detail.visitor.name;
    const color = out ? me.color : isBot ? '#e8582a' : '#4b5666';
    const tag = isBot
      ? '<span class="badge badge-orange" style="height:15px;padding:0 5px;font-size:9px">AI</span>'
      : '';
    const conf = isBot && m.confidence != null && m.confidence < 0.999
      ? `<span class="score">置信度 ${Math.round(m.confidence * 100)}%</span>` : '';
    return `<div class="m-row ${out ? 'out' : isBot ? 'bot' : 'in'}">
      <span class="avatar avatar-sm" style="background:${color}">${esc(initials(name))}</span>
      <div class="m-col">
        <div class="m-head"><span>${esc(name)}</span>${tag}${conf}</div>
        <div class="m-bubble">${esc(m.content)}</div>
        <div class="m-time">${fmtTime(m.at)}</div>
      </div>
    </div>`;
  }

  function scrollChat() {
    requestAnimationFrame(() => { cBody.scrollTop = cBody.scrollHeight; });
  }

  async function claimCurrent() {
    if (!currentId) return;
    try {
      await api(`/agent/conversation/${currentId}/claim`, { method: 'POST', body: {} });
      toast('已接入会话', 'ok');
      await loadList(false);
      await openConversation(currentId, false, true);
      cInput.focus();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function sendMessage() {
    const text = cInput.value.trim();
    if (!text || !detail) return;
    if (detail.conversation.agentId !== me.id) return;
    cInput.value = '';
    autoGrow();
    try {
      await api(`/agent/conversation/${currentId}/message`, { method: 'POST', body: { content: text } });
      await openConversation(currentId, false, true);
      await loadList(false);
      cInput.focus();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function autoGrow() {
    cInput.style.height = 'auto';
    cInput.style.height = `${Math.min(cInput.scrollHeight, 120)}px`;
  }

  /* ---------------- 右侧面板 ---------------- */

  function renderProfile() {
    if (!detail) {
      pBody.innerHTML = `<div class="empty" style="padding:40px 16px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.3"/><path d="M5.4 19.5c.5-3.3 3.2-5.4 6.6-5.4s6.1 2.1 6.6 5.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <p>选择左侧会话后<br/>查看客户资料与话术建议</p>
      </div>`;
      return;
    }
    if (pTab === 'customer') renderCustomer();
    else renderAssist();
  }

  function renderCustomer() {
    const v = detail.visitor;
    const c = detail.conversation;
    const tags = (v.tags || []).map((t) => `<span class="badge badge-outline">${esc(t)}</span>`).join('');
    const hist = (visitorHistory && visitorHistory.conversations) || [];

    pBody.innerHTML = `
      <div class="cust-hero">
        <span class="avatar" style="background:${colorOf(v.name)}">${esc(initials(v.name))}</span>
        <div>
          <div class="cust-name">${esc(v.name)}</div>
          <div class="cust-sub">${esc(v.level || '普通会员')}${v.city ? ` · ${esc(v.city)}` : ''}</div>
        </div>
      </div>
      ${tags ? `<div class="tag-row">${tags}</div>` : '<div style="height:10px"></div>'}

      <div class="sec-title">基础信息</div>
      <div class="kv"><span>手机号</span><b>${esc(v.phone || '未提供')}</b></div>
      <div class="kv"><span>来源渠道</span><b>${esc(v.source || '—')}</b></div>
      <div class="kv"><span>设备</span><b>${esc(v.device || '—')}</b></div>
      <div class="kv"><span>来访次数</span><b>${v.visits} 次</b></div>
      <div class="kv"><span>首次到访</span><b>${esc((v.createdAt || '').slice(0, 10))}</b></div>

      <div class="sec-title">服务记录</div>
      <div class="kv"><span>历史会话</span><b>${v.historyCount || 0} 次</b></div>
      <div class="kv"><span>平均评分</span><b>${v.historyCsat ? `${v.historyCsat} / 5` : '暂无评价'}</b></div>
      <div class="kv"><span>本次转接</span><b>${c.transferCount || 0} 次</b></div>

      <div class="sec-title">当前会话</div>
      <div class="kv"><span>状态</span><b>${statusMap[c.status] ? statusMap[c.status].text : c.status}</b></div>
      <div class="kv"><span>当前话题</span><b>${esc(c.topic || '—')}</b></div>
      <div class="kv"><span>发起时间</span><b>${c.startedAt ? fmtDate(c.startedAt) : '—'}</b></div>

      <div class="sec-title">最近会话</div>
      ${hist.length ? hist.slice(0, 5).map((h) => `
        <div class="hist-item">
          <div class="hist-top">
            <b>${esc(h.topic || '综合咨询')}</b>
            <span class="badge badge-outline" style="height:17px;font-size:9.5px">${statusMap[h.status] ? statusMap[h.status].text : h.status}</span>
          </div>
          <div class="hist-sub">${h.startedAt ? fmtDate(h.startedAt) : '—'} · ${h.satisfaction ? `${h.satisfaction} 星` : '未评价'}</div>
        </div>`).join('') : '<p class="tiny muted" style="padding:6px 0">暂无历史会话</p>'}
    `;
  }

  function renderAssist() {
    const assist = (detail && detail.assist) || [];
    const results = kbState.results;
    pBody.innerHTML = `
      <div class="asst-title">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2.2 9.6 6l3.9.3-3 2.5.9 3.8L8 10.5 4.6 12.6l.9-3.8-3-2.5L6.4 6 8 2.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        AI 推荐答案${assist.length ? '' : '（暂无）'}
      </div>
      ${assist.map((a) => `
        <div class="asst-card">
          <div class="asst-q">${esc(a.question)}</div>
          <div class="asst-a">${esc(a.answer)}</div>
          <div class="asst-foot">
            <span class="score">匹配度 ${Math.round(a.score * 100)}%</span>
            <button class="btn btn-xs" data-fill="${esc(a.answer)}">填入</button>
          </div>
        </div>`).join('')}

      <div class="asst-title" style="margin-top:16px">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.3"/><path d="m10.4 10.4 3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        知识库检索
      </div>
      <div class="search-box" style="margin-top:0;margin-bottom:10px">
        <input id="kbSearch" placeholder="输入关键词，回车检索" value="${esc(kbState.q)}" />
      </div>
      ${results
        ? results.map((r) => `
          <div class="asst-card">
            <div class="asst-q">${esc(r.question)}</div>
            <div class="asst-a">${esc(r.answer)}</div>
            <div class="asst-foot">
              <span class="score">${esc(r.category || '通用')}</span>
              <button class="btn btn-xs" data-fill="${esc(r.answer)}">填入</button>
            </div>
          </div>`).join('') || '<p class="tiny muted">没有找到相关条目</p>'
        : ''}

      <div class="asst-title" style="margin-top:16px">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 8h7M3 12h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        快捷回复
      </div>
      ${quickReplies.map((q) => `
        <div class="quick-item" data-fill="${esc(q.content)}">
          <b>${esc(q.title)}</b>
          <span>${esc(q.content)}</span>
        </div>`).join('')}
    `;

    pBody.querySelectorAll('[data-fill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cInput.value = btn.dataset.fill;
        cInput.focus();
        autoGrow();
        if (window.innerWidth <= 1180) profilePane.classList.remove('open');
      });
    });

    const kbInput = qs('#kbSearch', pBody);
    if (kbInput) {
      kbInput.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        kbState.q = kbInput.value.trim();
        if (!kbState.q) { kbState.results = null; renderAssist(); return; }
        try {
          kbState.results = await api(`/agent/kb?q=${encodeURIComponent(kbState.q)}`);
          renderAssist();
        } catch (err) { toast(err.message, 'err'); }
      });
    }
  }

  async function loadVisitorHistory(visitorId) {
    try {
      visitorHistory = await api(`/agent/visitor/${visitorId}`);
      if (pTab === 'customer') renderCustomer();
    } catch { /* ignore */ }
  }

  /* ---------------- 状态 / 转接 / 结束 ---------------- */

  function setStatusUI(status) {
    const map = agentStatusMap[status] || agentStatusMap.offline;
    qs('#statusText').textContent = map.text;
    qs('#statusDot').className = `dot ${map.dot}`;
  }

  async function changeStatus(status) {
    try {
      await api('/agent/status', { method: 'POST', body: { status } });
      me.status = status;
      setStatusUI(status);
      qs('#statusMenu').classList.add('hidden');
      toast(status === 'online' ? '已切换为在线，开始接收分配' : status === 'busy' ? '已切换为忙碌' : '已离线', 'ok');
      await loadList(false);
    } catch (e) { toast(e.message, 'err'); }
  }

  function openTransfer() {
    if (!detail) return;
    const others = (detail.agents || []).filter((a) => a.id !== me.id);
    if (!others.length) {
      toast('没有其他客服账号可转接', 'err');
      return;
    }
    const statusText = { online: '在线', busy: '忙碌', offline: '离线' };
    const options = others.map((a) => `<option value="${a.id}">${esc(a.name)} · ${statusText[a.status] || a.status} · 在接 ${a.load}</option>`).join('');
    const m = openModal({
      title: '转接会话',
      content: `<div class="field" style="margin-bottom:14px">
          <label>转接给</label>
          <select class="select" id="transferTo">${options}</select>
        </div>
        <div class="field">
          <label>转接原因（会写入会话记录）</label>
          <input class="input" id="transferReason" placeholder="例如：需要物流组跟进 / 售后专员处理" />
        </div>
        <p class="tiny muted" style="margin-top:12px">转接后客户无需重复描述，历史消息与 AI 摘要会一并带过去。转接给离线客服时，对方上线后可在「我的会话」中看到。</p>`,
      footer: '<button class="btn" data-act="cancel">取消</button><button class="btn btn-primary" data-act="ok">确认转接</button>'
    });
    m.foot.querySelector('[data-act="cancel"]').onclick = m.close;
    m.foot.querySelector('[data-act="ok"]').onclick = async () => {
      const toAgentId = Number(qs('#transferTo', m.modal).value);
      const reason = qs('#transferReason', m.modal).value.trim();
      try {
        await api(`/agent/conversation/${currentId}/transfer`, { method: 'POST', body: { toAgentId, reason } });
        m.close();
        toast('已转接', 'ok');
        currentId = null;
        detail = null;
        renderEmpty();
        await loadList(true);
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function endConversation() {
    if (!detail) return;
    const ok = await confirmDialog('结束本次会话？', '结束后访客会收到满意度评价邀请，会话记录将归档到管理后台。', { okText: '结束会话', danger: true });
    if (!ok) return;
    try {
      await api(`/agent/conversation/${currentId}/close`, { method: 'POST', body: {} });
      toast('会话已结束', 'ok');
      currentId = null;
      detail = null;
      renderEmpty();
      await loadList(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  function onTyping(data) {
    if (!data || data.convId !== currentId) return;
    const hint = qs('#typingHint');
    hint.textContent = `${data.name || '访客'}正在输入…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { hint.textContent = ''; }, 3000);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    qs('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      tab = btn.dataset.tab;
      qs('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      loadList(false);
    });

    qs('#search').addEventListener('input', debounce((e) => {
      keyword = e.target.value;
      loadList(false);
    }, 260));

    qs('#statusBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      qs('#statusMenu').classList.toggle('hidden');
    });
    document.addEventListener('click', () => qs('#statusMenu').classList.add('hidden'));
    qs('#statusMenu').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-s]');
      if (btn) changeStatus(btn.dataset.s);
    });

    qs('#btnLogout').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
      store.token = '';
      location.replace('/login');
    });

    qs('#cForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    cInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
    });
    cInput.addEventListener('input', autoGrow);

    qs('#cAvatar').addEventListener('click', () => profilePane.classList.toggle('open'));
    qs('#cName').addEventListener('click', () => profilePane.classList.toggle('open'));
    qs('#btnClaim').addEventListener('click', claimCurrent);
    qs('#btnTransfer').addEventListener('click', openTransfer);
    qs('#btnEnd').addEventListener('click', endConversation);
    qs('#backBtn').addEventListener('click', () => document.body.classList.remove('view-chat'));

    qs('#sumToggle').addEventListener('click', () => {
      const el = qs('#cSummary');
      el.classList.toggle('collapsed');
      qs('#sumToggle').textContent = el.classList.contains('collapsed') ? '展开' : '收起';
    });

    qs('.p-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-p]');
      if (!btn) return;
      pTab = btn.dataset.p;
      qs('.p-tabs').querySelectorAll('button[data-p]').forEach((b) => b.classList.toggle('on', b === btn));
      renderProfile();
    });

    qs('#pClose').addEventListener('click', () => profilePane.classList.remove('open'));
    qs('#btnProfile').addEventListener('click', () => profilePane.classList.toggle('open'));
    qs('#btnQuick').addEventListener('click', () => {
      pTab = 'assist';
      qs('.p-tabs').querySelectorAll('button[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === 'assist'));
      renderProfile();
      profilePane.classList.add('open');
    });
  }

  bind();
  init();
})();
