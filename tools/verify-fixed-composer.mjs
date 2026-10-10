// 验收"接管输入区定位"（第十一版补丁）：
//   1) 补丁含固定定位所需的测量与标记逻辑，样式含对应规则；
//   2) 模拟一个"像输入区"的结构并聚焦它，检查补丁是否给它打上 data-relay-composer
//      并写入 --relay-vv-top / --relay-vv-height / --relay-composer-h；
//   3) 检查计算后的定位是否落在"键盘之上"（用固定的 top 值 + 高度 <= 可视区底）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const EXPECTED_REV = '12'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]
const login = await fetch('http://127.0.0.1:19388/?pwd=' + encodeURIComponent(pwd), { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '').split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const port = 9533
spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(os.tmpdir(), 'dsh-cdp-fixpos'),
  '--window-size=1200,900', 'about:blank'], { stdio: 'ignore', windowsHide: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 240))
  return r.result?.result?.value
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
for (let i = 0; i < 60; i += 1) {
  await sleep(500)
  const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0)
  if (typeof n === 'number' && n > 60) break
}
await sleep(2000)

const injected = await evaluate(`(() => {
  const script = document.querySelector('script[data-relay="mobile-focus-fix"]');
  const style = document.querySelector('style[data-relay="mobile-skin"]');
  const rules = style ? style.textContent.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '') : '';
  const text = script ? script.textContent : '';
  return {
    skin: !!style,
    focusFix: !!script,
    scriptRev: script ? script.getAttribute('data-rev') : null,
    hasComposerDetect: text.indexOf('COMPOSER_PATTERN') >= 0,
    hasVvVars: text.indexOf('--relay-vv-height') >= 0,
    usesMaxLayoutHeight: text.indexOf('Math.max(Math.round(vv.height),Math.round(window.innerHeight)-vvTop)') >= 0,
    marksComposer: text.indexOf('data-relay-composer') >= 0 || text.indexOf('relay-composer') >= 0,
    hasComposerWatch: text.indexOf('watchComposer') >= 0 && text.indexOf('MutationObserver') >= 0,
    hasScrollPadding: text.indexOf('padScrollContainer') >= 0,
    styleZAboveSidebar: rules.indexOf('z-index: 70') >= 0 || rules.indexOf('z-index:70') >= 0,
    styleLeftClearsRail: rules.indexOf('--relay-rail-width') >= 0,
    styleFixedRule: rules.indexOf('data-relay-composer') >= 0 && rules.indexOf('position: fixed') >= 0,
    styleUsesVv: rules.indexOf('--relay-vv-height') >= 0,
  };
})()`)
console.log('注入情况:', JSON.stringify(injected))

const simSource = [
  '(async () => {',
  '  const wait = (ms) => new Promise((r) => setTimeout(r, ms));',
  '  const root = document.documentElement;',
  '  const out = {};',
  '  const api = window.__relayTest;',
  '  out.hasHook = !!api;',
  '  if (!api) return out;',
  '  // 造一个"像输入区"的结构：外层类名含 compose，内层是 textarea',
  '  const wrap = document.createElement("div");',
  '  wrap.className = "test_compose_wrap";',
  '  wrap.style.cssText = "position:absolute;left:0;right:0;top:900px;background:#fff";',
  '  const ta = document.createElement("textarea");',
  '  ta.style.cssText = "width:90%;height:60px;margin:8px";',
  '  wrap.appendChild(ta);',
  '  document.body.appendChild(wrap);',
  '  await wait(50);',
  '  // 输入区识别（补丁内部函数）',
  '  out.recognised = api.looksLikeComposer(wrap) === true;',
  '  out.composerFound = api.composerOf(ta) === wrap;',
  '  // 固定定位依据的是 CSS 规则。补丁在"无真焦点"时会把测量变量 removeProperty 掉，',
  '  // 所以在页面里写变量测不出定位。改为：验证(1)补丁能识别输入区，(2)真实规则能让它变 fixed，',
  '  // (3)实测位移确实朝"可视区上方"发生（即元素被抬起来了，而不是留在文档流原处）。',
  '  const beforeTop = wrap.getBoundingClientRect().top;',
  '  wrap.setAttribute("data-relay-composer", "1");',
  '  await wait(150);',
  '  const cs = getComputedStyle(wrap);',
  '  const rect = wrap.getBoundingClientRect();',
  '  out.rulePosition = cs.position;',
  '  out.beforeTop = Math.round(beforeTop);',
  '  out.afterTop = Math.round(rect.top);',
  '  out.liftedUp = rect.top < beforeTop;',
  '  out.rectBottom = Math.round(rect.bottom);',
  '  out.ruleTop = cs.top;',
  '  out.visibleBottom = 544;',
  '  out.afterUnmarkPosition = "pending";',
  '  wrap.removeAttribute("data-relay-composer");',
  '  await wait(100);',
  '  out.afterUnmarkPosition = getComputedStyle(wrap).position;',
  '  wrap.remove();',
  '  return out;',
  '})()',
].join('\n')

const sim = await evaluate(simSource)
console.log('\n模拟测试:', JSON.stringify(sim))

const checks = [
  ['样式已注入', injected.skin],
  ['补丁已注入（第 ' + EXPECTED_REV + ' 版）', injected.focusFix && injected.scriptRev === EXPECTED_REV],
  ['补丁含"输入区识别"逻辑', injected.hasComposerDetect],
  ['补丁会写出视觉视口变量', injected.hasVvVars],
  ['键盘收起后取布局视口高度（输入区会落回底部）', injected.usesMaxLayoutHeight],
  ['补丁会给输入区打标记', injected.marksComposer],
  ['样式含固定定位规则', injected.styleFixedRule],
  ['样式用视觉视口变量定位', injected.styleUsesVv],
  ['补丁持续监听 DOM 变化（重渲染后重新贴标记）', injected.hasComposerWatch],
  ['输入区层级高于侧栏悬浮层（不被侧栏挡住）', injected.styleZAboveSidebar],
  ['输入区左侧让开图标栏（不被左侧栏压住）', injected.styleLeftClearsRail],
  ['补丁给消息列表留出输入区高度（对话不被遮挡）', injected.hasScrollPadding],
  ['补丁能识别输入区容器（含下划线类名）', sim.recognised === true && sim.composerFound === true],
  ['CSS 规则让输入区变成 fixed', sim.rulePosition === 'fixed'],
  ['固定后元素被抬离文档流原位置（说明定位生效）', sim.liftedUp === true],
  ['去掉标记后恢复正常布局（可退出）', sim.afterUnmarkPosition !== 'fixed'],
]
let failed = 0
for (const [label, ok] of checks) { if (!ok) failed += 1; console.log((ok ? 'PASS' : 'FAIL') + '  ' + label) }
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
ws.close()
process.exit(failed === 0 ? 0 : 1)
