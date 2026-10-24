// claude.ai 站点适配器。
// ★ 所有和 claude.ai 页面结构有关的东西都只写在这个文件里。网站改版时只改这里。
//
// 页面结构要点（2026-10 实测）：
// - 消息列表是"虚拟列表"：只有屏幕附近的几条消息真正在页面里，滚远了就被卸载。
//   所以想拿到整段对话（比如做目录），要用 fetchTranscript() 从 Claude 自己的接口读取。
// - 长对话是"分批加载"的：一开始只加载最近 32 条，滚到顶部再加载更早的 32 条。
//   页面上"共 M 条"里的 M 是已加载的数量，不是整段对话的数量。
// - 每行消息是 [data-testid="transcript-row"]，带 data-index（从 0 开始，提问和回复都算，
//   只在已加载的这批里编号）。和接口数据的对应关系：接口序号 = data-index + (接口总数 - 已加载数)，
//   见 toTranscriptIndex()。
// - 对话区宽度由 CSS 变量 --transcript-width 控制，消息列表和输入框共用它。
// - 回复正文字体由 CSS 变量 --font-claude-response 控制，提问字体由 --font-user-message 控制。
(() => {
  const CR = window.CR;
  const { queryFirst, queryAllFirst } = CR.utils;

  // —— 选择器表：每项按顺序排列，第一个是主选择器，后面的是备用 ——
  const SEL = {
    // 对话内容的滚动容器（找不到时还会顺着消息列表往上找能滚动的元素）
    scrollContainer: ['[data-autoscroll-container="true"]'],
    // 消息列表根节点
    transcript: ['[data-testid="transcript-list"]', '[role="feed"]'],
    // 对话栏（包着消息列表和输入框，宽度变量在它身上生效）
    chatColumn: ['[data-testid="chat-column"]'],
    // 每一行消息（提问或回复）
    row: ['[data-testid="transcript-row"]', '[role="feed"] [role="article"]'],
    // 行内的提问 / 回复主体
    // 注意备用选择器只能圈住提问文字本身：[data-cds="UserMessage"] 包含了下面那排按钮，排版时会误伤图标
    userMessage: ['[data-testid="user-message"]', '.cds-user-message-body'],
    assistantMessage: ['[data-testid="assistant-message"]', '[data-cds="AssistantMessage"]'],
    // 带"第 N 条消息，共 M 条"信息的元素
    article: ['[role="article"][aria-setsize]'],
    // 底部输入框区域
    composer: ['[data-chat-input-container="true"]', '[data-testid="chat-input"]', '[role="textbox"][contenteditable="true"]'],
    // 回复正文（Markdown 渲染区域）
    markdown: ['.standard-markdown', '[data-cds="Prose"]'],
    // 回复正文的外层容器（Claude 的字号、行距、段落间距变量定义在它身上）
    prose: ['[data-cds="Prose"]', '.prose'],
    // 数学公式（KaTeX 库自带的 class，很稳定）
    katex: ['.katex'],
    // 代码块
    codeBlock: ['pre code', 'pre'],
    // 界面上的图标和按钮：图标是用 Claude 自己的图标字体（Anthropicons）画的，换字体会变成方块，排版时必须跳过
    uiChrome: ['[data-cds="Icon"]', 'button', '[role="button"]'],
  };

  // 给排版功能用的 CSS 选择器（多个备用用逗号连起来，哪个匹配上都生效）
  const css = (key) => SEL[key].join(', ');
  const STYLE_TARGETS = {
    chatColumn: css('chatColumn'),
    userMessage: css('userMessage'),
    assistantMessage: css('assistantMessage'),
    markdown: css('markdown'),
    prose: css('prose'),
    katex: css('katex'),
    codeBlock: css('codeBlock'),
    uiChrome: css('uiChrome'),
  };

  // 标注时不算正文的部分：公式的 MathML 副本（屏幕上看不见）、Claude 标了"查找时忽略"的状态行、
  // 屏幕阅读器专用文字、按钮和图标、沉浸式翻译等插件插入的译文
  const ANNOTATION_IGNORE = [
    '.katex-mathml',
    '[data-find-omitted]',
    '.sr-only',
    'button',
    '[role="button"]',
    '[data-cds="Icon"]',
    '[data-testid="message-actions"]',
    '[data-testid="user-message-actions"]',
    '[class*="immersive-translate"]',
  ].join(', ');

  // 只有 Claude 才有的排版"开关"（CSS 变量）。用它们比硬改元素更稳：标题、列表等会按 Claude 自己的比例跟着变
  const STYLE_HOOKS = {
    // 对话区宽度：消息列表和输入框共用 --transcript-width
    contentWidth: (px) => `${css('chatColumn')} { --transcript-width: ${px}px !important; }`,
    // 段落间距：Claude 用 --_prose-flow-base 控制段落、列表、标题之间的距离（标题前后是它的倍数）
    paragraphSpacing: (em) => `${css('prose')} { --_prose-flow-base: ${em}em !important; }`,
    // 背景色调：Claude 的背景由 --cds-surface-* 变量决定（surface-1 正文区，surface-2/3 次要区域），
    // 这些变量在很多 .cds-root 元素上会被重新定义，所以要连同 .cds-root 一起覆盖。
    // 侧栏用 --df-(web-)sidebar-bg；输入框是 .bg-surface-3（它附近把 surface-3 定义成了更亮的颜色），单独设置
    pageTint: (t) =>
      `:root, :root :is(.cds-root, .dframe-root, .dframe-sidebar) { --cds-surface-1: ${t.page} !important; --cds-surface-2: ${t.side} !important; ` +
      `--cds-surface-3: ${t.side} !important; --df-sidebar-bg: ${t.side} !important; --df-web-sidebar-bg: ${t.side} !important; }\n` +
      `:is(${css('composer')}) .bg-surface-3 { background-color: ${t.comp} !important; }`,
    // 在对话区右边留出空位（给目录面板）：加在对话栏的外层上，对话栏会在剩下的空间里居中
    reserveRightSpace: (px) =>
      `div:has(> :is(${css('chatColumn')})) { padding-right: ${px}px !important; transition: padding-right .2s ease; }`,
  };

  // —— 基础信息 ——

  function getConversationId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    if (m) return m[1];
    const el = document.querySelector('[data-conv-id]');
    return el ? el.getAttribute('data-conv-id') : null;
  }

  function getTitle() {
    const t = document.title.replace(/\s*[-–—|]\s*Claude\s*$/, '').trim();
    return t && t !== 'Claude' ? t : null;
  }

  function getTheme() {
    const mode = document.documentElement.getAttribute('data-mode');
    if (mode === 'dark' || mode === 'light') return mode;
    if (document.documentElement.classList.contains('dark')) return 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function findScrollContainer() {
    const hit = queryFirst(SEL.scrollContainer);
    if (hit.el) return hit;
    // 备用：从消息列表往上找第一个能纵向滚动的祖先
    let p = queryFirst(SEL.transcript).el;
    while (p && p !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) {
        return { el: p, index: SEL.scrollContainer.length };
      }
      p = p.parentElement;
    }
    return { el: null, index: -1 };
  }

  // —— 消息 ——

  function rowIndex(row) {
    if (row.dataset.index != null) return Number(row.dataset.index);
    const art = row.matches('[aria-posinset]') ? row : row.querySelector('[aria-posinset]');
    return art ? Number(art.getAttribute('aria-posinset')) - 1 : NaN;
  }

  function rowRole(row) {
    const kind = row.dataset.perfRow;
    if (kind === 'human') return 'user';
    if (kind === 'assistant') return 'assistant';
    if (queryFirst(SEL.userMessage, row).el) return 'user';
    if (queryFirst(SEL.assistantMessage, row).el) return 'assistant';
    return null;
  }

  // 当前"真正在页面里"的消息（虚拟列表，只是一部分），按顺序排列
  function getRenderedMessages() {
    return queryAllFirst(SEL.row).els
      .map((row) => {
        const role = rowRole(row);
        const body = queryFirst(role === 'user' ? SEL.userMessage : SEL.assistantMessage, row).el;
        return { index: rowIndex(row), role, el: row, bodyEl: body || row };
      })
      .filter((m) => m.role && !Number.isNaN(m.index))
      .sort((a, b) => a.index - b.index);
  }

  // 某个页面节点属于哪条消息（不在任何消息里返回 null）
  function findMessageForNode(node) {
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el) return null;
    return getRenderedMessages().find((m) => m.bodyEl.contains(el)) || null;
  }

  // 回复是否还在生成中（生成中的文字还会变，标注先不判定失效）
  function isStreaming(m) {
    return !!(m.el.querySelector('[data-is-streaming="true"]') || m.el.closest('[data-is-streaming="true"]'));
  }

  // 页面已加载的消息数（页面上"第 N 条消息，共 M 条"里的 M）。长对话里它小于整段对话的消息数
  function getLoadedMessageCount() {
    const art = queryFirst(SEL.article).el;
    const n = art ? Number(art.getAttribute('aria-setsize')) : NaN;
    return Number.isNaN(n) ? null : n;
  }

  // 页面上的消息序号 → 接口数据（fetchTranscript）里的序号
  function toTranscriptIndex(pageIndex, transcriptLength) {
    const loaded = getLoadedMessageCount();
    return loaded == null ? pageIndex : pageIndex + (transcriptLength - loaded);
  }

  // 比较文字是否是同一条消息（只看开头，忽略空白）
  const sameText = (a, b) => a.replace(/\s+/g, '').slice(0, 20) === b.replace(/\s+/g, '').slice(0, 20);

  // 页面上的某条消息（getRenderedMessages 的一项）是不是接口数据里的那一条
  function isSameMessage(rendered, item) {
    if (!rendered || !item || rendered.role !== item.role) return false;
    // 提问比较文字开头；回复可能还在生成或含工具调用，只比较角色
    return item.role !== 'user' || sameText(rendered.bodyEl.innerText, item.text);
  }

  // 检查页面上显示的提问和接口数据能不能对上（对不上说明数据过期了，比如刚切换了分支，需要重新读取）
  function checkAlignment(transcript) {
    const n = transcript.messages.length;
    const asks = getRenderedMessages().filter((m) => m.role === 'user');
    if (!asks.length) return null;
    return asks.every((m) => {
      const t = transcript.messages[toTranscriptIndex(m.index, n)];
      return t && t.role === 'user' && sameText(m.bodyEl.innerText, t.text);
    });
  }

  // —— 从 Claude 接口读取整段对话 ——
  // 返回 { title, messages }，messages 是当前分支上、按页面显示方式合并后的消息：
  // [{ index, role: 'user'|'assistant', text, uuid }]
  // 注意：这是 Claude 网页自己用的内部接口，不是公开 API，将来可能变化；出错时调用方要能降级。

  async function getOrgIds() {
    const ids = [];
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (m) ids.push(decodeURIComponent(m[1]));
    try {
      const res = await fetch('/api/organizations', { credentials: 'include' });
      if (res.ok) for (const o of await res.json()) if (!ids.includes(o.uuid)) ids.push(o.uuid);
    } catch (e) {
      // 拿不到组织列表时，只用 cookie 里的
    }
    return ids;
  }

  function messageText(m) {
    const parts = (m.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text);
    return parts.length ? parts.join('\n') : m.text || '';
  }

  async function fetchTranscript(convId = getConversationId()) {
    if (!convId) throw new Error('当前不是对话页面');
    let data = null;
    let lastStatus = 0;
    for (const org of await getOrgIds()) {
      const url = `/api/organizations/${org}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`;
      const res = await fetch(url, { credentials: 'include' });
      lastStatus = res.status;
      if (res.ok) {
        data = await res.json();
        break;
      }
    }
    if (!data) throw new Error(`读取对话数据失败（状态码 ${lastStatus}）`);

    // 对话可能有分支（编辑过提问 / 重新生成），从当前所在的最后一条消息顺着"父消息"往回找，得到当前分支
    const msgs = data.chat_messages || [];
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    let chain = [];
    for (let cur = byId.get(data.current_leaf_message_uuid); cur; cur = byId.get(cur.parent_message_uuid)) {
      chain.push(cur);
      if (chain.length > msgs.length) break; // 防止数据异常时死循环
    }
    chain.reverse();
    if (!chain.length) chain = [...msgs].sort((a, b) => a.index - b.index);

    // 接口里可能有"连着的几条 AI 消息"（比如一条只调用了工具、下一条接着回答，或者一条空消息），
    // 页面上会把它们合并成一行显示。这里也合并，序号才能和页面对上。（2026-10 实测）
    const merged = [];
    for (const m of chain) {
      const role = m.sender === 'human' ? 'user' : 'assistant';
      const prev = merged[merged.length - 1];
      const text = messageText(m);
      if (prev && prev.role === 'assistant' && role === 'assistant') {
        if (text) prev.text = prev.text ? prev.text + '\n' + text : text;
      } else {
        merged.push({ index: merged.length, role, text, uuid: m.uuid });
      }
    }

    return { title: data.name || null, messages: merged };
  }

  // —— 自检：给弹窗"适配状态"用 ——
  // 每项：{ label, status: 'ok' | 'warn' | 'fail' | 'info', detail }

  function selectorItem(label, key, { all = false, required = true } = {}) {
    const r = all ? queryAllFirst(SEL[key]) : queryFirst(SEL[key]);
    const count = all ? r.els.length : r.el ? 1 : 0;
    if (r.index < 0) return { label, status: required ? 'fail' : 'info', detail: required ? '未找到' : '本页没有' };
    const detail = all ? `找到 ${count} 个` : '已找到';
    if (r.index > 0) return { label, status: 'warn', detail: `${detail}（用的是备用选择器，网站可能改版了）` };
    return { label, status: 'ok', detail };
  }

  async function diagnose() {
    const items = [];
    const convId = getConversationId();
    if (!convId) {
      items.push({ label: '页面类型', status: 'info', detail: '当前不是对话页面，打开一个对话再看' });
      items.push({ label: '主题', status: 'info', detail: getTheme() === 'dark' ? '深色' : '浅色' });
      return items;
    }

    items.push({
      label: '对话 ID',
      status: location.pathname.includes(convId) ? 'ok' : 'warn',
      detail: location.pathname.includes(convId) ? '已找到' : '已找到（不是从网址里取的，网站可能改版了）',
    });
    const title = getTitle();
    items.push({ label: '对话标题', status: title ? 'ok' : 'warn', detail: title ? `「${title}」` : '未找到' });

    const sc = findScrollContainer();
    items.push(
      sc.index < 0
        ? { label: '滚动容器', status: 'fail', detail: '未找到' }
        : sc.index > 0
          ? { label: '滚动容器', status: 'warn', detail: '已找到（用的是备用方法，网站可能改版了）' }
          : { label: '滚动容器', status: 'ok', detail: '已找到' },
    );

    items.push(selectorItem('消息列表', 'transcript'));
    items.push(selectorItem('对话栏（控制宽度）', 'chatColumn'));

    const loaded = getLoadedMessageCount();
    items.push({
      label: '已加载的消息',
      status: loaded != null ? 'ok' : 'warn',
      detail: loaded != null ? `${loaded} 条（长对话往上滚会继续加载）` : '未找到',
    });

    const rendered = getRenderedMessages();
    const rowsHit = queryAllFirst(SEL.row);
    const users = rendered.filter((m) => m.role === 'user').length;
    const bots = rendered.filter((m) => m.role === 'assistant').length;
    items.push({
      label: '当前显示的消息',
      status: rendered.length ? (rowsHit.index > 0 ? 'warn' : 'ok') : 'fail',
      detail: rendered.length
        ? `${rendered.length} 条（提问 ${users}，回复 ${bots}）。Claude 只显示屏幕附近的消息，比已加载的少是正常的`
        : '未找到',
    });

    items.push(selectorItem('回复正文区域', 'markdown', { all: true }));
    items.push(selectorItem('回复正文容器（字号行距）', 'prose', { all: true }));
    items.push(selectorItem('输入框', 'composer'));
    items.push(selectorItem('数学公式', 'katex', { all: true, required: false }));
    items.push(selectorItem('代码块', 'codeBlock', { all: true, required: false }));
    items.push({ label: '主题', status: 'info', detail: getTheme() === 'dark' ? '深色' : '浅色' });

    try {
      const t = await fetchTranscript(convId);
      const n = t.messages.length;
      const asks = t.messages.filter((m) => m.role === 'user').length;
      items.push({ label: '对话数据接口', status: 'ok', detail: `读取成功：整段对话 ${n} 条消息，其中提问 ${asks} 条` });
      const aligned = checkAlignment(t);
      items.push(
        aligned === null
          ? { label: '页面与数据对齐', status: 'info', detail: '屏幕上没有提问，滚动到有提问的地方再检测' }
          : aligned
            ? { label: '页面与数据对齐', status: 'ok', detail: '一致' }
            : { label: '页面与数据对齐', status: 'warn', detail: '对不上（刚切换过分支时属正常，稍后重新检测）' },
      );
    } catch (e) {
      items.push({ label: '对话数据接口', status: 'fail', detail: e.message });
    }
    return items;
  }

  CR.adapters.claude = {
    name: 'Claude',
    matches: (hostname) => hostname === 'claude.ai',
    getConversationId,
    getTitle,
    getTheme,
    getScrollContainer: () => findScrollContainer().el,
    getTranscriptRoot: () => queryFirst(SEL.transcript).el,
    getChatColumn: () => queryFirst(SEL.chatColumn).el,
    getConversationUrl: (id = getConversationId()) => (id ? `${location.origin}/chat/${id}` : null),
    findMessageForNode,
    isStreaming,
    // 标注：在消息的哪个元素里取文字、哪些部分跳过
    getAnnotationRoot: (m) => m.bodyEl,
    annotationIgnore: ANNOTATION_IGNORE,
    getComposer: () => queryFirst(SEL.composer).el,
    getRenderedMessages,
    getLoadedMessageCount,
    toTranscriptIndex,
    checkAlignment,
    isSameMessage,
    fetchTranscript,
    styleTargets: STYLE_TARGETS,
    styleHooks: STYLE_HOOKS,
    diagnose,
  };
})();
