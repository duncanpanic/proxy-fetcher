#!/usr/bin/env node
/**
 * proxy-fetcher —— 免费节点聚合 / 真实可用性筛选 / 产出 mihomo 配置
 *
 * 三个阶段：
 *   1. 抓取     sources.yaml 里每个订阅源 -> 原始节点
 *   2. 规范化   统一字段名、补 mihomo 真实键、去重、打区域标签
 *   3. 真测用   启动一个临时 mihomo 内核，用它的 url-test 组对每个节点做
 *               「经代理访问 generate_204 拿到 204」的真实连通性测试，
 *               只保留真正能上网的节点，按延迟排序后截断
 *
 * 没有 mihomo 时自动降级为 TCP/TLS 握手探测（宽松模式，会放过一些假活节点）。
 *
 * 产出两个文件：
 *   public/free-nodes.yaml            完整 mihomo 配置（给订阅客户端用，链接保持不变）
 *   public/providers/free-nodes.yaml  只有 proxies: （给服务端 proxy-provider 用）
 *
 * 可用环境变量见 README.md
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');
const YAML = require('js-yaml');

const ROOT = __dirname;
const SRC_FILE = path.join(ROOT, 'sources.yaml');
const OUT_DIR = path.join(ROOT, 'public');
const OUT_CLIENT = path.join(OUT_DIR, 'free-nodes.yaml');
const OUT_PROVIDER = path.join(OUT_DIR, 'providers', 'free-nodes.yaml');
const OUT_POOL = path.join(OUT_DIR, 'pool.yaml');

const UA =
  'Mozilla/5.0 (compatible; proxy-fetcher/2.0; +https://github.com/duncanpanic/proxy-fetcher)';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function envNum(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : dflt;
}

const CFG = {
  fetchTimeoutMs: envNum('FETCH_TIMEOUT', 15000),
  probeTimeoutMs: envNum('PROBE_TIMEOUT', 3000),
  probeConcurrency: envNum('PROBE_CONCURRENCY', 24),
  maxDelayMs: envNum('MAX_DELAY', 800),
  maxNodes: envNum('MAX_NODES', 100),
  probeDeadlineMs: envNum('PROBE_DEADLINE', 240000),
  probeUrl: process.env.PROBE_URL || 'https://www.gstatic.com/generate_204',
  probeExpected: process.env.PROBE_EXPECTED || '204',
  mihomoBin: process.env.MIHOMO_BIN || '',
  // 候选池：不经过探测的干净节点，供本机按自己的网络再筛一遍
  poolLimit: envNum('POOL_LIMIT', 800),
  allowPlaintext: process.env.ALLOW_PLAINTEXT === '1',
};

function log(msg) {
  console.log(`[fetch] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 并发受限的 map */
async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// HTTP 抓取
// ---------------------------------------------------------------------------
function fetchText(url, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));

    // 本地调试用：file:// 直接读盘
    if (String(url).startsWith('file://')) {
      try {
        return resolve(fs.readFileSync(url.slice('file://'.length), 'utf8'));
      } catch (e) {
        return reject(e);
      }
    }

    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`非法 URL: ${url}`));
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return reject(new Error(`不支持的协议: ${u.protocol}`));
    }

    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      u,
      {
        timeout: timeoutMs,
        headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, u).href, timeoutMs, depth + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 源与解析
// ---------------------------------------------------------------------------
function loadSources(file = process.env.SOURCES_FILE || SRC_FILE) {
  const doc = YAML.load(fs.readFileSync(file, 'utf8')) || {};
  const list = Array.isArray(doc.sources) ? doc.sources : [];
  return list
    .filter((s) => s && s.enabled !== false && typeof s.url === 'string' && s.url.trim())
    .map((s) => ({ name: String(s.name || s.url).trim(), url: s.url.trim() }));
}

function isProxyLike(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && !!x.type && !!x.server;
}

function decodeBase64(text) {
  const compact = String(text).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact) || compact.length < 16) return null;
  try {
    const buf = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const str = buf.toString('utf8');
    if (!str || /[\u0000-\u0008\u000e-\u001f]/.test(str)) return null; // 不是可打印文本
    return str;
  } catch {
    return null;
  }
}

/**
 * 一段订阅文本 -> 节点数组。
 * 支持：mihomo/clash 的 proxies: 列表、纯节点数组、base64 再套一层 yaml。
 */
function parseProxyPayload(text) {
  const src = String(text || '').trim();
  if (!src) return [];

  const tryYaml = (s) => {
    try {
      return YAML.load(s);
    } catch {
      return null;
    }
  };

  const pick = (doc) => {
    if (Array.isArray(doc)) return doc.filter(isProxyLike);
    if (doc && typeof doc === 'object' && Array.isArray(doc.proxies)) return doc.proxies.filter(isProxyLike);
    return [];
  };

  let nodes = pick(tryYaml(src));
  if (nodes.length) return nodes;

  const decoded = decodeBase64(src);
  if (decoded) {
    nodes = pick(tryYaml(decoded));
    if (nodes.length) return nodes;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------
const SUPPORTED_TYPES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'socks5',
  'http',
  'wireguard',
]);

// 只能走 UDP 的协议，没法用 TCP 握手判断存活
const UDP_ONLY_TYPES = new Set(['hysteria', 'hysteria2', 'tuic', 'wireguard']);

// 明文代理：免费源里的 http/socks5 绝大多数是失效的开放代理，默认不发布
const PLAINTEXT_TYPES = new Set(['socks5', 'http']);

// mihomo 里这些协议的 SNI 字段叫 sni；vmess/vless 才叫 servername
const SNI_FIELD_TYPES = new Set(['trojan', 'hysteria', 'hysteria2', 'tuic']);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * 清洗 SNI：只去掉明显不是域名的垃圾，不做关键词黑名单。
 * 免费源里 node / free / vpn 在合法域名里很常见，旧版按关键词删 SNI 会误杀。
 */
function normalizeSni(value) {
  let s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('@').pop();
  s = s.replace(/[/?#].*$/, '');
  if (s.startsWith('[')) return ''; // IPv6 字面量
  if (s.includes(':')) s = s.split(':')[0];
  if (!s || IPV4.test(s) || s.includes(':')) return '';
  return DOMAIN.test(s) ? s : '';
}

function hasTLS(node, type) {
  if (type === 'trojan' || type === 'hysteria2' || type === 'hysteria' || type === 'tuic') return true;
  if (type === 'vmess' || type === 'vless') {
    return (
      node.tls === true ||
      node.tls === 'tls' ||
      node.security === 'tls' ||
      node.security === 'reality' ||
      !!node['reality-opts']
    );
  }
  return false;
}

/**
 * 单个原始节点 -> 可用的 mihomo proxy 对象（字段保留原样，只做必要修补）。
 * 关键修补：
 *   - skipCertVerify -> skip-cert-verify（旧版写成 skipCertVerify，mihomo 一直忽略）
 *   - 补 udp / client-fingerprint / servername
 */
function sanitizeNode(node) {
  if (!isProxyLike(node)) return null;

  const type = String(node.type).trim().toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) return null;

  const server = String(node.server).trim();
  const port = parseInt(node.port, 10);
  if (!server || !Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const out = { ...node, type, server, port };

  // 明文代理默认不发布（可用 ALLOW_PLAINTEXT=1 放行）
  if (PLAINTEXT_TYPES.has(type) && !CFG.allowPlaintext) return null;

  // 免费节点证书普遍不规范，统一放宽（只对走 TLS 的协议有意义）
  delete out.skipCertVerify;
  delete out.sni;
  delete out.servername;

  const tlsOk = hasTLS(node, type);
  if (tlsOk) {
    out['skip-cert-verify'] = true;
    // SNI 字段名跟协议绑定：trojan/hysteria2/tuic 认 sni，vmess/vless 认 servername。
    // 旧版一律写 servername 并先 delete 掉 sni，等于把 hy2/trojan 的 SNI 弄丢了。
    const sn = normalizeSni(node.sni) || normalizeSni(node.servername) || normalizeSni(server);
    if (sn) {
      if (SNI_FIELD_TYPES.has(type)) out.sni = sn;
      else out.servername = sn;
    }

    // uTLS 指纹，降低被指纹识别拦掉的概率
    if (!out['client-fingerprint'] && (type === 'vmess' || type === 'vless' || type === 'trojan')) {
      out['client-fingerprint'] = 'chrome';
    }
  } else {
    delete out['skip-cert-verify'];
  }

  out.udp = true;

  if (type === 'vmess') {
    out.alterId = parseInt(node.alterId ?? node.aid ?? 0, 10) || 0;
    delete out.aid;
    if (!out.cipher) out.cipher = 'auto';
  }

  return out;
}

// ---------------------------------------------------------------------------
// 区域识别 / 去重 / 排序 / 命名
// ---------------------------------------------------------------------------
const REGIONS = [
  ['HK', '🇭🇰', ['香港', '港', 'hk', 'hongkong', 'hong kong']],
  ['TW', '🇹🇼', ['台湾', '台灣', 'tw', 'taiwan']],
  ['JP', '🇯🇵', ['日本', '日', 'jp', 'japan', '东京', '東京', '大阪']],
  ['SG', '🇸🇬', ['新加坡', '狮城', 'sg', 'singapore']],
  ['US', '🇺🇸', ['美国', '美國', 'us', 'usa', 'america', 'united states', '洛杉矶', '圣何塞', '西雅图']],
  ['KR', '🇰🇷', ['韩国', '韓國', 'kr', 'korea', '首尔']],
  ['GB', '🇬🇧', ['英国', '英國', 'uk', 'gb', 'britain', 'london']],
  ['DE', '🇩🇪', ['德国', '德國', 'de', 'germany']],
  ['FR', '🇫🇷', ['法国', '法國', 'fr', 'france']],
  ['CA', '🇨🇦', ['加拿大', 'ca', 'canada']],
  ['AU', '🇦🇺', ['澳大利亚', '澳洲', 'au', 'australia']],
  ['NL', '🇳🇱', ['荷兰', '荷蘭', 'nl', 'netherlands']],
  ['RU', '🇷🇺', ['俄罗斯', '俄羅斯', 'ru', 'russia']],
  ['IN', '🇮🇳', ['印度', 'in', 'india']],
  ['TR', '🇹🇷', ['土耳其', 'tr', 'turkey']],
  ['VN', '🇻🇳', ['越南', 'vn', 'vietnam']],
  ['TH', '🇹🇭', ['泰国', '泰國', 'th', 'thailand']],
  ['MY', '🇲🇾', ['马来西亚', '馬來西亞', 'my', 'malaysia']],
  ['PH', '🇵🇭', ['菲律宾', '菲律賓', 'ph', 'philippines']],
  ['ID', '🇮🇩', ['印尼', '印度尼西亚', 'id', 'indonesia']],
  ['BR', '🇧🇷', ['巴西', 'br', 'brazil']],
];

const FLAGS = Object.fromEntries(REGIONS.map(([code, flag]) => [code, flag]));

/** 从节点名里猜区域，猜不出返回 XX */
function regionTag(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return 'XX';
  for (const [code, , aliases] of REGIONS) {
    for (const alias of aliases) {
      if (/^[a-z]{2}$/.test(alias)) {
        // 两字母代码要求词边界，避免 russia 里的 us
        if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(s)) return code;
      } else if (s.includes(alias)) {
        return code;
      }
    }
  }
  return 'XX';
}

/** 去重键：协议 + 服务器 + 端口 + 凭据 */
function dedupeKey(proxy) {
  const cred =
    proxy.uuid ||
    proxy.password ||
    (proxy.username ? `${proxy.username}:${proxy.password || ''}` : '');
  return [proxy.type, String(proxy.server).toLowerCase(), proxy.port, String(cred)].join('|');
}

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

/** 按实测延迟过滤 + 排序 + 截断（旧版先 slice 再排序，等于按源顺序取前 N） */
function rank(probed, opts = {}) {
  const maxDelay = opts.maxDelayMs ?? CFG.maxDelayMs;
  const maxNodes = opts.maxNodes ?? CFG.maxNodes;
  const kept = probed.filter((p) => p.delay > 0 && (maxDelay <= 0 || p.delay <= maxDelay));
  kept.sort((a, b) => a.delay - b.delay);
  return maxNodes > 0 ? kept.slice(0, maxNodes) : kept;
}

/** 重命名为 区域-序号·延迟，并保证唯一 */
function nameNodes(list) {
  const counter = new Map();
  return list.map((item) => {
    const code = item.region || 'XX';
    const n = (counter.get(code) || 0) + 1;
    counter.set(code, n);
    const flag = FLAGS[code] || '';
    const delay = Number.isFinite(item.delay) ? `·${item.delay}ms` : '';
    return `${flag}${code}-${String(n).padStart(3, '0')}${delay}`;
  });
}

// ---------------------------------------------------------------------------
// mihomo 真实连通性探测
// ---------------------------------------------------------------------------
function which(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function resolveMihomoBin() {
  const explicit = CFG.mihomoBin.trim();
  if (explicit) {
    // 显式给路径时只认这个文件，避免用错内核
    if (/[\\/]/.test(explicit) || /\.exe$/i.test(explicit)) {
      return fs.existsSync(explicit) ? explicit : null;
    }
    return which(explicit) || explicit;
  }
  return which('mihomo') || which('mihomo.exe') || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function apiGet(port, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`响应不是 JSON: ${body.slice(0, 120)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('API 超时')));
    req.on('error', reject);
  });
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const until = Date.now() + 3000;
  while (Date.now() < until && proc.exitCode === null) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * 起一个临时 mihomo，用 url-test 组的延迟测试接口做真实「经代理访问 204」测试。
 * 返回 [{ proxy, delay }]，测不通的节点已被过滤。
 */
async function probeWithMihomo(entries, opts = {}) {
  const bin = opts.bin || resolveMihomoBin();
  if (!bin) throw new Error('未找到 mihomo 可执行文件');

  const probeUrl = opts.probeUrl || CFG.probeUrl;
  const expected = String(opts.expected || CFG.probeExpected);
  const timeoutMs = opts.timeoutMs || CFG.probeTimeoutMs;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-probe-'));
  const cfgPath = path.join(workDir, 'probe.yaml');
  const apiPort = await freePort();

  const proxies = entries.map((e, i) => ({ ...e.proxy, name: `p${i}` }));

  const config = {
    'log-level': 'silent',
    mode: 'rule',
    ipv6: false,
    'unified-delay': true,
    'find-process-mode': 'off',
    'external-controller': `127.0.0.1:${apiPort}`,
    secret: '',
    proxies,
    'proxy-groups': [
      {
        name: 'probe',
        type: 'url-test',
        url: probeUrl,
        interval: 3600,
        tolerance: 0,
        lazy: false,
        proxies: proxies.map((p) => p.name),
      },
    ],
    rules: ['MATCH,DIRECT'],
  };
  fs.writeFileSync(cfgPath, YAML.dump(config, { lineWidth: 4096, noRefs: true }), 'utf8');

  let stderrTail = '';
  const proc = spawn(bin, ['-d', workDir, '-f', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (buf) => {
    stderrTail = (stderrTail + buf.toString('utf8')).slice(-2000);
  });
  proc.once('error', () => {}); // 由下面的状态轮询统一报错

  try {
    const until = Date.now() + 20000;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`mihomo 启动即退出(code=${proc.exitCode}) ${stderrTail.slice(-300)}`);
      }
      try {
        await apiGet(apiPort, '/version', 1500);
        break;
      } catch (e) {
        if (Date.now() > until) throw new Error(`等待 mihomo API 超时: ${e.message} ${stderrTail.slice(-300)}`);
        await sleep(300);
      }
    }

    // 一次性测全部，并发由 mihomo 内部调度
    const qs = new URLSearchParams({ url: probeUrl, timeout: String(timeoutMs), expected });
    const result = await apiGet(apiPort, `/group/probe/delay?${qs}`, Math.max(30000, timeoutMs * 4));

    const out = [];
    entries.forEach((e, i) => {
      const delay = Number(result[`p${i}`]);
      if (Number.isFinite(delay) && delay > 0) out.push({ ...e, delay });
    });
    return out;
  } finally {
    await stopProcess(proc);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 降级探测：TCP / TLS 握手
// ---------------------------------------------------------------------------
function testTCP(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function testTLS(host, port, timeoutMs, servername) {
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host, port, servername: servername || host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        sock.destroy();
        resolve(true);
      }
    );
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function probeBySocket(entries, opts = {}) {
  const timeoutMs = opts.timeoutMs || CFG.probeTimeoutMs;
  const concurrency = opts.concurrency || CFG.probeConcurrency;
  const deadline = Date.now() + (opts.deadlineMs || CFG.probeDeadlineMs);

  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= entries.length || Date.now() > deadline) return;
      const entry = entries[idx];
      const { proxy } = entry;
      if (UDP_ONLY_TYPES.has(proxy.type)) continue; // IP 层握手测不了，只能靠真机
      const started = Date.now();
      let ok;
      if (proxy['skip-cert-verify'] && String(proxy.tls) !== 'false') {
        ok = await testTLS(proxy.server, proxy.port, timeoutMs, proxy.servername || proxy.server);
      } else {
        ok = await testTCP(proxy.server, proxy.port, timeoutMs);
      }
      if (ok) results.push({ ...entry, delay: Date.now() - started });
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 产出
// ---------------------------------------------------------------------------
function buildClientDoc(proxies) {
  const names = proxies.map((p) => p.name);
  return {
    'mixed-port': 7890,
    'allow-lan': true,
    'bind-address': '*',
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': 'off',
    profile: { 'store-selected': true, 'store-fake-ip': true },
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        '+.msftconnecttest.com',
        '+.msftncsi.com',
        'time.*.com',
        '+.pool.ntp.org',
        'stun.*.*',
      ],
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      fallback: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
      'fallback-filter': { geoip: true, 'geoip-code': 'CN' },
    },
    proxies,
    'proxy-groups': [
      { name: '节点选择', type: 'select', proxies: ['自动选择', ...names] },
      {
        name: '自动选择',
        type: 'url-test',
        url: CFG.probeUrl,
        interval: 600,
        timeout: CFG.probeTimeoutMs,
        tolerance: 80,
        lazy: false,
        'expected-status': CFG.probeExpected,
        proxies: names,
      },
    ],
    rules: ['GEOIP,CN,DIRECT,no-resolve', 'MATCH,节点选择'],
  };
}

function buildProviderDoc(proxies) {
  return { proxies };
}

function writeYaml(file, doc, header) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = YAML.dump(doc, { lineWidth: 4096, noRefs: true, quotingType: '"' });
  fs.writeFileSync(file, `${header}\n${body}`, 'utf8');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function probeAll(entries, opts = {}) {
  const bin = opts.bin !== undefined ? opts.bin : resolveMihomoBin();
  if (bin) {
    try {
      log(`探测方式: mihomo 真实连通性测试 (${bin})`);
      return await probeWithMihomo(entries, { ...opts, bin });
    } catch (e) {
      log(`mihomo 探测失败，降级为 TCP/TLS 握手探测: ${e.message}`);
    }
  } else {
    log('未找到 mihomo 可执行文件，降级为 TCP/TLS 握手探测（宽松，可能放过假活节点）');
  }
  return probeBySocket(entries, opts);
}

async function crawlSources(sources) {
  const raw = [];
  const perSource = await pmap(sources, 4, async (src) => {
    try {
      const text = await fetchText(src.url, CFG.fetchTimeoutMs);
      return { src, nodes: parseProxyPayload(text) };
    } catch (e) {
      log(`拉取失败 ${src.name}: ${e.message}`);
      return { src, nodes: [] };
    }
  });
  for (const { src, nodes } of perSource) {
    log(`  ${src.name}: ${nodes.length} 个`);
    for (const node of nodes) raw.push({ source: src.name, node });
  }
  return raw;
}

/**
 * 完整流水线。opts 用于测试注入：
 *   sourcesFile / outClient / outProvider / probe(entries) -> [{proxy, region, delay}]
 */
async function runPipeline(opts = {}) {
  const started = Date.now();
  const sourcesFile = opts.sourcesFile || process.env.SOURCES_FILE || SRC_FILE;
  const outClient = opts.outClient || OUT_CLIENT;
  const outProvider = opts.outProvider || OUT_PROVIDER;
  const probe = opts.probe || ((entries) => probeAll(entries, opts.probeOptions || {}));

  const sources = loadSources(sourcesFile);
  if (!sources.length) throw new Error(`没有启用的源: ${sourcesFile}`);
  log(`源数量: ${sources.length}`);

  const raw = await crawlSources(sources);
  log(`原始节点: ${raw.length}`);

  const entries = [];
  for (const { source, node } of raw) {
    const proxy = sanitizeNode(node);
    if (!proxy) continue;
    entries.push({
      proxy,
      source,
      region: regionTag(node.name || proxy.name || ''),
      key: dedupeKey(proxy),
    });
  }
  const uniq = dedupe(entries);
  log(`规范化后: ${entries.length}，去重后: ${uniq.length}`);

  // 候选池：清洗去重后、未经探测的全量节点。
  // 探测结果只反映执行机器的网络位置（CI runner 在境外，与你本机视角差异极大），
  // 所以额外发布一份候选池，供本机用 select-local.js 按自己的网络重新筛选。
  const poolSlice = uniq.slice(0, CFG.poolLimit);
  const poolNames = nameNodes(poolSlice.map((item) => ({ region: item.region, delay: NaN })));
  const poolProxies = poolSlice.map((item, i) => ({ ...item.proxy, name: poolNames[i] }));
  writeYaml(
    opts.outPool || OUT_POOL,
    buildProviderDoc(poolProxies),
    `# candidate pool · ${poolProxies.length} nodes · unprobed\n# 本机执行 node select-local.js 可基于自己的网络重新筛选`
  );
  log(`候选池: ${poolProxies.length} 个（未探测）`);

  const probed = await probe(uniq);
  log(`通过真实探测: ${probed.length}`);

  const kept = rank(probed);
  const names = nameNodes(kept);
  const proxies = kept.map((item, i) => ({ ...item.proxy, name: names[i] }));

  if (!proxies.length) throw new Error('没有任何节点通过探测，保留上一版产物');

  const header = `# generated by proxy-fetcher at ${new Date().toISOString()}\n# nodes: ${proxies.length} · probe: ${CFG.probeUrl} (expect ${CFG.probeExpected})`;

  writeYaml(outClient, buildClientDoc(proxies), header);
  writeYaml(outProvider, buildProviderDoc(proxies), header);

  const dist = {};
  for (const item of kept) dist[item.region] = (dist[item.region] || 0) + 1;
  log(
    `区域分布: ${Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')}`
  );
  log(
    `延迟: 最快 ${kept[0] ? kept[0].delay + 'ms' : '-'} / 最慢 ${
      kept.length ? kept[kept.length - 1].delay + 'ms' : '-'
    }`
  );
  log(
    `产出: ${path.relative(ROOT, outClient)} / ${path.relative(ROOT, outProvider)}，耗时 ${(
      (Date.now() - started) /
      1000
    ).toFixed(1)}s`
  );

  return { proxies, kept, dist, sourceCount: sources.length, rawCount: raw.length };
}

async function main() {
  try {
    await runPipeline();
  } catch (err) {
    console.error(`[fetch] 失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  CFG,
  SRC_FILE,
  OUT_CLIENT,
  OUT_PROVIDER,
  OUT_POOL,
  fetchText,
  loadSources,
  parseProxyPayload,
  sanitizeNode,
  normalizeSni,
  regionTag,
  dedupeKey,
  dedupe,
  rank,
  nameNodes,
  buildClientDoc,
  buildProviderDoc,
  probeWithMihomo,
  probeBySocket,
  probeAll,
  crawlSources,
  runPipeline,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[fetch] 失败: ${err.message}`);
    process.exit(1);
  });
}
