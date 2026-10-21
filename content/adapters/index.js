// 按当前网址挑选站点适配器。以后加 ChatGPT、Gemini 时，在 adapters/ 下新增文件并在 manifest 里登记即可。
(() => {
  const CR = window.CR;
  CR.pickAdapter = (hostname) => Object.values(CR.adapters).find((a) => a.matches(hostname)) || null;
})();
