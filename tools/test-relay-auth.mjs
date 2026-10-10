// 验证中继的口令闸：未登录应被挡、登录后应放行、错口令应被拒。
// 用法：node tools/test-relay-auth.mjs <baseUrl> [口令]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:19388'
const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const password = process.argv[3] ?? creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)?.[1]
if (!password) throw new Error('拿不到口令')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
}

// 1. 未登录
const anon = await fetch(`${base}/`)
const anonBody = await anon.text()
check('未登录被挡', anon.status === 401 && anonBody.includes('DSH 需要口令'), `status=${anon.status}`)

// 2. 错口令
const bad = await fetch(`${base}/__login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: 'definitely-wrong' }).toString(),
  redirect: 'manual',
})
const badBody = await bad.text()
check('错口令被拒', bad.status === 401 && badBody.includes('口令不对'), `status=${bad.status}`)

// 3. 正确口令 → 拿到会话 cookie
const login = await fetch(`${base}/__login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password }).toString(),
  redirect: 'manual',
})
const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? ''
const sessionCookie = setCookie.split(';')[0]
check('正确口令签出会话', login.status === 303 && sessionCookie.startsWith('dsh-relay-session='), `status=${login.status} cookie=${sessionCookie.slice(0, 28)}…`)

// 4. 带会话访问 GUI
const authorized = await fetch(`${base}/`, { headers: { cookie: sessionCookie } })
const authorizedBody = await authorized.text()
check('带会话可访问 GUI', authorized.status === 200 && authorizedBody.includes('__DSH_BOOT__'), `status=${authorized.status} bytes=${authorizedBody.length}`)

// 5. 伪造会话被拒
const forged = await fetch(`${base}/`, { headers: { cookie: 'dsh-relay-session=eyJleHBpcmVzQXQiOjk5OTk5OTk5OTk5OTl9.bogus' } })
check('伪造会话被拒', forged.status === 401, `status=${forged.status}`)

// 6. /github 免口令直通（应到 webhook 适配器，而不是登录页）
const hookNoSig = await fetch(`${base}/github`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
const hookBody = await hookNoSig.text()
check('/github 免口令直通到 webhook', hookNoSig.status === 400 && /signature/i.test(hookBody), `status=${hookNoSig.status} body=${hookBody.slice(0, 60)}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
