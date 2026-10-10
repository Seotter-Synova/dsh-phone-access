// 专测"遮罩残留"：侧栏收起后，屏幕右侧**不能**还有任何变暗的覆盖层。
// 做法：对比开/关侧栏时同一坐标的像素颜色（在页面内用 canvas 采样不可行，改用命中测试 + 计算样式）。
// 更直接的办法：读 frame 与 sidebar 的伪元素/背景，并确认没有任何 fixed 全屏半透明层。
// 用法：node tools/verify-no-stuck-overlay.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]
const loginRes = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 19388, method: 'GET', path: `/?pwd=${encodeURIComponent(pwd)}` }, (res) => { res.resume(); resolve(res) })
  req.on('error', reject); req.end()
})
const cookie = (loginRes.headers['set-cookie'] ?? [''])[0].split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const port = 9444
spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'dsh-cdp-ov2')}`,
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

// 采样：把页面里某个坐标处的像素颜色取回来（用 CDP 截图后解析不方便，改成遍历 DOM 找半透明覆盖层 + 截图对比）
const overlayReport = () => evaluate(`(() => {
  const frame = document.querySelector('[class*="_frame"]');
  const side = document.querySelector('[class*="sidebarCol"]');
  const out = { collapsedAttr: frame?.hasAttribute('data-sidebar-collapsed') ?? null, layers: [] };
  const consider = (el, label) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    for (const which of ['::before', '::after']) {
      const ps = getComputedStyle(el, which);
      const bg = ps.backgroundColor || '';
      const alpha = /rgba?\\(([^)]+)\\)/.exec(bg);
      const parts = alpha ? alpha[1].split(',').map(s => parseFloat(s)) : [];
      const a = parts.length === 4 ? parts[3] : (parts.length === 3 ? 1 : 0);
      const positioned = ps.position === 'fixed' || ps.position === 'absolute';
      if (positioned && a > 0.01) {
        out.layers.push({ on: label, pseudo: which, background: bg, position: ps.position, content: ps.content });
      }
    }
  };
  consider(frame, 'frame');
  consider(side, 'sidebarCol');
  const sideCs = side ? getComputedStyle(side) : null;
  out.sidebar = side ? { width: Math.round(side.getBoundingClientRect().width), position: sideCs.position, bg: sideCs.backgroundColor } : null;
  // 全屏 fixed 元素扫描（z>0 且覆盖大半屏）
  out.fixedFullscreen = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > innerWidth * 0.8 && r.height > innerHeight * 0.8;
  }).slice(0, 6).map(el => ({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className.slice(0, 50) : ''), bg: getComputedStyle(el).backgroundColor }));
  return out;
})()`)

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
for (let i = 0; i < 60; i += 1) { await sleep(500); const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0); if (typeof n === 'number' && n > 60) break }
await sleep(2500)

const closed = await overlayReport()
console.log('=== 侧栏收起（初始）===')
console.log(JSON.stringify(closed, null, 1).slice(0, 1200))

await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /打开侧边栏/.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return !!b })()`)
await sleep(1500)
const open = await overlayReport()
console.log('\n=== 侧栏展开 ===')
console.log(JSON.stringify(open, null, 1).slice(0, 1200))

// 收起：注意展开后按钮标签是「收起侧边栏」（不是「关闭」——早期脚本找错标签，
// 导致"点了关闭还停在展开态"，看起来像遮罩残留，其实是假警报）
const collapsed = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /收起侧边栏/.test(x.getAttribute('aria-label') || '')); if (b) { b.click(); return true } return false })()`)
console.log('点击「收起侧边栏」:', collapsed)
await sleep(2500)
const reclosed = await overlayReport()
console.log('\n=== 再次收起（等 2.5s 过渡结束）===')
console.log(JSON.stringify(reclosed, null, 1).slice(0, 1200))

const checks = [
  ['收起态：frame 上没有半透明覆盖层', closed.layers.filter(l => l.on === 'frame').length === 0],
  ['展开态：侧栏上有遮罩（说明遮罩生效）', open.layers.some(l => l.on === 'sidebarCol')],
  ['收起动作确实生效（属性回到 collapsed）', reclosed.collapsedAttr === true],
  ['再次收起：frame 上没有覆盖层', reclosed.layers.filter(l => l.on === 'frame').length === 0],
  ['再次收起：侧栏上没有覆盖层（无残留）', reclosed.layers.filter(l => l.on === 'sidebarCol').length === 0],
  ['再次收起：无全屏半透明固定层', reclosed.fixedFullscreen.length === 0],
]
let failed = 0
for (const [label, ok] of checks) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
ws.close()
process.exit(failed === 0 ? 0 : 1)
