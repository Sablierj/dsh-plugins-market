// 开发调试：读一个 JSON 文件，打印指定路径的片段。
// 用法: node tools/inspect-json.mjs <file> [key1,key2,...]
import { readFile } from 'node:fs/promises'

const [, , file, keysArg] = process.argv
let data = JSON.parse(await readFile(file, 'utf8'))
if (typeof data === 'string') data = JSON.parse(data)
const keys = (keysArg || '').split(',').filter(Boolean)
if (!keys.length) {
  console.log('顶层键：', Object.keys(data).join(','))
  process.exit(0)
}
for (const key of keys) {
  const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), data)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`${key} = ${String(text).slice(0, 600)}`)
}
