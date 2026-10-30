// "我的笔记"页：所有对话的标注汇总，可搜索、编辑批注、删除、复制为 Markdown、导出/导入备份，并提醒定期备份。
const S = globalThis.CR_ANN;
const $ = (sel) => document.querySelector(sel);
const COLOR_LABEL = Object.fromEntries(S.COLORS.map((c) => [c.id, c.label]));

let groups = [];
let query = '';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// —— 搜索 ——
function matches(a, g) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (a.exact || '').toLowerCase().includes(q) || (a.note || '').toLowerCase().includes(q) || (g.title || '').toLowerCase().includes(q);
}

// 把搜索词在文字里标出来
function withHits(parent, text) {
  if (!query) {
    parent.append(text);
    return;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
    parent.append(text.slice(i, j), h('mark', 'hit', text.slice(j, j + q.length)));
    i = j + q.length;
  }
  parent.append(text.slice(i));
}

// —— Markdown ——
// 格式：对话标题作为标题，附原对话链接；每条标注用 > 引用原文，下面接批注
function groupMarkdown(g, items) {
  const lines = [`## ${g.title || '未命名对话'}`, ''];
  if (g.url) lines.push(`[在 Claude 中打开原对话](${g.url})`, '');
  for (const a of items) {
    for (const line of a.exact.split('\n')) lines.push('> ' + line);
    if (a.note) lines.push('', a.note);
    lines.push('');
  }
  return lines.join('\n');
}

// 危险操作点两下才执行：第一下按钮变成"确定删除？"，3 秒内再点一下才真删（不用弹窗）
function confirmButton(btn, confirmLabel, action) {
  const label = btn.textContent;
  let timer = null;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = confirmLabel;
      timer = setTimeout(() => {
        btn.classList.remove('confirm');
        btn.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    await action();
  });
}

// 在原处把批注变成输入框
function startEdit(body, g, a) {
  if (body.querySelector('.edit-box')) return;
  const box = h('div', 'edit-box');
  const ta = h('textarea');
  ta.value = a.note || '';
  ta.placeholder = '写点批注…（Ctrl+Enter 保存，Esc 取消）';
  const row = h('div', 'row');
  const cancel = h('button', 'btn btn-small', '取消');
  const save = h('button', 'btn btn-small', '保存');
  row.append(cancel, save);
  box.append(ta, row);
  const noteEl = body.querySelector('.note');
  const actions = body.querySelector('.actions');
  if (noteEl) noteEl.hidden = true;
  actions.hidden = true;
  body.insertBefore(box, actions);
  ta.focus();

  const close = () => {
    box.remove();
    if (noteEl) noteEl.hidden = false;
    actions.hidden = false;
  };
  const doSave = async () => {
    const note = ta.value.trim();
    if (note === (a.note || '')) return close();
    await S.updateItem(g.convId, a.id, { note });
    toast(note ? '批注已保存' : '批注已清空');
    // 存储变化会触发整页刷新，这里不用手动关闭
  };
  cancel.addEventListener('click', close);
  save.addEventListener('click', doSave);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
    if (e.key === 'Escape') close();
  });
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}，可以粘贴到 Obsidian 了`);
  } catch (e) {
    toast('复制失败：' + e.message);
  }
}

// —— 画页面 ——
function render() {
  const main = $('#groups');
  main.textContent = '';
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  $('#summary').textContent = total ? `${groups.length} 个对话，${total} 条标注` : '';

  if (!total) {
    main.append(h('p', 'empty', '还没有标注。在 Claude 的对话里选中文字，就可以划线、写批注。'));
    return;
  }

  let shown = 0;
  for (const g of groups) {
    const items = g.items.filter((a) => matches(a, g));
    if (!items.length) continue;
    shown += items.length;

    const sec = h('section', 'group');
    const head = h('div', 'group-head');
    const title = h('h2');
    if (g.url) {
      const link = h('a', null, g.title || '未命名对话');
      link.href = g.url;
      link.target = '_blank';
      link.title = '在 Claude 中打开原对话';
      title.append(link);
    } else {
      title.textContent = g.title || '未命名对话';
    }
    const count = h('span', 'muted', `${items.length} 条`);
    const copyBtn = h('button', 'btn btn-small', '复制本对话');
    copyBtn.addEventListener('click', () => copy(groupMarkdown(g, items), `「${g.title || '未命名对话'}」的 ${items.length} 条标注`));
    head.append(title, count);
    const orphans = g.items.filter((a) => a.status === 'orphan');
    if (orphans.length) {
      const clean = h('button', 'btn btn-small', `清理 ${orphans.length} 条失效标注`);
      clean.title = '删除这个对话里原文已经找不到的标注';
      confirmButton(clean, `确定删除 ${orphans.length} 条？`, async () => {
        const n = await S.removeItems(g.convId, orphans.map((a) => a.id));
        toast(`已删除 ${n} 条失效标注`);
      });
      head.append(clean);
    }
    head.append(copyBtn);

    const list = h('ul', 'items');
    for (const a of items) {
      const li = h('li', 'item');
      const bar = h('span', 'bar');
      bar.style.background = `var(--mark-${a.color})`;
      const body = h('div', 'body');
      const quote = h('div', 'quote' + (a.style === 'wavy' ? ' wavy' : ''));
      const mark = h('mark');
      mark.style.background = a.style === 'wavy' ? 'none' : `var(--mark-${a.color})`;
      withHits(mark, a.exact);
      quote.append(mark);
      body.append(quote);
      if (a.note) {
        const note = h('div', 'note');
        withHits(note, a.note);
        body.append(note);
      }
      const meta = h('div', 'meta', `${COLOR_LABEL[a.color] || ''}${a.style === 'wavy' ? '波浪线' : '高亮'} · ${a.role === 'user' ? '我的提问' : 'Claude 回复'} · ${fmtTime(a.createdAt)}`);
      if (a.status === 'orphan') meta.append(h('span', 'badge', '失效：原文找不到了'));
      body.append(meta);
      const actions = h('div', 'actions');
      const edit = h('button', 'link-btn', a.note ? '编辑批注' : '添加批注');
      edit.addEventListener('click', () => startEdit(body, g, a));
      const del = h('button', 'link-btn danger', '删除');
      confirmButton(del, '确定删除？', async () => {
        await S.removeItems(g.convId, [a.id]);
        toast('已删除这条标注');
      });
      actions.append(edit, del);
      body.append(actions);
      li.append(bar, body);
      list.append(li);
    }
    sec.append(head, list);
    main.append(sec);
  }
  if (!shown) main.append(h('p', 'empty', `没有找到包含「${query}」的标注`));
}

// —— 备份提醒 ——
async function renderBackupTip() {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const st = S.backupStatus(await S.getLastBackup(), total);
  const tip = $('#backup-tip');
  tip.hidden = !st;
  if (!st) return;
  tip.classList.toggle('warn', st.warn);
  $('#backup-text').textContent = st.text;
}

async function load() {
  groups = await S.listGroups();
  for (const g of groups) g.items.sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0) || (a.offset ?? 0) - (b.offset ?? 0));
  render();
  renderBackupTip();
}

// —— 操作 ——
$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  render();
});

$('#copy-all').addEventListener('click', () => {
  const parts = groups.map((g) => [g, g.items.filter((a) => matches(a, g))]).filter(([, items]) => items.length);
  if (!parts.length) return toast('没有可复制的标注');
  const n = parts.reduce((s, [, items]) => s + items.length, 0);
  copy(parts.map(([g, items]) => groupMarkdown(g, items)).join('\n'), query ? `搜索结果里的 ${n} 条标注` : `全部 ${n} 条标注`);
});

$('#backup-now').addEventListener('click', () => $('#export').click());

$('#export').addEventListener('click', async () => {
  const all = await S.listGroups();
  const data = { app: 'chat-reader', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), groups: all };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `chat-reader-标注备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  await S.markBackedUp();
  renderBackupTip();
  toast(`已导出 ${all.reduce((n, g) => n + g.items.length, 0)} 条标注`);
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.groups)) throw new Error('这不是 Chat Reader 的备份文件');
    const { added, updated } = await S.importGroups(data.groups);
    toast(`导入完成：新增 ${added} 条，更新 ${updated} 条`);
    load();
  } catch (err) {
    toast('导入失败：' + err.message);
  }
});

// 别的页面里新增/修改了标注，这里跟着刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(S.PREFIX))) load();
});

load();
