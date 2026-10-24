// 文字定位（和具体网站无关）：
// - describe：把用户的选区记成"原文 + 前后文 + 大致偏移"
// - locate：在消息里重新找到这段原文，挑前后文最吻合的那一处
// - toRange：把找到的位置变回 Range，交给 CSS 高亮去画
//
// 做法：把一条消息里所有"该算的"文字节点按顺序拼成一个长字符串（textMap），位置都用这个字符串里的下标表示。
// 页面怎么嵌套标签都不影响，所以跨段落、跨元素的选区也能处理；代码块、公式就算定位不完美，也只是找不到，不会出错。
(() => {
  const CR = window.CR;
  const CONTEXT = 32;

  // 段落一类的块级元素：两个文字节点分属不同的块时，拼接时在中间补一个换行（只是拼接字符串里的，不对应页面节点），
  // 这样跨段落标注的原文能保留分段，复制成 Markdown 时也不会挤成一行
  const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption, div';

  // ignore：不该算进正文的元素（按钮、隐藏的辅助文字、公式的 MathML 副本、翻译插件插入的译文……）
  function textMap(root, ignore) {
    const nodes = [];
    const index = new Map();
    let text = '';
    let lastBlock = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (ignore && p.closest(ignore)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = n.parentElement.closest(BLOCK);
      if (lastBlock && block !== lastBlock && text && !/\s$/.test(text)) text += '\n';
      lastBlock = block;
      const e = { node: n, start: text.length };
      nodes.push(e);
      index.set(n, e);
      text += n.nodeValue;
    }
    return { root, text, nodes, index };
  }

  // 选区的某个边界 → 拼接字符串里的下标（边界在消息之外时会自动夹到开头或结尾）
  function posOf(map, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const e = map.index.get(container);
      if (e) return e.start + Math.min(offset, container.nodeValue.length);
    }
    const r = document.createRange();
    try {
      r.setStart(container, offset);
    } catch (e) {
      return map.text.length;
    }
    r.collapse(true);
    for (const e of map.nodes) {
      if (r.comparePoint(e.node, 0) >= 0) return e.start;
    }
    return map.text.length;
  }

  function describe(map, range) {
    let start = posOf(map, range.startContainer, range.startOffset);
    let end = posOf(map, range.endContainer, range.endOffset);
    const t = map.text;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (end <= start) return null;
    return {
      exact: t.slice(start, end),
      prefix: t.slice(Math.max(0, start - CONTEXT), start),
      suffix: t.slice(end, end + CONTEXT),
      offset: start,
    };
  }

  // 两段文字从末尾/开头算起有多少字相同
  function sameTail(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function sameHead(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function bestMatch(text, q) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = text.indexOf(q.exact); i !== -1; i = text.indexOf(q.exact, i + 1)) {
      const pre = text.slice(Math.max(0, i - q.prefix.length), i);
      const suf = text.slice(i + q.exact.length, i + q.exact.length + q.suffix.length);
      const score = sameTail(pre, q.prefix || '') + sameHead(suf, q.suffix || '') - Math.abs(i - (q.offset || 0)) / 2000;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  // 去掉所有空白后的文字，以及每个字在原文里的下标（用来容忍换行、空格的变化）
  function squash(s) {
    let out = '';
    const pos = [];
    for (let i = 0; i < s.length; i++) {
      if (!/\s/.test(s[i])) {
        out += s[i];
        pos.push(i);
      }
    }
    return { out, pos };
  }

  // 返回 { start, end }，找不到返回 null
  function locate(map, q) {
    if (!q || !q.exact) return null;
    const i = bestMatch(map.text, q);
    if (i >= 0) return { start: i, end: i + q.exact.length };
    // 退一步：忽略空白再找一次
    const T = squash(map.text);
    const E = squash(q.exact).out;
    if (!E) return null;
    const j = bestMatch(T.out, { exact: E, prefix: squash(q.prefix || '').out, suffix: squash(q.suffix || '').out, offset: 0 });
    if (j < 0) return null;
    return { start: T.pos[j], end: T.pos[j + E.length - 1] + 1 };
  }

  // 下标 → 文字节点里的位置
  function pointAt(map, pos, isEnd) {
    const nodes = map.nodes;
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start < pos || (!isEnd && nodes[mid].start === pos)) lo = mid;
      else hi = mid - 1;
    }
    const e = nodes[lo];
    return { node: e.node, offset: Math.max(0, Math.min(pos - e.start, e.node.nodeValue.length)) };
  }

  function toRange(map, start, end) {
    if (!map.nodes.length) return null;
    const a = pointAt(map, start, false);
    const b = pointAt(map, end, true);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }

  CR.anchoring = { textMap, describe, locate, toRange };
})();
