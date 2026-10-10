// 公开前最后一道扫描：工作树 + git 历史，找凭据/口令/邮箱/手机号/身份证等。
// 在仓库根目录直接运行即可（不写死本机路径）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = process.cwd()
const run = (args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

// 工作树全部内容（跳过本脚本自身：它包含检查用的模式串，否则会自我命中）
const SELF = path.join('tools', 'prescan-public.mjs')
const tracked = run(['ls-files']).split('\n').filter(Boolean)
let treeText = ''
for (const f of tracked) {
  if (f === SELF) continue
  treeText += `\n## ${f}\n` + fs.readFileSync(path.join(repo, f), 'utf8')
}

// git 历史全部内容（所有 revision 的所有文件）；同样剔除历史里的本脚本版本
const historyText = run(['log', '-p', '--all']).split('\n').filter((l) => !l.includes('prescan-public.mjs')).join('\n')

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const realPwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]
const realSecret = creds.match(/^\s+DSH_GITHUB_WEBHOOK_SECRET:\s*(\S+)\s*$/m)[1]

const checks = [
  ['真实手机访问口令（工作树）', treeText.includes(realPwd)],
  ['真实手机访问口令（git 历史）', historyText.includes(realPwd)],
  ['真实 webhook secret（工作树）', treeText.includes(realSecret)],
  ['真实 webhook secret（git 历史）', historyText.includes(realSecret)],
  ['用户名（当前机器账户名）', new RegExp(process.env.USERNAME || os.userInfo().username, 'i').test(treeText.replace(/new RegExp\(process\.env\.USERNAME[^\n]*/g, ''))],
  ['内网 IP 192.168.x', /192\.168\.\d+\.\d+/.test(treeText) || /192\.168\.\d+\.\d+/.test(historyText)],
  ['个人仓库名 Notion-db-sync', /notion-db-sync/i.test(treeText) || /notion-db-sync/i.test(historyText)],
  ['邮箱地址', /[\w.+-]+@(?!users\.noreply\.github\.com)[\w-]+\.[a-z]{2,}/i.test(treeText.replace(/330323194\+Seotter-Synova@users\.noreply\.github\.com/g, ''))],
  ['中国手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/.test(treeText)],
  ['身份证号', /(?<!\d)\d{17}[\dXx](?!\d)/.test(treeText)],
  ['sk-/ghp_/gho_ 令牌', /\b(sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]{10,}/.test(treeText)],
  ['BEGIN PRIVATE KEY', /BEGIN [A-Z ]*PRIVATE KEY/.test(treeText)],
  ['Windows 绝对用户路径', /C:\\+Users\\+[A-Za-z0-9._-]+/.test(treeText) || /C:\/Users\/[A-Za-z0-9._-]+/.test(treeText)],
]

let bad = 0
console.log(`检查对象：工作树 ${tracked.length} 个文件 + git 全部历史\n`)
for (const [label, hit] of checks) {
  if (hit) bad += 1
  console.log(`${hit ? '⚠ 命中' : '✓ 干净'}  ${label}`)
}
console.log(bad === 0 ? '\n结论：未发现个人凭据或个人标识，可以公开。' : `\n结论：有 ${bad} 项命中，先别公开。`)
process.exit(bad === 0 ? 0 : 1)
