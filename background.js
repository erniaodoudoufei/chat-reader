// 后台脚本：接收快捷键，转发给当前标签页里的内容脚本。
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-toc' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'cr:toggle-toc' }).catch(() => {
      // 当前页面不是 claude.ai，忽略
    });
  }
});
