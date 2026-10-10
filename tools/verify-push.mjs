// 核实推送结果：远端提交、文件数、以及"远端内容是否等于本地"（用 git 自己比对，最可靠）。
// 仓库位置从本脚本推导（本脚本在 <repo>/tools/ 下），不写死本机路径。
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const head = run(['rev-parse', 'HEAD'])
const remoteHead = run(['rev-parse', 'origin/main'])
console.log('本地 HEAD      :', head.slice(0, 8))
console.log('origin/main    :', remoteHead.slice(0, 8))
console.log('两者一致       :', head === remoteHead ? '是 ✓' : '否 ✗')

const files = run(['ls-files']).split('\n').filter(Boolean)
console.log('远端跟踪文件数 :', files.length)

const status = run(['status', '--porcelain'])
console.log('工作区未提交改动:', status ? `有 ${status.split('\n').length} 处 ✗` : '无 ✓')

console.log('\n远端包含的文件:')
for (const f of files) console.log('  ' + f)
