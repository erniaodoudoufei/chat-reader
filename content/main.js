// 启动入口：选适配器 → 读设置 → 开始监听页面 → 启动各功能 → 响应弹窗的请求。
(async () => {
  const CR = window.CR;
  const adapter = CR.pickAdapter(location.hostname);
  if (!adapter) return;
  CR.adapter = adapter;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'cr:diagnose') {
      adapter
        .diagnose()
        .then((items) => sendResponse({ ok: true, site: adapter.name, version: CR.version, items: [...items, ...CR.featureManager.status()] }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // 告诉 Chrome 我们会异步回复
    }
    if (msg.type === 'cr:typography-preview') {
      CR.settings.preview(msg.typography);
      sendResponse({ ok: true });
    }
    return false;
  });

  try {
    await CR.settings.load();
  } catch (e) {
    CR.error('读取设置失败，使用默认设置：', e);
  }

  try {
    CR.pageWatcher.start(adapter);
  } catch (e) {
    CR.error('页面监听启动失败：', e);
  }

  CR.featureManager.startAll();
  CR.log(`已在 ${adapter.name} 上启动，版本 ${CR.version}`);
})();
