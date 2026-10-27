#!/usr/bin/env node
/**
 * 生成 DSH 插件市场索引 index.json（format 1）。
 *
 *   node scripts/market/build.mjs --state state.json --out index.json [--url <索引 URL>]
 *
 * 事实与展示分家：**每个插件的 name / version / commit / 时间戳来自 `--state`**
 * （由 publish.mjs 在发布仓里实测得到），标题/分类/关键词/图标来自 `market.config.json`。
 * 这样索引里的 commit 一定是「发布仓里真有这一版」的那个提交，不会指向别处。
 *
 * 为什么 source 不带 `path`：pnpm 只认 `#` 后的第一段，`#<sha>&path:/x` 会装成仓库根
 * （实测 pnpm 12.4.1）。所以每个插件在发布仓里独占一个分支、包就在该分支的根上，
 * 安装参数是干净的 `git+<url>.git#<sha>`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateIndex } from './lib-format.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const position = argv.indexOf(`--${name}`);
  if (position === -1) return fallback;
  const value = argv[position + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 需要一个值`);
  return value;
};

const configPath = path.resolve(opt('config', 'market.config.json'));
const statePath = opt('state', undefined);
const outPath = path.resolve(opt('out', 'index.json'));

if (!fs.existsSync(configPath)) {
  console.error(`配置不存在：${configPath}`);
  process.exit(2);
}
if (statePath === undefined) {
  console.error('缺少 --state：索引里每个版本的 name/version/commit 必须来自发布仓（publish.mjs 生成）。');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const base = String(config.source?.base ?? '').replace(/\/+$/u, '');
if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/u.test(base)) {
  console.error(`market.config.json 的 source.base 必须是 https 仓库 URL，当前是：${base || '(空)'}`);
  process.exit(2);
}
const branch = config.source?.branch ?? 'main';
const indexUrl = opt('url', `https://raw.githubusercontent.com/${base.replace('https://github.com/', '')}/${branch}/index.json`);

const byPath = new Map((state.plugins ?? []).map((entry) => [entry.path, entry]));
const problems = [];
const warnings = [];
const plugins = [];

for (const plugin of config.plugins ?? []) {
  const dir = String(plugin.path ?? '').replace(/\/+$/u, '');
  const fact = byPath.get(dir);
  if (fact === undefined) {
    problems.push(`${dir}: --state 里没有它 —— 先跑 publish.mjs 把它推到发布仓`);
    continue;
  }
  // 版本历史：优先用 state 里的 versions[]（每项 {version, commit, timestamp}），
  // 兼容旧格式（单个 version/commit/timestamp）。索引里每一版都带自己的 commit，
  // 所以旧版本只要 commit 可达（打 tag）就能装回去。
  const history = Array.isArray(fact.versions) && fact.versions.length > 0
    ? fact.versions.map((item) => ({ version: item.version, commit: item.commit, timestamp: item.timestamp }))
    : [{ version: fact.version, commit: fact.commit, timestamp: fact.timestamp }];

  if (typeof fact.name !== 'string' || fact.name === '') problems.push(`${dir}: state 里的 name 缺失`);
  const seenVersion = new Set();
  for (const item of history) {
    if (typeof item.version !== 'string' || item.version === '') problems.push(`${dir}: state 里有版本缺 version`);
    else if (seenVersion.has(item.version)) problems.push(`${dir}: 版本号重复 ${item.version}`);
    else seenVersion.add(item.version);
    if (!/^[0-9a-f]{40}$/u.test(item.commit ?? '')) problems.push(`${dir}: ${item.version} 的 commit 不是 40 位小写 sha`);
    if (!Number.isInteger(item.timestamp) || item.timestamp <= 0) problems.push(`${dir}: ${item.version} 的 timestamp 不是正整数秒`);
  }
  if (fact.branch !== undefined && plugin.branch !== undefined && fact.branch !== plugin.branch) {
    warnings.push(`${dir}: state 的分支 ${fact.branch} 与配置的 ${plugin.branch} 不一致`);
  }

  const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);
  const latest = sortedHistory[sortedHistory.length - 1];

  plugins.push({
    name: fact.name,
    title: plugin.title ?? { en: fact.name },
    description: plugin.description ?? { en: fact.description ?? fact.name },
    ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
    ...(plugin.author === undefined ? {} : { author: plugin.author }),
    repository: { url: base },
    metadata: {
      ...(plugin.category === undefined ? {} : { category: plugin.category }),
      keywords: plugin.keywords ?? [],
      labels: plugin.labels ?? [],
      sortKeys: { updated: latest.timestamp },
    },
    versions: sortedHistory.map((item) => ({
      version: item.version,
      publishTimestamp: item.timestamp,
      source: { type: 'git', url: base, commit: item.commit },
    })),
  });
}

const doc = {
  format: 1,
  title: config.title,
  ...(config.description === undefined ? {} : { description: config.description }),
  metadata: config.metadata ?? { categories: {}, labels: {}, sortKeys: {} },
  plugins,
};

const { errors, warnings: formatWarnings } = validateIndex(doc, indexUrl);
warnings.push(...formatWarnings);
problems.push(...errors);

for (const warning of warnings) console.warn(`警告  ${warning}`);
if (problems.length > 0) {
  console.error('不能生成索引：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
for (const plugin of plugins) {
  const last = plugin.versions[plugin.versions.length - 1];
  const extra = plugin.versions.length > 1 ? `  (共 ${plugin.versions.length} 个版本)` : '';
  console.log(`${plugin.name}@${last.version}  ${last.source.commit.slice(0, 7)}  ${new Date(last.publishTimestamp * 1000).toISOString().slice(0, 10)}${extra}`);
}
console.log(`\n已写出 ${outPath}`);
console.log(`索引 URL：${indexUrl}`);
if (!indexUrl.startsWith('https://') && !flag('allow-http')) {
  console.warn('注意：索引 URL 不是 https，DSH 允许 http，但另一台机器上请用 https。');
}
