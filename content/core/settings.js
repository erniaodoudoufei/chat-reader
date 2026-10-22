// 设置：从 chrome.storage.sync 读取，变化时发出 settings-change 事件。
// 弹窗拖滑块时会先发"预览"消息过来（实时生效），松手后才写入存储（避免超过 Chrome 的写入次数限制）。
(() => {
  const CR = window.CR;
  const { TYPOGRAPHY_DEFAULTS } = globalThis.CR_SHARED;

  let typography = { ...TYPOGRAPHY_DEFAULTS };

  function setTypography(value) {
    typography = { ...TYPOGRAPHY_DEFAULTS, ...(value || {}) };
    CR.events.emit('settings-change', { typography });
  }

  CR.settings = {
    async load() {
      const r = await chrome.storage.sync.get('typography');
      typography = { ...TYPOGRAPHY_DEFAULTS, ...(r.typography || {}) };
    },
    get typography() {
      return typography;
    },
    preview: setTypography,
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.typography) setTypography(changes.typography.newValue);
  });
})();
