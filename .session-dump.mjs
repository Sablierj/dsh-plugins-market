import fs from 'node:fs';
import zlib from 'node:zlib';

const src = process.argv[2];
const out = process.argv[3];

const raw = zlib.zstdDecompressSync(fs.readFileSync(src));
const text = raw.toString('utf8');
if (out) fs.writeFileSync(out, text, 'utf8');

const lines = text.split('\n').filter((l) => l.trim());
const kinds = new Map();
for (const l of lines) {
  let t = '(unparsed)';
  try {
    const o = JSON.parse(l);
    t = o.type ?? o.kind ?? o.role ?? Object.keys(o).slice(0, 4).join(',');
  } catch {}
  kinds.set(t, (kinds.get(t) ?? 0) + 1);
}
console.log('lines:', lines.length, 'bytes:', raw.length);
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
console.log('---- first 3 lines (truncated 600 chars) ----');
for (const l of lines.slice(0, 3)) console.log(l.slice(0, 600), '\n');
