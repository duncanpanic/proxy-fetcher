#!/usr/bin/env node
/**
 * proxy-fetcher v2
 * 免费节点自动拉取 + SNI清洗 + 多目标测速 + 服务分类 → mihomo yaml
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const { URL } = require('url');
const YAML = require('js-yaml');

const ROOT = path.resolve(__dirname);
const SRC_YAML = YAML.load(fs.readFileSync(path.join(ROOT, 'sources.yaml'), 'utf8'));
const CFG_YAML = YAML.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
const FILTER = CFG_YAML.filter;
const SPEED_TESTS = CFG_YAML.speed_tests;
const OUTPUT = CFG_YAML.output;
const OUT_PATH = path.join(ROOT, OUTPUT.path);
const RULES_PATH = path.join(ROOT, OUTPUT.rules_path || 'out/rules.yaml');

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

function cleanSNI(name) {
  if (!name) return '';
  name = name.replace(/^(https?:\/\/)?(www\.)?/, '');
  name = name.split(/[/?#]/)[0];
  name = name.split(':')[0];
  try { name = decodeURIComponent(name); } catch(e) {}
  name = name.replace(/\\u[0-9a-fA-F]{4}/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return '';
  const garbage = ['proxy', 'vpn', 'free', 'node', 'server'];
  for (const g of garbage) {
    if (name.toLowerCase().includes(g)) return '';
  }
  return name.trim();
}

function testTCP(host, port, timeoutMs = 4000) {
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

async function main() {
  console.log('proxy-fetcher v2 starting...');
  ensureDir(OUT_PATH);
  
  const allNodes = [];
  const sourceConfigs = SRC_YAML.sources.filter(s => s.enabled !== false);
  
  console.log(`Fetching from ${sourceConfigs.length} sources...`);
  
  for (const source of sourceConfigs) {
    try {
      console.log(`  - ${source.name}: ${source.url}`);
      const data = await fetchText(source.url);
      const parsed = YAML.load(data);
      if (parsed.proxies) {
        allNodes.push(...parsed.proxies);
      }
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
    }
  }
  
  console.log(`Total nodes fetched: ${allNodes.length}`);
  
  const allowed = new Set(FILTER.allowed_protocols || ['vmess', 'vless', 'trojan', 'shadowsocks', 'hysteria2', 'tuic']);
  let filtered = allNodes.filter(n => allowed.has(n.type?.toLowerCase()));
  console.log(`After protocol filter: ${filtered.length}`);
  
  if (FILTER.tcp_test) {
    console.log('Running TCP connectivity test...');
    const results = await pmap(filtered, async (node) => {
      let host = node.server;
      let port = node.port;
      const alive = await testTCP(host, port, FILTER.timeout_ms || 4000);
      return { node, alive };
    }, FILTER.concurrency || 16);
    
    filtered = results.filter(r => r.alive).map(r => r.node);
    console.log(`After TCP test: ${filtered.length} alive`);
  }
  
  if (FILTER.sni_mode === 'strict') {
    console.log('Cleaning SNI names...');
    filtered = filtered.map(n => {
      if (n.servername) {
        n.servername = cleanSNI(n.servername);
      }
      return n;
    }).filter(n => !n.servername || n.servername.length > 0);
  }
  
  filtered = filtered.map((n, i) => {
    const country = n.tag || n.region || 'UNK';
    const proto = n.type?.toLowerCase()?.slice(0, 4) || 'xx';
    n.name = `${country}-${proto}-${String(i+1).padStart(3, '0')}\`;
    return n;
  });
  
  const output = { ...CFG_YAML, proxies: filtered.slice(0, OUTPUT.max_nodes || 100) };
  fs.writeFileSync(OUT_PATH, YAML.dump(output));
  console.log(`Output: ${OUT_PATH}\`);
  console.log(`Total output nodes: ${output.proxies.length}\`);
}

main().catch(e => { console.error(e); process.exit(1); });
