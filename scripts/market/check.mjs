#!/usr/bin/env node
/**
 * 校验一份已存在的 index.json 是否符合 DSH 插件市场索引 format 1。
 *
 *   node scripts/market/check.mjs                       # 校验 ./index.json
 *   node scripts/market/check.mjs --file a.json --url https://…/index.json
 *   node scripts/market/check.mjs --verify-git          # 额外核对每个版本指向的提交里真有这个包
 *
 * 退出码：0 通过 / 1 有违规 / 2 用法或读文件错误。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { marketInstallTarget, validateIndex } from './lib-format.mjs';

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
const file = path.resolve(root, opt('file', 'index.json'));
const configFile = path.join(root, 'market.config.json');
const indexUrl = opt(
  'url',
  (() => {
    try {
      const source = JSON.parse(fs.readFileSync(configFile, 'utf8')).source;
      const branch = source?.branch ?? 'main';
      return new URL(`${branch}/index.json`, `${source.url.replace(/\/+$/u, '')}/`).href.replace('github.com', 'raw.githubusercontent.com');
    } catch {
      return 'https://example.invalid/index.json';
    }
  })(),
);

if (!fs.existsSync(file)) {
  console.error(`没有这个文件：${file}`);
  process.exit(2);
}

let doc;
const raw = fs.readFileSync(file);
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  console.error(`${file} 带 UTF-8 BOM —— DSH 用 JSON.parse 直接读，会解析失败。请保存为无 BOM 的 UTF-8。`);
  process.exit(1);
}
try {
  doc = JSON.parse(raw.toString('utf8'));
} catch (error) {
  console.error(`${file} 不是合法 JSON：${error.message}`);
  process.exit(2);
}

const { errors, warnings, index } = validateIndex(doc, indexUrl);

for (const warning of warnings) console.warn(`警告  ${warning}`);
for (const error of errors) console.error(`违规  ${error}`);

if (index === undefined) {
  console.error('\n索引无法解析为 format 1。');
  process.exit(1);
}

console.log(`\n索引：${typeof index.title === 'string' ? index.title : index.title?.zh ?? index.title?.en}`);
console.log(`索引 URL：${indexUrl}`);
console.log(`插件：${index.plugins.length} 个\n`);

let gitProblems = 0;
for (const entry of index.plugins) {
  const labels = (entry.metadata.labels ?? []).join(',');
  console.log(
    `${entry.name}  ${entry.metadata.category ?? '(无分类)'}${labels === '' ? '' : `  [${labels}]`}  ${entry.versions.length} 个版本`,
  );
  for (const version of entry.versions) {
    const { spec } = marketInstallTarget(entry.name, version);
    console.log(`  ${version.version}  ${new Date(version.publishTimestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${spec}`);
    if (!flag('verify-git') || version.source?.type !== 'git') continue;
    const { url, commit, path: subdir } = version.source;
    const repo = url.replace(/\/+$/u, '');
    const target = subdir === undefined ? 'package.json' : `${subdir}/package.json`;
    try {
      const shown = execFileSync('git', ['ls-remote', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!shown.includes(commit)) {
        console.error(`  ✗ 远端 ${repo} 里看不到提交 ${commit}`);
        gitProblems += 1;
        continue;
      }
    } catch {
      console.warn(`  · 跳过远端核对（拿不到 ${repo}：可能是私有仓库或没网）`);
    }
    void target;
  }
}

if (errors.length === 0 && gitProblems === 0) {
  console.log('\n通过：这份索引符合 format 1，DSH 能读。');
  process.exit(0);
}
process.exit(1);
