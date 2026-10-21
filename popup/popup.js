// 插件弹窗。弹窗本身不碰网页，需要页面信息时发消息给页面里的内容脚本去问。

const $ = (sel) => document.querySelector(sel);

$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;

// —— 标签页切换（记住上次停留的标签）——
const TAB_KEY = 'popupTab';
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'panel-' + name));
  if (name === 'status') runDiagnose();
}
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    showTab(b.dataset.tab);
    chrome.storage.local.set({ [TAB_KEY]: b.dataset.tab });
  }),
);
chrome.storage.local.get(TAB_KEY).then((r) => showTab(r[TAB_KEY] || 'status'));

// —— 和当前标签页里的内容脚本通信 ——
async function askPage(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('找不到当前标签页');
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // 没有内容脚本在听：不是 claude.ai，或者插件刚重新加载过而页面还没刷新
    throw new Error('NO_RECEIVER');
  }
}

// —— 适配状态 ——
const ICONS = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };

function renderStatus(items) {
  const list = $('#status-list');
  list.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 's-' + it.status;
    for (const [cls, text] of [['icon', ICONS[it.status] || ''], ['label', it.label], ['detail', it.detail]]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      li.appendChild(span);
    }
    list.appendChild(li);
  }
}

function renderEmpty(text) {
  const list = $('#status-list');
  list.textContent = '';
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  list.appendChild(li);
}

async function runDiagnose() {
  $('#status-site').textContent = '';
  renderEmpty('检测中……');
  try {
    const res = await askPage({ type: 'cr:diagnose' });
    if (!res || !res.ok) throw new Error((res && res.error) || '页面没有回应');
    $('#status-site').textContent = `站点：${res.site}`;
    renderStatus(res.items);
  } catch (e) {
    renderEmpty(
      e.message === 'NO_RECEIVER'
        ? '插件没有在这个页面上运行。请确认当前是 claude.ai 的页面；如果刚刚重新加载过插件，请刷新一下 claude.ai 页面（F5）。'
        : '检测出错：' + e.message,
    );
  }
}
$('#btn-refresh').addEventListener('click', runDiagnose);
