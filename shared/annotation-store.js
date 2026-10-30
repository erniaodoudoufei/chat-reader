// 标注数据的读写（页面里的标注功能和"我的笔记"页共用）。
// 存在 chrome.storage.local（只在本机，不同步到云端），每个对话一条：
//   'ann:<对话ID>' → { convId, title, url, updatedAt, items: [标注…] }
// 每条标注：
//   { id, exact, prefix, suffix, messageIndex, messageUuid, role, offset,
//     color, style: 'hl' | 'wavy', note, createdAt, updatedAt, status: 'ok' | 'orphan' }
//   exact/prefix/suffix 参考 W3C Web Annotation 的 TextQuoteSelector：原文 + 前后各约 32 个字；
//   messageIndex/messageUuid/offset 是位置提示，用来区分重复出现的相同文字。
globalThis.CR_ANN = (() => {
  const PREFIX = 'ann:';
  const key = (convId) => PREFIX + convId;

  async function getGroup(convId) {
    const r = await chrome.storage.local.get(key(convId));
    return r[key(convId)] || null;
  }

  async function saveGroup(group) {
    if (!group.items.length) {
      await chrome.storage.local.remove(key(group.convId));
      return;
    }
    group.updatedAt = Date.now();
    await chrome.storage.local.set({ [key(group.convId)]: group });
  }

  async function listGroups() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => all[k])
      .filter((g) => g && Array.isArray(g.items) && g.items.length)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 导入备份：按标注 id 合并，同一条以更新时间较新的为准
  async function importGroups(groups) {
    let added = 0;
    let updated = 0;
    for (const g of groups) {
      if (!g || !g.convId || !Array.isArray(g.items)) continue;
      const cur = (await getGroup(g.convId)) || { convId: g.convId, title: g.title, url: g.url, items: [] };
      const byId = new Map(cur.items.map((x) => [x.id, x]));
      for (const it of g.items) {
        if (!it || !it.id || !it.exact) continue;
        const old = byId.get(it.id);
        if (!old) {
          byId.set(it.id, it);
          added++;
        } else if ((it.updatedAt || 0) > (old.updatedAt || 0)) {
          byId.set(it.id, it);
          updated++;
        }
      }
      cur.items = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      cur.title = cur.title || g.title;
      cur.url = cur.url || g.url;
      await saveGroup(cur);
    }
    return { added, updated };
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // swatch：界面上表示这个颜色的小圆点用的色值
  const COLORS = [
    { id: 'yellow', label: '黄色', swatch: '#ffd43b' },
    { id: 'green', label: '绿色', swatch: '#69db7c' },
    { id: 'blue', label: '蓝色', swatch: '#74c0fc' },
    { id: 'pink', label: '粉色', swatch: '#f783ac' },
    { id: 'purple', label: '紫色', swatch: '#b197fc' },
  ];

  return { key, PREFIX, getGroup, saveGroup, listGroups, importGroups, newId, COLORS };
})();
