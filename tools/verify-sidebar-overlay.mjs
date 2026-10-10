// 验收"悬浮侧栏"覆盖：
//   手机收起态 → 图标栏保留、内容正常（原生行为不变）
//   手机展开态 → 内容列拿回整屏、侧栏是 fixed 悬浮层
//   桌面宽度   → 完全不受影响（媒体查询不该生效）
// 用法：node tools/verify-sidebar-overlay.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]

const loginRes = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 19388, method: 'GET', path: `/?pwd=${encodeURIComponent(pwd)}` }, (res) => { res.resume(); resolve(res) })
  req.on('error', reject)
  req.end()
})
const cookie = (loginRes.headers['set-cookie'] ?? [''])[0].split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const port = 9422
spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'dsh-cdp-ov')}`,
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

async function openAt(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 820 })
  await send('Network.enable')
  await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
  await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
  for (let i = 0; i < 60; i += 1) { await sleep(500); const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0); if (typeof n === 'number' && n > 60) break }
  await sleep(2500)
}

const snapshot = () => evaluate(`(() => {
  const frame = document.querySelector('[class*="_frame"]');
  const side = document.querySelector('[class*="sidebarCol"]');
  const center = document.querySelector('[class*="centerCol"]');
  const cs = frame ? getComputedStyle(frame) : null;
  const sideCs = side ? getComputedStyle(side) : null;
  return {
    collapsedAttr: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
    computedColumns: cs?.gridTemplateColumns ?? null,
    sidebarRect: side ? { w: Math.round(side.getBoundingClientRect().width), x: Math.round(side.getBoundingClientRect().x) } : null,
    sidebarPosition: sideCs?.position ?? null,
    centerRect: center ? { w: Math.round(center.getBoundingClientRect().width), x: Math.round(center.getBoundingClientRect().x) } : null,
    inlineColumns: frame?.getAttribute('style') ?? null,
    docScrollW: document.documentElement.scrollWidth,
    viewportW: innerWidth,
  };
})()`)

async function toggle() {
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /打开侧边栏|关闭侧边栏/.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'no-toggle'; b.click(); return b.getAttribute('aria-label');
  })()`)
}

await send('Page.enable'); await send('Runtime.enable')
const checks = []

// --- 手机 390：收起态 ---
await openAt(390, 844)
const mClosed = await snapshot()
checks.push(['手机·收起态：图标栏保留（>40px）', mClosed.sidebarRect.w > 40])
checks.push(['手机·收起态：内容占满剩余宽度', mClosed.centerRect.w > 250])
checks.push(['手机·收起态：侧栏未悬浮（原生网格）', mClosed.sidebarPosition !== 'fixed'])

// --- 手机 390：展开态 ---
await toggle()
await sleep(1200)
const mOpen = await snapshot()
// 注意：侧栏列本身因为 position:fixed 被移出网格 → 它自己的 rect 宽为 0，这是预期的。
// "内容拿回整屏"要看网格定义的第二列（实测 0px 390px 0px）与页面是否溢出。
const mOpenCenterCol = Number((mOpen.computedColumns ?? '').split(/\s+/)[1]?.replace('px', '')) || 0
checks.push(['手机·展开态：网格内容列 = 视口宽（侧栏不再占位）', mOpenCenterCol >= 380])
checks.push(['手机·展开态：侧栏悬浮 fixed', mOpen.sidebarPosition === 'fixed'])
checks.push(['手机·展开态：侧栏宽度受限（<=84vw）', mOpen.sidebarRect.w <= Math.round(390 * 0.85)])
checks.push(['手机·展开态：无横向溢出', mOpen.docScrollW <= 390 + 1])

// --- 桌面 1280：两侧状态都不该被改 ---
await openAt(1280, 800)
const dClosed = await snapshot()
const dInline = dClosed.inlineColumns ?? ''
const dComputed = dClosed.computedColumns ?? ''
checks.push(['桌面·收起态：计算列与内联列一致（未被覆盖）', dComputed.replace(/\s+/g, '') === dInline.replace(/\s+/g, '').replace(/;$/, '') + ''  || dComputed.startsWith(dInline.split(' ')[1])])
checks.push(['桌面·收起态：侧栏不是 fixed', dClosed.sidebarPosition !== 'fixed'])

await toggle()
await sleep(1200)
const dOpen = await snapshot()
checks.push(['桌面·展开态：侧栏不是 fixed（桌面保持原生）', dOpen.sidebarPosition !== 'fixed'])
checks.push(['桌面·展开态：内容列 > 600px（未被挤压成条）', dOpen.centerRect.w > 600])

let failed = 0
for (const [label, ok] of checks) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
console.log('\n手机收起:', JSON.stringify({ cols: mClosed.computedColumns, side: mClosed.sidebarRect, center: mClosed.centerRect }))
console.log('手机展开:', JSON.stringify({ cols: mOpen.computedColumns, side: mOpen.sidebarRect, center: mOpen.centerRect, pos: mOpen.sidebarPosition }))
console.log('桌面收起:', JSON.stringify({ inline: dClosed.inlineColumns, computed: dClosed.computedColumns, side: dClosed.sidebarRect }))
console.log('桌面展开:', JSON.stringify({ computed: dOpen.computedColumns, side: dOpen.sidebarRect, center: dOpen.centerRect, pos: dOpen.sidebarPosition }))
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
ws.close()
process.exit(failed === 0 ? 0 : 1)
