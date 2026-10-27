import fs from 'node:fs';
import zlib from 'node:zlib';

// DSH session files are a concatenation of zstd frames (one frame per append).
// Node's zstd API only decodes the first frame, so split frames by magic scan.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeAll(buf) {
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) {
    offsets.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  const chunks = [];
  let frames = 0;
  for (const off of offsets) {
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(off));
      if (out.length) chunks.push(out);
      frames++;
    } catch {
      // false positive magic inside compressed payload — skip
    }
  }
  return { frames, text: Buffer.concat(chunks).toString('utf8') };
}

const src = process.argv[2];
const out = process.argv[3];
const buf = fs.readFileSync(src);
const { frames, text } = decodeAll(buf);

if (out) fs.writeFileSync(out, text, 'utf8');

const lines = text.split('\n').filter((l) => l.trim());
console.log(`file=${src}`);
console.log(`size=${buf.length} frames=${frames} lines=${lines.length} bytes=${Buffer.byteLength(text)}`);
const kinds = new Map();
let bad = 0;
for (const l of lines) {
  let t = '(unparsed)';
  try {
    const o = JSON.parse(l);
    t = o.type ?? o.kind ?? o.role ?? Object.keys(o).slice(0, 4).join(',');
  } catch {
    bad++;
  }
  kinds.set(t, (kinds.get(t) ?? 0) + 1);
}
console.log('unparsed lines:', bad);
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${v}\t${k}`);
console.log('---- first line ----');
console.log(lines[0]?.slice(0, 500));
console.log('---- last line ----');
console.log(lines.at(-1)?.slice(0, 500));
