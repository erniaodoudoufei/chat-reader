// 设置：从 chrome.storage.sync 读取，变化时发出 settings-change 事件。
// 弹窗拖滑块时会先发"预览"消息过来（实时生效），松手后才写入存储（避免超过 Chrome 的写入次数限制）。
(() => {
  const CR = window.CR;
  const { TYPOGRAPHY_DEFAULTS, TOC_DEFAULTS, ANNOTATE_DEFAULTS } = globalThis.CR_SHARED;

  const DEFAULTS = { typography: TYPOGRAPHY_DEFAULTS, toc: TOC_DEFAULTS, annotate: ANNOTATE_DEFAULTS };
  const data = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { ...v }]));

  function set(key, value) {
    data[key] = { ...DEFAULTS[key], ...(value || {}) };
    CR.events.emit('settings-change', { key });
  }

  CR.settings = {
    async load() {
      const r = await chrome.storage.sync.get(Object.keys(DEFAULTS));
      for (const key of Object.keys(DEFAULTS)) data[key] = { ...DEFAULTS[key], ...(r[key] || {}) };
    },
    get typography() {
      return data.typography;
    },
    get toc() {
      return data.toc;
    },
    get annotate() {
      return data.annotate;
    },
    preview: (typography) => set('typography', typography),
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key of Object.keys(DEFAULTS)) if (changes[key]) set(key, changes[key].newValue);
  });
})();
