#!/usr/bin/env node
/**
 * fetch.js 纯逻辑单测：不联网、不起内核，只验证「规范化 / 去重 / 排序 / 产出」。
 * 运行：node test/logic.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const YAML = require('js-yaml');

const fetchLib = require(path.join(__dirname, '..', 'fetch.js'));

let failed = 0;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function parseYaml(text) {
  return YAML.load(text);
}

console.log('sanitizeNode');

test('vmess: skipCertVerify 被换成 mihomo 认的 skip-cert-verify，并补 udp/alterId', () => {
  const out = fetchLib.sanitizeNode({
    name: 'US-1',
    type: 'VMESS',
    server: '1.2.3.4',
    port: '443',
    uuid: 'u-1',
    aid: '0',
    tls: true,
    network: 'ws',
    'ws-opts': { path: '/ray' },
    skipCertVerify: true,
  });
  assert.strictEqual(out.type, 'vmess');
  assert.strictEqual(out.port, 443);
  assert.strictEqual(out.skipCertVerify, undefined);
  assert.strictEqual(out['skip-cert-verify'], true);
  assert.strictEqual(out.udp, true);
  assert.strictEqual(out.alterId, 0);
  assert.strictEqual(out.aid, undefined);
  assert.strictEqual(out.cipher, 'auto');
  assert.strictEqual(out['ws-opts'].path, '/ray');
  assert.strictEqual(out.servername, undefined, 'IP 服务器不应凭空造 SNI');
});

test('vless + reality: reality-opts 保留，补 client-fingerprint 与 servername', () => {
  const out = fetchLib.sanitizeNode({
    name: 'JP-reality',
    type: 'vless',
    server: 'jp.example.com',
    port: 443,
    uuid: 'u-2',
    network: 'tcp',
    tls: true,
    servername: 'jp.example.com',
    'reality-opts': { 'public-key': 'pk', 'short-id': 'ab' },
    'client-fingerprint': 'safari',
  });
  assert.deepStrictEqual(out['reality-opts'], { 'public-key': 'pk', 'short-id': 'ab' });
  assert.strictEqual(out['client-fingerprint'], 'safari', '已有指纹不应被覆盖');
  assert.strictEqual(out.servername, 'jp.example.com');
  assert.strictEqual(out['skip-cert-verify'], true);
});

test('ss 这类无 TLS 的协议不应带 skip-cert-verify / servername', () => {
  const out = fetchLib.sanitizeNode({
    name: 'SG-ss',
    type: 'ss',
    server: 'sg.example.com',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'p',
    servername: 'leftover.example.com',
  });
  assert.strictEqual(out['skip-cert-verify'], undefined);
  assert.strictEqual(out.servername, undefined);
  assert.strictEqual(out.udp, true);
});

test('垃圾节点被丢弃：未知协议 / 缺服务器 / 端口越界', () => {
  assert.strictEqual(fetchLib.sanitizeNode({ type: 'magic', server: 'a.com', port: 1 }), null);
  assert.strictEqual(fetchLib.sanitizeNode({ type: 'ss', server: '', port: 1 }), null);
  assert.strictEqual(fetchLib.sanitizeNode({ type: 'ss', server: 'a.com', port: 70000 }), null);
  assert.strictEqual(fetchLib.sanitizeNode(null), null);
});

console.log('normalizeSni');

test('SNI 只挡明显非域名，不因关键词误杀', () => {
  assert.strictEqual(fetchLib.normalizeSni('https://Node-Free.example.com/path'), 'node-free.example.com');
  assert.strictEqual(fetchLib.normalizeSni('proxy.example.com:443'), 'proxy.example.com');
  assert.strictEqual(fetchLib.normalizeSni('1.2.3.4'), '');
  assert.strictEqual(fetchLib.normalizeSni('[2001:db8::1]'), '');
  assert.strictEqual(fetchLib.normalizeSni('随便写的'), '');
  assert.strictEqual(fetchLib.normalizeSni(''), '');
});

console.log('regionTag / nameNodes');

test('区域识别：中英文与词边界', () => {
  assert.strictEqual(fetchLib.regionTag('🇺🇸 US-FreeNode-1'), 'US');
  assert.strictEqual(fetchLib.regionTag('日本 东京 01'), 'JP');
  assert.strictEqual(fetchLib.regionTag('hk-premium'), 'HK');
  assert.strictEqual(fetchLib.regionTag('russia-moscow'), 'RU');
  assert.strictEqual(fetchLib.regionTag('random-node'), 'XX');
});

test('节点命名唯一、带区域码、能匹配 config.yaml 的 filter', () => {
  const list = [
    { region: 'US', delay: 120 },
    { region: 'US', delay: 200 },
    { region: 'JP', delay: 90 },
    { region: 'XX', delay: 300 },
  ];
  const names = fetchLib.nameNodes(list);
  assert.strictEqual(new Set(names).size, names.length);
  assert.strictEqual(names[0], '🇺🇸US-001·120ms');
  assert.strictEqual(names[1], '🇺🇸US-002·200ms');
  assert.ok(/JP-001/.test(names[2]));
  const filter = new RegExp('(US|JP|SG|HK|TW|KR)', 'i'); // 对应 config.yaml 里的 (?i)(...)
  assert.ok(filter.test(names[0]) && filter.test(names[2]));
  assert.ok(!filter.test(names[3]));
});

console.log('dedupe / rank');

test('同一服务器同凭据的重复节点被去掉', () => {
  const mk = (server, uuid) => {
    const proxy = fetchLib.sanitizeNode({ type: 'vmess', server, port: 443, uuid, tls: true });
    return { proxy, region: 'US', key: fetchLib.dedupeKey(proxy) };
  };
  const uniq = fetchLib.dedupe([mk('a.com', 'x'), mk('a.com', 'x'), mk('a.com', 'y'), mk('b.com', 'x')]);
  assert.strictEqual(uniq.length, 3);
});

test('rank：过滤超时与死亡节点，按延迟升序，再截断', () => {
  const probed = [
    { region: 'US', delay: 300 },
    { region: 'JP', delay: 100 },
    { region: 'SG', delay: 0 },
    { region: 'HK', delay: 5000 },
    { region: 'TW', delay: 150 },
  ];
  const kept = fetchLib.rank(probed, { maxDelayMs: 800, maxNodes: 2 });
  assert.deepStrictEqual(
    kept.map((k) => k.delay),
    [100, 150]
  );
  const all = fetchLib.rank(probed, { maxDelayMs: 800, maxNodes: 0 });
  assert.deepStrictEqual(
    all.map((k) => k.delay),
    [100, 150, 300]
  );
});

console.log('parseProxyPayload');

test('解析 clash 风格 proxies 列表与纯数组', () => {
  const doc = fetchLib.parseProxyPayload(`
proxies:
  - {name: a, type: ss, server: a.com, port: 1, cipher: aes-128-gcm, password: p}
  - {name: b, type: trojan, server: b.com, port: 443, password: p}
`);
  assert.strictEqual(doc.length, 2);
  assert.strictEqual(fetchLib.parseProxyPayload('[{"type":"ss","server":"c.com","port":2}]').length, 1);
  assert.strictEqual(fetchLib.parseProxyPayload('not a subscription at all').length, 0);
});

test('base64 包裹的订阅也能解出来', () => {
  const inner = '- {name: a, type: ss, server: a.com, port: 1, cipher: aes-128-gcm, password: p}';
  const encoded = Buffer.from(inner, 'utf8').toString('base64');
  assert.strictEqual(fetchLib.parseProxyPayload(encoded).length, 1);
});

console.log('产出契约');

console.log('buildProviderDoc / buildClientDoc');

const sampleProxies = [
  fetchLib.sanitizeNode({ name: 'x', type: 'vmess', server: 'us.example.com', port: 443, uuid: 'u', tls: true }),
  fetchLib.sanitizeNode({ name: 'y', type: 'trojan', server: 'jp.example.com', port: 443, password: 'p' }),
].map((p, i) => ({ ...p, name: ['🇺🇸US-001·120ms', '🇯🇵JP-001·90ms'][i] }));

test('provider 产物只能有 proxies 一个顶级键（proxy-provider 严格要求）', () => {
  const doc = fetchLib.buildProviderDoc(sampleProxies);
  assert.deepStrictEqual(Object.keys(doc), ['proxies']);
  const roundTrip = parseYaml(YAML.dump(doc, { lineWidth: 4096, noRefs: true }));
  assert.strictEqual(roundTrip.proxies.length, 2);
  assert.strictEqual(roundTrip.proxies[0]['skip-cert-verify'], true);
  assert.strictEqual(roundTrip.proxies[0].name, '🇺🇸US-001·120ms');
});

test('客户端产物：组引用全部存在、规则指向有效组、非 204 期望状态已写入', () => {
  const doc = fetchLib.buildClientDoc(sampleProxies);
  const text = YAML.dump(doc, { lineWidth: 4096, noRefs: true });
  const back = parseYaml(text);

  const names = back.proxies.map((p) => p.name);
  const groupNames = back['proxy-groups'].map((g) => g.name);

  const select = back['proxy-groups'].find((g) => g.name === '节点选择');
  assert.ok(select, '缺少 节点选择 组');
  for (const ref of select.proxies) {
    assert.ok(ref === '自动选择' || names.includes(ref), `引用了不存在的节点: ${ref}`);
  }
  const auto = back['proxy-groups'].find((g) => g.name === '自动选择');
  assert.strictEqual(auto.type, 'url-test');
  assert.strictEqual(auto.lazy, false);
  assert.strictEqual(String(auto['expected-status']), '204');
  assert.deepStrictEqual(auto.proxies, names);

  for (const rule of back.rules) {
    if (rule === 'MATCH,节点选择') continue;
    assert.ok(rule.startsWith('GEOIP,CN,DIRECT'), `意外的规则: ${rule}`);
  }
  assert.strictEqual(back['unified-delay'], true);
  assert.strictEqual(back['tcp-concurrent'], true);
});

test('空节点列表时不应崩，输出空 proxies', () => {
  const doc = fetchLib.buildProviderDoc([]);
  assert.deepStrictEqual(doc, { proxies: [] });
});

console.log('\nSNI 字段名必须跟协议匹配（trojan/hy2/tuic 用 sni，vmess/vless 用 servername）');

test('trojan: SNI 写进 sni 而不是 servername', () => {
  const out = fetchLib.sanitizeNode({
    name: 'HK-1',
    type: 'trojan',
    server: '1.2.3.4',
    port: 443,
    password: 'p',
    sni: 'hk.example.com',
  });
  assert.strictEqual(out.sni, 'hk.example.com', 'trojan 的 SNI 必须落在 sni 字段');
  assert.strictEqual(out.servername, undefined, 'trojan 写 servername 会被内核忽略');
});

test('hysteria2: 源里的 sni 不能被丢掉', () => {
  const out = fetchLib.sanitizeNode({
    name: 'JP-1',
    type: 'hysteria2',
    server: '5.6.7.8',
    port: 443,
    password: 'p',
    sni: 'jp.example.com',
    obfs: 'salamander',
    'obfs-password': 'x',
  });
  assert.strictEqual(out.sni, 'jp.example.com');
  assert.strictEqual(out.obfs, 'salamander', 'hy2 的 obfs 必须原样保留');
  assert.strictEqual(out['obfs-password'], 'x');
});

test('tuic: SNI 写进 sni', () => {
  const out = fetchLib.sanitizeNode({
    name: 'SG-1',
    type: 'tuic',
    server: 'sg.example.com',
    port: 443,
    uuid: 'u',
    password: 'p',
  });
  assert.strictEqual(out.sni, 'sg.example.com', 'server 是域名时应自动补 SNI');
});

test('vmess: SNI 仍然写 servername（两套字段不能混）', () => {
  const out = fetchLib.sanitizeNode({
    name: 'US-1',
    type: 'vmess',
    server: 'us.example.com',
    port: 443,
    uuid: 'u',
    tls: true,
  });
  assert.strictEqual(out.servername, 'us.example.com');
  assert.strictEqual(out.sni, undefined);
});

test('明文代理（socks5/http）默认不发布', () => {
  const socks = fetchLib.sanitizeNode({
    name: 'SS-1',
    type: 'socks5',
    server: '9.9.9.9',
    port: 1080,
    username: 'a',
    password: 'b',
  });
  const plain = fetchLib.sanitizeNode({ name: 'HTTP-1', type: 'http', server: '9.9.9.9', port: 8080 });
  assert.strictEqual(socks, null);
  assert.strictEqual(plain, null);
});

test('ALLOW_PLAINTEXT=1 时才放行明文代理', () => {
  const { CFG } = fetchLib;
  const backup = CFG.allowPlaintext;
  CFG.allowPlaintext = true;
  const out = fetchLib.sanitizeNode({ name: 'SS-1', type: 'socks5', server: '9.9.9.9', port: 1080 });
  CFG.allowPlaintext = backup;
  assert.ok(out, '打开开关后应保留');
  assert.strictEqual(out.type, 'socks5');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
