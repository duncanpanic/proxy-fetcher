#!/usr/bin/env node
/**
 * 配置静态校验：config.yaml 与 deploy.yml 的结构约束（不联网）。
 * 运行：node test/config.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const YAML = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const cfg = YAML.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));

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

console.log('config.yaml');

test('envsubst 占位符只能有 ${SUB_URL} 和 ${MIHOMO_SECRET}', () => {
  assert.strictEqual(cfg.secret, '${MIHOMO_SECRET}', '密钥不能写 ${VAR:-默认值}，envsubst 不认');
  assert.strictEqual(cfg['proxy-providers']['free-nodes'].url, '${SUB_URL}');
  const dump = JSON.stringify(cfg);
  const found = dump.match(/\$\{[^}]+\}/g) || [];
  assert.deepStrictEqual([...new Set(found)].sort(), ['${MIHOMO_SECRET}', '${SUB_URL}']);
});

test('provider 健康检查是「非 204 即淘汰 + 未使用也体检」', () => {
  const hc = cfg['proxy-providers']['free-nodes']['health-check'];
  assert.strictEqual(hc.enable, true);
  assert.strictEqual(String(hc['expected-status']), '204');
  assert.strictEqual(hc.lazy, false, 'lazy 为 true 时节点没被用到就永不体检');
  assert.ok(hc.timeout <= 5000);
  assert.strictEqual(cfg['proxy-providers']['free-nodes'].path, './providers/free-nodes.yaml');
});

test('override 补齐了源里常见的错误字段', () => {
  const ov = cfg['proxy-providers']['free-nodes'].override;
  assert.strictEqual(ov.udp, true);
  assert.strictEqual(ov['skip-cert-verify'], true);
  assert.strictEqual(ov['client-fingerprint'], 'chrome');
});

test('所有代理组都挂 use: [free-nodes] 且类型合法', () => {
  const allowed = new Set(['select', 'url-test', 'fallback', 'load-balance', 'relay']);
  for (const g of cfg['proxy-groups']) {
    assert.ok(allowed.has(g.type), `${g.name} 类型非法: ${g.type}`);
    assert.deepStrictEqual(g.use, ['free-nodes'], `${g.name} 未使用 provider`);
  }
});

test('规则引用的规则集与代理组都存在，且以 MATCH 收尾', () => {
  const providers = Object.keys(cfg['rule-providers']);
  const groups = cfg['proxy-groups'].map((g) => g.name);
  const builtin = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

  for (const rule of cfg.rules) {
    const parts = rule.split(',');
    if (parts[0] === 'RULE-SET') {
      assert.ok(providers.includes(parts[1]), `未定义的规则集: ${parts[1]}`);
    }
    const target = parts[parts.length - 1];
    if (parts[0] === 'GEOIP') continue;
    assert.ok(groups.includes(target) || builtin.has(target), `规则目标不存在: ${target}`);
  }
  assert.ok(cfg.rules[cfg.rules.length - 1].startsWith('MATCH,'), '最后一条必须是 MATCH');
});

test('服务端全局参数：统一延迟、TCP 并发、不启用 IPv6', () => {
  assert.strictEqual(cfg['unified-delay'], true);
  assert.strictEqual(cfg['tcp-concurrent'], true);
  assert.strictEqual(cfg.ipv6, false);
  assert.strictEqual(cfg.profile['store-selected'], true);
});

console.log('deploy.yml');

const wf = YAML.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8'));

test('工作流会跑测试、跑 fetch.js 并部署 public/', () => {
  const runBlocks = wf.jobs.build.steps.map((s) => s.run || '').join('\n');
  assert.ok(/node test\/logic\.test\.js/.test(runBlocks), '缺少逻辑单测');
  assert.ok(/node test\/pipeline\.test\.js/.test(runBlocks), '缺少流水线测试');
  assert.ok(/node fetch\.js/.test(runBlocks), '缺少抓取步骤');
  assert.ok(/wrangler pages deploy public/.test(runBlocks), '缺少部署步骤');
  assert.ok(wf.jobs.build.steps.some((s) => s['continue-on-error'] === true), 'mihomo 步骤应允许失败降级');
});

test('定时任务与手动触发都在', () => {
  assert.ok(Array.isArray(wf.on.schedule), '缺少 schedule');
  assert.ok(wf.on.workflow_dispatch !== undefined, '缺少 workflow_dispatch');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
