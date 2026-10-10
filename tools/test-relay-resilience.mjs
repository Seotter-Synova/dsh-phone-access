// 回归测试：中继在"客户端粗暴断开"下必须存活（2026-10-10 的真实崩溃点）。
// 用法：node tools/test-relay-resilience.mjs [port]
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.argv[2] ?? 19388)
const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const pwd = creds.match(/^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$/m)[1]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function isAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    return res.status === 401 || res.status === 200 || res.status === 303
  } catch {
    return false
  }
}

function abruptClose() {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      // 发半截请求头就销毁（模拟客户端中断）
      sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
      setTimeout(() => { sock.destroy(); resolve('destroyed') }, 20)
    })
    sock.on('error', () => resolve('error'))
  })
}

function resetMidBody() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/__login', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    req.on('error', () => resolve('error'))
    req.write('password=abc')            // 写一半
    setTimeout(() => { req.destroy(); resolve('reset') }, 20)
  })
}

const results = []
results.push(['初始存活', await isAlive()])
for (let i = 0; i < 10; i += 1) await abruptClose()
await sleep(300)
results.push(['10 次半截请求后仍存活', await isAlive()])
for (let i = 0; i < 10; i += 1) await resetMidBody()
await sleep(300)
results.push(['10 次中断 POST 后仍存活', await isAlive()])
for (let i = 0; i < 5; i += 1) { await abruptClose(); await resetMidBody() }
await sleep(500)
const alive = await isAlive()
results.push(['混合 10 次暴力断开后仍存活', alive])

// 功能仍正常：一键登录应 303
const login = await fetch(`http://127.0.0.1:${port}/?pwd=${encodeURIComponent(pwd)}`, { redirect: 'manual' })
results.push(['一键登录仍返回 303', login.status === 303])

let failed = 0
for (const [label, ok] of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
