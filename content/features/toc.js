// 目录：右侧面板里的"目录"标签页，列出我的每一次提问。
//
// 两个难点：
// - Claude 只把屏幕附近的消息放在页面里，所以目录内容来自共享的整段对话数据（CR.transcript）。
// - 点击还没显示/还没加载的提问时，要一步步把页面滚过去，等 Claude 渲染或加载出来，再精确定位。
//   这个跳转能力也给标注用（CR.toc.jumpTo）。
(() => {
  const CR = window.CR;
  const A = () => CR.adapter;
  const T = () => CR.transcript;
  const guard = (fn) => (...args) => CR.featureManager.run('toc', () => fn(...args));
  const sleep = CR.utils.sleep;

  const SCROLL_OFFSET = 72; // 跳转后目标离滚动区顶部的距离（让开 Claude 顶部的标题栏）

  let ui = {};
  let questions = []; // [{ q: 第几问(从1开始), tIndex: 在整段对话里的序号, text }]
  let activeQ = -1;

  let io = null;
  let ioRoot = null;
  let observed = new WeakSet();
  const visibleRows = new Set();

  let jumpToken = 0;
  let jumping = 0; // 正在进行的跳转的编号，0 表示没有在跳转
  let scrollRaf = 0;

  const tLen = () => (T().data ? T().data.messages.length : 0);
  const tIndexOf = (m) => T().indexOf(m);

  // ———————————————— 数据 ————————————————

  function summary(text) {
    const s = (text || '')
      .replace(/```[\s\S]*?```/g, ' [代码] ')
      .replace(/[#>*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '（图片或附件）';
    return s.length > 30 ? s.slice(0, 30) + '…' : s;
  }

  function buildQuestions() {
    let list;
    const data = T().data;
    if (data) {
      list = data.messages.filter((m) => m.role === 'user').map((m) => ({ tIndex: m.index, text: m.text }));
    } else {
      // 降级：读不到整段对话时，只列出页面上看得到的提问
      list = A()
        .getRenderedMessages()
        .filter((m) => m.role === 'user')
        .map((m) => ({ tIndex: m.index, text: m.bodyEl.innerText }));
    }
    questions = list.map((x, i) => ({ q: i + 1, tIndex: x.tIndex, text: x.text }));
  }

  // 整段对话里第 tIdx 条消息属于第几问（返回 questions 数组下标）
  function questionOf(tIdx) {
    let found = -1;
    for (let i = 0; i < questions.length && questions[i].tIndex <= tIdx; i++) found = i;
    return found;
  }

  function onTranscriptChange() {
    if (!jumping) {
      if (T().failed) setStatus('无法读取完整对话，只列出屏幕附近的提问');
      else if (ui.status && /正在读取|无法读取|对不上/.test(ui.status.textContent)) setStatus('');
    }
    buildQuestions();
    renderList();
    updateActive();
    updateProgress();
  }

  // ———————————————— 当前位置 & 进度 ————————————————

  function setupObserver() {
    const sc = A().getScrollContainer();
    if (sc === ioRoot && io) return;
    teardownObserver();
    ioRoot = sc;
    if (!sc) return;
    // 只看滚动区上部的一条"阅读带"（顶部往下 15%～45%），哪条消息在带里，就算正在读它
    io = new IntersectionObserver(
      guard((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleRows.add(e.target);
          else visibleRows.delete(e.target);
        }
        updateActive();
      }),
      { root: sc, rootMargin: '-15% 0px -55% 0px', threshold: 0 },
    );
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('wheel', cancelJump, { passive: true });
    sc.addEventListener('touchstart', cancelJump, { passive: true });
    observeRows();
  }

  function teardownObserver() {
    if (io) io.disconnect();
    if (ioRoot) {
      ioRoot.removeEventListener('scroll', onScroll);
      ioRoot.removeEventListener('wheel', cancelJump);
      ioRoot.removeEventListener('touchstart', cancelJump);
    }
    io = null;
    ioRoot = null;
    observed = new WeakSet();
    visibleRows.clear();
  }

  // 虚拟列表滚动时会不断出现新的消息行，要把它们也交给观察器
  function observeRows() {
    if (!io) return;
    for (const m of A().getRenderedMessages()) {
      if (!observed.has(m.el)) {
        observed.add(m.el);
        io.observe(m.el);
      }
    }
  }

  const onScroll = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(
      guard(() => {
        scrollRaf = 0;
        observeRows();
        updateProgress();
        if (atBottom()) updateActive();
      }),
    );
  };

  const atBottom = () => ioRoot && ioRoot.scrollTop + ioRoot.clientHeight >= ioRoot.scrollHeight - 4;

  function updateActive() {
    if (!questions.length) return;
    if (atBottom()) return setActive(questions.length - 1);
    let top = null;
    for (const m of A().getRenderedMessages()) {
      if (visibleRows.has(m.el) && m.el.isConnected && (!top || m.index < top.index)) top = m;
    }
    if (!top) return;
    const q = questionOf(tIndexOf(top));
    if (q >= 0) setActive(q);
  }

  function updateProgress() {
    if (!ui.bar) return;
    const sc = ioRoot;
    let pct = null;
    if (sc && tLen()) {
      if (atBottom()) {
        pct = 100;
      } else {
        const line = sc.getBoundingClientRect().top + sc.clientHeight * 0.2;
        for (const m of A().getRenderedMessages()) {
          const r = m.el.getBoundingClientRect();
          if (r.top <= line && r.bottom > line) {
            pct = ((tIndexOf(m) + (line - r.top) / Math.max(1, r.height)) / tLen()) * 100;
            break;
          }
        }
      }
    }
    if (pct == null) return;
    pct = Math.max(0, Math.min(100, pct));
    ui.bar.style.width = pct.toFixed(1) + '%';
    ui.pct.textContent = Math.round(pct) + '%';
  }

  // ———————————————— 跳转 ————————————————

  function waitFor(cond, timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (cond()) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  const nextFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));

  function waitScrollEnd(sc, timeout) {
    return new Promise((resolve) => {
      const done = () => {
        sc.removeEventListener('scrollend', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      sc.addEventListener('scrollend', done);
    });
  }

  // 平滑滚动到某个位置。距离很远时先瞬间跳到附近再平滑滚动：
  // 长距离平滑滚动途中 Claude 会重新计算消息高度，终点会跑偏
  async function scrollSmooth(sc, top) {
    const far = sc.clientHeight * 2;
    if (Math.abs(top - sc.scrollTop) > far) {
      sc.scrollTo({ top: top > sc.scrollTop ? top - far / 2 : top + far / 2, behavior: 'instant' });
      await nextFrames();
    }
    if (Math.abs(top - sc.scrollTop) < 2) return;
    sc.scrollTo({ top, behavior: 'smooth' });
    await waitScrollEnd(sc, 1500);
  }

  // 把页面上某个位置（元素或选区的矩形）平滑滚到滚动区上部
  async function scrollRectIntoView(rectFn, offset = SCROLL_OFFSET) {
    const sc = A().getScrollContainer();
    if (!sc) return;
    const r = rectFn();
    if (!r) return;
    await scrollSmooth(sc, sc.scrollTop + r.top - sc.getBoundingClientRect().top - offset);
  }

  // 跳到整段对话里的第 tIdx 条消息。返回页面上的那条消息（失败返回 null）
  async function jumpTo(tIdx, opts) {
    const token = ++jumpToken;
    jumping = token;
    T().hold(); // 跳转途中 Claude 在加载消息，编号会暂时错位，别让共享数据去刷新
    try {
      return await doJump(token, tIdx, opts || {});
    } finally {
      T().release();
      if (jumping === token) jumping = 0;
    }
  }

  // 跳转途中用户自己动了滚轮/键盘，就取消跳转，不跟用户抢
  function cancelJump() {
    if (!jumping) return;
    jumpToken++;
    jumping = 0;
    setStatus('');
  }

  async function doJump(token, tIdx, { flash = true, scroll = true } = {}) {
    const sc = A().getScrollContainer();
    if (!sc) return null;
    let batches = 0;
    let mismatches = 0;
    for (let step = 0; step < 300; step++) {
      if (token !== jumpToken) return null; // 又点了别的，放弃这次
      const rows = A().getRenderedMessages();
      if (!rows.length) {
        await sleep(150);
        continue;
      }
      // 编号对上还要核对内容：Claude 加载新一批消息的瞬间，编号会短暂错位
      const data = T().data;
      const target = rows.find((m) => tIndexOf(m) === tIdx && (!data || A().isSameMessage(m, data.messages[tIdx])));
      if (!target && rows.some((m) => tIndexOf(m) === tIdx)) {
        if (++mismatches > 10) {
          // 一直对不上：目录数据过期了，重新读取
          setStatus('目录和页面对不上，正在刷新…');
          T().release();
          T().refresh();
          T().hold();
          return null;
        }
        await sleep(200);
        continue;
      }
      if (target) {
        setStatus('');
        if (scroll) await scrollRectIntoView(() => target.el.getBoundingClientRect());
        if (flash && token === jumpToken && target.bodyEl.isConnected) CR.panel.flashRect(target.bodyEl.getBoundingClientRect());
        return token === jumpToken ? target : null;
      }

      // 以离屏幕中间最近的那条消息为参照，判断目标在上面还是下面
      // （不能看页面里第一条/最后一条：Claude 有时会把最后几条一直留在页面里，中间是断开的）
      const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
      let ref = rows[0];
      let best = Infinity;
      for (const m of rows) {
        const r = m.el.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < best) {
          best = d;
          ref = m;
        }
      }
      const cur = tIndexOf(ref);
      const avg = rows.reduce((s, m) => s + m.el.getBoundingClientRect().height, 0) / rows.length || 600;

      if (tIdx < cur) {
        if (sc.scrollTop <= 2) {
          // 已经到顶，等 Claude 加载更早的一批消息
          batches++;
          setStatus(`正在加载更早的消息…（第 ${batches} 批，滚动鼠标可取消）`);
          const before = A().getLoadedMessageCount();
          const ok = await waitFor(() => A().getLoadedMessageCount() !== before, 5000);
          if (!ok) {
            setStatus('没能加载到这条消息，可以手动往上滚动试试');
            return null;
          }
          continue;
        }
        sc.scrollTo({ top: Math.max(0, sc.scrollTop - Math.max(sc.clientHeight * 0.5, (cur - tIdx) * avg)), behavior: 'instant' });
      } else {
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) {
          // 到底了还找不到：数据过期了（比如刚发了新消息），重新读取
          setStatus('目录和页面对不上，正在刷新…');
          T().release();
          T().refresh();
          T().hold();
          return null;
        }
        sc.scrollTo({ top: sc.scrollTop + Math.max(sc.clientHeight * 0.5, (tIdx - cur) * avg), behavior: 'instant' });
      }
      await nextFrames();
    }
    setStatus('跳转超时，可以再点一次试试');
    return null;
  }

  async function goTop() {
    const m = await jumpTo(0, { flash: false });
    const sc = A().getScrollContainer();
    if (sc && m) await scrollSmooth(sc, 0);
  }

  // 底部的消息高度可能还没算准，滚一次不一定到底，所以到达后检查，没到底就再补几次
  async function goBottom() {
    const token = ++jumpToken;
    setStatus('');
    const sc = A().getScrollContainer();
    if (!sc) return;
    await scrollSmooth(sc, sc.scrollHeight - sc.clientHeight);
    for (let i = 0; i < 10 && token === jumpToken && !atBottom(); i++) {
      sc.scrollTo({ top: sc.scrollHeight, behavior: 'instant' });
      await nextFrames();
    }
  }

  // ———————————————— 标签页内容 ————————————————

  const CSS = `
    .toc-progress { height: 3px; margin: 2px 14px 0; background: var(--line); border-radius: 2px; overflow: hidden; }
    .toc-bar { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
    .toc-meta { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; padding: 4px 14px 6px; }
    .toc-list { list-style: none; margin: 0; padding: 4px 6px 6px; overflow-y: auto; flex: 1; scrollbar-width: thin; }
    .toc-item {
      display: flex; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 7px;
      color: var(--fg); white-space: nowrap; overflow: hidden;
    }
    .toc-item:hover { background: var(--hover); }
    .toc-item .n { color: var(--muted); min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; flex: none; }
    .toc-item .t { overflow: hidden; text-overflow: ellipsis; }
    .toc-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .toc-item.active .n { color: var(--accent); }
    .toc-status { color: var(--muted); font-size: 12px; padding: 4px 14px; }
    .toc-status:empty { display: none; }
    .toc-empty { color: var(--muted); padding: 12px 10px; }
    .toc-foot { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--line); }
    .toc-foot button { flex: 1; padding: 5px 0; border-radius: 7px; border: 1px solid var(--line); color: var(--muted); }
    .toc-foot button:hover { color: var(--accent); border-color: var(--accent); }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build(container) {
    const progress = h('div', 'toc-progress');
    const bar = h('div', 'toc-bar');
    progress.append(bar);
    const meta = h('div', 'toc-meta');
    const where = h('span');
    const pct = h('span');
    meta.append(where, pct);
    const status = h('div', 'toc-status');
    const list = h('ol', 'toc-list');
    const foot = h('div', 'toc-foot');
    const top = h('button', null, '↑ 回到顶部');
    const bottom = h('button', null, '↓ 回到底部');
    foot.append(top, bottom);
    container.append(progress, meta, status, list, foot);

    top.addEventListener('click', guard(goTop));
    bottom.addEventListener('click', guard(goBottom));
    list.addEventListener(
      'click',
      guard((e) => {
        const btn = e.target.closest('.toc-item');
        if (!btn) return;
        const i = Number(btn.dataset.i);
        setActive(i);
        jumpTo(questions[i].tIndex);
      }),
    );

    ui = { bar, where, pct, status, list };
    renderList();
    updateActive();
    updateProgress();
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function renderList() {
    CR.panel.setBadge('toc', questions.length ? String(questions.length) : '');
    if (!ui.list) return;
    ui.list.textContent = '';
    if (!questions.length) {
      ui.list.append(h('li', 'toc-empty', A().getConversationId() ? (T().loading ? '正在读取对话…' : '这个对话还没有提问') : ''));
      ui.where.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    questions.forEach((q, i) => {
      const li = h('li');
      const btn = h('button', 'toc-item');
      btn.dataset.i = i;
      btn.title = (q.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      btn.append(h('span', 'n', String(q.q)), h('span', 't', summary(q.text)));
      li.append(btn);
      frag.append(li);
    });
    ui.list.append(frag);
    const keep = activeQ;
    activeQ = -1;
    if (keep >= 0 && keep < questions.length) setActive(keep);
  }

  function setActive(i) {
    if (!ui.list || i === activeQ) return;
    const items = ui.list.querySelectorAll('.toc-item');
    if (items[activeQ]) items[activeQ].classList.remove('active');
    activeQ = i;
    const cur = items[i];
    if (!cur) return;
    cur.classList.add('active');
    ui.where.textContent = `第 ${i + 1} / ${questions.length} 问`;
    // 让高亮项保持在目录可见范围内（只滚目录自己，不用 scrollIntoView，以免带动页面滚动）
    const list = ui.list;
    const top = cur.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 8;
    else if (top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + cur.offsetHeight - list.clientHeight + 8;
  }

  // ———————————————— 生命周期 ————————————————

  const isEnabled = () => CR.settings.toc.enabled;
  let active = false;

  function onConversationChange() {
    jumpToken++;
    questions = [];
    activeQ = -1;
    setStatus('');
    renderList();
    teardownObserver();
    setupObserver();
  }

  function onContentChange() {
    setupObserver();
    observeRows();
    if (!T().data) {
      buildQuestions();
      renderList();
    }
    updateActive();
    updateProgress();
  }

  function setActiveState(on) {
    active = on;
    if (on) {
      CR.transcript.start();
      setupObserver();
      buildQuestions();
    } else {
      jumpToken++;
      teardownObserver();
      ui = {};
    }
    CR.panel.setEnabled('toc', on);
  }

  CR.panel.register('toc', { label: '目录', css: CSS, build, onShow: () => (updateActive(), updateProgress()) });

  CR.featureManager.register('toc', '目录', {
    start() {
      if (isEnabled()) setActiveState(true);
      CR.events.on('settings-change', (e) => {
        if (e.key === 'toc') CR.featureManager.run('toc', () => isEnabled() !== active && setActiveState(isEnabled()));
      });
      CR.events.on('conversation-change', guard(() => active && onConversationChange()));
      CR.events.on('content-change', guard(() => active && onContentChange()));
      CR.events.on('transcript-change', guard(() => active && onTranscriptChange()));
    },
    stop: () => setActiveState(false),
    isEnabled,
  });

  // 给标注等其他功能用：跳到某条消息、把某个矩形滚到视野里
  CR.toc = { jumpTo, scrollRectIntoView };
})();
