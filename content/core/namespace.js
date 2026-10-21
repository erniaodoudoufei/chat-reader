// 全局命名空间 CR：内容脚本的各个文件通过它共享代码。
// 内容脚本运行在扩展自己的"隔离环境"里，这个 window.CR 页面上的 JS 看不到，不会互相干扰。
(() => {
  const CR = {
    version: chrome.runtime.getManifest().version,
    adapters: {}, // 各站点适配器，由 adapters/*.js 注册
    features: {}, // 各功能模块
  };

  const TAG = '[ChatReader]';
  CR.log = (...args) => console.log(TAG, ...args);
  CR.warn = (...args) => console.warn(TAG, ...args);
  CR.error = (...args) => console.error(TAG, ...args);

  window.CR = CR;
})();
