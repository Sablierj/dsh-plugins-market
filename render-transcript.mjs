// Render a decoded DSH session transcript (jsonl) into a print-friendly HTML file.
import fs from 'node:fs';

const src = process.argv[2];
const out = process.argv[3];

const LIMITS = { reasoning: 1400, args: 1800, result: 1400, text: 200000 };

const lines = fs
  .readFileSync(src, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const clip = (s, n) => {
  const t = String(s ?? '');
  if (t.length <= n) return esc(t);
  return esc(t.slice(0, n)) + `\n…（已截断，原文共 ${t.length} 字）`;
};

const t = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const session = lines.find((r) => r.type === 'session');
const title = lines.filter((r) => r.type === 'session/title').at(-1)?.data?.val ?? '(无标题)';

// strip the wechat channel preamble that the bridge prepends to every user message
function cleanUserText(s) {
  const marker = '--- 用户消息 ---';
  const i = s.indexOf(marker);
  const body = i === -1 ? s : s.slice(i + marker.length);
  return body.replace(/^\s+/, '');
}

const parts = [];
let counts = { user: 0, assistant: 0, tool: 0 };

const callNames = new Map();

for (const r of lines) {
  if (r.type === 'user/message') {
    const text = (r.data?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => cleanUserText(b.text))
      .join('\n');
    if (!text.trim()) continue;
    counts.user++;
    parts.push(`<section class="turn user">
<div class="who">用户 · ${t(r.time)}</div>
<div class="body user-body">${esc(text)}</div>
</section>`);
  } else if (r.type === 'assistant/message') {
    const blocks = r.data?.message?.content ?? [];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const reas = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n\n');
    const calls = blocks.filter((b) => b.type === 'tool-call');
    if (texts.trim()) {
      counts.assistant++;
      parts.push(`<section class="turn assistant">
<div class="who">助手 · ${t(r.time)}</div>
<div class="body assistant-body">${esc(texts)}</div>
</section>`);
    }
    if (reas.trim()) {
      parts.push(`<details class="reas"><summary>思考过程（${reas.length} 字）</summary><pre>${clip(reas, LIMITS.reasoning)}</pre></details>`);
    }
    for (const c of calls) {
      counts.tool++;
      callNames.set(c.id, c.name);
      parts.push(`<section class="tool">
<div class="who">🔧 调用工具 <b>${esc(c.name)}</b> · ${t(r.time)}</div>
<pre class="args">${clip(c.arguments, LIMITS.args)}</pre>
</section>`);
    }
  } else if (r.type === 'tool/result') {
    const m = r.data?.message ?? {};
    const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const name = callNames.get(m.toolCallId) ?? '工具';
    const flag = m.isError ? ' tool-error' : '';
    parts.push(`<section class="tool-result${flag}">
<div class="who">↳ ${esc(name)} 返回</div>
<pre>${clip(text, LIMITS.result)}</pre>
</section>`);
  }
}

const firstTime = lines[0]?.time;
const lastTime = lines.at(-1)?.time;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>会话记录 ${esc(session?.id ?? '')}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  html { -webkit-print-color-adjust: exact; }
  body { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 10.5pt; line-height: 1.6; color: #1b1b1b; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 6px; }
  .meta { color: #666; font-size: 8.5pt; margin-bottom: 4px; word-break: break-all; }
  .meta b { color: #333; }
  .summary { background: #f4f6f8; border: 1px solid #e2e6ea; border-radius: 6px; padding: 8px 10px; margin: 10px 0 16px; font-size: 9pt; color: #444; }
  .summary span { display: inline-block; margin-right: 14px; }
  section, details { break-inside: avoid; page-break-inside: avoid; margin: 0 0 8px; }
  .who { font-size: 8.5pt; color: #7a7a7a; margin-bottom: 3px; }
  .body { border-radius: 6px; padding: 7px 10px; white-space: pre-wrap; word-wrap: break-word; }
  .user-body { background: #eef4ff; border-left: 3px solid #4a7fd4; }
  .assistant-body { background: #f6f6f4; border-left: 3px solid #9aa0a6; }
  pre { font-family: Consolas, "Cascadia Mono", monospace; font-size: 8pt; line-height: 1.45;
        background: #fbfbfa; border: 1px solid #e6e6e2; border-radius: 5px; padding: 6px 8px; margin: 2px 0 0;
        white-space: pre-wrap; word-wrap: break-word; color: #333; }
  .tool .who { color: #2f6f4f; }
  .tool-result .who { color: #7a5a2f; }
  .tool-error .who { color: #a33; }
  .tool-error pre { background: #fdf3f3; border-color: #f0d5d5; }
  details.reas { background: #faf9f4; border: 1px dashed #ddd8c8; border-radius: 5px; padding: 4px 8px; }
  details.reas summary { cursor: default; font-size: 8.5pt; color: #8a7f5f; }
  details.reas pre { background: transparent; border: none; padding: 4px 0 0; color: #6b6450; }
</style></head>
<body>
<h1>会话记录：${esc(title)}</h1>
<div class="meta">会话 ID：<b>${esc(session?.id ?? '—')}</b></div>
<div class="meta">工作目录：${esc(session?.cwd ?? '—')}</div>
<div class="meta">时间：${t(firstTime)} → ${t(lastTime)}</div>
<div class="summary">
  <span>用户消息：<b>${counts.user}</b></span>
  <span>助手回复：<b>${counts.assistant}</b></span>
  <span>工具调用：<b>${counts.tool}</b></span>
  <span>记录行数：<b>${lines.length}</b></span>
  <div style="margin-top:6px">说明：这是微信通道那条会话的完整落盘记录（含思考过程、每次工具调用的参数与返回）。长输出已做截断，完整原文见 session.v4.jsonl.zstd。</div>
</div>
${parts.join('\n')}
</body></html>`;

fs.writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}: ${Buffer.byteLength(html)} bytes, html chars=${html.length}`);
