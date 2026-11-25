/**
 * antigravity-zh 页面内 DOM 翻译脚本（自包含，由 daemon 序列化注入）。v2
 *
 * v1 事故复盘：MutationObserver 回调里对 addedNodes 同步全子树 walk，
 * 在 React 高频重渲染 + 动画页面上造成 CPU 雪崩导致页面卡死。
 *
 * v2 架构原则：
 *  1. 全树扫描整个生命周期最多两次（DOM 就绪时一次，安全兜底一次）；
 *  2. 之后纯增量：只翻译真正变化的节点，不遍历子树；
 *  3. 批处理预算：每批节点/时间双上限，超出拆到下批（不阻塞主线程）；
 *  4. 乒乓防护：同一节点两次翻译之间若少于 N ms 且原文相同，跳过（冷静期）；
 *  5. 版本化守卫：同版本幂等；新版本先 dispose 旧实例（断开 observer）再激活。
 */
(function () {
  'use strict';
  // __AGY_ZH_VER__ 由 daemon 构建时嵌入（词典+脚本内容 hash）；词典热重载产生新版本。
  var __AGY_ZH_VER__ = '__AGY_ZH_VERSION_PLACEHOLDER__';
  if (window.__AGY_ZH_VER__ === __AGY_ZH_VER__) return;
  try { if (typeof window.__AGY_ZH_DISPOSE__ === 'function') window.__AGY_ZH_DISPOSE__(); } catch (e) {}
  window.__AGY_ZH_ACTIVE__ = true;
  window.__AGY_ZH_VER__ = __AGY_ZH_VER__;

  var __AGY_ZH_DICT__ = {};
  var __AGY_ZH_PATTERNS__ = [];
  var __AGY_ZH_CSS_OVERRIDE__ = '';  // daemon 构建时嵌入（模型胶囊 CSS 规则）
  var DICT = (typeof __AGY_ZH_DICT__ === 'object' && __AGY_ZH_DICT__) || {};
  var PATTERNS = Array.isArray(__AGY_ZH_PATTERNS__) ? __AGY_ZH_PATTERNS__ : [];

  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH']);
  var TR_ATTRS = ['placeholder', 'title', 'aria-label', 'aria-placeholder', 'aria-description'];
  var MAX_TEXT = 320;        // 只翻译不超过此长度的整节点文本（公告类长句约 161 字符需覆盖）
  var BATCH_NODES = 300;     // 每批最多处理节点数
  var BATCH_MS = 8;          // 每批时间预算（ms）
  var COOLDOWN_MS = 1500;    // 同一节点相同原文的翻译冷静期
  var STATS = { translated: 0, skipped: 0, fullScans: 0 };
  var RES = [];
  for (var pi = 0; pi < PATTERNS.length; pi++) {
    try { RES.push({ re: new RegExp(PATTERNS[pi][0]), result: PATTERNS[pi][1] }); } catch (e) { }
  }

  function translateCore(s) {
    if (!s || s.length > MAX_TEXT || !/[A-Za-z]/.test(s)) return null;
    var t = DICT[s];
    if (t !== undefined) return t;
    for (var i = 0; i < RES.length; i++) {
      var m = RES[i].re.exec(s);
      if (m && m[0] === s) {
        return RES[i].result.replace(/\$(\d)/g, function (_, d) { return m[+d] !== undefined ? m[+d] : ''; });
      }
    }
    return null;
  }

  function translateWhole(s) {
    if (!s) return null;
    var core = s.trim().replace(/\s+/g, ' ');
    if (!core) return null;
    var t = translateCore(core);
    if (t === null) return null;
    var lead = /^\s*/.exec(s)[0];
    var tail = /\s*$/.exec(s)[0];
    return lead + t + tail;
  }

  function isSkipped(node) {
    try {
      var p = node;
      while (p && p.nodeType === 1) {
        if (SKIP_TAGS.has(p.tagName)) return true;
        p = p.parentElement;
      }
    } catch (e) { return true; }
    return false;
  }

  var lastTouch = new WeakMap(); // node -> {v, t}

  /**
   * 模型胶囊区域（React 受控 DOM）：文本节点由 React reconciler 持有，
   * 任何外部写入都会在其下次 commit 时被校正回英文（实测：写入中文后
   * 3 秒内被校正，肉眼闪动）。因此该区域 DOM 层跳过，改由 CSS 层翻译：
   * 按 data-model-label 属性生成选择器，隐藏原文本（font-size:0）并用
   * ::after 显示中文。React 只校正文本节点，与 ::after 伪元素正交。
   */
  var CSS_OVERRIDE_ZONE = '[data-testid="model-selector-trigger"]';
  function isCssOverrideZone(node) {
    try {
      if (!node.parentElement || !node.parentElement.closest) return false;
      return !!node.parentElement.closest(CSS_OVERRIDE_ZONE);
    } catch (e) { return false; }
  }

  /** 注入/更新 CSS 覆盖规则（内容变化时刷新，词典热重载后自动更新）。 */
  function injectStyleOverride() {
    try {
      var css = __AGY_ZH_CSS_OVERRIDE__ || '';
      if (!css) return;
      var style = document.getElementById('agy-zh-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'agy-zh-style';
        (document.head || document.documentElement).appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    } catch (e) { }
  }

  /**
   * 翻译单个文本节点（带冷静期）。
   * 冷静期保证：同一节点同一原文在 COOLDOWN_MS 内只处理一次（高频 miss 节点节流）。
   * 实测（60 秒只读探针）：胶囊等 UI 区域 React 不周期重写文本节点，
   * DOM 翻译安全无拉锯；若未来某节点出现真实拉锯，再针对该节点单独处理。
   */
  function doTextNode(node) {
    var v = node.nodeValue;
    if (!v || v.length > MAX_TEXT || !/[A-Za-z]/.test(v)) return false;
    if (isCssOverrideZone(node)) return false; // React 受控区：CSS 层负责
    var prev = lastTouch.get(node);
    var now = Date.now();
    if (prev && prev.v === v) {
      if (now - prev.t < COOLDOWN_MS) { STATS.skipped++; return false; }
    }
    var t = translateWhole(v);
    if (t === null || t === v) {
      lastTouch.set(node, { v: v, t: now });
      return false;
    }
    node.nodeValue = t;
    lastTouch.set(node, { v: v, t: now });
    STATS.translated++;
    return true;
  }

  function doAttributes(el) {
    if (el.nodeType !== 1) return false;
    var changed = false;
    for (var i = 0; i < TR_ATTRS.length; i++) {
      var a = TR_ATTRS[i];
      var v = el.getAttribute && el.getAttribute(a);
      if (typeof v === 'string' && v && v.length <= MAX_TEXT) {
        var t = translateCore(v.trim());
        if (t !== null && t !== v) {
          try { el.setAttribute(a, t); changed = true; } catch (e) { }
        }
      }
    }
    return changed;
  }

  /**
   * 单节点处理：文本节点翻文本；元素节点翻属性 + 子节点延展入队
   * （子延展：大子树（如整块弹出的菜单）被拆到后续批次异步消化，
   *   不在 mutation 回调里递归递打，保持 CPU 安全；队列硬上限兜底）。
   */
  function doOne(node) {
    if (node.nodeType === 3) return isSkipped(node) ? false : doTextNode(node);
    if (node.nodeType === 1 && !isSkipped(node)) {
      var changed = doAttributes(node);
      var kids = node.childNodes;
      for (var i = 0; i < kids.length && queue.length < QUEUE_HARD_LIMIT; i++) {
        var k = kids[i];
        if (k.nodeType !== 1 && k.nodeType !== 3) continue;
        if (queued.has(k)) continue;
        queue.push(k);
        queued.add(k);
      }
      return changed;
    }
    return false;
  }

  /* ---------- 队列化批处理 ---------- */
  var queue = [];
  var queued = new WeakSet();
  var timer = null;

  function drain() {
    timer = null;
    var done = 0;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    while (queue.length > 0) {
      var node = queue.shift();
      try { doOne(node); } catch (e) { }
      queued.delete(node);
      done++;
      if (done >= BATCH_NODES) { schedule(); return; }
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      if (now - t0 > BATCH_MS) { schedule(); return; }
    }
  }

  /**
   * 批处理驱动：setTimeout（不依赖 requestIdleCallback —— Chromium 在 hidden
   * 页面会冻结 rIC（含 timeout 选项），导致队列死锁：窗口失焦后新增/重渲染节点
   * 永不翻译。setTimeout 在隐藏页仍触发（限流至约 1 秒/批），保证后台窗口
   * 也能持续补翻；批内 BATCH_MS/BATCH_NODES 双预算不变，主线程占用可控）。
   */
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(function () { timer = null; drain(); }, 120);
  }

  var QUEUE_HARD_LIMIT = 50000; // 队列硬上限（病态 DOM 兜底；正常 Hub 全树数万节点需完整覆盖）

  /**
   * 节点入队：任何元素/文本节点直接入队；整块插入的大子树
   * 通过 doOne 的子节点延展（逐批入队）异步消化，不漏译也不卡顿。
   */
  function enqueue(node) {
    if (!node || !node.nodeName) return;
    if (queued.has(node)) return;
    if (node.nodeType !== 1 && node.nodeType !== 3) return;
    if (node.nodeType === 3 && isSkipped(node)) return;
    queue.push(node);
    queued.add(node);
    schedule();
  }

  /* ---------- 全树扫描（队列消化式：enqueue 根节点，延展机制异步分批走完整棵树） ---------- */
  var scanTimer = null;
  var lastRescanAt = 0;

  function fullScan(force) {
    if (force !== true && STATS.fullScans >= 3) return; // 主动重扫（force）不限次
    STATS.fullScans++;
    enqueue(document.body || document.documentElement);
  }

  /**
   * 预渲染浮层兜底：菜单/弹窗常驻 DOM，打开只改 aria-hidden/style，
   * childList 不触发 —— 在交互（点击/按键）与 aria 开关属性变化后
   * 节流地续扫一次全树（已翻译节点被冷静期跳过，成本低）。
   */
  var rescanTimer = null;
  function requestRescan(immediate) {
    var now = Date.now();
    if (now - lastRescanAt < 2000) return; // 节流：≥2s 一次
    if (rescanTimer !== null) return;
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      lastRescanAt = Date.now();
      fullScan(true);
    }, immediate ? 350 : 500);
  }

  /* ---------- 标题（窗口标题联动） ---------- */
  var TITLE_TAIL = [
    [/ - Standalone - Antigravity$/, ' - 独立版 - Antigravity'],
  ];
  function translateTitle(v) {
    if (typeof v !== 'string' || !/[A-Za-z]/.test(v)) return v;
    for (var i = 0; i < TITLE_TAIL.length; i++) {
      if (TITLE_TAIL[i][0].test(v)) return v.replace(TITLE_TAIL[i][0], TITLE_TAIL[i][1]);
    }
    return v;
  }
  function installTitleHook() {
    try {
      var d = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
      if (!d || !d.set) return;
      var origSet = d.set;
      var origGet = d.get;
      Object.defineProperty(document, 'title', {
        configurable: true,
        get: function () { return origGet.call(this); },
        set: function (v) { origSet.call(this, translateTitle(v)); },
      });
    } catch (e) { }
  }

  /* ---------- 启动 ---------- */
  injectStyleOverride();
  installTitleHook();

  var observer = new MutationObserver(function (muts) {
    try {
      var ariaToggled = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) enqueue(m.addedNodes[j]);
        } else if (m.type === 'characterData') {
          if (m.target && m.target.nodeType === 3) enqueue(m.target);
        } else if (m.type === 'attributes') {
          if (!m.target || m.target.nodeType !== 1) continue;
          if (TR_ATTRS.indexOf(m.attributeName) >= 0) enqueue(m.target);
          else if (m.attributeName === 'aria-hidden' || m.attributeName === 'aria-expanded') ariaToggled = true;
        }
      }
      if (ariaToggled) requestRescan();
    } catch (e) { }
  });

  function start() {
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TR_ATTRS.concat(['aria-hidden', 'aria-expanded']),
      });
      fullScan(true);
      // 交互后节流续扫（捕获预渲染浮层）/ 兜底重扫
      document.addEventListener('click', function () { requestRescan(); }, true);
      document.addEventListener('keydown', function () { requestRescan(); }, true);
      document.addEventListener('focusin', function () { requestRescan(); }, true);
      setTimeout(function () { fullScan(); }, 60000);
    } catch (e) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
    try {
      observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
    } catch (e) { }
  } else {
    start();
  }

  // 调试/管理出口（供 daemon 诊断与热重载 dispose）
  window.__AGY_ZH_STATS__ = function () { return JSON.parse(JSON.stringify(STATS)); };
  window.__AGY_ZH_DISPOSE__ = function () {
    try { observer.disconnect(); } catch (e) { }
    try { if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; } } catch (e) { }
    try { if (rescanTimer !== null) { clearTimeout(rescanTimer); rescanTimer = null; } } catch (e) { }
    try { if (timer !== null) { clearTimeout(timer); timer = null; } } catch (e) { }
  };
})();
