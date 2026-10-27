import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const want = process.argv.slice(3);
for (const w of want) {
  const rec = lines.find((r) => r.type === w);
  if (!rec) {
    console.log(`### ${w}: (none)\n`);
    continue;
  }
  console.log(`### ${w}`);
  console.log(JSON.stringify(rec, null, 1).slice(0, 1400));
  console.log();
}
