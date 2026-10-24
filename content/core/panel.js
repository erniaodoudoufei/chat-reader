// 右侧浮动面板（共享）：目录、标注各占一个标签页。
// 面板放在 Shadow DOM 里（相当于一个隔音房间：Claude 的样式进不来，面板的样式也漏不出去），挂在 <body> 最后，不碰 Claude 的页面元素。
// 这里只管外框：标签切换、收起/展开（记住状态）、深浅色、给正文让位、闪烁提示。每个标签页的内容由各功能自己画。
(() => {
  const CR = window.CR;
  const A = () => CR.adapter;

  const OPEN_KEY = 'tocOpen';
  const TAB_KEY = 'panelTab';
  const PANEL_SPACE = 256 + 16 + 16; // 面板宽 + 离窗口右边 + 和正文的间隔

  const tabs = {}; // id -> { id, label, css, build, onShow, enabled, btn, body }
  const order = [];
  let host = null;
  let ui = {};
  let open = true;
  let current = null;
  let prefsLoaded = null;

  const BASE_CSS = `
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
    .head { display: flex; align-items: center; gap: 2px; padding: 8px 8px 4px 8px; }
    .tabs { display: flex; gap: 2px; flex: 1; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    .tabbtn { padding: 4px 8px; border-radius: 7px; color: var(--muted); font-weight: 600; font-size: 14px; }
    .tabbtn:hover { background: var(--hover); color: var(--fg); }
    .tabbtn[aria-selected="true"] { color: var(--fg); background: var(--hover); }
    .tabbtn .badge { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 4px; }
    .icon { width: 26px; height: 26px; border-radius: 6px; color: var(--muted); font-size: 16px; line-height: 26px; text-align: center; }
    .icon:hover { background: var(--hover); color: var(--fg); }
    .body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .tab-pill {
      position: fixed; right: 0; top: 140px; padding: 10px 6px; writing-mode: vertical-rl; letter-spacing: 2px;
      background: var(--bg); color: var(--muted); border: 1px solid var(--line); border-right: 0;
      border-radius: 10px 0 0 10px; box-shadow: var(--shadow);
    }
    .tab-pill:hover { color: var(--accent); }
    .hidden { display: none !important; }
    .flash {
      position: fixed; pointer-events: none; border-radius: 12px;
      border: 2px solid var(--accent); background: var(--accent-soft);
      animation: cr-flash 1.4s ease-out forwards; z-index: 2;
    }
    @keyframes cr-flash { 0%,40% { opacity: 1; } 20%,60% { opacity: .25; } 100% { opacity: 0; } }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const safe = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      CR.error('面板出错：', e);
    }
  };

  // ———————————————— 外框 ————————————————

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'chat-reader-panel';
    host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:0;z-index:30;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = BASE_CSS + order.map((id) => tabs[id].css || '').join('\n');

    const wrap = h('div', 'wrap');
    const panel = h('div', 'panel');
    const head = h('div', 'head');
    const tabBar = h('div', 'tabs');
    const collapse = h('button', 'icon', '›');
    collapse.title = '收起面板（Alt+M）';
    head.append(tabBar, collapse);
    panel.append(head);

    for (const id of order) {
      const t = tabs[id];
      t.btn = h('button', 'tabbtn');
      t.btn.append(document.createTextNode(t.label), (t.badgeEl = h('span', 'badge')));
      t.btn.addEventListener('click', () => select(id));
      tabBar.append(t.btn);
      t.body = h('div', 'body');
      panel.append(t.body);
      try {
        t.build(t.body);
      } catch (e) {
        CR.error(`面板标签「${t.label}」初始化出错：`, e);
      }
    }

    const pill = h('button', 'tab-pill', '目录');
    pill.title = '展开面板（Alt+M）';
    wrap.append(panel, pill);
    shadow.append(style, wrap);

    collapse.addEventListener('click', () => setOpen(false));
    pill.addEventListener('click', () => setOpen(true));

    ui = { root: wrap, panel, pill };
    document.body.appendChild(host);
    window.addEventListener('resize', onResize);
    applyTheme();
    refresh();
  }

  function unmount() {
    if (host) host.remove();
    host = null;
    ui = {};
    for (const id of order) tabs[id].btn = tabs[id].body = tabs[id].badgeEl = null;
    window.removeEventListener('resize', onResize);
    updateSpace();
  }

  function enabledTabs() {
    return order.filter((id) => tabs[id].enabled);
  }

  // 根据开关状态决定：面板挂不挂、显示哪些标签、显示哪个
  function refresh() {
    const list = enabledTabs();
    if (!list.length) return unmount();
    if (!host) return mount();
    if (!list.includes(current)) current = list[0];
    for (const id of order) {
      const t = tabs[id];
      t.btn.classList.toggle('hidden', !t.enabled);
      t.btn.setAttribute('aria-selected', String(id === current));
      t.body.classList.toggle('hidden', id !== current);
    }
    ui.pill.textContent = tabs[current].label;
    applyOpen();
  }

  function select(id) {
    if (!tabs[id] || !tabs[id].enabled) return;
    const changed = current !== id;
    current = id;
    refresh();
    chrome.storage.local.set({ [TAB_KEY]: id });
    if (changed && tabs[id].onShow) safe(tabs[id].onShow)();
  }

  function applyTheme() {
    if (ui.root) ui.root.classList.toggle('dark', A().getTheme() === 'dark');
  }

  function applyOpen() {
    if (!ui.panel) return;
    const inChat = !!A().getConversationId();
    ui.panel.classList.toggle('hidden', !inChat || !open);
    ui.pill.classList.toggle('hidden', !inChat || open);
    updateSpace();
  }

  function setOpen(v) {
    open = v;
    applyOpen();
    chrome.storage.local.set({ [OPEN_KEY]: v });
    if (v && current && tabs[current].onShow) safe(tabs[current].onShow)();
  }

  // ———————————————— 给面板让位 ————————————————
  // 面板展开时，如果对话区右边的空地放不下面板，就让对话区往左挪（必要时变窄），保证正文不被挡住。
  // 算法：外层宽 P，对话栏最大宽 W，需要的右侧空地 R。对话栏在 (P - 右边距 p) 里居中，
  // 右边空地 = (P + p - W) / 2 ≥ R  →  p = max(0, 2R + W - P)

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
      spaceEl.id = 'chat-reader-panel-space';
    }
    spaceEl.textContent = hook(p);
    if (!spaceEl.isConnected) document.head.appendChild(spaceEl);
  }

  const onResize = CR.utils.debounce(safe(updateSpace), 150);

  // ———————————————— 对外接口 ————————————————

  let started = false;
  function start() {
    if (started) return;
    started = true;
    prefsLoaded = chrome.storage.local.get([OPEN_KEY, TAB_KEY]).then((r) => {
      open = r[OPEN_KEY] !== false;
      if (r[TAB_KEY]) current = r[TAB_KEY];
    });
    CR.events.on('conversation-change', safe(applyOpen));
    CR.events.on('content-change', safe(() => {
      if (host && !host.isConnected) document.body.appendChild(host);
      updateSpace();
    }));
    CR.events.on('theme-change', safe(applyTheme));
    CR.events.on('settings-change', safe((e) => e.key === 'typography' && updateSpace())); // 对话区宽度可能变了
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'cr:toggle-toc' && host) safe(setOpen)(!open);
    });
  }

  CR.panel = {
    // 登记一个标签页。build(container) 画内容；onShow() 切到这个标签时调用
    register(id, { label, css, build, onShow }) {
      tabs[id] = { id, label, css, build, onShow, enabled: false };
      order.push(id);
    },
    async setEnabled(id, enabled) {
      start();
      await prefsLoaded;
      if (!tabs[id] || tabs[id].enabled === enabled) return;
      tabs[id].enabled = enabled;
      // 新开/关一个标签时，外框要重建，才能带上它的内容和样式
      if (host) unmount();
      refresh();
    },
    select,
    setBadge(id, text) {
      if (tabs[id] && tabs[id].badgeEl) tabs[id].badgeEl.textContent = text || '';
    },
    get isOpen() {
      return !!host && open && !!A().getConversationId();
    },
    get currentTab() {
      return current;
    },
    // 在屏幕某个区域上盖一个闪两下的框（叠加层，不碰原来的元素）
    flashRect(r) {
      if (!ui.root || !r) return;
      const f = h('div', 'flash');
      Object.assign(f.style, {
        left: r.left - 6 + 'px',
        top: r.top - 6 + 'px',
        width: r.width + 12 + 'px',
        height: Math.min(r.height, innerHeight) + 12 + 'px',
      });
      ui.root.appendChild(f);
      setTimeout(() => f.remove(), 1400);
    },
  };
})();
