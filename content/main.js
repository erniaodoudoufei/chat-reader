// 启动入口：选适配器 → 开始监听页面 → 响应弹窗的请求。
(() => {
  const CR = window.CR;
  const adapter = CR.pickAdapter(location.hostname);
  if (!adapter) return;
  CR.adapter = adapter;

  try {
    CR.pageWatcher.start(adapter);
  } catch (e) {
    CR.error('页面监听启动失败：', e);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'cr:diagnose') {
      adapter
        .diagnose()
        .then((items) => sendResponse({ ok: true, site: adapter.name, version: CR.version, items }))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true; // 告诉 Chrome 我们会异步回复
    }
    return false;
  });

  CR.log(`已在 ${adapter.name} 上启动，版本 ${CR.version}`);
})();
