import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-recruit-test-'))
const env = { ...process.env, BOSS_RECRUIT_STORE_DIR: path.join(store, 'ledger') }
const runNode = (script) => {
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout)
  return r.stdout.trim()
}

const first = path.join(store, 'first.mjs')
const second = path.join(store, 'second.mjs')
const pluginPath = pathToFileURL(path.join(root, 'index.js')).href
const harness = `
import fs from 'node:fs'
import { apply } from ${JSON.stringify(pluginPath)}
let def
apply({tools:{register(x){def=x}},systemPrompt:{section(){return()=>{}}},webServer:{register(){}},effect(f){if(typeof f==='function')f()},on(){},provide(){}})
export const run = (args) => def.execute(args,{})
export const ok = (x) => { if(!x.ok) throw new Error(JSON.stringify(x)); return x }
export const rejected = (x) => { if(x.ok) throw new Error('应被拒绝却成功：'+JSON.stringify(x)); return x }
`
fs.writeFileSync(first, `${harness}
const jobs = ok(await run({action:'jobs'}))
const jobId = jobs.jobs[0].id
await run({action:'mode',jobId,mode:'recruit'})
ok(await run({action:'config',jobId,key:'greetMinGapSec',value:120}))
ok(await run({action:'config',jobId,key:'greetMaxGapSec',value:720}))
rejected(await run({action:'config',jobId,key:'greetMinGapSec',value:721}))
const v1 = ok(await run({action:'view',jobId,name:'隔离甲',company:'隔离公司',sourceTab:'recommend',note:'看过'}))
const v2 = ok(await run({action:'view',jobId,name:'隔离甲',company:'隔离公司',note:'二看'}))
if(!v1.created || v2.created || v1.seq!==v2.seq) throw new Error('看过未落到同一条记录')
await run({action:'upsert',jobId,name:'同名甲',company:'甲公司',stage:'new'})
await run({action:'upsert',jobId,name:'同名甲',company:'乙公司',stage:'new'})
if(ok(await run({action:'list',jobId,q:'同名甲'})).total!==2) throw new Error('同名不同公司被误合并')
await run({action:'upsert',jobId,name:'简历甲',company:'隔离公司',stage:'resume_received'})
ok(await run({action:'backfill',jobId,stage:'resume_received',field:'resumeAt',value:'2026-10-26T10:00:00.000Z'}))
if(ok(await run({action:'list',jobId,q:'简历甲'})).items[0].resumeAt!=='2026-10-26T10:00:00.000Z') throw new Error('简历时间补录未生效')
ok(await run({action:'chatScope',jobId,pageJobLabel:'<岗位标题>'}))
ok(await run({action:'config',jobId,key:'screenMinReadSec',value:1}))
ok(await run({action:'screen',jobId,name:'隔离甲',company:'隔离公司',resumeRead:true,projects:'负责移动应用接口自动化和性能测试的完整在线简历项目原文，用于验证跨重启保留',decision:'greet'}))
await new Promise(r=>setTimeout(r,1200))
ok(await run({action:'completeGreet',jobId,name:'隔离甲',company:'隔离公司'}))
rejected(await run({action:'completeGreet',jobId,name:'隔离甲',company:'隔离公司'}))
await run({action:'config',jobId,key:'greetMinGapSec',value:0})
const dup = ok(await run({action:'completeGreet',jobId,name:'隔离甲',company:'隔离公司'}))
if(!dup.duplicate) throw new Error('重复招呼没有按幂等处理')
if(ok(await run({action:'pace',jobId})).greeted!==1) throw new Error('重复招呼导致重复计数')
rejected(await run({action:'flow',jobId,track:'chatting'}))
await run({action:'mode',jobId,mode:'reply'})
if(ok(await run({action:'flow',jobId,track:'chatting'})).steps.length!==5) throw new Error('沟通中步骤缺失')
ok(await run({action:'observe',jobId,tab:'chatting',batch:[{name:'隔离甲',company:'隔离公司',preview:'您好',unread:true,lastSpeaker:'them'}]}))
rejected(await run({action:'observe',jobId,tab:'chatting',hitEnd:false,batch:[{name:'隔离甲'}]}))
ok(await run({action:'config',jobId,key:'workflows',value:{chatting:['先确认岗位','只读未读','按四类回应']}}))
if(ok(await run({action:'flow',jobId,track:'chatting'})).steps.length!==3) throw new Error('可配置流程未生效')
const badInterview = await run({action:'interview',jobId,name:'隔离甲',time:'2026-10-28 14:00',location:'测试地点',contact:'测试联系人'})
if(badInterview.ok || !badInterview.error.includes('尚未实际接收简历')) throw new Error('无简历却允许约面')
ok(await run({action:'claim',jobId,bossId:'隔离甲|隔离公司',op:'take',by:'测试员'}))
// A 机器导出整份备份，B 机器先有部分字段，再合并导入：不能丢本机信息，也不能重复沟通。
const exported = ok(await run({action:'backup-export'})).backup
if(exported.summary.candidates!==4 || exported.summary.screens!==1) throw new Error('备份未包含全部候选人和凭据：'+JSON.stringify(exported.summary))
fs.writeFileSync(${JSON.stringify(path.join(store, 'backup.json'))}, JSON.stringify(exported))
await run({action:'upsert',jobId,bossId:'隔离甲|隔离公司',name:'隔离甲',company:'隔离公司',phone:'13800000000',email:'a@example.test'})
const incoming = JSON.parse(JSON.stringify(exported))
const firstImport = ok(await run({action:'backup-import',backup:incoming,replace:false}))
if(firstImport.stats.added!==0 || !firstImport.backupFile) throw new Error('合并导入没有保护本机已有记录')
const afterFirst = ok(await run({action:'list',jobId,q:'隔离甲'})).items[0]
if(afterFirst.phone!=='13800000000' || afterFirst.email!=='a@example.test') throw new Error('备份空字段覆盖了 B 机器已有联系方式')
const secondImport = ok(await run({action:'backup-import',backup:incoming,replace:false}))
if(secondImport.stats.added!==0) throw new Error('重复导入新增重复记录')
const mergedState = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(store, 'ledger', 'pipeline.json'))},'utf8'))
const mergedCandidate = Object.values(mergedState.candidates).find(c=>c.jobId===jobId&&c.name==='隔离甲')
if(mergedCandidate.viewCount!==2 || mergedCandidate.phone!=='13800000000') throw new Error('重复导入或合并破坏了记录')
rejected(await run({action:'backup-import',backup:{format:'wrong',state:{}}}))
console.log(JSON.stringify({firstPass:'PASS',jobId,backup:exported.summary,importStats:firstImport.stats}))
`)
fs.writeFileSync(second, `${harness}
const jobs = ok(await run({action:'jobs'}))
const jobId = jobs.jobs[0].id
const c = ok(await run({action:'list',jobId,q:'隔离甲'})).items[0]
if(c.viewCount!==2 || c.stage!=='greeted' || !c.screenedAt || !c.lease) throw new Error('重启后记录/凭据/租约丢失')
const r = ok(await run({action:'list',jobId,q:'简历甲'})).items[0]
if(r.resumeAt!=='2026-10-26T10:00:00.000Z') throw new Error('重启后简历时间丢失')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(store, 'ledger', 'pipeline.json'))},'utf8'))
if(state.screens.length!==1 || !state.chatScope || !state.inbox.chatting) throw new Error('重启后流程凭据丢失')
console.log(JSON.stringify({restartPass:'PASS',viewCount:c.viewCount,stage:c.stage,resumeAt:r.resumeAt}))
`)
console.log(runNode(first))
console.log(runNode(second))
console.log(JSON.stringify({ testStore: store, note: '仅使用临时目录，未触碰真实候选人台账' }))
