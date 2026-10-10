// 校验中继返回的首页：禁缓存、皮肤版本标记、遮罩规则挂在侧栏上（而不是 frame 上）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// 样式文件位置从本脚本位置推导（本脚本在 <root>/tools/ 下），换机器/换目录都不用改。
const here = path.dirname(fileURLToPath(import.meta.url))
const cssPath = path.join(here, '..', 'webhook-projects', 'github-review', 'mobile-skin.css')
const localRev = crypto.createHash('sha1').update(fs.readFileSync(cssPath, 'utf8')).digest('hex').slice(0, 8)

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]
const login = await fetch(`http://127.0.0.1:19388/?pwd=${encodeURIComponent(pwd)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '').split(';')[0]
const page = await fetch('http://127.0.0.1:19388/', { headers: { cookie } })
const html = await page.text()

const servedRev = (html.match(/data-skin-rev="([a-f0-9]+)"/) ?? [])[1]
const checks = [
  ['HTML 禁缓存 (no-store)', (page.headers.get('cache-control') ?? '').includes('no-store')],
  [`服务端皮肤版本 = 本地文件版本 (${localRev})`, servedRev === localRev],
  ['遮罩规则挂在 sidebarCol 上', /sidebarCol[^{]*::before\s*\{/.test(html)],
  ['frame 上的旧遮罩规则已移除', !/_frame[^{]*::after\s*\{/.test(html)],
  ['侧栏悬浮规则仍存在', /sidebarCol"\]\s*\{[^}]*position:\s*fixed/.test(html)],
]

let failed = 0
for (const [label, ok] of checks) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
