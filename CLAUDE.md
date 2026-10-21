# Chat Reader — 项目约定

Chrome 扩展（Manifest V3），把 claude.ai 聊天页变成可批注的教材。完整需求见 [SPEC.md](SPEC.md)，有冲突以 SPEC.md 为准。

## 协作约定
- 全程用中文沟通。用户不写代码，负责测试和做决定；技术决定要用大白话讲清"为什么"。
- 需要用户决定时，给 2～3 个选项并标出推荐项。
- 分三期开发（排版+目录 → 标注 → 选中解释）。**每期做完必须停下**，给出中文测试清单和"网页改版后怎么排查"说明，用户测试通过后才进入下一期。
- 每完成一个功能节点 git commit 一次，提交说明用中文。
- 不加 SPEC 里没提的功能；想加先列出来问。
- 不做任何代理设置（用户网络走路由器透明代理）。

## 架构原则
- **站点适配层**：所有和页面结构有关的代码（选择器、取对话 ID/标题/消息/滚动容器/输入框、主题判断）只能写在 `content/adapters/<站点>.js`。功能代码一律只调用适配层接口，不直接写选择器。
- 选择器优先用 `data-testid`、`aria-*`、role、语义标签，不用带哈希的 class；每个关键元素一个主选择器 + 至少一个备用选择器。
- 不要凭印象猜 claude.ai 的页面结构，以真实页面（通过 Claude in Chrome 查看）或 `samples/` 里的样本为准。
- claude.ai 的消息列表是虚拟列表 + 分批加载（每批 32 条），页面里只有一部分消息。需要整段对话时用适配层的 `fetchTranscript()`（Claude 内部接口），详见 `content/adapters/claude.js` 开头的说明。
- **不修改 React 管理的 DOM**：不给页面文字套标签、不改页面节点。视觉效果只用注入的 `<style>`、CSS Custom Highlight API、或挂在 `document.body` 末尾的 Shadow DOM 叠加层实现。
- 单页应用：用 MutationObserver + 防抖监听内容变化和对话切换（URL 变但页面不刷新）。
- 每个功能独立开关、独立 try/catch，任何功能出错都不能影响 Claude 本身使用。
- 尊重 Claude 自带的深色/浅色模式，两种模式都要好看。
- 不用构建工具：纯 JS + CSS，改完在扩展管理页"重新加载"即可。如需引入构建工具须先征得用户同意。
- 权限按需申请。存储：排版设置 `chrome.storage.sync`；标注数据 `chrome.storage.local`（+`unlimitedStorage`）；API key 存 `chrome.storage.local`，不打日志、界面打码。
- 界面文字全部中文。
