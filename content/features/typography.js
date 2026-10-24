// 排版功能（含背景色调）：根据设置生成一段 CSS，放进页面 <head> 里的一个 <style>。
// 只"给页面换衣服"，不改动 Claude 的任何页面元素。
(() => {
  const CR = window.CR;
  const STYLE_ID = 'chat-reader-typography';
  let styleEl = null;

  // 字体名单里每一项都要加引号（用户手动输入的名字可能没加）
  function fontList(value) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^["']/.test(s) || /^[a-z-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`))
      .join(', ');
  }

  // 背景色调跟随 Claude 当前的深色/浅色模式
  function currentTint(t, theme) {
    const id = theme === 'dark' ? t.bgDark : t.bgLight;
    if (!id) return null;
    return globalThis.CR_SHARED.BG_TINTS[theme === 'dark' ? 'dark' : 'light'].find((x) => x.id === id) || null;
  }

  function buildCss(t, A, hooks, theme) {
    const rules = [];
    const tint = currentTint(t, theme);
    if (tint && hooks.pageTint) rules.push(hooks.pageTint(tint));
    // 作用范围：对话栏里的 AI 回复 + 我的提问（限定在对话栏里，避免影响 Claude 其他页面上的同类元素）
    const col = `:is(${A.chatColumn})`;
    const scope = `${col} :is(${A.prose}, ${A.markdown}, ${A.userMessage})`;
    const text = `${col} :is(${A.prose}, ${A.userMessage})`;
    // 代码和公式不跟正文字体走
    const notCodeOrMath = `:not(code, code *, pre, pre *, kbd, :is(${A.katex}), :is(${A.katex}) *)`;

    if (t.bodyFont) {
      rules.push(`${scope}, ${scope} *${notCodeOrMath} { font-family: ${fontList(t.bodyFont)}, system-ui, sans-serif !important; }`);
    }
    if (t.codeFont) {
      rules.push(`${scope} :is(code, pre, kbd), ${scope} :is(code, pre) * { font-family: ${fontList(t.codeFont)}, ui-monospace, Consolas, monospace !important; }`);
    }
    if (t.fontSize != null) {
      rules.push(`${text} { font-size: ${t.fontSize}px !important; }`);
      rules.push(`${col} :is(${A.userMessage}) :is(p, li) { font-size: inherit !important; }`);
    }
    if (t.lineHeight != null) {
      rules.push(`${text}, ${text} :is(p, li, blockquote, td, th) { line-height: ${t.lineHeight} !important; }`);
    }
    if (t.letterSpacing != null) {
      rules.push(`${text} { letter-spacing: ${t.letterSpacing}em !important; }`);
      rules.push(`${text} :is(code, pre, kbd, ${A.katex}) { letter-spacing: normal !important; }`);
    }
    if (t.paragraphSpacing != null && hooks.paragraphSpacing) rules.push(hooks.paragraphSpacing(t.paragraphSpacing));
    if (t.contentWidth != null && hooks.contentWidth) rules.push(hooks.contentWidth(t.contentWidth));
    if (t.katexScale != null) {
      // KaTeX 自带的公式字号是周围文字的 1.21 倍
      rules.push(`${col} :is(${A.katex}) { font-size: calc(1.21em * ${t.katexScale / 100}) !important; }`);
    }
    return rules.join('\n');
  }

  function apply() {
    const t = CR.settings.typography;
    if (!t.enabled) return remove();
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
    }
    styleEl.textContent = buildCss(t, CR.adapter.styleTargets, CR.adapter.styleHooks || {}, CR.adapter.getTheme());
    ensureAttached();
  }

  // 万一 <style> 被页面移除了，重新放回去
  function ensureAttached() {
    if (styleEl && !styleEl.isConnected && CR.settings.typography.enabled) document.head.appendChild(styleEl);
  }

  function remove() {
    if (styleEl) styleEl.remove();
  }

  const run = (fn) => () => CR.featureManager.run('typography', fn);

  CR.featureManager.register('typography', '排版', {
    start() {
      apply();
      CR.events.on('settings-change', (e) => e.key === 'typography' && run(apply)());
      CR.events.on('content-change', run(ensureAttached));
      CR.events.on('theme-change', run(apply));
      CR.events.on('conversation-change', run(ensureAttached));
    },
    stop: remove,
    isEnabled: () => CR.settings.typography.enabled,
  });

  // 给测试用：在控制台里能看到当前生成的 CSS
  CR.features.typography = { buildCss };
})();
