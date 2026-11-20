(function () {
  'use strict';

  const { api, store, esc, fmtTime, toast, connectSSE, debounce, confirmDialog, qs, initials } = CS;

  store.setScope('visitor');

  let state = null;
  let sending = false;
  let rateScore = 0;
  const rateTags = new Set();

  const bodyEl = qs('#chatBody');
  const inputEl = qs('#input');
  const formEl = qs('#composer');
  const quickEl = qs('#quickRow');
  const queueEl = qs('#queueBanner');
  const composerWrap = qs('.composer-wrap');
  const btnHuman = qs('#btnHuman');
  const btnClose = qs('#btnClose');
  const headAvatar = qs('#headAvatar');
  const headName = qs('#headName');
  const headBadge = qs('#headBadge');
  const headStatus = qs('#headStatus');
  const headDot = qs('#headDot');
  const topicText = qs('#topicText');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 启动 ---------------- */

  async function boot() {
    try {
      if (!store.token) throw new Error('no-token');
      state = await api('/visitor/state', { token: store.token });
    } catch (e) {
      try {
        const res = await api('/visitor/session', { method: 'POST', body: {}, token: '' });
        store.token = res.token;
        state = res;
      } catch (err) {
        toast('连接客服失败，请刷新页面重试', 'err');
        console.error(err);
        return;
      }
    }
    render();
    connectSSE('/visitor/stream', { refresh: debounce(() => refresh(), 100) });
    setInterval(() => { if (state && state.queue) refresh(); }, 6000);
  }

  async function refresh() {
    try {
      state = await api('/visitor/state');
      render();
    } catch (e) {
      if (e.code === 'unauthenticated') {
        store.token = '';
        boot();
      }
    }
  }

  /* ---------------- 渲染 ---------------- */

  function needRating() {
    return Boolean(state.needRating && state.conversation && state.conversation.status === 'closed');
  }

  function render() {
    const conv = state.conversation || {};
    const isHuman = conv.mode === 'human' && conv.status === 'active';
    const isQueue = conv.status === 'waiting';
    const isClosed = conv.status === 'closed';

    // 头部
    if (isHuman && state.agent) {
      headName.textContent = state.agent.name;
      headBadge.textContent = '人工';
      headBadge.className = 'badge badge-blue';
      headStatus.textContent = '已接入 · 正在为你服务';
      headAvatar.textContent = initials(state.agent.name);
      headAvatar.className = 'avatar';
      headAvatar.style.background = state.agent.color || '#2563eb';
      headDot.className = 'dot dot-online';
    } else {
      headName.textContent = '智能客服小满';
      headBadge.textContent = isQueue ? '等待' : 'AI';
      headBadge.className = `badge ${isQueue ? 'badge-amber' : 'badge-orange'}`;
      headStatus.textContent = isQueue ? '正在为你接入人工客服' : isClosed ? '本次会话已结束' : '在线 · 通常立即回复';
      headAvatar.textContent = '溪';
      headAvatar.className = 'avatar avatar-brand';
      headAvatar.style.background = '';
      headDot.className = `dot ${isQueue ? 'dot-busy' : isClosed ? 'dot-offline' : 'dot-online'}`;
    }

    btnHuman.classList.toggle('hidden', isHuman || isClosed || isQueue);
    btnHuman.disabled = isQueue;

    // 话题
    topicText.textContent = conv.topic || (isClosed ? '会话已结束' : '等待你的问题');
    btnClose.textContent = isClosed ? '开始新会话' : '结束会话';

    // 排队
    if (state.queue) {
      queueEl.classList.remove('hidden');
      qs('#queueTitle').textContent = state.queue.onlineAgents > 0
        ? `正在为你排队 · 前面还有 ${state.queue.ahead} 位`
        : '人工客服当前不在线';
      qs('#queueSub').textContent = state.queue.onlineAgents > 0
        ? '已为你保留会话，接入后聊天记录会一起转过去'
        : '已记录你的需求，客服上线后会第一时间接入';
    } else {
      queueEl.classList.add('hidden');
    }

    renderMessages();
    renderQuick();
    renderComposer(isClosed);
    scrollBottom();
  }

  function renderMessages() {
    const msgs = state.messages || [];
    let html = msgs.map(messageHtml).join('');
    if (needRating()) html += rateCardHtml();
    bodyEl.innerHTML = html;
    bindRateCard();

    bodyEl.querySelectorAll('.sugg button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.q) send(btn.dataset.q);
        else if (btn.dataset.act === 'human') requestHuman();
      });
    });
  }

  function messageHtml(m) {
    if (m.from === 'system') {
      return `<div class="sys"><span>${esc(m.content)}</span></div>`;
    }
    const out = m.from === 'visitor';
    const isAgent = m.from === 'agent';
    const name = isAgent ? (state.agent ? state.agent.name : '人工客服') : '智能客服小满';

    let avatar;
    if (out) avatar = '';
    else if (isAgent) {
      avatar = `<div class="av" style="background:${esc((state.agent && state.agent.color) || '#2563eb')}">${esc(initials(name))}</div>`;
    } else {
      avatar = '<div class="av bot">溪</div>';
    }

    let meta = '';
    if (!out) {
      const chips = [];
      if (m.confidence != null && m.confidence < 0.999) {
        const low = m.confidence < 0.5;
        chips.push(`<span class="ai-tag ${low ? 'warn' : ''}">置信度 ${Math.round(m.confidence * 100)}%</span>`);
      }
      if (m.meta && m.meta.viaContext) chips.push('<span class="ai-tag ctx">承接上文</span>');
      meta = `<div class="meta"><span>${esc(name)}</span>${isAgent ? '<span class="badge badge-blue" style="height:16px;padding:0 5px;font-size:9.5px">人工</span>' : ''}${chips.join('')}</div>`;
    } else {
      meta = '';
    }

    let extra = '';
    if (m.from === 'bot' && m.meta && m.meta.low) {
      const items = (m.meta.suggestions || []).map((s) => `<button data-q="${esc(s.question)}">${esc(s.question)}</button>`);
      if (m.meta.canHuman) items.push('<button class="human" data-act="human">转人工客服</button>');
      if (items.length) extra = `<div class="sugg">${items.join('')}</div>`;
    }

    return `<div class="msg ${out ? 'out' : isAgent ? 'agent' : 'in'}">
      ${avatar}
      <div class="main">
        ${meta}
        <div class="bubble">${esc(m.content)}<span class="t">${fmtTime(m.at)}</span></div>
        ${extra}
      </div>
    </div>`;
  }

  function rateCardHtml() {
    return `<div class="rate-card" id="rateCard">
      <h4>${esc(state.settings.ratingPrompt || '本次服务还满意吗？')}</h4>
      <p class="sub">评价会同步给客服主管，用于服务改进</p>
      <div class="stars">
        ${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-score="${i}" aria-label="${i} 星">★</button>`).join('')}
      </div>
      <div class="rate-tags">
        ${['响应快', '态度好', '专业', '问题解决', '未解决'].map((t) => `<button type="button" data-tag="${t}">${t}</button>`).join('')}
      </div>
      <textarea id="rateComment" placeholder="补充说明（选填）"></textarea>
      <button class="btn btn-primary btn-sm" id="rateSubmit" disabled>提交评价</button>
    </div>`;
  }

  function bindRateCard() {
    const card = qs('#rateCard');
    if (!card) return;
    const submit = qs('#rateSubmit', card);
    card.querySelectorAll('.stars button').forEach((btn) => {
      btn.addEventListener('click', () => {
        rateScore = Number(btn.dataset.score);
        card.querySelectorAll('.stars button').forEach((b) => b.classList.toggle('on', Number(b.dataset.score) <= rateScore));
        submit.disabled = false;
      });
    });
    card.querySelectorAll('.rate-tags button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tag;
        if (rateTags.has(t)) rateTags.delete(t);
        else rateTags.add(t);
        btn.classList.toggle('on');
      });
    });
    submit.addEventListener('click', async () => {
      if (!rateScore) return;
      submit.disabled = true;
      try {
        state = await api('/visitor/rate', {
          method: 'POST',
          body: { score: rateScore, tags: [...rateTags], comment: qs('#rateComment', card).value }
        });
        rateScore = 0;
        rateTags.clear();
        toast('感谢你的评价', 'ok');
        render();
      } catch (e) {
        toast(e.message, 'err');
        submit.disabled = false;
      }
    });
  }

  function renderQuick() {
    const conv = state.conversation || {};
    const list = state.quickQuestions || [];
    if (conv.status === 'closed' || (conv.mode === 'human' && conv.status === 'active')) {
      quickEl.innerHTML = '';
      quickEl.classList.add('hidden');
      return;
    }
    quickEl.classList.remove('hidden');
    quickEl.innerHTML = list
      .map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`)
      .join('');
    quickEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
  }

  function renderComposer(isClosed) {
    let closedBar = qs('.closed-bar', composerWrap);
    if (isClosed) {
      formEl.classList.add('hidden');
      if (!closedBar) {
        closedBar = document.createElement('div');
        closedBar.className = 'closed-bar';
        closedBar.innerHTML = `<span>本次会话已结束，随时可以再找我们</span><button class="btn btn-sm btn-primary" type="button">开始新会话</button>`;
        closedBar.querySelector('button').addEventListener('click', newConversation);
        composerWrap.insertBefore(closedBar, formEl);
      }
      closedBar.classList.remove('hidden');
    } else {
      formEl.classList.remove('hidden');
      if (closedBar) closedBar.classList.add('hidden');
      inputEl.disabled = sending;
      qs('#btnSend').disabled = sending;
    }
  }

  function scrollBottom() {
    requestAnimationFrame(() => {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  }

  /* ---------------- 交互 ---------------- */

  function appendLocal(text) {
    const div = document.createElement('div');
    div.className = 'msg out';
    div.dataset.temp = '1';
    div.innerHTML = `<div class="main"><div class="bubble">${esc(text)}<span class="t">${fmtTime(new Date().toISOString())}</span></div></div>`;
    bodyEl.appendChild(div);
    scrollBottom();
  }

  function showTyping(on) {
    let el = qs('#typingRow');
    if (on) {
      if (el) return;
      el = document.createElement('div');
      el.id = 'typingRow';
      el.className = 'msg in';
      el.innerHTML = `<div class="av bot">溪</div><div class="main"><div class="bubble" style="padding:8px 12px"><span class="tdots"><i></i><i></i><i></i></span></div></div>`;
      bodyEl.appendChild(el);
      scrollBottom();
    } else if (el) {
      el.remove();
    }
  }

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || sending) return;
    if (!state.conversation || state.conversation.status === 'closed') {
      await newConversation();
      if (!state.conversation) return;
    }
    sending = true;
    inputEl.value = '';
    autoGrow();
    appendLocal(content);
    showTyping(true);
    try {
      await api('/visitor/message', { method: 'POST', body: { content } });
      await sleep(240);
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
      await refresh();
    } finally {
      sending = false;
      showTyping(false);
      renderComposer(Boolean(state.conversation && state.conversation.status === 'closed'));
      scrollBottom();
      inputEl.focus();
    }
  }

  async function requestHuman() {
    try {
      state = await api('/visitor/request-human', { method: 'POST', body: {} });
      render();
      toast('已提交转人工请求', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function newConversation() {
    try {
      state = await api('/visitor/new', { method: 'POST', body: {} });
      rateScore = 0;
      rateTags.clear();
      render();
      inputEl.focus();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 108)}px`;
  }

  const typingPing = debounce(() => {
    api('/visitor/typing', { method: 'POST', body: {} }).catch(() => {});
  }, 1500);

  function bind() {
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      send(inputEl.value);
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(inputEl.value);
      }
    });
    inputEl.addEventListener('input', () => {
      autoGrow();
      typingPing();
    });

    btnHuman.addEventListener('click', requestHuman);

    btnClose.addEventListener('click', async () => {
      const conv = state.conversation || {};
      if (conv.status === 'closed') {
        newConversation();
        return;
      }
      const ok = await confirmDialog('结束本次会话？', '结束后可以为本次服务打分，也随时可以重新发起咨询。', { okText: '结束会话' });
      if (!ok) return;
      try {
        state = await api('/visitor/close', { method: 'POST', body: {} });
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }

  bind();
  boot();
})();
