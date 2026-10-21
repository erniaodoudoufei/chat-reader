// 页面监听：Claude 是单页应用，切换对话时 URL 变了但页面不刷新。
// 这里统一监听页面变化，再用"事件"通知各个功能，功能模块自己不用各写一套监听。
//
// 发出的事件：
//   conversation-change  切换到另一个对话（或离开对话页），参数：新的对话 ID（不在对话页时为 null）
//   content-change       当前对话内容有变化（新消息、滚动加载、回复生成中……），已防抖
//   theme-change         深色/浅色模式切换，参数：'dark' | 'light'
(() => {
  const CR = window.CR;

  // —— 简单的事件中心 ——
  const listeners = {};
  CR.events = {
    on(name, fn) {
      (listeners[name] ||= []).push(fn);
    },
    emit(name, data) {
      for (const fn of listeners[name] || []) {
        // 每个监听者单独 try/catch，一个功能出错不影响其他功能
        try {
          fn(data);
        } catch (e) {
          CR.error(`事件 ${name} 的处理出错：`, e);
        }
      }
    },
  };

  let adapter = null;
  let lastConvId;
  let lastTheme;

  // 页面一变就会频繁触发（回复生成时每秒几十次），所以防抖：停下 300ms 后处理，持续变化时最多每 1.5 秒处理一次
  const onMutations = CR.utils.debounce(() => {
    const convId = adapter.getConversationId();
    if (convId !== lastConvId) {
      lastConvId = convId;
      CR.events.emit('conversation-change', convId);
    } else if (convId) {
      CR.events.emit('content-change');
    }
  }, 300, 1500);

  function checkTheme() {
    const theme = adapter.getTheme();
    if (theme !== lastTheme) {
      lastTheme = theme;
      CR.events.emit('theme-change', theme);
    }
  }

  CR.pageWatcher = {
    start(siteAdapter) {
      adapter = siteAdapter;
      lastConvId = adapter.getConversationId();
      lastTheme = adapter.getTheme();

      // 只监听节点增删，不监听文字和属性变化，开销小
      new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
      // 主题一般写在 <html> 的属性上
      new MutationObserver(checkTheme).observe(document.documentElement, { attributes: true });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', checkTheme);
      // 浏览器前进/后退
      window.addEventListener('popstate', onMutations);
    },
  };
})();
