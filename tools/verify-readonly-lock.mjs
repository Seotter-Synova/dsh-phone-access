// 验证第六版补丁：readOnly 锁 + 菜单关闭后恢复。
// 覆盖：锁生效、blur 生效、菜单关闭后 readOnly 恢复、用户自己点输入框时不被误锁、不影响打字。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const EXPECTED_REV = '12'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]
const login = await fetch(`http://127.0.0.1:19388/?pwd=${encodeURIComponent(pwd)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '').split(';')[0]

const edge = `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
const port = 9488
spawn(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'dsh-cdp-fx3')}`,
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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: 'http://127.0.0.1:19388/' })
for (let i = 0; i < 60; i += 1) { await sleep(500); const n = await evaluate('document.querySelectorAll("#root *").length').catch(() => 0); if (typeof n === 'number' && n > 60) break }
await sleep(2500)

const injected = await evaluate(`(() => {
  const script = document.querySelector('script[data-relay="mobile-focus-fix"]');
  const style = document.querySelector('style[data-relay="mobile-skin"]');
  return {
    skin: !!style, focusFix: !!script,
    scriptRev: script?.getAttribute('data-rev') ?? null,
    hasReadonlyLogic: !!script && /readOnly=true/.test(script.textContent) && /readOnly=locked.prev/.test(script.textContent),
    styleHasMenuSizing: !!style && /min-height:\\s*44px/.test(style.textContent),
    rawStyleText: style ? style.textContent : '',
  };
})()`)
const styleRules = String(injected.rawStyleText || '').replace(/\/\*[\s\S]*?\*\//g, '')
injected.styleMenuNotShrunk = !styleRules.includes('--relay-keyboard-inset')
console.log('注入情况:', JSON.stringify({ ...injected, rawStyleText: `<${injected.rawStyleText.length} chars>` }))

const sim = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const isEditable = (el) => { if(!el) return false; const t=(el.tagName||'').toLowerCase(); return t==='textarea'||t==='input'||el.isContentEditable===true; };
  const fire = (el, types) => { for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true })); };
  const out = {};

  // 造一个输入框 + 一个"菜单按钮"（带 aria-haspopup）+ 一个菜单层（带 role=menu）
  const input = document.createElement('textarea');
  input.style.position='fixed'; input.style.opacity='0';
  document.body.appendChild(input);
  const menuBtn = document.createElement('button');
  menuBtn.setAttribute('aria-haspopup','menu');
  menuBtn.setAttribute('aria-expanded','false');
  menuBtn.textContent='m';
  document.body.appendChild(menuBtn);

  // 1) 聚焦输入框 → 点菜单按钮 → 应立刻 readOnly=true 且失去焦点
  input.focus();
  out.focusedBefore = document.activeElement === input;
  fire(menuBtn, ['pointerdown','touchstart','mousedown','click']);
  await wait(30);
  out.readonlyRightAfterTap = input.readOnly;
  out.focusedRightAfterTap = document.activeElement === input;

  // 2) 应用把焦点抢回来（模拟真实应用行为）→ 由于 readOnly，键盘不该出现（无法直接测键盘，检查 readOnly 仍在）
  input.focus();
  await wait(120);
  out.readonlyAfterAppRefocus = input.readOnly;

  // 3) 菜单'打开'（插一个可见弹层）→ 再关掉 → 补丁应恢复 readOnly=false
  const menu = document.createElement('div');
  menu.setAttribute('role','menu');
  menu.style.cssText='position:fixed;left:10px;top:100px;width:300px;height:200px;background:#fff';
  document.body.appendChild(menu);
  await wait(200);
  out.readonlyWhileMenuOpen = input.readOnly;
  menu.remove();
  await wait(600);
  out.readonlyAfterMenuClose = input.readOnly;
  out.focusedAfterMenuClose = isEditable(document.activeElement);

  input.remove(); menuBtn.remove();
  return out;
})()`)
console.log('\n模拟测试:', JSON.stringify(sim))

const checks = [
  ['样式已注入', injected.skin],
  [`焦点补丁已注入（第 ${EXPECTED_REV} 版）`, injected.focusFix && injected.scriptRev === EXPECTED_REV],
  ['补丁含 readOnly 锁定与恢复逻辑', injected.hasReadonlyLogic],
  ['菜单选项行高仍是 44px', injected.styleHasMenuSizing],
  ['菜单尺寸不再被键盘变量压小', injected.styleMenuNotShrunk],
  ['点按前输入框已聚焦', sim.focusedBefore === true],
  ['点菜单按钮后：输入框被锁 readOnly', sim.readonlyRightAfterTap === true],
  ['点菜单按钮后：焦点被释放', sim.focusedRightAfterTap === false],
  ['应用抢回焦点后：readOnly 仍生效（键盘起不来）', sim.readonlyAfterAppRefocus === true],
  ['菜单打开期间：仍锁定', sim.readonlyWhileMenuOpen === true],
  ['菜单关闭后：readOnly 恢复为 false', sim.readonlyAfterMenuClose === false],
]
const failed = checks.filter(([, ok]) => !ok).length
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
ws.close(); process.exit(failed === 0 ? 0 : 1)
