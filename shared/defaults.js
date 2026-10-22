// 弹窗和页面共用的设置定义：默认值、字体选项、滑块范围。
// 这个文件同时被 popup.html 和内容脚本加载，所以只放纯数据，不碰页面。
globalThis.CR_SHARED = (() => {
  // 排版设置。数值为 null 表示"不改，用 Claude 默认"
  const TYPOGRAPHY_DEFAULTS = {
    enabled: true,
    bodyFont: '', // '' = Claude 默认字体
    codeFont: '',
    fontSize: null,
    lineHeight: null,
    letterSpacing: null,
    paragraphSpacing: null,
    contentWidth: null,
    katexScale: null,
  };

  // 滑块：claude 表示 Claude 默认大约是多少（未调整时滑块停在这里）
  const SLIDERS = [
    { key: 'fontSize', label: '字号', min: 12, max: 26, step: 0.5, claude: 15, unit: 'px', digits: 1 },
    { key: 'lineHeight', label: '行距', min: 1.2, max: 2.6, step: 0.05, claude: 1.5, unit: '倍', digits: 2 },
    { key: 'letterSpacing', label: '字间距', min: 0, max: 0.2, step: 0.01, claude: 0, unit: 'em', digits: 2 },
    { key: 'paragraphSpacing', label: '段落间距', min: 0, max: 2.5, step: 0.05, claude: 0.75, unit: 'em', digits: 2 },
    { key: 'contentWidth', label: '对话区宽度', min: 600, max: 1800, step: 20, claude: 768, unit: 'px', digits: 0 },
    { key: 'katexScale', label: '公式缩放', min: 60, max: 200, step: 5, claude: 100, unit: '%', digits: 0 },
  ];

  // 字体选项：value 是 CSS 字体列表（同一款字体的几种常见安装名都写上）
  const BODY_FONTS = [
    { label: 'Claude 默认', value: '' },
    { label: '霞鹜文楷 LXGW WenKai', value: '"LXGW WenKai", "LXGW WenKai Screen", "霞鹜文楷", "LXGW WenKai GB"' },
    { label: '思源宋体 Noto Serif SC', value: '"Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", "思源宋体"' },
    { label: 'MiSans', value: '"MiSans", "MiSans VF", "MiSans Normal"' },
    { label: 'HarmonyOS Sans', value: '"HarmonyOS Sans SC", "HarmonyOS Sans", "HarmonyOS_Sans_SC"' },
    { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑", "Microsoft YaHei UI"' },
    { label: '系统默认', value: 'system-ui' },
  ];

  const CODE_FONTS = [
    { label: 'Claude 默认', value: '' },
    { label: 'Cascadia Mono（Win11 自带）', value: '"Cascadia Mono", "Cascadia Code"' },
    { label: 'Consolas（Windows 自带）', value: 'Consolas' },
    { label: 'JetBrains Mono', value: '"JetBrains Mono"' },
    { label: 'Fira Code', value: '"Fira Code"' },
    { label: '更纱等宽黑体 Sarasa Mono SC', value: '"Sarasa Mono SC", "等距更纱黑体 SC"' },
  ];

  const PRESET_COUNT = 3;

  return { TYPOGRAPHY_DEFAULTS, SLIDERS, BODY_FONTS, CODE_FONTS, PRESET_COUNT };
})();
