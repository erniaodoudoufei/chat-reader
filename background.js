// 后台脚本：接收快捷键，转发给当前标签页里的内容脚本；替页面打开"我的笔记"。
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-toc' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'cr:toggle-toc' }).catch(() => {
      // 当前页面不是 claude.ai，忽略
    });
  }
});

// 内容脚本不能直接打开扩展自己的页面，由这里代劳
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'cr:open-notes') chrome.tabs.create({ url: chrome.runtime.getURL('notes/notes.html') });
});
