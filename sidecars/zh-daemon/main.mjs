/**
 * antigravity-zh — 简体中文汉化守护进程（官方 sidecar 形态，单文件自包含）
 *
 * 通道：Antigravity 官方支持的 Chromium 远程调试接口（主进程在
 * `--remote-debugging-port` 模式下会把端口写入 DevToolsActivePort 并转交给
 * 语言服务器）。本 sidecar 通过该端口为每个窗口/iframe 提供：
 *
 *   1. Fetch 响应拦截：UI JS bundle 在加载前应用中文词典（源头替换 =
 *      零闪烁、覆盖源层字符串；短语级整串替换 + 引号边界，不改语法结构）；
 *   2. Page.addScriptToEvaluateOnNewDocument：注入 DOM 兜底翻译
 *      （动态文本/属性/窗口标题；纯增量、批处理预算、冷静期防乒乓）。
 *
 * 安全设计：
 *   - 不修改 Antigravity 任何文件（asar/二进制/配置均不动）；
 *   - 词典未命中一律原文放行，应用升级天然降级（不会因新版本布局变化而崩溃）；
 *   - 单个英文单词（可作为查找键）不出现在源替换层，仅参与 DOM 显示层翻译；
 *   - 用户内容（代码块、会话正文、模型名等）不翻译 —— 只做整节点精确/模式匹配。
 *
 * 本文件为独立开源项目，与 Google LLC 无关，未使用任何第三方汉化代码。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const DICT_DIR = path.join(PLUGIN_ROOT, 'dictionaries');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config.json');
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8')).version || '1.3.0'; }
  catch { return '1.3.0'; }
})();

/* ============================ 词典 ============================ */

/** 把字面转义序列还原为真实字符（\uXXXX、\n、\t 等）。 */
function unescapeLiteral(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, g) => {
    if (g[0] === 'u' || g[0] === 'x') return String.fromCodePoint(parseInt(g.slice(1), 16));
    switch (g) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case 'b': return '\b';
      case 'f': return '\f';
      case '\n': return '';
      default: return g;
    }
  });
}

/** 加载 dictionaries/*.json：普通文件为词条，patterns 文件的 patterns 数组为正则规则；
 *  顶层 "@layer": "dom" 标记该文件全部词条仅用于 DOM 显示层（不进 JS 源替换层）。 */
function loadDictionaries(dir) {
  const merged = new Map();
  const patterns = [];
  const warnings = [];
  const domOnly = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { return { dict: merged, patterns, warnings: ['无法读取词典目录: ' + e.message], domOnly }; }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(data.patterns)) {
        for (const p of data.patterns) {
          if (typeof p.re === 'string' && typeof p.result === 'string') {
            try { patterns.push({ re: new RegExp(p.re), result: p.result }); }
            catch { warnings.push(`${f}: 非法正则 ${p.re}`); }
          }
        }
        continue;
      }
      const domLayer = data['@layer'] === 'dom';
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('//') || k.startsWith('@') || typeof v !== 'string') continue;
        const key = unescapeLiteral(k);
        merged.set(key, unescapeLiteral(v));
        if (domLayer) domOnly.add(key);
      }
    } catch (e) { warnings.push(`${f}: ${e.message}`); }
  }
  return { dict: merged, patterns, warnings, domOnly };
}

/* 词典的加载与热重载统一由下方 reloadDictionaries() 管理（版本化注入脚本）。 */

/* ======================== JS 字面量替换引擎 ======================== */

function encodeLiteral(s) { return JSON.stringify(s); }
const QUOTES = new Set(['"', "'"]);

/** 粗略判断 '/' 在 i 处是否为正则字面量起点。 */
function isRegexPosition(out, code, i) {
  let k = out.length - 1;
  let prev = '';
  while (k >= 0) {
    const chunk = out[k];
    for (let m = chunk.length - 1; m >= 0; m--) {
      const ch = chunk[m];
      if (/\s/.test(ch)) continue;
      prev = ch;
      break;
    }
    if (prev) break;
    k--;
  }
  if (!prev) return true;
  if (/[({[,;:!&|?+\-*/%~^=<>]/.test(prev)) return true;
  if (/[a-zA-Z_$]/.test(prev)) {
    let start = i;
    while (start > 0 && /[a-zA-Z_$0-9]/.test(code[start - 1])) start--;
    const word = code.slice(start, i);
    return /^(return|typeof|instanceof|in|of|case|do|else|yield|await)$/.test(word);
  }
  return false;
}

/** 对压缩 JS 应用词典：只改字符串字面量的值，语法结构不变。 */
function replaceJsLiterals(code, d) {
  if (d.size === 0 || typeof code !== 'string' || code.length === 0) return { code, replaced: 0 };
  const out = [];
  let replaced = 0;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (QUOTES.has(c)) {
      let j = i + 1;
      let decoded = '';
      let terminated = false;
      while (j < n) {
        const q = code[j];
        if (q === '\\') {
          const u = /^\\u\{[0-9a-fA-F]{1,6}\}/.exec(code.slice(j)) || /^\\u[0-9a-fA-F]{4}/.exec(code.slice(j, j + 7));
          if (u) {
            const hex = u[0].includes('{') ? u[0].slice(3, -1) : u[0].slice(2);
            decoded += String.fromCodePoint(parseInt(hex, 16));
            j += u[0].length;
          } else if (j + 1 < n) {
            const e = code[j + 1];
            if (e === 'n') decoded += '\n';
            else if (e === 't') decoded += '\t';
            else if (e === 'r') decoded += '\r';
            else if (e === 'b') decoded += '\b';
            else if (e === 'f') decoded += '\f';
            else if (e === 'v') decoded += '\v';
            else if (e === '0' && !/[0-9]/.test(code[j + 2] || '')) decoded += '\0';
            else if (e === '\n') { /* 行继续 */ }
            else decoded += e;
            j += 2;
          } else j++;
          continue;
        }
        if (q === c) { terminated = true; j++; break; }
        if (q === '\n') break;
        decoded += q;
        j++;
      }
      if (!terminated) { out.push(code.slice(i, j)); i = j; continue; }
      const hit = d.get(decoded);
      if (hit !== undefined) { out.push(encodeLiteral(hit)); replaced++; }
      else out.push(code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '`') { // 模板字面量整段跳过
      let j = i + 1;
      while (j < n && code[j] !== '`') { if (code[j] === '\\') j++; j++; }
      out.push(code.slice(i, Math.min(j + 1, n)));
      i = j + 1;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      let j = code.indexOf('\n', i);
      j = j === -1 ? n : j;
      out.push(code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      let j = code.indexOf('*/', i);
      j = j === -1 ? n : j + 2;
      out.push(code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && isRegexPosition(out, code, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const q = code[j];
        if (q === '\\') { j += 2; continue; }
        if (q === '[') inClass = true;
        else if (q === ']') inClass = false;
        else if (q === '/' && !inClass) { j++; break; }
        else if (q === '\n') break;
        j++;
      }
      while (j < n && /[a-z]/.test(code[j])) j++;
      out.push(code.slice(i, j));
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return { code: out.join(''), replaced };
}

/* ======================== DOM 注入脚本模板（版本化 + 热重载） ======================== */

const INJECT_TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'sidecars', 'zh-daemon', 'inject-dom.js');

/** 词典目录 + 注入模板的内容指纹（mtime+size），用于热重载检测。 */
function dictDirFingerprint(dir) {
  try {
    const parts = [];
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of names) {
      try { const st = fs.statSync(path.join(dir, f)); parts.push(`${f}:${st.mtimeMs}:${st.size}`); }
      catch { parts.push(`${f}:x`); }
    }
    // 注入模板也参与指纹：模板更新 → 新版本号 → 自动重注入
    try {
      const st = fs.statSync(INJECT_TEMPLATE_PATH);
      parts.push(`__inject__:${st.mtimeMs}:${st.size}`);
    } catch { /* ignore */ }
    return parts.join('|');
  } catch { return ''; }
}

let dict = new Map();
let patterns = [];
let domOnly = new Set();
let SRC_DICT = new Map();
let DOM_SCRIPT = '';
let DOM_SCRIPT_VER = '';
const replaceCache = new Map(); // body-sha1 -> {body: Buffer, replaced}（声明提前，热重载共用）

/**
 * 构建模型胶囊的 CSS 覆盖规则。
 * 背景：胶囊内模型名由 React 随轮询/动画周期重写，DOM 回写会与之拉锯闪抖。
 * 方案：按胶囊 data-model-label 属性生成选择器 —— 隐藏第一个文本 span 的
 * 字号并用 ::after 显示中文译名。React 只重写被隐藏的英文，视觉恒为中文。
 * 档位词（极高/高/中）不在模型词典键里，由普通 DOM 层照常翻译。
 */
function buildCssOverride(d) {
  const TIER = [['Extra High', '极高'], ['High', '高'], ['Medium', '中'], ['Low', '低'], ['', '']];
  const ZONE = '[data-testid="model-selector-trigger"]';
  const escAttr = (x) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escContent = (x) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const rules = [];
  for (const [k, v] of d) {
    if (!/^(Gemini|Claude|GPT-OSS)/.test(k)) continue;
    if (/\(/.test(k)) continue;
    for (const [tEn, tZh] of TIER) {
      const label = tEn ? k + ' ' + tEn : k;
      const content = tZh ? v + ' ' + tZh : v;
      const sel = ZONE + '[data-model-label="' + escAttr(label) + '"] > span.min-w-0';
      rules.push(sel + ' { font-size: 0 !important; }');
      rules.push(sel + '::after { content: "' + escContent(content) + '" !important; font-size: 12.5px !important; }');
    }
  }
  return rules.join('\n');
}

function reloadDictionaries() {
  const { dict: d, patterns: p, warnings, domOnly: domSet } = loadDictionaries(DICT_DIR);
  for (const w of warnings) console.log('[warn]', w);
  const src = new Map();
  for (const [k, v] of d) {
    if (domSet.has(k)) continue; // @layer:dom 的词条不进源替换层
    if (/\s/.test(k) || k.length >= 12) src.set(k, v);
  }
  const tpl = fs.readFileSync(INJECT_TEMPLATE_PATH, 'utf8');
  const dictJson = JSON.stringify(Object.fromEntries(d));
  const patternsJson = JSON.stringify(p.map((x) => [x.re.source, x.result]));
  const cssOverride = buildCssOverride(d);
  let s = tpl.replace('var __AGY_ZH_DICT__ = {};', 'var __AGY_ZH_DICT__ = ' + dictJson + ';');
  s = s.replace('var __AGY_ZH_PATTERNS__ = [];', 'var __AGY_ZH_PATTERNS__ = ' + patternsJson + ';');
  s = s.replace(/var __AGY_ZH_CSS_OVERRIDE__ = '';/, 'var __AGY_ZH_CSS_OVERRIDE__ = ' + JSON.stringify(cssOverride) + ';');
  if (s === tpl) throw new Error('inject-dom.js 模板占位符缺失');
  const ver = 'v' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
  s = s.replace("var __AGY_ZH_VER__ = '__AGY_ZH_VERSION_PLACEHOLDER__';", "var __AGY_ZH_VER__ = '" + ver + "';");
  if (ver === DOM_SCRIPT_VER) return false; // 无变化
  dict = d; patterns = p; domOnly = domSet; SRC_DICT = src; DOM_SCRIPT = s; DOM_SCRIPT_VER = ver;
  replaceCache.clear(); // 源替换层缓存随词典重建
  console.log(`[antigravity-zh] 词典已加载: ${d.size} 词条（DOM 专用 ${domSet.size}）, ${p.length} 模式（注入版本 ${ver}）`);
  return true;
}
reloadDictionaries();

/* ======================== CDP 客户端 ======================== */

class CdpSession {
  constructor(connection, sessionId) {
    this.conn = connection;
    this.sessionId = sessionId || undefined;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._detached = false;
  }
  send(method, params = {}) {
    if (this._detached) return Promise.reject(new Error('session detached: ' + method));
    const id = ++this.conn._msgId;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 30000);
      this._pending.set(id, { resolve, reject, timer });
      try { this.conn.ws.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(fn);
  }
  _dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId === this.sessionId) this._detached = true;
      const set = this._listeners.get(msg.method);
      if (set) for (const fn of [...set]) {
        try { fn(msg.params || {}); } catch { /* listener 异常不阻断 */ }
      }
    }
  }
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._msgId = 0;
    this.sessions = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (ev) => this._onMessage(ev);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('ws open failed: ' + this.wsUrl));
    });
    this.browser = new CdpSession(this, undefined);
    this.sessions.set('browser', this.browser);
    return this;
  }
  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const sid = msg.sessionId;
    if (sid) {
      const s = this.sessions.get(sid);
      if (s) s._dispatch(msg);
      return;
    }
    // 无 sessionId：命令回包按 _pending 路由；事件视为浏览器级
    if (msg.id !== undefined) {
      for (const s of this.sessions.values()) {
        if (s._pending.has(msg.id)) { s._dispatch(msg); return; }
      }
      this.browser._dispatch(msg);
    } else {
      this.browser._dispatch(msg);
    }
  }
  createSession(targetId) {
    return this.browser.send('Target.attachToTarget', { targetId, flatten: true }).then(({ sessionId }) => {
      const s = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, s);
      return s;
    });
  }
  registerSession(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) { s = new CdpSession(this, sessionId); this.sessions.set(sessionId, s); }
    return s;
  }
  close() {
    for (const s of this.sessions.values()) {
      s._detached = true;
      for (const p of s._pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
      s._pending.clear();
    }
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* ======================== 拦截与应用 ======================== */

const FETCH_PATTERNS = [
  { urlPattern: '*://127.0.0.1*main.js', requestStage: 'Response' },
  { urlPattern: '*://127.0.0.1*_bundle.js', requestStage: 'Response' },
];

/** 对 JS 响应体应用 SRC_DICT；未命中返回 null（原样放行）。 */
function applyToBody(buf, url) {
  if (!/\.js(\?|$)/.test(url)) return null;
  const key = crypto.createHash('sha1').update(buf).digest('hex');
  if (replaceCache.has(key)) return replaceCache.get(key);
  const r = replaceJsLiterals(buf.toString('utf8'), SRC_DICT);
  if (r.replaced === 0) return null; // 命中 0 处也无须替换，减少内存缓存
  const out = { body: Buffer.from(r.code, 'utf8'), replaced: r.replaced };
  if (replaceCache.size >= 8) replaceCache.delete(replaceCache.keys().next().value);
  replaceCache.set(key, out);
  return out;
}

/* ======================== Hub 接管 ======================== */

class Hub {
  constructor(port) {
    this.port = port;
    this.conn = null;
    this.readySessions = new Set();
    this.attachedTargets = new Set();
  }

  isUiTarget(t) {
    if (t.type !== 'page' && t.type !== 'iframe' && t.type !== 'webview') return false;
    const u = t.url || '';
    return /^https?:\/\/127\.0\.0\.1/.test(u) || u === 'about:blank' || u === '' || u.startsWith('devtools:');
  }

  async start() {
    const ver = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
      signal: AbortSignal.timeout(4000),
    }).then((r) => r.json());
    this.conn = new CdpConnection(ver.webSocketDebuggerUrl);
    await this.conn.connect();
    const browser = this.conn.browser;

    browser.on('Target.attachedToTarget', (p) => this.onAttached(p));
    await browser.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    for (const t of (await browser.send('Target.getTargets')).targetInfos || []) {
      if (!this.isUiTarget(t) || this.attachedTargets.has(t.targetId)) continue;
      this.attachedTargets.add(t.targetId);
      try {
        const s = await this.conn.createSession(t.targetId);
        await this.ensureTargetReady(s, t);
      } catch (e) {
        this.attachedTargets.delete(t.targetId);
        console.log('[debug] attach 现有 target 失败', String(e).slice(0, 90));
      }
    }
    console.log(`[antigravity-zh] 已连接调试端口 ${this.port}（会话 ${this.conn.sessions.size} 个）`);
  }

  async onAttached(p) {
    const { sessionId, targetInfo } = p;
    if (!sessionId || !targetInfo || !this.isUiTarget(targetInfo)) return;
    if (this.attachedTargets.has(targetInfo.targetId)) return;
    this.attachedTargets.add(targetInfo.targetId);
    const s = this.conn.registerSession(sessionId);
    await this.ensureTargetReady(s, targetInfo);
  }

  async ensureTargetReady(s, targetInfo) {
    if (this.readySessions.has(s.sessionId)) return true;
    const silent = (m) => s.send(m).catch(() => undefined);
    try {
      await silent('Runtime.enable');
      await silent('Page.enable');
      await s.send('Fetch.enable', { patterns: FETCH_PATTERNS });
      await s.send('Page.addScriptToEvaluateOnNewDocument', { source: DOM_SCRIPT });
      // 已加载页面：按注入版本号判断是否需要（重新）注入；脚本自身同版本幂等。
      const guard = await s.send('Runtime.evaluate', {
        expression: `window.__AGY_ZH_VER__ === ${JSON.stringify(DOM_SCRIPT_VER)}`,
        returnByValue: true,
      }).catch(() => null);
      const upToDate = guard?.result?.value === true;
      if (!upToDate) {
        const r = await s.send('Runtime.evaluate', {
          expression: DOM_SCRIPT,
          sourceURL: 'antigravity-zh-inject.js',
        }).catch(() => null);
        if (r?.exceptionDetails) console.log('[warn] DOM 注入异常:', JSON.stringify(r.exceptionDetails).slice(0, 180));
      }
      this.readySessions.add(s.sessionId);
      s.on('Fetch.requestPaused', async (ev) => this.onRequestPaused(s, ev));
      s.on('Target.attachedToTarget', (p2) => this.onAttached(p2));
      console.log(`[antigravity-zh] 已接入 [${targetInfo.type}] ${(targetInfo.url || '').slice(0, 84)}`);
      return true;
    } catch (e) {
      this.readySessions.delete(s.sessionId);
      console.log('[warn] session 初始化失败', String(e).slice(0, 120));
      return false;
    }
  }

  /** 词典热重载后：为全部已接入会话重注入新版本脚本（脚本自身会 dispose 旧实例）。 */
  async reinjectAll() {
    for (const s of this.conn?.sessions?.values() || []) {
      if (!this.readySessions.has(s.sessionId)) continue;
      try {
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: DOM_SCRIPT });
        const r = await s.send('Runtime.evaluate', {
          expression: DOM_SCRIPT,
          sourceURL: 'antigravity-zh-inject.js',
        });
        if (r?.exceptionDetails) console.log('[warn] 重注入异常:', JSON.stringify(r.exceptionDetails).slice(0, 150));
      } catch (e) {
        console.log('[debug] 会话重注入跳过:', String(e).slice(0, 70));
      }
    }
  }

  async onRequestPaused(session, ev) {
    const { requestId, request, responseStatusCode, responseHeaders } = ev;
    const url = request.url;
    if (!responseStatusCode) {
      try { await session.send('Fetch.continueRequest', { requestId }); } catch { /* ignore */ }
      return;
    }
    try {
      const body = await session.send('Fetch.getResponseBody', { requestId });
      const buf = Buffer.from(body.base64Blob || body.body || '', body.base64Blob ? 'base64' : 'utf8');
      const replaced = applyToBody(buf, url);
      if (!replaced) {
        try { await session.send('Fetch.continueResponse', { requestId }); }
        catch { try { await session.send('Fetch.continueRequest', { requestId }); } catch { /* ignore */ } }
        return;
      }
      const headers = (responseHeaders || [])
        .filter((h) => !/^content-length$/i.test(h.name))
        .filter((h) => !/^content-encoding$/i.test(h.name));
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: responseStatusCode,
        responseHeaders: headers,
        body: replaced.body.toString('base64'),
      });
      console.log(`[antigravity-zh] 已替换 ${url.split('/').pop()}（${replaced.replaced} 处）`);
    } catch (e) {
      try { await session.send('Fetch.continueRequest', { requestId }); } catch { /* ignore */ }
      console.log('[warn] Fetch 处理失败，已放行:', url.slice(-40), String(e).slice(0, 70));
    }
  }

  stop() { if (this.conn) { this.conn.close(); this.conn = null; } }
}

/* ======================== 主循环 ======================== */

function loadConfig() {
  const def = { userDataDirs: [], portFiles: [], logLevel: 'info' };
  try { Object.assign(def, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch { /* 默认 */ }
  const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
  return { userDataDirs: arr(def.userDataDirs).filter(Boolean), portFiles: arr(def.portFiles).filter(Boolean) };
}

function candidatePortFiles(cfg) {
  const files = [];
  if (process.env.AGY_ZH_PORT_FILE) files.push(process.env.AGY_ZH_PORT_FILE);
  for (const d of cfg.userDataDirs) files.push(path.join(d, 'DevToolsActivePort'));
  for (const f of cfg.portFiles) files.push(f);
  // 常见默认位置（标准安装 / 便携安装均可自动发现）
  if (process.env.APPDATA) files.push(path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) files.push(path.join(home, '.gemini', 'antigravity', 'DevToolsActivePort'));
  return files;
}

function readPort(files) {
  for (const f of files) {
    try {
      const port = Number(fs.readFileSync(f, 'utf8').split('\n')[0].trim());
      if (port > 0 && port < 65536) return port;
    } catch { /* try next */ }
  }
  return 0;
}

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  const portFiles = candidatePortFiles(cfg);
  let hub = null;
  let lastPort = 0;
  let lastDictFp = dictDirFingerprint(DICT_DIR);
  console.log(`[antigravity-zh] sidecar 已启动（v${PLUGIN_VERSION}），监视:`, portFiles.slice(0, 3).join(' ; '));

  const shutdown = () => {
    try { hub && hub.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    // 词典热重载：检测 dictionaries/ 目录变化（mtime+size 指纹，轻量无依赖）
    try {
      const fp = dictDirFingerprint(DICT_DIR);
      if (fp !== lastDictFp) {
        lastDictFp = fp;
        await sleep(500); // 等编辑器写完
        if (reloadDictionaries()) {
          console.log('[antigravity-zh] 检测到词典变更，已热重载');
          if (hub) await hub.reinjectAll().catch(() => undefined);
        }
      }
    } catch { /* ignore */ }

    const port = readPort(portFiles);
    if (!port) {
      if (hub) {
        const alive = await ping(lastPort);
        if (!alive) {
          console.log('[antigravity-zh] Antigravity 已退出，断开连接');
          hub.stop(); hub = null; lastPort = 0;
        }
      }
      await sleep(4000);
      continue;
    }
    if (port !== lastPort || !hub) {
      if (hub) { hub.stop(); hub = null; }
      if (await ping(port)) {
        hub = new Hub(port);
        lastPort = port;
        try { await hub.start(); }
        catch (e) {
          console.error('[antigravity-zh] CDP 连接失败，稍后重试:', String(e).slice(0, 100));
          hub = null;
          await sleep(8000);
        }
      } else await sleep(4000);
    } else {
      const alive = await ping(lastPort);
      if (!alive) { hub.stop(); hub = null; lastPort = 0; }
    }
    await sleep(4000);
  }
}

main().catch((e) => { console.error('[antigravity-zh] 致命错误:', e); process.exit(1); });
