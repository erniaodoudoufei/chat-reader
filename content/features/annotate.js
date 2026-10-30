// 标注：选中文字 → 浮动工具栏（颜色高亮 / 波浪线 / 批注）；点击已有标注可改颜色、写批注、删除；
// 右侧面板的"标注"标签页列出本对话的全部标注。
//
// 高亮用 CSS Custom Highlight API（CSS.highlights + ::highlight()）来画：只是在文字上"盖一层颜色"，不改页面元素。
// 因为高亮不产生页面元素，点击时要根据点击坐标判断点中了哪条标注。
// Claude 只把屏幕附近的消息放在页面里，所以每次页面变化都重新找一遍"当前显示的消息里有哪些标注"再画。
(() => {
  const CR = window.CR;
  const A = () => CR.adapter;
  const T = () => CR.transcript;
  const S = globalThis.CR_ANN;
  const guard = (fn) => (...args) => CR.featureManager.run('annotate', () => fn(...args));
  const isEnabled = () => CR.settings.annotate.enabled;

  const COLORS = S.COLORS.map((c) => c.id);

  let active = false;
  let convId = null;
  let group = null; // { convId, title, url, items }
  let lastSaved = '';
  const resolved = new Map(); // 标注 id → { range, m }：当前画在页面上的
  const statusById = new Map(); // 标注 id → 'ok' | 'orphan'
  const ownedHighlights = new Set();
  let hlStyleEl = null;

  // ———————————————— 数据 ————————————————

  async function loadGroup() {
    const id = A().getConversationId();
    convId = id;
    resolved.clear();
    statusById.clear();
    if (!id) {
      group = null;
      paint();
      return;
    }
    const g = await S.getGroup(id);
    if (convId !== id) return;
    group = g || { convId: id, title: A().getTitle(), url: A().getConversationUrl(id), items: [] };
    for (const a of group.items) if (a.status === 'orphan') statusById.set(a.id, 'orphan');
    lastSaved = JSON.stringify(group.items);
    paint();
  }

  async function persist() {
    if (!group) return;
    group.title = A().getTitle() || group.title;
    group.url = group.url || A().getConversationUrl(group.convId);
    for (const a of group.items) {
      const st = statusById.get(a.id);
      if (st) a.status = st;
    }
    lastSaved = JSON.stringify(group.items);
    await S.saveGroup(group);
  }

  const persistSoon = CR.utils.debounce(() => persist().catch((e) => CR.error('保存标注失败：', e)), 600);

  const sortItems = () =>
    group.items.sort((a, b) => a.messageIndex - b.messageIndex || a.offset - b.offset || a.createdAt - b.createdAt);

  // 页面上某条消息在整段对话里的序号（读不到整段数据时用页面序号）
  function indexInConversation(a) {
    const data = T().data;
    if (data && a.messageUuid) {
      const i = data.messages.findIndex((m) => m.uuid === a.messageUuid);
      if (i >= 0) return i;
    }
    return a.messageIndex;
  }

  // ———————————————— 画高亮 ————————————————

  function highlightCss(dark) {
    const bg = dark
      ? { yellow: 'rgba(250,204,21,.32)', green: 'rgba(81,207,102,.28)', blue: 'rgba(77,171,247,.30)', pink: 'rgba(247,131,172,.30)', purple: 'rgba(177,151,252,.30)' }
      : { yellow: 'rgba(255,212,0,.42)', green: 'rgba(64,192,87,.30)', blue: 'rgba(51,154,240,.28)', pink: 'rgba(240,101,149,.28)', purple: 'rgba(151,117,250,.28)' };
    const line = dark
      ? { yellow: '#fcc419', green: '#69db7c', blue: '#74c0fc', pink: '#faa2c1', purple: '#b197fc' }
      : { yellow: '#d9a400', green: '#2f9e44', blue: '#1c7ed6', pink: '#d6336c', purple: '#7048e8' };
    const rules = [];
    for (const c of COLORS) {
      rules.push(`::highlight(cr-hl-${c}) { background-color: ${bg[c]}; }`);
      rules.push(
        `::highlight(cr-wavy-${c}) { text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: ${line[c]}; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }`,
      );
    }
    rules.push(`::highlight(cr-note) { text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: currentColor; text-underline-offset: 4px; }`);
    rules.push(`::highlight(cr-flash) { background-color: ${dark ? 'rgba(255,146,43,.65)' : 'rgba(255,146,43,.55)'}; }`);
    return rules.join('\n');
  }

  function applyHighlightCss() {
    if (!hlStyleEl) {
      hlStyleEl = document.createElement('style');
      hlStyleEl.id = 'chat-reader-highlights';
    }
    hlStyleEl.textContent = highlightCss(A().getTheme() === 'dark');
    if (!hlStyleEl.isConnected) document.head.appendChild(hlStyleEl);
  }

  function setHighlights(byName) {
    for (const name of ownedHighlights) if (!byName[name]) CSS.highlights.delete(name);
    ownedHighlights.clear();
    for (const [name, ranges] of Object.entries(byName)) {
      const hl = new Highlight(...ranges);
      hl.priority = name === 'cr-flash' ? 3 : name === 'cr-note' ? 2 : name.startsWith('cr-wavy') ? 1 : 0;
      CSS.highlights.set(name, hl);
      ownedHighlights.add(name);
    }
  }

  let flashRange = null;

  // 重新找一遍当前显示的消息里有哪些标注，并画出来
  function paint() {
    const byName = {};
    const add = (name, r) => (byName[name] ||= []).push(r);
    resolved.clear();
    let statusChanged = false;
    const setStatus = (id, st) => {
      if (statusById.get(id) !== st) {
        statusById.set(id, st);
        statusChanged = true;
      }
    };

    if (group && group.items.length) {
      const data = T().data;
      const uuids = data ? new Set(data.messages.map((m) => m.uuid)) : null;
      const info = A()
        .getRenderedMessages()
        .map((m) => ({ m, tIdx: T().indexOf(m), item: T().itemOf(m) }));
      const maps = new Map();
      const mapOf = (m) => {
        if (!maps.has(m.el)) maps.set(m.el, CR.anchoring.textMap(A().getAnnotationRoot(m), A().annotationIgnore));
        return maps.get(m.el);
      };

      for (const a of group.items) {
        // 所在的消息已经不在对话里了（编辑过提问 / 重新生成了回复，换到了新的分支）
        if (uuids && a.messageUuid && !uuids.has(a.messageUuid)) {
          setStatus(a.id, 'orphan');
          continue;
        }
        let target = null;
        let pos = null;
        if (data) {
          target = info.find((x) => x.item && (a.messageUuid ? x.item.uuid === a.messageUuid : x.tIdx === a.messageIndex && x.m.role === a.role));
          if (!target) continue; // 不在屏幕附近，状态不变
          if (A().isStreaming(target.m)) continue; // 还在生成，文字会变
          pos = CR.anchoring.locate(mapOf(target.m), a);
          if (!pos) {
            setStatus(a.id, 'orphan');
            continue;
          }
        } else {
          // 降级：读不到整段数据时，在页面上同角色的消息里按文字找
          for (const x of info) {
            if (x.m.role !== a.role) continue;
            const p = CR.anchoring.locate(mapOf(x.m), a);
            if (p) {
              target = x;
              pos = p;
              break;
            }
          }
          if (!target) continue;
        }
        const range = CR.anchoring.toRange(mapOf(target.m), pos.start, pos.end);
        if (!range) continue;
        resolved.set(a.id, { range, m: target.m });
        setStatus(a.id, 'ok');
        add(`cr-${a.style === 'wavy' ? 'wavy' : 'hl'}-${a.color}`, range);
        if (a.note) add('cr-note', range);
      }
    }
    if (flashRange) add('cr-flash', flashRange);
    setHighlights(byName);
    if (statusChanged) persistSoon();
    renderTab();
    announce();
  }

  // 告诉其他功能（目录）：本对话有哪些有效标注、各在哪条消息上。只在内容变了时才发事件
  let lastAnnounced = '';
  function announce() {
    const list = (group ? group.items : [])
      .filter((a) => statusById.get(a.id) !== 'orphan')
      .map((a) => ({ tIndex: indexInConversation(a), color: a.color }));
    const key = JSON.stringify(list);
    if (key === lastAnnounced) return;
    lastAnnounced = key;
    CR.events.emit('annotations-change', list);
  }

  const paintSoon = CR.utils.debounce(guard(paint), 120);

  // ———————————————— 选中文字 → 工具栏 ————————————————

  let pending = null; // { range, m }：工具栏针对的选区

  function selectionTarget() {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const m = A().findMessageForNode(range.startContainer);
    if (!m || !String(sel).trim()) return null;
    return { range: range.cloneRange(), m };
  }

  const inOurUi = (e) => e.composedPath().some((n) => n === uiHost || (n && n.id === 'chat-reader-panel'));

  function onMouseUp(e) {
    if (inOurUi(e)) return;
    setTimeout(
      guard(() => {
        pending = selectionTarget();
        if (pending) showToolbar(pending.range.getBoundingClientRect());
        else hideToolbar();
      }),
      0,
    );
  }

  function onKeyUp(e) {
    if (e.key === 'Escape') return closeAll();
    if (!e.shiftKey) return;
    pending = selectionTarget();
    if (pending) showToolbar(pending.range.getBoundingClientRect());
  }

  async function create({ color, style, withNote }) {
    if (!pending || !group) return;
    const { range, m } = pending;
    const map = CR.anchoring.textMap(A().getAnnotationRoot(m), A().annotationIgnore);
    const d = CR.anchoring.describe(map, range);
    hideToolbar();
    getSelection().removeAllRanges();
    pending = null;
    if (!d) return;
    const item = T().itemOf(m);
    const now = Date.now();
    const a = {
      id: S.newId(),
      ...d,
      messageIndex: T().indexOf(m),
      messageUuid: item ? item.uuid : null,
      role: m.role,
      color,
      style,
      note: '',
      title: A().getTitle(),
      createdAt: now,
      updatedAt: now,
      status: 'ok',
    };
    group.items.push(a);
    sortItems();
    paint();
    await persist();
    if (withNote) {
      const r = resolved.get(a.id);
      openEditor(a.id, r ? r.range.getBoundingClientRect() : null, true);
    }
  }

  // ———————————————— 点击已有标注 → 编辑框 ————————————————

  // 根据点击坐标找标注（高亮不产生页面元素，只能比对文字的位置）；重叠时选最短的那条
  function hitTest(x, y) {
    let best = null;
    let bestLen = Infinity;
    for (const [id, { range }] of resolved) {
      for (const r of range.getClientRects()) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
          const len = range.toString().length;
          if (len < bestLen) {
            best = id;
            bestLen = len;
          }
          break;
        }
      }
    }
    return best;
  }

  function onClick(e) {
    if (inOurUi(e) || e.button !== 0) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    const id = hitTest(e.clientX, e.clientY);
    if (id) openEditor(id, new DOMRect(e.clientX, e.clientY, 0, 0));
  }

  function onMouseDownOutside(e) {
    if (inOurUi(e)) return;
    if (ui.pop && !ui.pop.classList.contains('hidden')) closeEditor();
  }

  // ———————————————— 浮层界面（工具栏 + 编辑框） ————————————————

  let uiHost = null;
  let ui = {};
  let editingId = null;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #ffffff; --fg: #2b2a27; --muted: #85827a; --line: #e6e3da; --hover: #f3f1ea;
      --accent: #c96442; --shadow: 0 6px 24px rgba(0,0,0,.16);
      font: 13px/1.45 "Microsoft YaHei", system-ui, sans-serif; color: var(--fg);
    }
    .wrap.dark { --bg: #2b2b29; --fg: #e9e7e0; --muted: #9c998f; --line: #3e3d39; --hover: #353532; --accent: #d97757; --shadow: 0 6px 24px rgba(0,0,0,.5); }
    .box { position: fixed; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); z-index: 40; }
    .hidden { display: none !important; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    .bar { display: flex; align-items: center; gap: 2px; padding: 5px 6px; }
    .dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; }
    .dot:hover { background: var(--hover); }
    .dot i { width: 14px; height: 14px; border-radius: 50%; display: block; border: 1px solid rgba(0,0,0,.08); }
    .sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }
    .tbtn { padding: 3px 7px; border-radius: 6px; white-space: nowrap; }
    .tbtn:hover { background: var(--hover); }
    .tbtn:disabled { color: var(--muted); opacity: .6; cursor: default; background: none; }
    .wavy { text-decoration: underline wavy var(--accent); text-underline-offset: 3px; }
    .pop { width: 280px; padding: 10px; }
    .row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
    .dot[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--accent); }
    .seg { display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; margin-left: auto; }
    .seg button { padding: 2px 8px; font-size: 12px; color: var(--muted); }
    .seg button[aria-pressed="true"] { background: var(--hover); color: var(--fg); font-weight: 600; }
    .quote { color: var(--muted); font-size: 12px; margin-bottom: 6px; max-height: 3.2em; overflow: hidden; }
    textarea {
      width: 100%; min-height: 72px; max-height: 220px; resize: vertical; padding: 6px 8px;
      font: inherit; color: var(--fg); background: var(--hover); border: 1px solid var(--line); border-radius: 7px; outline: none;
    }
    textarea:focus { border-color: var(--accent); }
    .foot { display: flex; justify-content: space-between; margin: 8px 0 0; }
    .danger { color: #e5484d; padding: 3px 6px; border-radius: 6px; }
    .danger:hover { background: rgba(229,72,77,.1); }
    .done { padding: 3px 12px; border-radius: 6px; border: 1px solid var(--line); }
    .done:hover { border-color: var(--accent); color: var(--accent); }
  `;

  const SWATCH = Object.fromEntries(S.COLORS.map((c) => [c.id, c.swatch]));
  const COLOR_LABEL = Object.fromEntries(S.COLORS.map((c) => [c.id, c.label]));

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function dotButton(color) {
    const b = h('button', 'dot');
    const i = h('i');
    i.style.background = SWATCH[color];
    b.append(i);
    b.dataset.color = color;
    return b;
  }

  function mountUi() {
    if (uiHost) return;
    uiHost = document.createElement('div');
    uiHost.id = 'chat-reader-annotate';
    uiHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:40;';
    const shadow = uiHost.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = UI_CSS;
    const wrap = h('div', 'wrap');

    // 工具栏
    const bar = h('div', 'box bar hidden');
    for (const c of COLORS) {
      const b = dotButton(c);
      b.title = `${COLOR_LABEL[c]}高亮`;
      b.addEventListener('click', guard(() => create({ color: c, style: 'hl' })));
      bar.append(b);
    }
    bar.append(h('span', 'sep'));
    const wavy = h('button', 'tbtn');
    wavy.append(h('span', 'wavy', '波浪线'));
    wavy.title = '加波浪下划线';
    wavy.addEventListener('click', guard(() => create({ color: 'pink', style: 'wavy' })));
    const note = h('button', 'tbtn', '✎ 批注');
    note.title = '高亮并写批注';
    note.addEventListener('click', guard(() => create({ color: 'yellow', style: 'hl', withNote: true })));
    bar.append(wavy, note);
    // 按下按钮时别让页面上的选区消失
    bar.addEventListener('mousedown', (e) => e.preventDefault());

    // 编辑框
    const pop = h('div', 'box pop hidden');
    const colorRow = h('div', 'row');
    const dots = COLORS.map((c) => {
      const b = dotButton(c);
      b.title = COLOR_LABEL[c];
      b.addEventListener('click', guard(() => updateEditing({ color: c })));
      return b;
    });
    const seg = h('div', 'seg');
    const segHl = h('button', null, '高亮');
    const segWavy = h('button', null, '波浪线');
    segHl.addEventListener('click', guard(() => updateEditing({ style: 'hl' })));
    segWavy.addEventListener('click', guard(() => updateEditing({ style: 'wavy' })));
    seg.append(segHl, segWavy);
    colorRow.append(...dots, seg);
    const quote = h('div', 'quote');
    const textarea = h('textarea');
    textarea.placeholder = '写点批注…（Ctrl+Enter 完成）';
    textarea.addEventListener(
      'input',
      guard(() => updateEditing({ note: textarea.value }, { repaint: false })),
    );
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) closeEditor();
      if (e.key === 'Escape') closeEditor();
      e.stopPropagation(); // 别让 Claude 的快捷键接收到
    });
    const foot = h('div', 'foot');
    const del = h('button', 'danger', '删除标注');
    const done = h('button', 'done', '完成');
    del.addEventListener('click', guard(() => removeItem(editingId)));
    done.addEventListener('click', guard(closeEditor));
    foot.append(del, done);
    pop.append(colorRow, quote, textarea, foot);

    wrap.append(bar, pop);
    shadow.append(style, wrap);
    document.body.appendChild(uiHost);
    ui = { wrap, bar, pop, dots, segHl, segWavy, quote, textarea };
    applyUiTheme();
  }

  function unmountUi() {
    if (uiHost) uiHost.remove();
    uiHost = null;
    ui = {};
    editingId = null;
  }

  function applyUiTheme() {
    if (ui.wrap) ui.wrap.classList.toggle('dark', A().getTheme() === 'dark');
  }

  // 把浮层放在某个矩形的下方（下方放不下才放上方），左右不超出窗口。
  // 放下方是因为 Claude 自己的"回复"按钮和其他插件的划词按钮通常出现在选区上方，避免互相遮挡
  function place(box, rect) {
    box.classList.remove('hidden');
    const w = box.offsetWidth;
    const hgt = box.offsetHeight;
    let top = rect.bottom + 10;
    if (top + hgt > innerHeight - 8) top = rect.top - hgt - 10;
    top = Math.max(8, Math.min(top, innerHeight - hgt - 8));
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8));
    box.style.top = top + 'px';
    box.style.left = left + 'px';
  }

  function showToolbar(rect) {
    mountUi();
    closeEditor();
    place(ui.bar, rect);
  }

  function hideToolbar() {
    if (ui.bar) ui.bar.classList.add('hidden');
  }

  function findItem(id) {
    return group && group.items.find((a) => a.id === id);
  }

  function openEditor(id, rect, focus) {
    const a = findItem(id);
    if (!a) return;
    mountUi();
    hideToolbar();
    if (editingId && editingId !== id) persistSoon();
    editingId = id;
    syncEditor();
    ui.textarea.value = a.note || '';
    ui.quote.textContent = '“' + a.exact.replace(/\s+/g, ' ').slice(0, 80) + (a.exact.length > 80 ? '…' : '') + '”';
    const r = rect || (resolved.get(id) && resolved.get(id).range.getBoundingClientRect()) || new DOMRect(innerWidth / 2, innerHeight / 3, 0, 0);
    place(ui.pop, r);
    if (focus) ui.textarea.focus();
  }

  function syncEditor() {
    const a = findItem(editingId);
    if (!a || !ui.pop) return;
    ui.dots.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === a.color)));
    ui.segHl.setAttribute('aria-pressed', String(a.style !== 'wavy'));
    ui.segWavy.setAttribute('aria-pressed', String(a.style === 'wavy'));
  }

  function closeEditor() {
    if (!ui.pop || ui.pop.classList.contains('hidden')) return;
    ui.pop.classList.add('hidden');
    if (editingId) persist().catch((e) => CR.error('保存标注失败：', e));
    editingId = null;
  }

  function closeAll() {
    hideToolbar();
    closeEditor();
  }

  function updateEditing(patch, { repaint = true } = {}) {
    const a = findItem(editingId);
    if (!a) return;
    const hadNote = !!a.note;
    Object.assign(a, patch, { updatedAt: Date.now() });
    syncEditor();
    if (repaint || hadNote !== !!a.note) paint();
    else renderTab();
    persistSoon();
  }

  function removeItem(id) {
    if (!group) return;
    group.items = group.items.filter((a) => a.id !== id);
    statusById.delete(id);
    if (editingId === id) {
      editingId = null;
      if (ui.pop) ui.pop.classList.add('hidden');
    }
    paint();
    persist().catch((e) => CR.error('保存标注失败：', e));
  }

  // ———————————————— 跳到某条标注 ————————————————

  function flash(range) {
    let n = 0;
    const tick = () => {
      flashRange = n % 2 === 0 ? range : null;
      paint();
      if (++n < 4) setTimeout(guard(tick), 280);
      else {
        flashRange = null;
        paint();
      }
    };
    tick();
  }

  async function goTo(a) {
    const m = await CR.toc.jumpTo(indexInConversation(a), { flash: false, scroll: false });
    if (!m) return;
    paint();
    const r = resolved.get(a.id);
    if (!r) {
      // 消息到了但找不到原文：已失效
      await CR.toc.scrollRectIntoView(() => m.el.getBoundingClientRect());
      CR.panel.flashRect(m.bodyEl.getBoundingClientRect());
      return;
    }
    await CR.toc.scrollRectIntoView(() => r.range.getBoundingClientRect(), innerHeight * 0.3);
    flash(r.range);
  }

  // ———————————————— 面板里的"标注"标签页 ————————————————

  let tab = {};
  let filter = 'all';

  const TAB_CSS = `
    .an-filter { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 12px 6px; }
    .an-chip { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
    .an-chip i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .an-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    .an-list { list-style: none; margin: 0; padding: 2px 6px 6px; overflow-y: auto; flex: 1; scrollbar-width: thin; }
    .an-item { display: flex; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 7px; color: var(--fg); }
    .an-item:hover { background: var(--hover); }
    .an-bar { width: 4px; border-radius: 2px; flex: none; }
    .an-bar.wavy { background: none !important; border-left: 2px dashed; width: 0; }
    .an-main { min-width: 0; flex: 1; }
    .an-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .an-note { color: var(--muted); font-size: 12px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .an-note::before { content: "✎ "; }
    .an-sub { color: var(--muted); font-size: 12px; padding: 8px 8px 2px; border-top: 1px solid var(--line); margin-top: 6px; }
    .an-hint { font-size: 11px; color: var(--muted); padding: 0 8px 4px; }
    .an-orphan { opacity: .75; cursor: default; }
    .an-del { color: #e5484d; font-size: 12px; padding: 0 4px; border-radius: 5px; align-self: flex-start; }
    .an-del:hover { background: rgba(229,72,77,.1); }
    .an-empty { color: var(--muted); padding: 12px 10px; }
    .an-foot { display: flex; padding: 8px 10px 10px; border-top: 1px solid var(--line); }
    .an-foot button { flex: 1; padding: 5px 0; border-radius: 7px; border: 1px solid var(--line); color: var(--muted); }
    .an-foot button:hover { color: var(--accent); border-color: var(--accent); }
  `;

  function buildTab(container) {
    const filterRow = h('div', 'an-filter');
    const list = h('ol', 'an-list');
    const foot = h('div', 'an-foot');
    const notes = h('button', null, '打开「我的笔记」');
    notes.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cr:open-notes' }).catch(() => {}));
    foot.append(notes);
    container.append(filterRow, list, foot);

    const chips = [{ id: 'all', label: '全部' }, ...S.COLORS.map((c) => ({ id: c.id, label: '', color: c.id }))];
    for (const c of chips) {
      const b = h('button', 'an-chip', c.label);
      if (c.color) {
        const i = h('i');
        i.style.background = SWATCH[c.color];
        b.prepend(i);
        b.title = `只看${COLOR_LABEL[c.color]}`;
      }
      b.dataset.f = c.id;
      b.addEventListener('click', () => {
        filter = c.id;
        renderTab();
      });
      filterRow.append(b);
    }
    list.addEventListener(
      'click',
      guard((e) => {
        const del = e.target.closest('.an-del');
        if (del) return removeItem(del.dataset.id);
        const it = e.target.closest('.an-item');
        if (!it || it.classList.contains('an-orphan')) return;
        const a = findItem(it.dataset.id);
        if (a) goTo(a);
      }),
    );
    tab = { filterRow, list };
    renderTab();
  }

  function itemEl(a, orphan) {
    const li = h('li');
    const b = h(orphan ? 'div' : 'button', 'an-item' + (orphan ? ' an-orphan' : ''));
    b.dataset.id = a.id;
    const bar = h('span', 'an-bar' + (a.style === 'wavy' ? ' wavy' : ''));
    bar.style.background = SWATCH[a.color];
    bar.style.borderColor = SWATCH[a.color];
    const main = h('span', 'an-main');
    main.append(h('span', 'an-text', a.exact.replace(/\s+/g, ' ')));
    if (a.note) main.append(h('span', 'an-note', a.note));
    b.append(bar, main);
    if (orphan) {
      const del = h('button', 'an-del', '删除');
      del.dataset.id = a.id;
      b.append(del);
    }
    b.title = orphan ? '原文找不到了' : '点击跳到原文';
    li.append(b);
    return li;
  }

  function renderTab() {
    const items = group ? group.items : [];
    CR.panel.setBadge('annotate', items.length ? String(items.length) : '');
    if (!tab.list) return;
    tab.filterRow.querySelectorAll('.an-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.f === filter)));
    tab.list.textContent = '';
    if (!items.length) {
      tab.list.append(h('li', 'an-empty', A().getConversationId() ? '还没有标注。选中正文里的文字，就会弹出标注工具栏。' : ''));
      return;
    }
    const shown = items.filter((a) => filter === 'all' || a.color === filter);
    const live = shown.filter((a) => statusById.get(a.id) !== 'orphan');
    const dead = shown.filter((a) => statusById.get(a.id) === 'orphan');
    const frag = document.createDocumentFragment();
    if (!live.length && !dead.length) frag.append(h('li', 'an-empty', '这个颜色还没有标注'));
    live.forEach((a) => frag.append(itemEl(a, false)));
    if (dead.length) {
      frag.append(h('li', 'an-sub', `失效的标注（${dead.length}）`));
      frag.append(h('li', 'an-hint', '原文找不到了（可能编辑过提问或重新生成了回复），原文和批注都保留着。'));
      dead.forEach((a) => frag.append(itemEl(a, true)));
    }
    tab.list.append(frag);
  }

  // ———————————————— 生命周期 ————————————————

  function onStorageChange(changes, area) {
    if (area !== 'local' || !convId) return;
    const c = changes[S.key(convId)];
    if (!c) return;
    const items = (c.newValue && c.newValue.items) || [];
    if (JSON.stringify(items) === lastSaved) return; // 自己刚存的
    group = c.newValue || { convId, title: A().getTitle(), url: A().getConversationUrl(convId), items: [] };
    lastSaved = JSON.stringify(group.items);
    paint();
  }

  // 滚动时：工具栏的位置已经不对了，先收起；页面上显示的消息换了，就重新画一次高亮
  let lastRowsKey = '';
  let scrollTimer = 0;
  const onScroll = () => {
    hideToolbar();
    if (scrollTimer) return;
    scrollTimer = setTimeout(
      guard(() => {
        scrollTimer = 0;
        const key = A()
          .getRenderedMessages()
          .map((m) => m.index)
          .join(',');
        if (key !== lastRowsKey) {
          lastRowsKey = key;
          paint();
        }
      }),
      200,
    );
  };

  function setActive(on) {
    if (on === active) return;
    active = on;
    if (on) {
      if (!('highlights' in CSS)) throw new Error('这个版本的 Chrome 不支持 CSS 高亮，请升级 Chrome');
      CR.transcript.start();
      applyHighlightCss();
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('keyup', onKeyUp);
      document.addEventListener('click', onClick);
      document.addEventListener('mousedown', onMouseDownOutside);
      document.addEventListener('scroll', onScroll, true);
      chrome.storage.onChanged.addListener(onStorageChange);
      loadGroup();
    } else {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('click', onClick);
      document.removeEventListener('mousedown', onMouseDownOutside);
      document.removeEventListener('scroll', onScroll, true);
      chrome.storage.onChanged.removeListener(onStorageChange);
      for (const name of ownedHighlights) CSS.highlights.delete(name);
      ownedHighlights.clear();
      if (hlStyleEl) hlStyleEl.remove();
      unmountUi();
      group = null;
      announce();
    }
    CR.panel.setEnabled('annotate', on);
  }

  CR.panel.register('annotate', { label: '标注', css: TAB_CSS, build: buildTab, onShow: renderTab });

  CR.featureManager.register('annotate', '标注', {
    start() {
      setActive(isEnabled());
      CR.events.on('settings-change', (e) => {
        if (e.key === 'annotate') CR.featureManager.run('annotate', () => setActive(isEnabled()));
      });
      CR.events.on('conversation-change', guard(() => active && (closeAll(), loadGroup())));
      CR.events.on('content-change', guard(() => active && paintSoon()));
      CR.events.on('transcript-change', guard(() => active && paint()));
      CR.events.on('theme-change', guard(() => active && (applyHighlightCss(), applyUiTheme())));
    },
    stop: () => {
      active = true;
      setActive(false);
    },
    isEnabled,
  });
})();
