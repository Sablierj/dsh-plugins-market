import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const src = process.argv[2];
const out = process.argv[3];

await pipeline(
  fs.createReadStream(src),
  zlib.createZstdDecompress(),
  fs.createWriteStream(out)
);

const text = fs.readFileSync(out, 'utf8');
const lines = text.split('\n').filter((l) => l.trim());
console.log('lines:', lines.length, 'bytes:', Buffer.byteLength(text));
const kinds = new Map();
for (const l of lines) {
  let t = '(unparsed)';
  try {
    const o = JSON.parse(l);
    t = o.type ?? o.kind ?? o.role ?? Object.keys(o).slice(0, 4).join(',');
  } catch {}
  kinds.set(t, (kinds.get(t) ?? 0) + 1);
}
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
console.log('---- first line ----');
console.log(lines[0]?.slice(0, 400));
console.log('---- last line ----');
console.log(lines.at(-1)?.slice(0, 400));
