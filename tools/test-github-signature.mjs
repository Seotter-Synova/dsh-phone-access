// 实测 /github 是否真的严格验签：正确签名必须放行，篡改签名/篡改正文/无签名必须拒绝。
// 打本机中继的 /github（免口令路径），与打公网等价（同一段代码）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const creds = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const secret = creds.match(/^\s+DSH_GITHUB_WEBHOOK_SECRET:\s*(\S+)\s*$/m)[1]

const body = JSON.stringify({
  action: 'opened',
  number: 4242,
  repository: { full_name: process.env.PROBE_REPO || 'owner/repo' },
  pull_request: { number: 4242, title: 'signature-verification-probe', draft: false, head: { sha: 'deadbeef' }, base: { ref: 'main' } },
})
const sign = (b, s = secret) => 'sha256=' + crypto.createHmac('sha256', s).update(b).digest('hex')

async function post(label, { b = body, sig, omitSig = false, event = 'pull_request', extraHeaders = {} } = {}) {
  const headers = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`, ...extraHeaders }
  if (!omitSig) headers['x-hub-signature-256'] = sig ?? sign(b)
  const res = await fetch('http://127.0.0.1:19388/github', { method: 'POST', headers, body: b })
  const text = await res.text().catch(() => '')
  console.log(`${String(label).padEnd(34)} status=${res.status}  ${text.slice(0, 70).replace(/\s+/g, ' ')}`)
  return res.status
}

const results = []
results.push(['无签名', await post('无签名（应拒绝）', { omitSig: true }), [400, 401, 403]])
results.push(['错误密钥签名', await post('错误密钥签名（应拒绝）', { sig: sign(body, 'wrong-secret-' + secret) }), [400, 401, 403]])
results.push(['篡改正文（签名对旧正文）', await post('篡改正文（应拒绝）', { b: body.replace('4242', '9999'), sig: sign(body) }), [400, 401, 403]])
results.push(['签名格式不对', await post('签名格式不对（应拒绝）', { sig: 'sha256=deadbeef' }), [400, 401, 403]])
results.push(['正确签名', await post('正确签名（应接受）', {}), [200, 202, 204]])
results.push(['错误事件类型 + 正确签名', await post('非 pull_request 事件', { event: 'push' }), [200, 202, 204, 400, 404]])

let failed = 0
console.log('')
for (const [label, got, expect] of results) {
  const ok = expect.includes(got)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} → ${got}（期望 ${expect.join('/')}）`)
}
console.log(failed === 0 ? '\nALL PASS: 验签严格（篡改/无签名均被拒，正确签名放行）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
