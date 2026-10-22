#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const { URL } = require('url');
const YAML = require('js-yaml');

const ROOT = path.resolve(__dirname);
const SRC_YAML = YAML.load(fs.readFileSync(path.join(ROOT, 'sources.yaml'), 'utf8'));
const OUT_PATH = path.join(ROOT, 'public', 'free-nodes.yaml');

const TIMEOUT_MS = 3000; 
const CONCURRENCY = 30;  
const MAX_NODES = 100;   

function ensureDir(fp) { fs.mkdirSync(path.dirname(fp), { recursive: true }); }

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function pmap(arr, fn, concurrency) {
  const results = [];
  const executing = new Set();
  for (const item of arr) {
    const p = fn(item).then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// 1. DNS 污染/异常解析过滤
async function checkDNS(server) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(server)) return true; // 纯 IP 直接放行
  try {
    const addresses = await dns.lookup(server, { all: true });
    if (!addresses || addresses.length === 0) return false;
    const badIPs = ['127.0.0.1', '0.0.0.0', '255.255.255.255'];
    for (const addr of addresses) {
      if (badIPs.includes(addr.address) || addr.address.startsWith('192.168.') || addr.address.startsWith('10.') || addr.address.startsWith('172.16.')) {
        return false; // 解析到内网/保留 IP，判定为污染
      }
    }
    return true;
  } catch (e) {
    return false; // 解析失败直接杀
  }
}

// 2. TCP 连通性测试
function testTCP(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.connect(port, host, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// 3. TLS 真实握手测试
function testTLS(host, port, sni, timeoutMs) {
  return new Promise((resolve) => {
    const options = {
      host: host,
      port: port,
      rejectUnauthorized: false,
      timeout: timeoutMs
    };
    if (sni && sni.length > 0) options.servername = sni;

    const socket = tls.connect(options, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// 4. SNI 清洗逻辑
function cleanSNI(sni) {
  if (!sni || typeof sni !== 'string') return '';
  let name = sni.trim();
  name = name.replace(/^(https?:\/\/)?(www\.)?/, '');
  name = name.split(/[/?#:]/)[0];
  try { name = decodeURIComponent(name); } catch(e) {}
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return '';
  const garbage = ['proxy', 'vpn', 'free', 'node', 'server', 'telegram', '更新', '官网'];
  for (const g of garbage) {
    if (name.toLowerCase().includes(g)) return '';
  }
  if (!name.includes('.')) return '';
  return name.trim();
}

async function main() {
  console.log('开始抓取节点...');
  ensureDir(OUT_PATH);
  
  const allNodes = [];
  const sourceConfigs = SRC_YAML.sources.filter(s => s.enabled !== false);
  
  for (const source of sourceConfigs) {
    try {
      console.log(`  - 获取: ${source.name}`);
      const data = await fetchText(source.url);
      const parsed = YAML.load(data);
      if (parsed.proxies) {
        allNodes.push(...parsed.proxies);
      }
    } catch (e) {
      console.error(`  ✗ 失败: ${e.message}`);
    }
  }
  
  console.log(`总共抓取到节点: ${allNodes.length}`);
  
  console.log('开始清洗杂乱的 SNI...');
  let cleanedNodes = allNodes.map(n => {
    if (n.servername) n.servername = cleanSNI(n.servername);
    if (n.sni) n.sni = cleanSNI(n.sni);
    return n;
  });
  
  console.log('开始进行 DNS、TCP、TLS 综合连通性测试...');
  const results = await pmap(cleanedNodes, async (node) => {
    if (!node.server || !node.port) return { node, alive: false };
    
    // DNS 检查
    const dnsOk = await checkDNS(node.server);
    if (!dnsOk) return { node, alive: false };

    // 协议判断
    const isTLS = 
      node.type === 'trojan' || 
      (node.type === 'vmess' && node.tls === true) || 
      (node.type === 'vless' && (node.tls === true || node.security === 'tls')) ||
      (node.type === 'hysteria2') ||
      (node.type === 'tuic');

    let alive = false;
    if (isTLS) {
      const sni = node.sni || node.servername || node.server;
      alive = await testTLS(node.server, node.port, sni, TIMEOUT_MS);
    } else {
      alive = await testTCP(node.server, node.port, TIMEOUT_MS);
    }
    
    return { node, alive };
  }, CONCURRENCY);
  
  let aliveNodes = results.filter(r => r.alive).map(r => r.node);
  console.log(`存活节点数量: ${aliveNodes.length}`);
  
  // 字段清洗，防报错
  aliveNodes = aliveNodes.map((n, i) => {
    const country = n.name || n.tag || n.region || 'UNK';
    const base = {
      name: `🚀 ${country.slice(0, 10)}-${String(i+1).padStart(3, '0')}`,
      type: n.type,
      server: n.server,
      port: n.port,
    };
    if (n.type === 'vmess') {
      base.uuid = n.uuid;
      base.alterId = n.alterId || 0;
      base.cipher = n.cipher || 'auto';
      base.network = n.network || 'tcp';
      if (n.servername) base.servername = n.servername;
      if (n.tls) base.tls = true;
      if (n['ws-opts']) base['ws-opts'] = n['ws-opts'];
    } else if (n.type === 'vless') {
      base.uuid = n.uuid;
      base.network = n.network || 'tcp';
      if (n.servername) base.servername = n.servername;
      if (n.flow) base.flow = n.flow;
      if (n.tls) base.tls = true;
      if (n.security) base.security = n.security;
      if (n['ws-opts']) base['ws-opts'] = n['ws-opts'];
    } else if (n.type === 'trojan') {
      base.password = n.password;
      base.sni = n.sni || n.servername || '';
      base.skipCertVerify = true;
      if (n['ws-opts']) base['ws-opts'] = n['ws-opts'];
    } else if (n.type === 'ss' || n.type === 'shadowsocks') {
      base.cipher = n.cipher;
      base.password = n.password;
      if (n.plugin) base.plugin = n.plugin;
      if (n['plugin-opts']) base['plugin-opts'] = n['plugin-opts'];
    } else {
      return n;
    }
    return base;
  });
  
  aliveNodes = aliveNodes.slice(0, MAX_NODES);
  
  const output = {
    'mixed-port': 7890,
    'allow-lan': true,
    'mode': 'rule',
    'log-level': 'info',
    'proxies': aliveNodes,
    'proxy-groups': [
      { name: "节点选择", type: "select", proxies: ["自动选择", ...aliveNodes.map(n => n.name)] },
      { name: "自动选择", type: "url-test", url: "http://www.gstatic.com/generate_204", interval: 300, proxies: aliveNodes.map(n => n.name) }
    ],
    'rules': [
      'GEOIP,CN,DIRECT',
      'MATCH,节点选择'
    ]
  };

  fs.writeFileSync(OUT_PATH, YAML.dump(output));
  console.log(`✅ 输出成功: ${OUT_PATH} (包含 ${aliveNodes.length} 个极速节点)`);
}

main().catch(e => { console.error(e); process.exit(1); });