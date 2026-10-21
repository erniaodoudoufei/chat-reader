// 通用小工具，和具体网站无关。
(() => {
  const CR = window.CR;

  // 防抖：连续触发时只在停下 wait 毫秒后执行一次；maxWait 保证持续触发时也至少每隔这么久执行一次
  function debounce(fn, wait, maxWait) {
    let timer = null;
    let firstCallAt = 0;
    return function debounced(...args) {
      const now = Date.now();
      if (!timer) firstCallAt = now;
      clearTimeout(timer);
      const delay = maxWait ? Math.max(0, Math.min(wait, firstCallAt + maxWait - now)) : wait;
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, delay);
    };
  }

  // 按顺序尝试一组选择器，返回第一个找到的元素。
  // index 表示用的是第几个选择器：0 = 主选择器，>0 = 备用选择器，-1 = 都没找到
  function queryFirst(selectors, root = document) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return { el, index: i };
    }
    return { el: null, index: -1 };
  }

  // 同上，但返回第一个"能找到元素"的选择器匹配到的全部元素
  function queryAllFirst(selectors, root = document) {
    for (let i = 0; i < selectors.length; i++) {
      const els = root.querySelectorAll(selectors[i]);
      if (els.length) return { els: [...els], index: i };
    }
    return { els: [], index: -1 };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  CR.utils = { debounce, queryFirst, queryAllFirst, sleep };
})();
