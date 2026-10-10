// 验证中继是否把移动端样式注入到首页 HTML（以及是否只在窄屏生效）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]

const login = await fetch(`http://127.0.0.1:19388/?pwd=${encodeURIComponent(pwd)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '').split(';')[0]

const page = await fetch('http://127.0.0.1:19388/', { headers: { cookie } })
const html = await page.text()

const checks = [
  ['首页 200', page.status === 200],
  ['有注入标记', html.includes('data-relay="mobile-skin"')],
  ['有样式内容', html.includes('DSH 移动端样式层')],
  ['注入在 </head> 之前', html.indexOf('data-relay="mobile-skin"') < html.indexOf('</head>')],
  ['有窄屏媒体查询', html.includes('@media (max-width: 820px)')],
  ['content-length 与实体一致', Number(page.headers.get('content-length')) === Buffer.byteLength(html)],
]

// 非 HTML 资源不应被改动
const asset = await fetch('http://127.0.0.1:19388/assets/index-BPHePDI_.css', { headers: { cookie } })
const assetBody = await asset.text()
checks.push(['CSS 资源未被注入', !assetBody.includes('data-relay="mobile-skin"')])

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(`\n首页大小 ${html.length} 字节`)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
