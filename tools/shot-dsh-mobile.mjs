// 在移动端视口下截图 DSH GUI（经中继鉴权），用于目视评估移动端体验。
// 用法：node tools/shot-dsh-mobile.mjs <out.png> [width] [height] [mobile:0|1]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const out = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-mobile.png')
const width = Number(process.argv[3] ?? 390)
const height = Number(process.argv[4] ?? 844)
const mobile = (process.argv[5] ?? '1') !== '0'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]

const loginRes = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 19388, method: 'GET', path: `/?pwd=${encodeURIComponent(pwd)}` }, (res) => {
    res.resume()
    resolve(res)
  })
  req.on('error', reject)
  req.end()
})
const cookie = (loginRes.headers['set-cookie'] ?? [''])[0].split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const userDataDir = path.join(os.tmpdir(), 'dsh-cdp-profile')
const port = 9333
spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
  '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let wsUrl
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch { /* not ready */ }
  await sleep(250)
}
if (!wsUrl) throw new Error('CDP 未就绪')

const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true })
  return res.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 2, mobile,
})
await send('Network.enable')
await send('Network.setCookie', {
  name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/',
})
await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
for (let i = 0; i < 60; i += 1) {
  await sleep(500)
  const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0)
  if (n > 60) break
}
await sleep(2500)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const data = shot.result?.data
if (!data) throw new Error(`截图失败: ${JSON.stringify(shot).slice(0, 200)}`)
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log(JSON.stringify({ out, bytes: fs.statSync(out).size, viewport: { width, height, mobile } }))
ws.close()
process.exit(0)
