import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const blockTypes = new Map();
const toolNames = new Map();
for (const r of lines) {
  if (r.type === 'assistant/message') {
    for (const b of r.data?.message?.content ?? []) {
      blockTypes.set(b.type, (blockTypes.get(b.type) ?? 0) + 1);
    }
  }
  if (r.type === 'tool/call') {
    const n = r.data?.name ?? r.data?.toolName ?? r.data?.call?.name ?? JSON.stringify(Object.keys(r.data ?? {}));
    toolNames.set(n, (toolNames.get(n) ?? 0) + 1);
  }
}
console.log('assistant block types:', [...blockTypes]);
console.log('tool names:', [...toolNames]);

const samples = {};
for (const r of lines) {
  if (!samples[r.type] && ['tool/call', 'tool/result', 'request/header', 'agent/inbox/spliced'].includes(r.type)) samples[r.type] = r;
}
for (const [k, v] of Object.entries(samples)) {
  console.log(`\n### ${k} (keys: ${Object.keys(v.data ?? {}).join(', ')})`);
  console.log(JSON.stringify(v).slice(0, 900));
}
// one assistant message with a reasoning block, if any
const withReason = lines.find((r) => r.type === 'assistant/message' && (r.data?.message?.content ?? []).some((b) => b.type !== 'text'));
if (withReason) {
  console.log('\n### assistant message block shapes:', (withReason.data.message.content ?? []).map((b) => b.type));
  console.log(JSON.stringify(withReason).slice(0, 900));
}
