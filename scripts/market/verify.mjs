#!/usr/bin/env node
/**
 * 发布之后的自检：**站在另一台机器的角度**，把这条索引源真的走一遍。
 *
 *   node scripts/market/verify.mjs --url https://raw.githubusercontent.com/<owner>/<repo>/main/index.json
 *   node scripts/market/verify.mjs --url http://127.0.0.1:8787/index.json --skip-git
 *
 * 它检查的每一件事，都是 DSH 在「发现」页或安装时会踩到的：
 *   1. 索引 URL 直连 200（DSH 拒绝重定向；404 通常意味着仓是私有的）；
 *   2. 无 BOM、可解析、符合 format 1（规则与 DSH 自己那份校验器一致）；
 *   3. 每个 icon 真的能取到图片；
 *   4. 每个 git 版本指向的 commit **在远端存在**，且该 commit 里 `<path>/package.json`
 *      的 name/version 与索引写着的一致（不一致 = 索引指错了版本，装了会得到别的东西）。
 *
 * 退出码：0 全通过 / 1 有失败项 / 2 用法错误。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

const url = opt('url', undefined);
if (url === undefined) {
  console.error('用法：node scripts/market/verify.mjs --url <索引 URL> [--skip-git] [--timeout 15000]');
  process.exit(2);
}
const skipGit = flag('skip-git');
const timeout = Number(opt('timeout', '15000'));

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

function git(cwd, args, allowFailure = false) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    throw error;
  }
}

/* ── 1. 取索引：不跟随重定向，与 DSH 一致 ───────────────────── */
console.log(`索引源：${url}\n`);
let body;
try {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if (response.status >= 300 && response.status < 400) {
    fail(`索引 URL 返回 ${response.status} 重定向 → DSH 拒绝重定向，必须直接配置最终 URL`);
  } else if (response.status === 404) {
    fail('索引 URL 返回 404 —— 仓可能还是私有的，或者分支/路径写错了');
  } else if (!response.ok) {
    fail(`索引 URL 返回 ${response.status}`);
  } else {
    body = Buffer.from(await response.arrayBuffer());
    console.log(`✓ 取到索引（${body.length} 字节）`);
  }
} catch (error) {
  fail(`取不到索引：${error.message}（本机 git/fetch 的代理设置也会影响这里）`);
}

if (body !== undefined) {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    fail('索引带 UTF-8 BOM —— DSH 用 JSON.parse 直接读会失败');
  } else {
    let doc;
    try {
      doc = JSON.parse(body.toString('utf8'));
    } catch (error) {
      fail(`索引不是合法 JSON：${error.message}`);
    }
    if (doc !== undefined) {
      const { errors, warnings, index } = validateIndex(doc, url);
      for (const warning of warnings) note(`格式提醒 ${warning}`);
      if (errors.length === 0) {
        console.log(`✓ 符合 format 1（${index.plugins.length} 个插件）`);
      } else {
        for (const error of errors) fail(`格式违规 ${error}`);
      }

      /* ── 2. 图标 ─────────────────────────────────────────── */
      for (const plugin of index.plugins) {
        if (plugin.icon === undefined || plugin.icon.startsWith('data:')) continue;
        try {
          const response = await fetch(plugin.icon, { signal: AbortSignal.timeout(timeout) });
          const type = response.headers.get('content-type') ?? '';
          if (!response.ok) fail(`${plugin.name} 的图标取不到：${response.status} ${plugin.icon}`);
          else if (!type.startsWith('image/')) note(`${plugin.name} 的图标 content-type 是 ${type}（不是 image/*），浏览器可能不显示`);
          else console.log(`✓ 图标 ${plugin.name}（${type}）`);
        } catch (error) {
          fail(`${plugin.name} 的图标取不到：${error.message}`);
        }
      }

      /* ── 3. git 版本：commit 真在、内容真是这一版 ─────────── */
      if (skipGit) {
        note('已跳过 git 版本核对（--skip-git）');
      } else {
        for (const plugin of index.plugins) {
          for (const version of plugin.versions) {
            if (version.source?.type !== 'git') {
              note(`${plugin.name}@${version.version} 是 npm 源，未在这里核对（本脚本只核对 git 源）`);
              continue;
            }
            const { url: repo, commit, path: subdir } = version.source;
            const work = fs.mkdtempSync(path.join(os.tmpdir(), 'market-verify-'));
            try {
              git(work, ['init', '-q']);
              // 只取这一个提交，不 clone 整棵历史。
              const fetched = git(work, ['fetch', '-q', '--depth', '1', repo, commit], true);
              if (fetched === undefined) {
                fail(`${plugin.name}@${version.version} 取不到提交 ${commit.slice(0, 7)}（仓私有/commit 没推/网络不通）`);
                continue;
              }
              const target = subdir === undefined ? 'package.json' : `${subdir}/package.json`;
              const manifest = git(work, ['show', `${commit}:${target}`], true);
              if (manifest === undefined) {
                fail(`${plugin.name}@${version.version}：提交里没有 ${target}`);
                continue;
              }
              const parsed = JSON.parse(manifest);
              if (parsed.name !== plugin.name) fail(`${plugin.name}：索引的 name 与包里不一致（包是 ${parsed.name}）`);
              if (parsed.version !== version.version) {
                fail(`${plugin.name}：索引写 ${version.version}，但提交里是 ${parsed.version}`);
              }
              if (parsed.name === plugin.name && parsed.version === version.version) {
                const { spec } = marketInstallTarget(plugin.name, version);
                console.log(`✓ ${plugin.name}@${version.version} 提交存在，安装参数 ${spec}`);
              }
            } catch (error) {
              fail(`${plugin.name}@${version.version} 核对失败：${error.message}`);
            } finally {
              fs.rmSync(work, { recursive: true, force: true });
            }
          }
        }
      }
    }
  }
}

for (const message of notes) console.log(`· ${message}`);
if (failures.length === 0) {
  console.log('\n通过：这条索引源在另一台机器上应该能被 DSH 正常读取与安装。');
} else {
  console.error('\n未通过：');
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exitCode = 1;
}
