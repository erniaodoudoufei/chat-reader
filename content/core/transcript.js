// 整段对话数据（共享）：目录和标注都要用，统一在这里读取、缓存、判断是否过期。
// 数据来自 adapter.fetchTranscript()；读取失败时 data 为 null，使用方要能降级。
//
// 发出的事件：transcript-change（数据换了：切换对话、重新读取完成）
(() => {
  const CR = window.CR;
  const A = () => CR.adapter;

  let convId = null;
  let data = null; // { title, messages: [{ index, role, text, uuid }] }
  let failed = false;
  let loading = null;
  let refetchAt = 0;
  let refetchDelay = 3000;
  let holds = 0; // 有人（比如目录跳转中）要求暂时别刷新

  async function load() {
    const id = A().getConversationId();
    convId = id;
    refetchAt = Date.now();
    if (!id) {
      data = null;
      failed = false;
      CR.events.emit('transcript-change');
      return;
    }
    const p = (async () => {
      let t = null;
      try {
        t = await A().fetchTranscript(id);
      } catch (e) {
        CR.warn('读取整段对话失败：', e);
      }
      if (convId !== id) return; // 读取期间已经切到别的对话了
      data = t;
      failed = !t;
      CR.events.emit('transcript-change');
    })();
    loading = p;
    await p;
    if (loading === p) loading = null;
  }

  // 页面内容变了（新消息、回复生成中、切换分支…）：看看数据是否过期
  function checkFreshness() {
    if (holds || !data || loading) return;
    const aligned = A().checkAlignment(data);
    const rows = A().getRenderedMessages();
    const n = data.messages.length;
    const beyond = rows.length && A().toTranscriptIndex(rows[rows.length - 1].index, n) >= n;
    if (aligned !== false && !beyond) {
      refetchDelay = 3000;
      return;
    }
    if (Date.now() - refetchAt < refetchDelay) return;
    // 回复生成过程中接口可能还没有最新内容，会一直对不上；所以每次重读后把间隔拉长，最长 30 秒
    refetchDelay = Math.min(refetchDelay * 2, 30000);
    load();
  }

  let started = false;

  CR.transcript = {
    // 使用方调用一次即可（多次调用无副作用）
    start() {
      if (started) return;
      started = true;
      CR.events.on('conversation-change', () => {
        data = null;
        failed = false;
        refetchDelay = 3000;
        load();
      });
      CR.events.on('content-change', checkFreshness);
      load();
    },
    get data() {
      return data;
    },
    get failed() {
      return failed;
    },
    get loading() {
      return !!loading;
    },
    refresh: load,
    hold() {
      holds++;
    },
    release() {
      holds = Math.max(0, holds - 1);
    },
    // 页面上的消息（getRenderedMessages 的一项）在整段对话里的序号；没有数据时退回页面序号
    indexOf(m) {
      return data ? A().toTranscriptIndex(m.index, data.messages.length) : m.index;
    },
    // 页面上的消息对应的数据项（对不上时返回 null）
    itemOf(m) {
      if (!data) return null;
      const item = data.messages[this.indexOf(m)];
      return item && A().isSameMessage(m, item) ? item : null;
    },
  };
})();
