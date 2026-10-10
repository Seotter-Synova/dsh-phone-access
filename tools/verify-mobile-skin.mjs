// 验证移动端样式真的生效（不只是"HTML 里多了一段 CSS"）：
// 用无头浏览器打开 GUI，检查挂件是否被隐藏、按钮实际高度是否达标、有无横向溢出。
// 用法：node tools/verify-mobile-skin.mjs [width] [height]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const width = Number(process.argv[2] ?? 390)
const height = Number(process.argv[3] ?? 844)

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]

const loginRes = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 19388, method: 'GET', path: `/?pwd=${encodeURIComponent(pwd)}` }, (res) => { res.resume(); resolve(res) })
  req.on('error', reject)
  req.end()
})
const cookie = (loginRes.headers['set-cookie'] ?? [''])[0].split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const port = 9399
spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'dsh-cdp-skin')}`,
  '--window-size=1200,900', 'about:blank'], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch { }
  await sleep(250)
}
if (!wsUrl) throw new Error('CDP 未就绪')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const id = ++nextId; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)) }
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
for (let i = 0; i < 60; i += 1) { await sleep(500); const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0); if (typeof n === 'number' && n > 60) break }
await sleep(3000)

const result = await evaluate(`(() => {
  const skinTag = document.querySelector('style[data-relay="mobile-skin"]');
  const widget = document.querySelector('.dshwv-root');
  const widgetHidden = !widget || getComputedStyle(widget).display === 'none' || widget.getBoundingClientRect().width === 0;
  const buttons = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4 });
  const smallOnes = buttons.filter(b => b.getBoundingClientRect().height < 40).length;
  const rail = document.querySelector('[class*="sidebarCol"]');
  return {
    skinPresent: !!skinTag,
    skinRules: skinTag ? skinTag.textContent.length : 0,
    viewport: { w: innerWidth, h: innerHeight },
    widgetHidden,
    buttonCount: buttons.length,
    buttonsUnder40: smallOnes,
    docScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
  };
})()`)

const checks = [
  ['样式标签已注入', result.skinPresent],
  ['挂件在窄屏已隐藏', result.widgetHidden],
  ['无横向溢出', !result.horizontalOverflow],
  ['按钮高度基本达标（<40px 的占比 <30%）', result.buttonCount === 0 || result.buttonsUnder40 / result.buttonCount < 0.3],
]
console.log(JSON.stringify(result, null, 1))
let failed = 0
for (const [label, ok] of checks) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
ws.close()
process.exit(failed === 0 ? 0 : 1)
