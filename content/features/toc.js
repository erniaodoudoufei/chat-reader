// 目录面板：页面右侧的浮动面板，列出我的每一次提问。
// 面板放在 Shadow DOM 里（相当于一个隔音房间：Claude 的样式进不来，面板的样式也漏不出去），挂在 <body> 最后，不碰 Claude 的页面元素。
//
// 两个难点（都由适配层兜底）：
// - Claude 只把屏幕附近的消息放在页面里，所以目录内容来自 adapter.fetchTranscript()（整段对话）。
// - 点击还没显示/还没加载的提问时，要一步步把页面滚过去，等 Claude 渲染或加载出来，再精确定位。
(() => {
  const CR = window.CR;
  const A = () => CR.adapter;
  const guard = (fn) => (...args) => CR.featureManager.run('toc', () => fn(...args));
  const sleep = CR.utils.sleep;

  const OPEN_KEY = 'tocOpen';
  const SCROLL_OFFSET = 72; // 跳转后目标离滚动区顶部的距离（让开 Claude 顶部的标题栏）

  let host = null;
  let ui = {};
  let open = true;

  let convId = null;
  let transcript = null; // { title, messages }，读取失败时为 null（降级：只用页面上看得到的提问）
  let questions = []; // [{ q: 第几问(从1开始), tIndex: 在整段对话里的序号, text }]
  let activeQ = -1;

  let io = null;
  let ioRoot = null;
  let observed = new WeakSet();
  const visibleRows = new Set();

  let jumpToken = 0;
  let jumping = 0; // 正在进行的跳转的编号，0 表示没有在跳转
  let refetchAt = 0;
  let refetchDelay = 3000;
  let scrollRaf = 0;

  // ———————————————— 数据 ————————————————

  const tLen = () => (transcript ? transcript.messages.length : 0);
  const tIndexOf = (m) => (transcript ? A().toTranscriptIndex(m.index, tLen()) : m.index);

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
    if (transcript) {
      list = transcript.messages.filter((m) => m.role === 'user').map((m) => ({ tIndex: m.index, text: m.text }));
    } else {
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

  async function loadTranscript() {
    const id = A().getConversationId();
    convId = id;
    refetchAt = Date.now();
    if (!id) {
      transcript = null;
      questions = [];
      renderList();
      return;
    }
    if (!questions.length && !jumping) setStatus('正在读取对话…');
    let t = null;
    try {
      t = await A().fetchTranscript(id);
    } catch (e) {
      CR.warn('读取整段对话失败，目录只显示页面上看得到的提问：', e);
    }
    if (convId !== id) return; // 读取期间已经切到别的对话了
    transcript = t;
    if (!jumping) setStatus(t ? '' : '无法读取完整对话，只列出屏幕附近的提问');
    buildQuestions();
    renderList();
    updateActive();
    updateProgress();
  }

  // 页面内容变了（新消息、回复生成中、切换分支…）：看看目录数据是否过期
  function checkFreshness() {
    if (jumping) return; // 跳转途中 Claude 在加载消息，编号会暂时错位，等跳完再说
    if (!transcript) {
      buildQuestions();
      renderList();
      return;
    }
    const aligned = A().checkAlignment(transcript);
    const rows = A().getRenderedMessages();
    const beyond = rows.length && tIndexOf(rows[rows.length - 1]) >= tLen();
    if (aligned !== false && !beyond) {
      refetchDelay = 3000;
      return;
    }
    if (Date.now() - refetchAt < refetchDelay) return;
    // 回复生成过程中接口可能还没有最新内容，会一直对不上；所以每次重读后把间隔拉长，最长 30 秒
    refetchDelay = Math.min(refetchDelay * 2, 30000);
    loadTranscript();
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

  async function smoothTo(sc, el) {
    await scrollSmooth(sc, sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - SCROLL_OFFSET);
  }

  async function jumpTo(tIdx, opts) {
    const token = ++jumpToken;
    jumping = token;
    try {
      await doJump(token, tIdx, opts);
    } finally {
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

  async function doJump(token, tIdx, { flash = true } = {}) {
    const sc = A().getScrollContainer();
    if (!sc) return;
    let batches = 0;
    let mismatches = 0;
    for (let step = 0; step < 300; step++) {
      if (token !== jumpToken) return; // 又点了别的，放弃这次
      const rows = A().getRenderedMessages();
      if (!rows.length) {
        await sleep(150);
        continue;
      }
      // 编号对上还要核对内容：Claude 加载新一批消息的瞬间，编号会短暂错位
      const target = rows.find((m) => tIndexOf(m) === tIdx && (!transcript || A().isSameMessage(m, transcript.messages[tIdx])));
      if (!target && rows.some((m) => tIndexOf(m) === tIdx)) {
        if (++mismatches > 10) {
          // 一直对不上：目录数据过期了，重新读取
          setStatus('目录和页面对不上，正在刷新…');
          loadTranscript();
          return;
        }
        await sleep(200);
        continue;
      }
      if (target) {
        setStatus('');
        await smoothTo(sc, target.el);
        if (flash && token === jumpToken) flashOver(target.bodyEl);
        return;
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
            return;
          }
          continue;
        }
        sc.scrollTo({ top: Math.max(0, sc.scrollTop - Math.max(sc.clientHeight * 0.5, (cur - tIdx) * avg)), behavior: 'instant' });
      } else {
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) {
          // 到底了还找不到：目录数据过期了（比如刚发了新消息），重新读取
          setStatus('目录和页面对不上，正在刷新…');
          loadTranscript();
          return;
        }
        sc.scrollTo({ top: sc.scrollTop + Math.max(sc.clientHeight * 0.5, (tIdx - cur) * avg), behavior: 'instant' });
      }
      await nextFrames();
    }
    setStatus('跳转超时，可以再点一次试试');
  }

  async function goTop() {
    await jumpTo(0, { flash: false });
    const sc = A().getScrollContainer();
    if (sc && ui.status && !ui.status.textContent) await scrollSmooth(sc, 0);
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

  // 到达后在目标位置上盖一个半透明框闪两下（叠加层，不碰原来的元素）
  function flashOver(el) {
    if (!el || !el.isConnected || !ui.root) return;
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'flash';
    Object.assign(f.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: Math.min(r.height, innerHeight) + 12 + 'px' });
    ui.root.appendChild(f);
    setTimeout(() => f.remove(), 1400);
  }

  // ———————————————— 给面板让位 ————————————————
  // 面板展开时，如果对话区右边的空地放不下面板，就让对话区往左挪（必要时变窄），保证正文不被挡住。
  // 算法：外层宽 P，对话栏最大宽 W，需要的右侧空地 R。对话栏在 (P - 右边距 p) 里居中，
  // 右边空地 = (P + p - W) / 2 ≥ R  →  p = max(0, 2R + W - P)

  const PANEL_SPACE = 256 + 16 + 16; // 面板宽 + 离窗口右边 + 和正文的间隔
  let spaceEl = null;
  let spacePx = -1;

  function updateSpace() {
    const hook = A().styleHooks && A().styleHooks.reserveRightSpace;
    const col = A().getChatColumn && A().getChatColumn();
    let p = 0;
    if (hook && col && col.parentElement && host && open && A().getConversationId()) {
      const P = col.parentElement.clientWidth;
      const W = parseFloat(getComputedStyle(col).maxWidth) || col.getBoundingClientRect().width;
      p = Math.max(0, Math.ceil(2 * PANEL_SPACE + W - P));
    }
    if (p === spacePx) return;
    spacePx = p;
    if (!p) {
      if (spaceEl) spaceEl.remove();
      return;
    }
    if (!spaceEl) {
      spaceEl = document.createElement('style');
      spaceEl.id = 'chat-reader-toc-space';
    }
    spaceEl.textContent = hook(p);
    if (!spaceEl.isConnected) document.head.appendChild(spaceEl);
  }

  const onResize = CR.utils.debounce(guard(updateSpace), 150);

  // ———————————————— 界面 ————————————————

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #ffffff; --fg: #2b2a27; --muted: #85827a; --line: #e6e3da; --hover: #f3f1ea;
      --accent: #c96442; --accent-soft: rgba(201, 100, 66, 0.12); --shadow: 0 6px 24px rgba(0,0,0,.12);
      font: 13px/1.45 "Microsoft YaHei", system-ui, sans-serif; color: var(--fg);
    }
    .wrap.dark {
      --bg: #2b2b29; --fg: #e9e7e0; --muted: #9c998f; --line: #3e3d39; --hover: #353532;
      --accent: #d97757; --accent-soft: rgba(217, 119, 87, 0.16); --shadow: 0 6px 24px rgba(0,0,0,.45);
    }
    .panel {
      position: fixed; top: 64px; right: 16px; width: 256px;
      max-height: calc(100vh - 220px); min-height: 160px;
      display: flex; flex-direction: column;
      background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
      overflow: hidden;
    }
    .head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px 14px; }
    .title { font-weight: 600; font-size: 14px; }
    .count { color: var(--muted); font-size: 12px; flex: 1; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    .icon { width: 26px; height: 26px; border-radius: 6px; color: var(--muted); font-size: 16px; line-height: 26px; text-align: center; }
    .icon:hover { background: var(--hover); color: var(--fg); }
    .progress { height: 3px; margin: 0 14px; background: var(--line); border-radius: 2px; overflow: hidden; }
    .bar { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
    .meta { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; padding: 4px 14px 6px; }
    .list { list-style: none; margin: 0; padding: 4px 6px 6px; overflow-y: auto; flex: 1; scrollbar-width: thin; }
    .item {
      display: flex; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 7px;
      color: var(--fg); white-space: nowrap; overflow: hidden;
    }
    .item:hover { background: var(--hover); }
    .item .n { color: var(--muted); min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; flex: none; }
    .item .t { overflow: hidden; text-overflow: ellipsis; }
    .item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .item.active .n { color: var(--accent); }
    .status { color: var(--muted); font-size: 12px; padding: 4px 14px; }
    .status:empty { display: none; }
    .empty { color: var(--muted); padding: 12px 10px; }
    .foot { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--line); }
    .foot button { flex: 1; padding: 5px 0; border-radius: 7px; border: 1px solid var(--line); color: var(--muted); }
    .foot button:hover { color: var(--accent); border-color: var(--accent); }
    .tab {
      position: fixed; right: 0; top: 140px; padding: 10px 6px; writing-mode: vertical-rl; letter-spacing: 2px;
      background: var(--bg); color: var(--muted); border: 1px solid var(--line); border-right: 0;
      border-radius: 10px 0 0 10px; box-shadow: var(--shadow);
    }
    .tab:hover { color: var(--accent); }
    .hidden { display: none !important; }
    .flash {
      position: fixed; pointer-events: none; border-radius: 12px;
      border: 2px solid var(--accent); background: var(--accent-soft);
      animation: cr-flash 1.4s ease-out forwards;
    }
    @keyframes cr-flash { 0%,40% { opacity: 1; } 20%,60% { opacity: .25; } 100% { opacity: 0; } }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'chat-reader-toc';
    host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:0;z-index:30;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = CSS;

    const wrap = h('div', 'wrap');
    const panel = h('div', 'panel');
    const head = h('div', 'head');
    const count = h('span', 'count');
    const collapse = h('button', 'icon', '›');
    collapse.title = '收起目录';
    head.append(h('span', 'title', '目录'), count, collapse);

    const progress = h('div', 'progress');
    const bar = h('div', 'bar');
    progress.append(bar);
    const meta = h('div', 'meta');
    const where = h('span');
    const pct = h('span');
    meta.append(where, pct);

    const status = h('div', 'status');
    const list = h('ol', 'list');
    const foot = h('div', 'foot');
    const top = h('button', null, '↑ 回到顶部');
    const bottom = h('button', null, '↓ 回到底部');
    foot.append(top, bottom);
    panel.append(head, progress, meta, status, list, foot);

    const tab = h('button', 'tab', '目录');
    tab.title = '展开目录';
    wrap.append(panel, tab);
    shadow.append(style, wrap);

    collapse.addEventListener('click', () => setOpen(false));
    tab.addEventListener('click', () => setOpen(true));
    top.addEventListener('click', guard(goTop));
    bottom.addEventListener('click', guard(goBottom));
    list.addEventListener(
      'click',
      guard((e) => {
        const btn = e.target.closest('.item');
        if (!btn) return;
        const i = Number(btn.dataset.i);
        setActive(i);
        jumpTo(questions[i].tIndex);
      }),
    );

    ui = { root: wrap, panel, tab, count, bar, where, pct, status, list };
    document.body.appendChild(host);
    window.addEventListener('resize', onResize);
    applyTheme();
    applyOpen();
  }

  function unmount() {
    jumpToken++;
    teardownObserver();
    if (host) host.remove();
    host = null;
    ui = {};
    window.removeEventListener('resize', onResize);
    updateSpace();
  }

  function ensureAttached() {
    if (host && !host.isConnected) document.body.appendChild(host);
  }

  function applyTheme() {
    if (ui.root) ui.root.classList.toggle('dark', A().getTheme() === 'dark');
  }

  function applyOpen() {
    if (!ui.panel) return;
    const inChat = !!A().getConversationId();
    ui.panel.classList.toggle('hidden', !inChat || !open);
    ui.tab.classList.toggle('hidden', !inChat || open);
    updateSpace();
  }

  function setOpen(v) {
    open = v;
    applyOpen();
    chrome.storage.local.set({ [OPEN_KEY]: v });
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function renderList() {
    if (!ui.list) return;
    ui.list.textContent = '';
    ui.count.textContent = questions.length ? `${questions.length} 问` : '';
    if (!questions.length) {
      ui.list.append(h('li', 'empty', convId ? '这个对话还没有提问' : ''));
      ui.where.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    questions.forEach((q, i) => {
      const li = h('li');
      const btn = h('button', 'item');
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
    const items = ui.list.querySelectorAll('.item');
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

  function onConversationChange() {
    jumpToken++;
    transcript = null;
    questions = [];
    activeQ = -1;
    refetchDelay = 3000;
    setStatus('');
    applyOpen();
    renderList();
    teardownObserver();
    setupObserver();
    loadTranscript();
  }

  function onContentChange() {
    ensureAttached();
    setupObserver();
    observeRows();
    checkFreshness();
    updateActive();
    updateProgress();
    updateSpace();
  }

  async function enable() {
    const r = await chrome.storage.local.get(OPEN_KEY);
    open = r[OPEN_KEY] !== false;
    mount();
    onConversationChange();
  }

  const isEnabled = () => CR.settings.toc.enabled;

  CR.featureManager.register('toc', '目录', {
    start() {
      if (isEnabled()) enable();
      CR.events.on('settings-change', (e) => {
        if (e.key === 'typography' && host) CR.featureManager.run('toc', updateSpace); // 对话区宽度可能变了
        if (e.key !== 'toc') return;
        CR.featureManager.run('toc', () => (isEnabled() ? enable() : unmount()));
      });
      CR.events.on('conversation-change', guard(() => host && onConversationChange()));
      CR.events.on('content-change', guard(() => host && onContentChange()));
      CR.events.on('theme-change', guard(applyTheme));
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'cr:toggle-toc' && host) CR.featureManager.run('toc', () => setOpen(!open));
      });
    },
    stop: unmount,
    isEnabled,
  });
})();
