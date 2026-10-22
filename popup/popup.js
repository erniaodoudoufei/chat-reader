// 插件弹窗。弹窗本身不碰网页，需要页面信息时发消息给页面里的内容脚本去问。

const { TYPOGRAPHY_DEFAULTS, SLIDERS, BODY_FONTS, CODE_FONTS, PRESET_COUNT } = globalThis.CR_SHARED;
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function toast(text) {
  let t = $('.toast');
  if (!t) document.body.append((t = el('div', { class: 'toast' })));
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1400);
}

$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;

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
chrome.storage.local.get(TAB_KEY).then((r) => showTab(r[TAB_KEY] || 'typography'));

// ======================== 排版 ========================

let ty = { ...TYPOGRAPHY_DEFAULTS };
let presets = new Array(PRESET_COUNT).fill(null);

// 调整时：立刻发给页面预览；停手 400ms 后才写入存储（Chrome 限制了同步存储每分钟的写入次数）
let saveTimer = null;
function changed({ immediate = false } = {}) {
  askPage({ type: 'cr:typography-preview', typography: ty }).catch(() => {});
  clearTimeout(saveTimer);
  const save = () => chrome.storage.sync.set({ typography: ty });
  if (immediate) save();
  else saveTimer = setTimeout(save, 400);
}
// 弹窗关闭前把没来得及保存的写进去
window.addEventListener('pagehide', () => {
  if (saveTimer) chrome.storage.sync.set({ typography: ty });
});

// —— 字体是否已安装：用画布量同一段文字的宽度，装了这个字体宽度就会和后备字体不一样 ——
const ctx = document.createElement('canvas').getContext('2d');
const SAMPLE = '永和九年岁在癸丑暮春之初 abcdefghijklmnopqrstuvwxyz 0123456789 MWiIl';
function familyInstalled(family) {
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `40px ${base}`;
    const w0 = ctx.measureText(SAMPLE).width;
    ctx.font = `40px "${family}", ${base}`;
    if (ctx.measureText(SAMPLE).width !== w0) return true;
  }
  return false;
}
function fontInstalled(value) {
  if (!value || value === 'system-ui') return true;
  return value
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .some(familyInstalled);
}

const CUSTOM = '__custom__';
const PREVIEW_TEXT = { bodyFont: '永和九年，岁在癸丑。The quick brown fox 123', codeFont: 'const x = 42; // 代码 0O1lI' };

function buildFontField(key, label, options) {
  const select = el('select');
  for (const o of options) {
    const mark = o.value && o.value !== 'system-ui' ? (fontInstalled(o.value) ? '  ✓' : '  （未安装）') : '';
    select.append(el('option', { value: o.value, text: o.label + mark }));
  }
  select.append(el('option', { value: CUSTOM, text: '手动输入字体名…' }));

  const custom = el('input', { type: 'text', class: 'custom-font', placeholder: '例如：Source Han Sans SC', hidden: '' });
  const state = el('span', { class: 'font-state' });
  const preview = el('div', { class: 'font-preview', text: PREVIEW_TEXT[key] });

  function refresh() {
    const v = ty[key];
    preview.style.fontFamily = v ? `${v}, ${key === 'codeFont' ? 'monospace' : 'sans-serif'}` : '';
    if (!v) {
      state.textContent = '';
    } else {
      const ok = fontInstalled(v);
      state.textContent = ok ? '✓ 已安装' : '⚠ 没检测到这个字体';
      state.className = 'font-state ' + (ok ? 'yes' : 'no');
    }
  }

  function syncFromState() {
    const v = ty[key];
    const known = options.some((o) => o.value === v);
    select.value = known ? v : CUSTOM;
    custom.hidden = known;
    if (!known) custom.value = v.replace(/"/g, '');
    refresh();
  }

  select.addEventListener('change', () => {
    if (select.value === CUSTOM) {
      custom.hidden = false;
      custom.focus();
      return;
    }
    custom.hidden = true;
    ty[key] = select.value;
    refresh();
    changed();
  });
  custom.addEventListener('input', () => {
    ty[key] = custom.value.trim();
    refresh();
    changed();
  });

  const field = el('div', { class: 'field' }, [
    el('div', { class: 'field-head' }, [el('span', { class: 'field-label', text: label }), state]),
    select,
    custom,
    preview,
  ]);
  field.sync = syncFromState;
  return field;
}

function fmt(spec, v) {
  return `${v.toFixed(spec.digits)}${spec.unit === '倍' ? ' 倍' : spec.unit}`;
}

function buildSlider(spec) {
  const range = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step });
  const value = el('span', { class: 'slider-value' });
  const reset = el('button', { class: 'icon-btn', title: '恢复默认', text: '↺' });

  function syncFromState() {
    const v = ty[spec.key];
    range.value = v == null ? spec.claude : v;
    value.textContent = v == null ? '默认' : fmt(spec, v);
    value.title = v == null ? `Claude 默认，约 ${fmt(spec, spec.claude)}` : '';
    value.classList.toggle('is-default', v == null);
    reset.disabled = v == null;
  }

  range.addEventListener('input', () => {
    ty[spec.key] = Number(range.value);
    syncFromState();
    changed();
  });
  reset.addEventListener('click', () => {
    ty[spec.key] = null;
    syncFromState();
    changed();
  });

  const row = el('div', { class: 'slider-row' }, [el('span', { class: 'field-label', text: spec.label }), range, value, reset]);
  row.sync = syncFromState;
  return row;
}

// —— 预设 ——
function presetName(i) {
  return (presets[i] && presets[i].name) || `预设 ${i + 1}`;
}
function savePresets() {
  chrome.storage.sync.set({ presets });
}
function stripEnabled(t) {
  const { enabled, ...rest } = t;
  return rest;
}

function buildPresetRow(i) {
  const name = el('input', { type: 'text', placeholder: `预设 ${i + 1}` });
  const applyBtn = el('button', { class: 'btn', text: '应用' });
  const saveBtn = el('button', { class: 'btn', text: '保存当前' });

  function syncFromState() {
    name.value = presets[i] ? presets[i].name || '' : '';
    applyBtn.disabled = !presets[i];
    applyBtn.title = presets[i] ? '' : '这个位置还没有保存过';
  }

  name.addEventListener('change', () => {
    if (presets[i]) {
      presets[i].name = name.value.trim();
      savePresets();
    }
  });
  saveBtn.addEventListener('click', () => {
    presets[i] = { name: name.value.trim() || `预设 ${i + 1}`, typography: stripEnabled(ty) };
    savePresets();
    syncFromState();
    toast(`已保存到「${presetName(i)}」`);
  });
  applyBtn.addEventListener('click', () => {
    if (!presets[i]) return;
    ty = { ...TYPOGRAPHY_DEFAULTS, ...presets[i].typography, enabled: ty.enabled };
    renderTypography();
    changed({ immediate: true });
    toast(`已切换到「${presetName(i)}」`);
  });

  const row = el('div', { class: 'preset-row' }, [name, applyBtn, saveBtn]);
  row.sync = syncFromState;
  return row;
}

// —— 组装 ——
const syncers = [];
function renderTypography() {
  $('#ty-enabled').checked = ty.enabled;
  $('#ty-body').classList.toggle('disabled', !ty.enabled);
  syncers.forEach((s) => s());
}

function initTypography() {
  const fonts = [buildFontField('bodyFont', '正文字体', BODY_FONTS), buildFontField('codeFont', '代码字体', CODE_FONTS)];
  $('#ty-fonts').append(...fonts);
  const sliders = SLIDERS.map(buildSlider);
  $('#ty-sliders').append(...sliders);
  const rows = Array.from({ length: PRESET_COUNT }, (_, i) => buildPresetRow(i));
  $('#ty-presets').append(...rows);
  syncers.push(...[...fonts, ...sliders, ...rows].map((x) => x.sync));

  $('#ty-enabled').addEventListener('change', (e) => {
    ty.enabled = e.target.checked;
    renderTypography();
    changed({ immediate: true });
  });
  $('#ty-reset').addEventListener('click', () => {
    ty = { ...TYPOGRAPHY_DEFAULTS, enabled: ty.enabled };
    renderTypography();
    changed({ immediate: true });
    toast('已恢复默认');
  });
}

chrome.storage.sync.get(['typography', 'presets']).then((r) => {
  ty = { ...TYPOGRAPHY_DEFAULTS, ...(r.typography || {}) };
  if (Array.isArray(r.presets)) presets = Array.from({ length: PRESET_COUNT }, (_, i) => r.presets[i] || null);
  initTypography();
  renderTypography();
});

// ======================== 适配状态 ========================

const ICONS = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };

function renderStatus(items) {
  const list = $('#status-list');
  list.textContent = '';
  for (const it of items) {
    list.append(
      el('li', { class: 's-' + it.status }, [
        el('span', { class: 'icon', text: ICONS[it.status] || '' }),
        el('span', { class: 'label', text: it.label }),
        el('span', { class: 'detail', text: it.detail }),
      ]),
    );
  }
}

function renderEmpty(text) {
  const list = $('#status-list');
  list.textContent = '';
  list.append(el('li', { class: 'empty', text }));
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
