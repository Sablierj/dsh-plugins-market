#!/usr/bin/env node
/**
 * 「市场里那份索引，跟本仓库的代码对得上吗？」
 *
 *   node scripts/market/status.mjs                       # 跟公网索引比（默认）
 *   node scripts/market/status.mjs --offline             # 跟本地发布目录的 index.json 比
 *   node scripts/market/status.mjs --url <索引 URL>
 *
 * 回答三个问题：
 *   1. 本地代码有没有**没提交**的改动（有的话，索引只能指向旧代码）；
 *   2. 本地这次改动**升没升版本号**——DSH 判「有没有新版本」比的是**版本号**，
 *      只动代码不动版本号，别的机器永远看不到「有新版本」；
 *   3. 版本升了但**还没发布**（发布仓索引里还是旧版本）。
 *
 * 退出码：0 一致 / 1 有未发布或未升版本的改动 / 2 用法或读取错误。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const position = argv.indexOf(`--${name}`);
  if (position === -1) return fallback;
  const value = argv[position + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 需要一个值`);
  return value;
};

const repo = path.resolve(opt('root', process.cwd()));
const configPath = path.join(repo, 'market.config.json');
if (!fs.existsSync(configPath)) {
  console.error(`找不到 ${configPath}`);
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dist = path.resolve(repo, opt('dist', '.market-dist'));
const branch = config.source?.branch ?? 'main';
const url = opt(
  'url',
  `https://raw.githubusercontent.com/${String(config.source.base).replace(/^https:\/\/github\.com\//u, '')}/${branch}/index.json`,
);

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    throw error;
  }
}

/* ── 远端 / 本地发布索引 ─────────────────────────────────────── */
let published;
if (flag('offline')) {
  const file = path.join(dist, 'index.json');
  if (!fs.existsSync(file)) {
    console.error(`没有 ${file} —— 先跑一次 publish，或去掉 --offline 走公网索引`);
    process.exit(2);
  }
  published = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`对照：本地发布目录 ${file}\n`);
} else {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
    if (!response.ok) {
      console.error(`取不到索引（${response.status}）：${url}`);
      process.exit(2);
    }
    published = JSON.parse(await response.text());
    console.log(`对照：公网索引 ${url}\n`);
  } catch (error) {
    console.error(`取不到索引：${error.message}\n（本机的 git/fetch 代理设置也会影响这里）`);
    process.exit(2);
  }
}
const publishedByName = new Map((published.plugins ?? []).map((plugin) => [plugin.name, plugin]));

/* ── 本地状态 ───────────────────────────────────────────────── */
const rows = [];
let drift = false;
for (const plugin of config.plugins ?? []) {
  const dir = String(plugin.path).replace(/\/+$/u, '');
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, dir, 'package.json'), 'utf8'));
  const dirty = (git(['status', '--porcelain', '--', dir], true) ?? '') !== '';
  const commit = git(['log', '-1', '--format=%H', '--', dir], true) ?? '';
  const publishedPlugin = publishedByName.get(manifest.name);
  const publishedVersion = publishedPlugin?.versions?.[0]?.version;
  const publishedCommit = publishedPlugin?.versions?.[0]?.source?.commit;
  const publishedAt = Number(publishedPlugin?.versions?.[0]?.publishTimestamp ?? 0);
  // 代码仓的提交与发布仓的提交在两个不同的仓库里，sha 永远不同 —— 不能拿 sha 比。
  // 跨仓可比的只有时间：这个目录最后一次改动，vs 索引里那一版的发布时间。
  const localChangedAt = Number(git(['log', '-1', '--format=%ct', '--', dir], true) ?? 0);

  let verdict;
  if (publishedPlugin === undefined) {
    verdict = '🔴 从没发布过';
    drift = true;
  } else if (dirty) {
    verdict = '⚠️ 有未提交改动（索引只能指向已提交的代码）';
    drift = true;
  } else if (publishedVersion !== manifest.version) {
    verdict = `🔴 本地 ${manifest.version} 未发布（索引里是 ${publishedVersion}）`;
    drift = true;
  } else if (localChangedAt > publishedAt) {
    verdict = '⚠️ 代码比索引新（没升版本号就发不出去 —— DSH 比的是版本号）';
    drift = true;
  } else {
    verdict = '✅ 一致';
  }
  const when = (seconds) => (seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : '（无）');
  rows.push({
    插件: manifest.name,
    本地版本: manifest.version,
    索引版本: publishedVersion ?? '（无）',
    代码最后改动: when(localChangedAt),
    索引发布时间: when(publishedAt),
    索引提交: (publishedCommit ?? '').slice(0, 7) || '（无）',
    结论: verdict,
  });
}

const widths = {};
for (const row of rows) {
  for (const [key, value] of Object.entries(row)) widths[key] = Math.max((widths[key] ?? 0), String(value).length, key.length);
}
const line = (row) => Object.keys(widths).map((key) => String(row[key]).padEnd(widths[key] + 2)).join('');
console.log(line(Object.fromEntries(Object.keys(widths).map((key) => [key, key]))));
console.log(Object.values(widths).map((width) => '-'.repeat(width + 2)).join(''));
for (const row of rows) console.log(line(row));

console.log('');
if (!drift) {
  console.log('市场里那份索引与本仓库一致。');
} else {
  console.log('有需要处理的项：改完代码 → 升 package.json 的 version → commit → 跑 publish.mjs。');
  process.exitCode = 1;
}
