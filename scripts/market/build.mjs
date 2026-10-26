#!/usr/bin/env node
/**
 * 生成 DSH 插件市场索引 index.json（format 1）。
 *
 *   node scripts/market/build.mjs                 # 在本仓库生成 / 覆盖根目录 index.json
 *   node scripts/market/build.mjs --root <dir>    # 在另一个树（发布仓）里生成
 *
 * 每个版本的 `source.commit` 取「最后一次改动该插件目录的提交」——
 * 这样索引指向的提交里**一定**有这一版代码；索引自身随后再提交一次即可。
 * 因此**代码没提交就不要生成索引**：脚本会发现 package.json 的版本与提交里的不一致并拒绝。
 */
import { execFileSync } from 'node:child_process';
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

const root = path.resolve(opt('root', process.cwd()));
const configPath = path.resolve(root, opt('config', 'market.config.json'));
const outPath = path.resolve(root, opt('out', 'index.json'));
const allowDirty = flag('allow-dirty');
const requirePushed = flag('require-pushed');

const problems = [];
const warnings = [];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (!fs.existsSync(configPath)) {
  console.error(`配置不存在：${configPath}`);
  process.exit(2);
}

const config = readJson(configPath);
const source = config.source ?? {};
if (source.type !== 'git' || typeof source.url !== 'string') {
  console.error('market.config.json 的 source 目前只支持 { "type": "git", "url": "https://github.com/<owner>/<repo>" }');
  process.exit(2);
}
const branch = source.branch ?? 'main';
const indexUrl = opt(
  'url',
  new URL(`${branch}/index.json`, `${source.url.replace(/\/+$/u, '')}/`).href.replace('github.com', 'raw.githubusercontent.com'),
);

/** 索引 URL 必须是 http(s)、无凭据与 fragment，且直连（DSH 拒绝重定向）。 */
let indexUrlValid = true;
try {
  const parsed = new URL(indexUrl);
  if (!/^https?:$/u.test(parsed.protocol)) indexUrlValid = false;
  if (parsed.username || parsed.password || parsed.hash) indexUrlValid = false;
} catch {
  indexUrlValid = false;
}
if (!indexUrlValid) {
  console.error(`索引 URL 不合法：${indexUrl}`);
  process.exit(2);
}

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
} catch {
  console.error(`${root} 不是一个 git 仓库 —— build.mjs 必须在仓库里跑：索引里每个版本都要指向一个提交 SHA。`);
  process.exit(2);
}

const head = git(['rev-parse', 'HEAD']);
const pluginEntries = [];

if (!indexUrl.startsWith('https://') && !flag('allow-http')) {
  warnings.push(`索引 URL 不是 https（DSH 允许 http，但另一台机器上请用 https）：${indexUrl}`);
}

for (const plugin of config.plugins ?? []) {
  const dir = String(plugin.path ?? '').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
  if (dir === '') {
    problems.push('market.config.json 里有一个插件没有 path');
    continue;
  }
  const packageFile = path.join(root, dir, 'package.json');
  if (!fs.existsSync(packageFile)) {
    problems.push(`${dir}: 缺少 package.json`);
    continue;
  }
  const manifest = readJson(packageFile);

  // 能被 install_bundle 挂起来的前提：声明了组合包补丁，且补丁文件真的在。
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== 'string') {
    problems.push(`${dir}: package.json 没有 dsh.bundle.patch —— 这样装上了也不会被组合进插件树`);
  } else if (!fs.existsSync(path.join(root, dir, patch))) {
    problems.push(`${dir}: dsh.bundle.patch 指向的 ${patch} 不存在`);
  }
  if (typeof manifest.main === 'string' && !fs.existsSync(path.join(root, dir, manifest.main))) {
    problems.push(`${dir}: main 指向的 ${manifest.main} 不存在`);
  }

  // 最后一次改动这个目录的提交 —— 就是这一版代码所在的提交。
  const log = git(['log', '-1', '--format=%H%n%ct', '--', dir]).split('\n');
  const commit = log[0];
  const timestamp = Number(log[1]);
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) {
    problems.push(`${dir}: 找不到改动该目录的提交（目录可能还没入库）`);
    continue;
  }

  // 提交里的版本必须与工作树一致，否则索引会指向一个「还没有这一版」的提交。
  let committedVersion;
  try {
    committedVersion = JSON.parse(git(['show', `${commit}:${dir}/package.json`])).version;
  } catch {
    problems.push(`${dir}: 提交 ${commit.slice(0, 7)} 里没有 ${dir}/package.json`);
    continue;
  }
  if (committedVersion !== manifest.version) {
    problems.push(
      `${dir}: 工作树版本 ${manifest.version} 与提交 ${commit.slice(0, 7)} 里的 ${committedVersion} 不一致 —— 先 git commit 再生成索引`,
    );
  }

  if (!allowDirty) {
    const dirty = git(['status', '--porcelain', '--', dir]);
    if (dirty !== '') problems.push(`${dir}: 有未提交改动，索引会指向旧代码\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }

  if (requirePushed) {
    try {
      git(['merge-base', '--is-ancestor', commit, `origin/${branch}`]);
    } catch {
      warnings.push(`${dir}: 提交 ${commit.slice(0, 7)} 还没推到 origin/${branch}，别的机器拉不到这一版`);
    }
  }

  pluginEntries.push({
    name: manifest.name,
    title: plugin.title ?? { en: manifest.name },
    description: plugin.description ?? { en: manifest.description ?? manifest.name },
    ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
    ...(plugin.author ?? manifest.author === undefined ? {} : { author: typeof (plugin.author ?? manifest.author) === 'string' ? (plugin.author ?? manifest.author) : undefined }),
    ...(plugin.homepage ?? manifest.homepage === undefined ? {} : { homepage: plugin.homepage ?? manifest.homepage }),
    repository: { url: source.url, directory: dir },
    metadata: {
      ...(plugin.category === undefined ? {} : { category: plugin.category }),
      keywords: plugin.keywords ?? [],
      labels: plugin.labels ?? [],
      sortKeys: { updated: timestamp },
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: timestamp,
        source: { type: 'git', url: source.url, commit, path: dir },
      },
    ],
  });

  console.log(
    `${manifest.name}@${manifest.version}  ${dir}  commit=${commit.slice(0, 7)}  ${new Date(timestamp * 1000).toISOString().slice(0, 10)}`,
  );
}

const doc = {
  format: 1,
  title: config.title,
  ...(config.description === undefined ? {} : { description: config.description }),
  metadata: config.metadata ?? { categories: {}, labels: {}, sortKeys: {} },
  plugins: pluginEntries,
};

// 先按格式 1 自检，再落盘 —— 宁可不出文件，也不要出一个 DSH 装不下的文件。
const { errors, warnings: formatWarnings } = validateIndex(doc, indexUrl);
warnings.push(...formatWarnings);
problems.push(...errors);

if (warnings.length > 0) {
  console.warn('\n警告：');
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

if (problems.length > 0) {
  console.error('\n不能生成索引：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`\n已写出 ${outPath}`);
console.log(`索引 URL：${indexUrl}`);
console.log(`基于提交：${head.slice(0, 7)}（HEAD）`);
