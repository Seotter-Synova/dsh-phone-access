// 生成"手机访问 DSH"页面（自包含单文件 HTML：二维码内嵌为 data URL，无外部依赖）。
// 用成熟库 qrcode-generator 出矩阵，再由手写 PNG 编码器出图（见 lib.mjs / png.mjs）。
// 用法：node tools/qrcode/make-access-page.mjs --url <公网> --lan <局域网> --pwd <口令> --out <html> [--relay up|down] [--tunnel up|down]
import fs from 'node:fs'
import path from 'node:path'
import { encodeWithLibrary } from './lib.mjs'
import { matrixToPng } from './png.mjs'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const publicUrl = arg('url')
const lanUrl = arg('lan')
const password = arg('pwd')
const out = arg('out')
const relay = arg('relay', 'unknown')
const tunnel = arg('tunnel', 'unknown')

if (!publicUrl || !password || !out) {
  console.error('usage: make-access-page.mjs --url <public> --pwd <password> --out <file.html> [--lan <lan-url>]')
  process.exit(2)
}

// 二维码：内容 = 带口令的一键登录链接
const loginUrl = `${publicUrl}/?pwd=${encodeURIComponent(password)}`
const { matrix, version } = encodeWithLibrary(loginUrl, 'M')
const png = matrixToPng(matrix, 8, 4)
const qrDataUrl = `data:image/png;base64,${png.toString('base64')}`

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const chip = (label, state) => {
  const cls = state === 'up' ? 'chip up' : state === 'down' ? 'chip down' : 'chip unknown'
  const text = state === 'up' ? '正常' : state === 'down' ? '未运行' : '未知'
  return `<span class="${cls}"><i></i>${escapeHtml(label)} ${text}</span>`
}

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>手机访问 DSH</title>
<style>
  :root{
    --bg:#0b0d10; --card:#14181d; --card2:#1a1f26; --line:#252b33;
    --fg:#e8edf3; --muted:#98a3b0; --accent:#4c8dff; --ok:#38c172; --bad:#e05252;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; background:radial-gradient(1200px 600px at 50% -10%,#1b2431 0%,var(--bg) 60%);
    color:var(--fg); font:15px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
    display:flex; align-items:center; justify-content:center; padding:32px 20px;
  }
  .wrap{width:100%; max-width:860px}
  header{text-align:center; margin-bottom:22px}
  h1{font-size:20px; margin:0 0 6px; font-weight:600; letter-spacing:.2px}
  header p{margin:0; color:var(--muted); font-size:13px}
  .grid{display:grid; grid-template-columns:340px 1fr; gap:18px}
  @media (max-width:760px){ .grid{grid-template-columns:1fr} }
  .card{background:linear-gradient(180deg,var(--card2),var(--card)); border:1px solid var(--line);
        border-radius:14px; padding:18px}
  .qr{display:flex; flex-direction:column; align-items:center; gap:12px}
  .qr img{width:100%; max-width:300px; border-radius:10px; background:#fff; padding:12px; display:block}
  .qr small{color:var(--muted); font-size:12px; text-align:center}
  .row{margin-bottom:14px}
  .row:last-child{margin-bottom:0}
  .label{font-size:12px; color:var(--muted); margin-bottom:6px; letter-spacing:.3px}
  .value{display:flex; align-items:center; gap:8px}
  code, .code{font:13px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace; word-break:break-all;
        background:#0e1216; border:1px solid var(--line); border-radius:9px; padding:10px 12px; flex:1}
  button{background:var(--accent); color:#fff; border:0; border-radius:9px; padding:10px 14px;
         font-size:13px; cursor:pointer; white-space:nowrap; transition:filter .15s}
  button:hover{filter:brightness(1.1)}
  button.ghost{background:#232a33}
  .chips{display:flex; flex-wrap:wrap; gap:8px}
  .chip{display:inline-flex; align-items:center; gap:7px; font-size:12px; color:var(--muted);
        background:#0e1216; border:1px solid var(--line); border-radius:999px; padding:6px 11px}
  .chip i{width:7px; height:7px; border-radius:50%; background:#8b949e; display:inline-block}
  .chip.up i{background:var(--ok)} .chip.down i{background:var(--bad)}
  .tips{margin-top:16px; color:var(--muted); font-size:12.5px; line-height:1.8}
  .tips b{color:#c8d2de; font-weight:600}
  .copied{color:var(--ok); font-size:12px; min-height:16px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>手机访问 DSH</h1>
    <p>用手机相机扫左边二维码即可免口令进入；也可手动输入下面的地址与口令</p>
  </header>
  <div class="grid">
    <div class="card qr">
      <img src="${qrDataUrl}" alt="手机访问二维码" width="300" height="300">
      <small>二维码已内嵌（不含外部请求）· v${version}</small>
    </div>
    <div class="card">
      <div class="row">
        <div class="label">外网地址（任何网络都能用）</div>
        <div class="value">
          <code id="pub">${escapeHtml(publicUrl)}</code>
          <button onclick="copy('pub',this)">复制</button>
        </div>
      </div>
      <div class="row">
        <div class="label">口令（首次打开需要，记住 72 小时）</div>
        <div class="value">
          <code id="pwd">${escapeHtml(password)}</code>
          <button onclick="copy('pwd',this)">复制</button>
        </div>
      </div>
      ${lanUrl ? `<div class="row">
        <div class="label">局域网地址（手机与电脑同一 Wi-Fi）</div>
        <div class="value">
          <code id="lan">${escapeHtml(lanUrl)}</code>
          <button class="ghost" onclick="copy('lan',this)">复制</button>
        </div>
      </div>` : ''}
      <div class="row">
        <div class="label">状态</div>
        <div class="chips">
          ${chip('中继', relay)}
          ${chip('隧道', tunnel)}
        </div>
      </div>
      <div class="copied" id="msg"></div>
    </div>
  </div>
  <div class="tips">
    <b>用法</b>：先打开 DSH，再双击桌面「手机访问DSH.cmd」，这张页面会自动弹出；手机扫码或手动登录即可。<br>
    <b>域名会变</b>：每次重启电脑后隧道域名都会换，重新双击一次脚本拿新页面即可（GitHub webhook 会自动跟着改）。<br>
    <b>前提</b>：电脑开着、插着电（电池下 5 分钟会睡），DSH 开着。<br>
    <b>安全</b>：这个地址是公网入口，别截图外传；口令泄露了就跑 <code>node tools\\set-credential-ref.mjs PHONE_ACCESS_PASSWORD</code> 换一个。
  </div>
</div>
<script>
  function copy(id, btn) {
    const text = document.getElementById(id).textContent;
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制';
      document.getElementById('msg').textContent = '已复制到剪贴板';
      setTimeout(() => { btn.textContent = old; document.getElementById('msg').textContent = ''; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }
</script>
</body>
</html>
`

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log(JSON.stringify({
  out,
  bytes: Buffer.byteLength(html),
  loginUrlLength: loginUrl.length,
  qrVersion: version,
  qrPngBytes: png.length,
  relay,
  tunnel,
}))
