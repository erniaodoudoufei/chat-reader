// 功能管理：每个功能单独启动、单独出错。一个功能出错只会停掉它自己，Claude 页面照常使用。
(() => {
  const CR = window.CR;
  const registry = {}; // name -> { label, impl, state: 'running' | 'off' | 'error', error }

  function guard(name, fn) {
    const f = registry[name];
    try {
      fn();
    } catch (e) {
      f.state = 'error';
      f.error = String((e && e.message) || e);
      CR.error(`功能「${f.label}」出错，已停用：`, e);
      try {
        f.impl.stop && f.impl.stop();
      } catch (e2) {
        // 停用时再出错也不管了
      }
    }
  }

  CR.featureManager = {
    // impl: { start(), stop(), isEnabled() }
    register(name, label, impl) {
      registry[name] = { label, impl, state: 'off', error: null };
    },
    startAll() {
      for (const name of Object.keys(registry)) {
        guard(name, () => {
          registry[name].impl.start();
          registry[name].state = 'running';
        });
      }
    },
    // 包一层：功能内部的回调（事件、定时器）也用它执行，出错同样被隔离
    run(name, fn) {
      if (registry[name] && registry[name].state !== 'error') guard(name, fn);
    },
    status() {
      return Object.values(registry).map((f) => {
        if (f.state === 'error') return { label: `功能：${f.label}`, status: 'fail', detail: `出错已停用：${f.error}` };
        const on = f.impl.isEnabled ? f.impl.isEnabled() : true;
        return { label: `功能：${f.label}`, status: on ? 'ok' : 'info', detail: on ? '运行中' : '已关闭' };
      });
    },
  };
})();
