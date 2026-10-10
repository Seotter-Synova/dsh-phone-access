// 手机 / 外网访问 DSH GUI 的中继：鉴权 + 口令 + 可选 webhook 直通。
//
// 它解决三件事：
//   1. DSH GUI 的 Host/Origin 围栏只认本机 —— 中继把 Host/Origin 改写成回环地址；
//   2. DSH GUI 用「进程启动令牌换签名 cookie」鉴权，而桌面应用不打印那个令牌 ——
//      中继用持久存在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 密钥
//      自己签一个合法 cookie 注入（格式与 client-connection 的实现一致）；
//   3. 暴露到公网需要自己的口令 —— 中继前置一个口令闸（登录页 + HMAC 签名的会话 cookie）。
//
// `/github` 路径是直通：不查口令（GitHub 不会带口令），转给本机 webhook 监听器，安全性由
// GitHub 自己的 HMAC 签名（x-hub-signature-256）保证。这样一条隧道同时服务 GUI 和 webhook。
//
// 用法：
//   node tools/dsh-auth-relay.mjs [--listen 0.0.0.0:19388] [--target 127.0.0.1:19387]
//                                [--webhook 127.0.0.1:3081] [--pwd-env PHONE_ACCESS_PASSWORD]
//                                [--session-hours 72] [--no-password]
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const out = {
    listen: '0.0.0.0:19388',
    target: '127.0.0.1:19387',
    webhook: '127.0.0.1:3081',
    pwdEnv: 'PHONE_ACCESS_PASSWORD',
    sessionHours: 72,
    password: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--listen') out.listen = argv[++i]
    else if (arg === '--target') out.target = argv[++i]
    else if (arg === '--webhook') out.webhook = argv[++i]
    else if (arg === '--pwd-env') out.pwdEnv = argv[++i]
    else if (arg === '--session-hours') out.sessionHours = Number(argv[++i])
    else if (arg === '--no-password') out.password = false
  }
  return out
}

const splitAuthority = (value) => {
  const [host, port] = value.split(':')
  return { host, port: Number(port) }
}
const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const config = parseArgs(process.argv.slice(2))
const listenAddr = splitAuthority(config.listen)
const targetAddr = splitAuthority(config.target)
const webhookAddr = splitAuthority(config.webhook)

// ---------- 凭据 ----------
const credsPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const creds = fs.readFileSync(credsPath, 'utf8')

const secretB64 = creds.match(
  /client-connection\/browser-session:\s*\n\s+kind:\s*grant\s*\n\s+payload:\s*\n\s+version:\s*1\s*\n\s+secret:\s*(\S+)/,
)?.[1]
if (!secretB64) {
  console.error('找不到 client-connection/browser-session 的签名密钥，先让 DSH 跑一次再试')
  process.exit(1)
}
const dshSecret = Buffer.from(secretB64.replaceAll('-', '+').replaceAll('_', '/'), 'base64')

const password = (() => {
  if (!config.password) return undefined
  const match = creds.match(new RegExp(`^\\s+${config.pwdEnv}:\\s*(\\S+)\\s*$`, 'm'))
  if (!match) {
    console.error(
      `凭据库里没有 ${config.pwdEnv}。先加一条 refs: ${config.pwdEnv}: <口令>（或 --no-password 显式关掉口令）`,
    )
    process.exit(1)
  }
  return match[1]
})()

// ---------- DSH 侧 cookie（让后端以为是本机已认证浏览器）----------
const backendAuthority = `${targetAddr.host}:${targetAddr.port}`
const dshCookieName = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(backendAuthority).digest())

function mintDshCookie() {
  const now = Date.now()
  const payload = { version: 1, authority: backendAuthority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64url(crypto.createHmac('sha256', dshSecret).update(body).digest())
  return `v1.${body}.${signature}`
}

// ---------- 中继自己的口令会话（与 DSH 那套无关）----------
const SESSION_COOKIE = 'dsh-relay-session'

// 会话 cookie 的属性。Secure 必须**按请求协议条件化**：
//   - 公网入口（Cloudflare 隧道）→ https，加 Secure，防止凭证以后被明文请求带走；
//   - 局域网入口 http://<内网IP>:19388 → 明文，若加 Secure 浏览器会直接拒绝保存，
//     等于局域网登录彻底失效（所以不能无条件加）。
//
// 判断依据的取舍（2026-10-10 实测后收紧）：
//   拓扑是 `cloudflared tunnel --url http://127.0.0.1:19388` 而中继监听 0.0.0.0:19388，
//   即**隧道与局域网共用同一个监听口**，中继无法从协议上区分二者。
//   因此 Host 头是唯一可靠的判据：局域网客户端无法证明自己是隧道域名（除非它真的经 Cloudflare 过来，
//   而 *.trycloudflare.com 的 DNS 指向 Cloudflare，不会解析到内网机器）。
//   `x-forwarded-proto` **可由任何直连客户端伪造**（实测：内网 Host + 自带 XFP:https 会让旧实现加上
//   Secure），所以它只能作为"Host 不是隧道域名"时的补充信号，绝不能单独作为信任依据。
function isSecureRequest(headers) {
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? '').toLowerCase()
  if (host.endsWith('.trycloudflare.com')) return true   // Host 判定优先，且不可被直连客户端伪造
  if (host) return false                                  // 非隧道域名（内网 IP / 本机）→ 一律按明文
  const proto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return proto === 'https'
}

function sessionCookie(headers, ttlMs) {
  const parts = [
    `${SESSION_COOKIE}=${mintSession(ttlMs)}`,
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (isSecureRequest(headers)) parts.push('Secure')
  return parts.join('; ')
}
const sessionKey = crypto.randomBytes(32)

function mintSession(ttlMs) {
  const expiresAt = Date.now() + ttlMs
  const body = b64url(Buffer.from(JSON.stringify({ expiresAt }), 'utf8'))
  return `${body}.${b64url(crypto.createHmac('sha256', sessionKey).update(body).digest())}`
}

function sessionValid(value) {
  if (typeof value !== 'string') return false
  const [body, signature] = value.split('.')
  if (!body || !signature) return false
  const expected = crypto.createHmac('sha256', sessionKey).update(body).digest()
  let actual
  try {
    actual = Buffer.from(signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  } catch {
    return false
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false
  try {
    const payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    return typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now()
  } catch {
    return false
  }
}

function passwordMatches(candidate) {
  if (password === undefined) return true
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(password, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- 移动端样式注入 ----------
// 手机浏览器里 DSH 的桌面布局偏挤；中继在返回 HTML 时把一份覆盖样式追加到 </head> 前。
// 只在窄屏生效（样式层内部包了 @media），桌面端行为不变。样式文件缺失/上游压缩编码时静默跳过。
const MOBILE_SKIN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'webhook-projects', 'github-review', 'mobile-skin.css',
)
let mobileSkinCache = null
function mobileSkin() {
  if (mobileSkinCache !== null) return mobileSkinCache
  try {
    mobileSkinCache = fs.readFileSync(MOBILE_SKIN_PATH, 'utf8')
    log(`mobile skin loaded (${mobileSkinCache.length} bytes)`)
  } catch (error) {
    mobileSkinCache = ''
    log(`mobile skin unavailable: ${error.message}`)
  }
  return mobileSkinCache
}

function injectMobileSkin(html) {
  const css = mobileSkin()
  if (!css || !html) return html
  // 带版本号：手机刷新后可以直接看页面源码确认拿到的是不是新样式（排查缓存问题时很有用）
  const stamp = crypto.createHash('sha1').update(css).digest('hex').slice(0, 8)
  const tag = `<style data-relay="mobile-skin" data-skin-rev="${stamp}">\n${css}\n</style>`
  const patched = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
  // 焦点补丁：样式管不了"点开菜单时输入框仍被聚焦 → 手机键盘弹出来盖住菜单"。
  // 2026-10-10 第二版：第一版只在 click 捕获阶段 blur，实测无效（手机仍弹键盘），原因是
  //   a) 触发路径很可能走 pointerdown/touchstart，而不是 click；
  //   b) 即使 blur 了，应用可能在该手势之后重新聚焦输入框。
  // 所以现在：四种事件都监听、blur 延后到本次手势收尾之后（setTimeout 0）再执行，
  // 并记录命中次数到 document.documentElement.dataset.relayBlurCount，便于事后核对是否生效。
  const focusFix = `<script data-relay="mobile-focus-fix" data-rev="12">(function(){try{
if(!window.matchMedia||!matchMedia("(max-width: 820px)").matches)return;
var root=document.documentElement;
// 被锁的编辑器：{el, kind, prev}。菜单打开期间 readOnly，菜单关闭后恢复原样。
var locked=null;
var menuObserver=null;
var generation=0;
function isEditable(el){
  if(!el)return false;
  var tag=(el.tagName||"").toLowerCase();
  return tag==="textarea"||tag==="input"||el.isContentEditable===true;
}
function bump(tag){
  var n=(parseInt(root.dataset.relayBlurCount||"0",10)||0)+1;
  root.dataset.relayBlurCount=String(n);
  root.dataset.relayBlurFrom=tag||"";
}
function lockEditing(){
  var el=document.activeElement;
  if(!isEditable(el))return false;
  if(locked&&locked.el===el)return true;
  unlockEditing();
  var tag=(el.tagName||"").toLowerCase();
  if(tag==="textarea"||tag==="input"){
    locked={el:el,kind:"readonly",prev:el.readOnly};
    el.readOnly=true;
  }else{
    locked={el:el,kind:"contenteditable",prev:el.getAttribute("contenteditable")};
    el.setAttribute("contenteditable","false");
  }
  root.dataset.relayEditingLocked="1";
  return true;
}
function unlockEditing(){
  if(!locked)return;
  try{
    if(locked.kind==="readonly")locked.el.readOnly=locked.prev;
    else if(locked.prev===null)locked.el.removeAttribute("contenteditable");
    else locked.el.setAttribute("contenteditable",locked.prev);
  }catch(e){}
  locked=null;
  delete root.dataset.relayEditingLocked;
}
function blurIfEditable(tag){
  var active=document.activeElement;
  if(isEditable(active)){try{active.blur()}catch(e){}bump(tag);return true}
  return false;
}
// 菜单是否还开着：只看"真的存在可见弹层"。
// 注意不要看触发按钮自己的 aria-expanded —— 实测点开后它一直是 true，
// 会让"菜单已关闭"永远判不出来，readOnly 就一直不恢复（踩过）。
function menuStillOpen(){
  var layers=document.querySelectorAll("[role=menu],[role=listbox],[class*=popover],[class*=Popover],[class*=dropdown],[class*=Dropdown]");
  for(var i=0;i<layers.length;i++){
    var el=layers[i];
    if(el.tagName==="BUTTON")continue;
    var r=el.getBoundingClientRect();
    if(r.width>40&&r.height>40)return true;
  }
  return false;
}
// 观察菜单关闭 → 恢复输入框；另有 8 秒兜底轮询，绝不把输入框永久锁死。
// 用轮询而不是 MutationObserver：观察器只看"当前状态"，实测菜单插入前它就已把 closedSince 置上，
// 之后菜单再插入/移除时状态判断会错位，导致恢复不触发。轮询简单且可靠。
function watchMenuClose(){
  if(menuObserver)clearInterval(menuObserver);
  var deadline=Date.now()+8000;
  menuObserver=setInterval(function(){
    if(!menuStillOpen()||Date.now()>deadline){
      clearInterval(menuObserver);
      menuObserver=null;
      unlockEditing();
    }
  },200);
}
function onGesture(event){
  var node=event.target;
  while(node&&node!==document.body){
    if(node.tagName==="BUTTON"||(node.getAttribute&&node.getAttribute("role")==="button")){
      if(node.hasAttribute&&(node.hasAttribute("aria-haspopup")||node.hasAttribute("aria-expanded"))){
        var tag=event.type;
        // 关键一步：先给编辑器上 readOnly —— 这是唯一能真正阻止 iOS 弹键盘的手段
        lockEditing();
        // 再释放焦点，并在随后一段时间里防止应用把焦点抢回去
        var mine=++generation;
        blurIfEditable(tag);
        [0,60,180,360,640].forEach(function(delay){
          setTimeout(function(){if(mine!==generation)return;blurIfEditable(tag)},delay);
        });
        watchMenuClose();
      }
      return;
    }
    node=node.parentElement;
  }
}
for(const type of ["pointerdown","touchstart","mousedown","click"]){
  document.addEventListener(type,onGesture,true);
}
// 用户自己点编辑器时：作废待执行的压制；若锁的不是它，解除锁（避免误锁）
document.addEventListener("focusin",function(event){
  if(isEditable(event.target)){
    generation++;
    if(locked&&locked.el!==event.target)unlockEditing();
  }
},true);
// ---- 底部遮挡补偿（2026-10-10 阿特反馈"输入的字被下面的网址栏挡住"）----
// 前一阶段做法（留白 + 滚动纠正）与 iOS 的自动滚动互相抢位置，加图片后仍会输。
// 阿特拍定：**接管定位** —— 把输入区固定贴在可视区底部（键盘之上），Safari 怎么滚都影响不到它。
// 这里负责测量并用 CSS 变量驱动：--relay-vv-top / --relay-vv-height / --relay-composer-h。
// 注意：这段代码整体在 JS 模板字符串里，注释中绝对不能出现反引号（会把模板提前闭合，踩过）。
var blankTimer=null;
var lastFocusAt=0;
var blankObserver=null;
var observedBox=null;
var lastEditor=null;
var paddedScroller=null;
var COMPOSER_PATTERN=/(^|[^a-z])compose|composer/i;
// 上面这条在含下划线的类名（如实测的 RlGAzG_compose、test_compose_wrap）上匹配不到，
// 所以再补一条宽松的兜底判断：类名里只要包含 compose 就算。
function looksLikeComposer(el){
  var cls=(typeof el.className==="string")?el.className:"";
  if(COMPOSER_PATTERN.test(cls))return true;
  return /compose/i.test(cls);
}
// 输入区尺寸变化也要重算：阿特实测"加了图片后再打字就跳到被挡位置"——有图片时输入区变高。
function observeComposer(box){
  if(!box||!window.ResizeObserver)return;
  if(observedBox===box&&blankObserver)return;
  if(blankObserver)blankObserver.disconnect();
  observedBox=box;
  blankObserver=new ResizeObserver(function(){syncBlankSoon()});
  try{blankObserver.observe(box)}catch(e){}
}
function syncBlank(){
  var vv=window.visualViewport;
  var el=focusedEditor();
  // 关键修正（阿特实测："只要点击输入区外侧，就会变回原来网页的输入区并被挡"）：
  // 标记**不能随失焦撤掉** —— 用户点输入区外面（看历史消息、点按钮）时输入区仍需保持贴底。
  // 所以标记与测量值跟"输入区这个元素是否存在"绑定，而不是跟焦点绑定。
  var lane=el||lastEditor||anyEditor();
  if(el)lastEditor=el;
  if(lane&&lane.isConnected!==false){
    if(fixComposer(lane)){
      if(vv){
        // 键盘收起后 visualViewport.height 可能仍是收缩值（阿特实测"键盘收起来后输入框没往下移"），
        // 所以取"视觉视口高度"与"布局视口高度"的较大者：没有编辑焦点时即为整屏高度 → 输入区自动落回底部。
        var vvTop=Math.round(vv.offsetTop);
        var vvH=Math.max(Math.round(vv.height),Math.round(window.innerHeight)-vvTop);
        root.style.setProperty("--relay-vv-top",vvTop+"px");
        root.style.setProperty("--relay-vv-height",vvH+"px");
      }
      root.dataset.relayComposerFixed="1";
    }
  }else if(!el){
    // 输入区真的从 DOM 里消失了（换页面/换会话）才撤掉
    lastEditor=null;
    markComposer(null);
    root.style.removeProperty("--relay-vv-top");
    root.style.removeProperty("--relay-vv-height");
    root.style.removeProperty("--relay-composer-h");
    delete root.dataset.relayComposerFixed;
  }
  // 兼容旧路径的滚动纠正（只在输入区确实压在可视区底部附近时才动，避免把用户从历史消息里拽走）
  if(vv&&el&&Date.now()-lastFocusAt>400){
    try{
      var br=el.getBoundingClientRect();
      var visibleBottom=vv.offsetTop+vv.height;
      if(br.bottom>visibleBottom-8&&br.bottom<visibleBottom+260){
        var box=composerOf(el)||el;
        try{box.scrollIntoView({block:"center",inline:"nearest"})}catch(e){}
        root.dataset.relayCentered="1";
      }
    }catch(e){}
  }
}
function focusedEditor(){
  var el=document.activeElement;
  if(!el)return null;
  var tag=(el.tagName||"").toLowerCase();
  return (tag==="textarea"||tag==="input"||el.isContentEditable===true)?el:null;
}
// 找输入区容器：从可编辑元素往上找一个"像输入区"的祖先
function composerOf(el){
  for(var p=el.parentElement;p&&p!==document.body;p=p.parentElement){
    if(looksLikeComposer(p)&&p.getBoundingClientRect().height>24)return p;
  }
  return null;
}
// 给滚动容器留出输入区的身高，否则最后一段对话会被压在输入区下面（阿特实测"输入区遮挡对话内容"）。
// 不能只靠 CSS 选择器猜：实测真正滚动的是内部容器，所以从输入区往上找第一个可滚动的祖先。
function padScrollContainer(box,h){
  if(!box)return false;
  var pad=Math.round(h)+24;
  var scroller=null;
  for(var p=box.parentElement;p&&p!==document.body;p=p.parentElement){
    var cs=getComputedStyle(p);
    var oy=cs.overflowY;
    var canScroll=(oy==="auto"||oy==="scroll"||oy==="overlay");
    if(canScroll&&p.clientHeight>120){scroller=p;break}
  }
  if(!scroller)return false;
  if(paddedScroller&&paddedScroller!==scroller)try{paddedScroller.style.paddingBottom=""}catch(e){}
  paddedScroller=scroller;
  scroller.style.paddingBottom=pad+"px";
  return true;
}
function markComposer(box){
  if(observedBox&&observedBox!==box)observedBox.removeAttribute("data-relay-composer");
  if(box)box.setAttribute("data-relay-composer","1");
}
function fixComposer(el){
  var box=composerOf(el);
  if(!box)return false;
  if(observedBox!==box){
    markComposer(box);
    observeComposer(box);
  }
  // 让占位父元素保持原高度，避免输入区脱离文档流后页面塌掉一块
  var parent=box.parentElement;
  var h=box.getBoundingClientRect().height;
  root.style.setProperty("--relay-composer-h",Math.round(h)+"px");
  if(parent)parent.style.minHeight=Math.round(h)+"px";
  // 同时给消息列表留出等高的空间，避免最后一段对话被压在输入区下面
  padScrollContainer(box,h);
  return true;
}
// 文档里当前的编辑器（不要求有焦点：点输入区外面时也要保持贴底）
function anyEditor(){
  var el=document.querySelector('textarea,[contenteditable="true"],input[type="text"]');
  return el&&el.isConnected!==false?el:null;
}
function syncBlankSoon(){
  if(blankTimer)clearTimeout(blankTimer);
  blankTimer=setTimeout(function(){blankTimer=null;syncBlank()},60);
}
if(window.visualViewport){
  window.visualViewport.addEventListener("resize",syncBlankSoon);
  window.visualViewport.addEventListener("scroll",syncBlankSoon);
}else{
  window.addEventListener("resize",syncBlankSoon);
}
window.addEventListener("orientationchange",function(){setTimeout(syncBlank,200)});
document.addEventListener("focusin",function(){
  lastFocusAt=Date.now();
  setTimeout(syncBlank,200);
  setTimeout(syncBlank,500);
},true);
document.addEventListener("focusout",function(){setTimeout(syncBlank,200)},true);
// 打字时视觉视口的 scroll/resize 会连续触发（Safari 滚动光标）→ 每次都校正一次；
// 补一个"打字后稍等再校正一次"，让 Safari 先滚完、我们再把它拉回来。
document.addEventListener("input",function(){
  syncBlankSoon();
  setTimeout(syncBlank,120);
  setTimeout(syncBlank,320);
},true);
syncBlank();
watchComposer();
// 视觉视口 → CSS 变量（固定定位靠它贴到键盘之上）
function syncViewportVars(){
  var vv=window.visualViewport;
  if(!vv)return false;
  root.style.setProperty("--relay-vv-top",Math.round(vv.offsetTop)+"px");
  root.style.setProperty("--relay-vv-height",Math.round(vv.height)+"px");
  return true;
}
// 阿特实测："只有第一次进入时有那个（固定好的）输入区，随后会变回原样并被挡"——
// 说明 DSH 重渲染把标记弄丢了（元素被替换或属性被覆盖）。用 MutationObserver 持续补标记。
var composerWatch=null;
function watchComposer(){
  if(composerWatch)return;
  composerWatch=new MutationObserver(function(){syncBlankSoon()});
  try{composerWatch.observe(document.body,{childList:true,subtree:true})}catch(e){}
}
// 测试钩子：把纯函数暴露出来，便于用合成元素直接验收（真机路径仍是 focus→syncBlank）。
window.__relayTest={
  syncBlank:syncBlank,
  syncViewportVars:syncViewportVars,
  composerOf:composerOf,
  fixComposer:fixComposer,
  looksLikeComposer:looksLikeComposer,
  focusedEditor:focusedEditor
};
}catch(e){}})();</script>`
  if (patched.includes('</body>')) return patched.replace('</body>', `${focusFix}</body>`)
  return patched + focusFix
}

// 上游可能带 content-encoding（实测 DSH 首页返回 gzip，即使 entity 本身是明文）。
// 注入必须先把 body 解出来；解不开就原样回传，绝不破坏响应。
function decodeBody(buffer, encoding) {
  try {
    if (!encoding) return buffer
    const enc = String(encoding).toLowerCase()
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer)
    if (enc.includes('deflate')) return zlib.inflateSync(buffer)
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer)
    return buffer
  } catch (error) {
    log(`decodeBody failed (${encoding}): ${error.message}`)
    return null
  }
}

function cookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

const log = (msg) => console.log(`[relay ${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ---------- 转发 ----------
function forwardedHeaders(incoming) {
  const headers = { ...incoming }
  headers.host = backendAuthority
  if (headers.origin !== undefined && !/^http:\/\/(127\.|localhost)/.test(headers.origin)) {
    headers.origin = `http://${backendAuthority}`
  }
  headers.cookie = `${dshCookieName}=${mintDshCookie()}`
  delete headers['content-length']
  delete headers['transfer-encoding']
  return headers
}

// 给一个流挂上"出错不致命"的处理器。
// 2026-10-10 修的真实崩溃：中继会因 ECONNRESET 未处理而**整个进程退出**
// （客户端中途断开 / 我在探测时反复连断就会触发）。任何 socket 的 error 都必须被吃掉并记录。
function guard(stream, label) {
  if (!stream || typeof stream.on !== 'function') return
  stream.on('error', (error) => {
    if (error?.code === 'ECONNRESET' || error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      log(`${label}: ${error.code}（客户端断开，忽略）`)
    } else {
      log(`${label}: ${error?.code ?? 'error'} ${error?.message ?? ''}`)
    }
  })
}

function proxy(req, res, upstreamAddr) {
  const headers = forwardedHeaders(req.headers)
  guard(req, 'client req')
  guard(res, 'client res')
  const upstream = http.request(
    { host: upstreamAddr.host, port: upstreamAddr.port, method: req.method, path: req.url, headers },
    (upRes) => {
      guard(upRes, 'upstream res')
      const contentType = String(upRes.headers['content-type'] ?? '')
      const contentEncoding = upRes.headers['content-encoding']
      // HTML 才注入：先按 content-encoding 解出来，改完以明文回传（去掉编码头）
      if (contentType.includes('text/html')) {
        const chunks = []
        upRes.on('data', (chunk) => chunks.push(chunk))
        upRes.on('end', () => {
          const raw = Buffer.concat(chunks)
          const decoded = decodeBody(raw, contentEncoding)
          if (decoded === null) {
            // 解不开就原样回传（含原有编码头）
            res.writeHead(upRes.statusCode ?? 502, upRes.headers)
            res.end(raw)
            return
          }
          const patched = Buffer.from(injectMobileSkin(decoded.toString('utf8')), 'utf8')
          const outHeaders = { ...upRes.headers }
          // 我们自己定长度：必须同时去掉 content-encoding 与 transfer-encoding，
          // 否则 "Content-Length can't be present with Transfer-Encoding"（实测报错）。
          delete outHeaders['content-encoding']
          delete outHeaders['content-length']
          delete outHeaders['transfer-encoding']
          // 样式改动必须立刻生效：禁止缓存 HTML（否则手机上看到的还是旧样式，排查时会被误导）
          outHeaders['cache-control'] = 'no-store'
          outHeaders['content-length'] = String(patched.length)
          res.writeHead(upRes.statusCode ?? 502, outHeaders)
          res.end(patched)
        })
        return
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    log(`upstream ${upstreamAddr.port} error: ${error.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('relay: 上游连不上（DSH 或 webhook 监听器没在跑？）')
  })
  req.pipe(upstream)
}

// ---------- 口令闸 ----------
const attempts = new Map() // ip -> { count, until }

function throttled(ip) {
  const entry = attempts.get(ip)
  if (!entry) return false
  if (entry.until > Date.now()) return true
  attempts.delete(ip)
  return false
}

function noteFailure(ip) {
  const entry = attempts.get(ip) ?? { count: 0, until: 0 }
  entry.count += 1
  if (entry.count >= 5) entry.until = Date.now() + Math.min(60_000, 2 ** (entry.count - 4) * 1000)
  attempts.set(ip, entry)
}

function loginPage(error) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 访问口令</title>
<style>
 body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;background:#111;color:#eee;display:flex;
 min-height:100vh;align-items:center;justify-content:center;margin:0}
 form{background:#1c1c1c;padding:24px;border-radius:12px;width:min(360px,86vw)}
 h1{font-size:16px;margin:0 0 4px}
 p{font-size:13px;color:#999;margin:0 0 16px}
 input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #333;
 background:#0d0d0d;color:#eee;font-size:15px}
 button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;
 font-size:15px}
 .err{color:#f87171;font-size:13px;margin-top:10px;min-height:16px}
</style></head><body>
<form method="POST" action="/__login">
  <h1>DSH 需要口令</h1>
  <p>输入访问口令后，这台设备会被记住一段时间。</p>
  <input type="password" name="password" autofocus autocomplete="current-password" inputmode="text">
  <div class="err">${error ?? ''}</div>
  <button type="submit">进入</button>
</form></body></html>`
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay.invalid')
  const ip = req.socket.remoteAddress ?? '?'

  // webhook 直通：不查口令，安全性由 GitHub 的 HMAC 签名保证
  if (url.pathname === '/github' && config.webhook) {
    proxy(req, res, webhookAddr)
    return
  }

  if (config.password) {
    // 扫码一键登录：链接里带 ?pwd=<口令>，校验通过就种 cookie 并跳到干净地址（不含口令）。
    // 这样手机扫桌面脚本画出的二维码即可直接进入，不必手输。
    if (url.searchParams.has('pwd')) {
      const submitted = url.searchParams.getAll('pwd').join('')
      if (throttled(ip)) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage('尝试太频繁，等一会儿再试。'))
        return
      }
      if (passwordMatches(submitted)) {
        attempts.delete(ip)
        const ttl = config.sessionHours * 3600 * 1000
        const target = url.pathname === '/__login' ? '/' : url.pathname
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: target,
          referrerPolicy: 'no-referrer',
          'set-cookie': sessionCookie(req.headers, ttl),
        })
        res.end()
        log(`link login ok from ${ip}`)
      } else {
        noteFailure(ip)
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage('链接里的口令不对（可能已过期改过）。'))
        log(`link login failed from ${ip}`)
      }
      return
    }

    // 登录 / 登出
    if (url.pathname === '/__login' && req.method === 'POST') {
      const body = await readBody(req)
      const submitted = new URLSearchParams(body).get('password') ?? ''
      if (throttled(ip)) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPage('尝试太频繁，等一会儿再试。'))
        return
      }
      if (passwordMatches(submitted)) {
        attempts.delete(ip)
        const ttl = config.sessionHours * 3600 * 1000
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'set-cookie': sessionCookie(req.headers, ttl),
        })
        res.end()
        log(`login ok from ${ip}`)
      } else {
        noteFailure(ip)
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPage('口令不对。'))
        log(`login failed from ${ip}`)
      }
      return
    }
    if (url.pathname === '/__logout') {
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
      })
      res.end()
      return
    }

    const authenticated =
      sessionValid(cookieValue(req.headers.cookie, SESSION_COOKIE)) ||
      req.headers.authorization === 'Basic ' + Buffer.from(`:${password}`).toString('base64') ||
      req.headers.authorization === 'Basic ' + Buffer.from(password).toString('base64')

    if (!authenticated) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage())
      return
    }
  }

  proxy(req, res, targetAddr)
})

// WebSocket / 其他 upgrade 握手（口令闸同样生效）
server.on('upgrade', (req, clientSocket, head) => {
  const url = new URL(req.url ?? '/', 'http://relay.invalid')
  const isWebhook = url.pathname === '/github' && config.webhook
  if (config.password && !isWebhook && !sessionValid(cookieValue(req.headers.cookie, SESSION_COOKIE))) {
    clientSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    clientSocket.destroy()
    return
  }
  const upstreamAddr = isWebhook ? webhookAddr : targetAddr
  const headers = forwardedHeaders(req.headers)
  guard(clientSocket, 'ws client')
  const upstream = http.request({
    host: upstreamAddr.host,
    port: upstreamAddr.port,
    method: req.method,
    path: req.url,
    headers,
  })
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    guard(upSocket, 'ws upstream')
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`)
      else if (v !== undefined) lines.push(`${k}: ${v}`)
    }
    clientSocket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upHead?.length) clientSocket.write(upHead)
    if (head?.length) upSocket.write(head)
    upSocket.pipe(clientSocket)
    clientSocket.pipe(upSocket)
  })
  upstream.on('error', (error) => {
    log(`upgrade error: ${error.message}`)
    clientSocket.destroy()
  })
  upstream.end()
})

server.on('error', (error) => {
  log(`listen failed: ${error.message}`)
  process.exit(1)
})

// 客户端在握手阶段就断开（半截请求、TLS 探针等）会走到这里；不回错误就会把进程带崩。
server.on('clientError', (error, socket) => {
  log(`clientError: ${error?.code ?? error?.message ?? 'unknown'}（忽略）`)
  try { socket?.destroy() } catch { /* ignore */ }
})

// 兜底：任何未捕获异常/未处理拒绝都记下来，绝不静默退出。
process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${error?.stack ?? error}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason}`)
})

server.listen(listenAddr.port, listenAddr.host, () => {
  log(`listening on ${listenAddr.host}:${listenAddr.port}`)
  log(`  GUI      -> ${backendAuthority}`)
  log(`  webhook  -> ${config.webhook ? `${webhookAddr.host}:${webhookAddr.port} (/github, 免口令)` : 'off'}`)
  log(`  password -> ${config.password ? `on (ref ${config.pwdEnv}, 会话 ${config.sessionHours}h)` : 'off'}`)
})

process.on('SIGINT', () => { log('bye'); server.close(() => process.exit(0)) })
process.on('SIGTERM', () => { log('bye'); server.close(() => process.exit(0)) })
