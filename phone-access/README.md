# 手机上访问 DSH GUI（局域网 + 外网 + 口令）

> **这是什么**：把 DSH 的 Web GUI 安全地开放给手机访问的一整套本机工具。**不改动 DSH 本体、不改动 DSH 配置**，靠一个本机"鉴权中继" + 一条临时隧道 + 一份移动端样式注入实现。
>
> **先看这三节**：
> - [安全边界与信任模型](#安全边界与信任模型) —— 每条防线由哪个组件负责、实测证据、以及**它不代表什么**（**改认证/转发/Webhook/隧道前必读**）
> - [它是怎么工作的](#它是怎么工作的) —— 中继如何绕过 DSH 的 Host 围栏与鉴权
> - [日常使用](#日常使用2026-10-09-定稿按需启动无任何自启) —— 平时怎么用
>
> **这套东西依赖什么**：DSH 桌面版本机监听 `127.0.0.1:19387`；`cloudflared`（快速隧道）；Node 18+（中继只用内置模块，**零依赖**）；Windows + PowerShell 5.1（启动脚本）。
> **可移植性**：脚本里的工作区路径都从脚本自身位置推导（或用 `DSH_WORKSPACE` 覆盖），目录换位置不用改代码。**唯一需要手填的是 `desktop-launcher.cmd` 里的工作区路径**（复制到桌面用时）。
>
> **第三方**：二维码用 [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)（MIT，Kazuhiko Arase），源码随仓库放在 `tools/qrcode/pkg/package/`，请遵守其许可证。

## 最快的方式：双击桌面上的「手机访问DSH.cmd」

它会**自动把中继和隧道建好**，然后**在浏览器里打开一张访问页面**（`phone-access/access.html`）：左边是内嵌的二维码（手机一扫免口令进入），右边是可一键复制的**外网地址 / 口令 / 局域网地址**和中继、隧道的状态指示。

**一次只管一个页面**（不再像早期那样弹图片窗口），看完直接关掉；想再看就再双击一次脚本。控制台同时打印一份文字摘要作为兜底。

**重启电脑后域名会变**，重新双击一次即可（不用来问我）。

> 页面是**自包含单文件**：二维码以 `data:` URL 内嵌，不请求任何外部资源，断网/离线也能打开。
> 生成链：`tools/qrcode/make-access-page.mjs` → `lib.mjs`（加载成熟库 `qrcode-generator`，MIT、零依赖）出矩阵 → `png.mjs`（手写零依赖 PNG 编码器，CRC32 + zlib，1-bit 灰度）出图 → 内嵌进 HTML。
> 脚本参数：`-SkipBootstrap`（只出页面不动中继/隧道）、`-NoOpen`（只生成不打开浏览器）、`-Diagnose`（打印诊断）。
> **不要再用自写编码器**：我在 2026-10-09 试过自己写 QR，结构正确、码字与参考实现逐字节一致，但**掩码层与标准不符，手机扫不出来**——那个文件早已删除。

> 桌面这个 `.cmd` 转发到 `phone-access/phone-access.ps1`；两者都在工作区里，改哪边都行。它已经处理了 PowerShell 5.1 读中文需要 UTF-8 BOM 的坑（脚本必须带 BOM，改完用 `node tools/ensure-ps1-bom.mjs phone-access\phone-access.ps1`）。

> **webhook secret 的唯一真源是凭据库** ref `DSH_GITHUB_WEBHOOK_SECRET`（工作区里不再放明文副本）。同步到 GitHub：`node tools\sync-webhook-secret.mjs`。

## 两种入口

**局域网（家里/公司同一 Wi-Fi）**

```
http://<你的内网IP>:19388/
```

**外网（4G/5G、任何网络）**

```
https://<隧道域名>.trycloudflare.com   （每次重启隧道都会变；以桌面脚本弹出的页面为准）
```

两个入口都要**口令**（首次打开会看到登录页）：同样以桌面脚本显示的为准。

口令存在凭据库 ref `PHONE_ACCESS_PASSWORD`（`~/.dsh/.credentials.yaml`），改口令：`node tools/set-credential-ref.mjs PHONE_ACCESS_PASSWORD <新口令>`（省略值则自动生成），**然后必须重启中继**才生效。登录成功后浏览器会拿到一个 `dsh-relay-session` cookie，**记住 72 小时**；换设备/换浏览器要重新输一次；**中继每重启一次，所有手机登录态都会失效**（会话密钥是启动时随机生成的）。

> `<你的内网IP>` 是本机 WLAN 地址（每次查法见文末排错）；公网域名是 trycloudflare 临时隧道，**每次重启都会换**（换了以后 GitHub webhook 会自动跟着改，手机链接靠桌面脚本重新拿）。

## 安全边界与信任模型

> 这一节是**可审计的安全说明**，不是实现备注。每条防线都写明：**由哪个组件负责**、**实测证据**、以及**它不代表什么**。改认证/转发/Cookie/Webhook/隧道后，请连带更新本节并重跑第 4 条的测试。

### 1. 手机访问口令仅由本地中继处理

- 手机访问页面用 `?pwd=<口令>` 传递一次性登录凭据；中继验证成功后建立会话，并用 `303` 重定向**清理 URL**（地址栏不留口令），同时带 `Referrer-Policy: no-referrer`。
- **责任组件：中继（`tools/dsh-auth-relay.mjs`）**。带 `?pwd=` 的请求在中继内**无论验证成功或失败都直接 `return`**，不进入转发分支 ⇒ **DSH 永远不会从这个请求里收到手机访问口令**。
- 中继日志**不记录口令、不记录完整 URL、不记录查询参数**（成功/失败只记来源 IP）。
- **已知边界（本项目不可控）**：首次请求经过 **Cloudflare**，查询参数是否被平台记录或保留，不由本项目决定。
- **安全要求**：`phone-access/access.html` 及其二维码**等同于口令本身**，按敏感凭据保管，不得公开分享或截图外传。口令泄露后：`node tools\set-credential-ref.mjs PHONE_ACCESS_PASSWORD`（省略值则自动生成）**然后重启中继** —— 旧口令与基于旧口令的登录链接随即失效。

### 2. `/github` 的安全性由 DSH Webhook 适配器的 HMAC 验签保障

- 中继对 `/github` 跳过的是**手机访问口令校验**，**不代表该路径无条件接受请求**。
- **责任组件：DSH 自身的 webhook 适配器**（`secretEnv: DSH_GITHUB_WEBHOOK_SECRET`）。它用该密钥对**原始请求正文**做 HMAC-SHA256 验签（`x-hub-signature-256`）。中继只做转发，不参与验签。
- **实测覆盖**（`node tools\test-github-signature.mjs`）：

  | 情形 | 结果 |
  |---|---|
  | 无签名 | `400 missing x-hub-signature-256 header` |
  | 错误密钥签名 | `401 invalid webhook signature` |
  | 正文被篡改（签名对旧正文） | `401 invalid webhook signature` |
  | 签名格式错误 | `401 invalid webhook signature` |
  | 正确签名 | `202` |

- **安全边界**：**路径白名单本身不提供任何身份认证**。安全性**完全依赖上游适配器正确执行验签** —— 因此改动中继的转发逻辑、或改动 webhook 适配器/密钥配置后，**必须重跑签名验证测试**（第 4 条）。
- **未实现的防护**：**没有基于投递 ID（`x-github-delivery`）的重放去重**。一份有效签名的请求可被重复提交；业务侧需自行考虑重复事件的影响（HTTPS 通道 + 重放仅导致同一 PR 事件被处理两次，故当前判定风险低）。
- `content_type` 必须是 `json`：验签比对的是**原始字节**，表单编码会改变正文。

### 3. 会话 Cookie 与凭据保护

- **中继自签自验自己的会话 Cookie**（`dsh-relay-session`，HMAC 签名 + 内含过期时间戳，默认 72h）。转发到 DSH 时，**中继生成的 DSH Cookie 无条件覆盖客户端提供的 `cookie` 请求头**（`forwardedHeaders()`）⇒ **客户端无法自带凭据来指定上游身份**。DSH Cookie 只存在于"中继 → 本机 19387"这一跳，浏览器永远看不到它。
- **凭据文件 ACL 已收紧**：`~/.dsh/.credentials.yaml` 仅 `SYSTEM` / `Administrators` / 当前用户可读（实测 `Get-Acl`），无普通用户可读问题。
- 会话 Cookie 属性：`HttpOnly` + `SameSite=Lax`，并按连接协议条件化加 `Secure`：
  - **隧道域名访问 → 加 `Secure`**；
  - **局域网 HTTP 访问 → 不加**（加了浏览器会拒绝保存，等于局域网登录彻底坏掉）。
- **协议判断的信任依据（2026-10-10 实测后收紧）**：拓扑是 `cloudflared tunnel --url http://127.0.0.1:19388`，而中继监听 `0.0.0.0:19388` —— **隧道与局域网共用同一个监听口，中继无法从协议上区分二者**。因此：

  > **`x-forwarded-proto` 是客户端可控的，不能单独作为信任依据。**
  > 实测（旧实现）：局域网客户端自带 `X-Forwarded-Proto: https` + 内网 Host，中继**会**加 `Secure`。
  > 现实现改为 **Host 头优先且具最终决定权**：`*.trycloudflare.com` → 安全；其余 Host（内网 IP / 本机）→ 一律按明文；只有在**完全没有 Host** 时才回退看 `x-forwarded-proto`。
  > 依据：`*.trycloudflare.com` 的 DNS 指向 Cloudflare，**局域网客户端无法证明自己是隧道域名**，除非它真的经 Cloudflare 过来 —— 那条路径本身就是 HTTPS。

  **加固后实测**：内网 Host + 伪造 `XFP:https` → 不加 `Secure` ✅；隧道 Host + `XFP:http` → 仍加 `Secure`（Host 优先）✅。

- **中继重启 = 会话吊销**：会话密钥是进程启动时随机生成的，重启后所有旧 Cookie 失效。这是一项**吊销措施**，**不应替代**口令保护、上游认证或凭据文件权限控制。
- **尚未做**：把中继的 GUI 监听限制为只看回环（现在必须绑 `0.0.0.0` 才能服务局域网入口）；隧道与局域网口未拆分。若哪天要收紧，可让 cloudflared 指向一个**仅回环**的监听、局域网另开一个端口。

### 4. 安全验证（改配置后至少重跑）

```powershell
node tools\test-relay-auth.mjs <公网域名>     # 口令闸 6 条
node tools\test-github-signature.mjs          # Webhook 验签 6 条
node tools\test-relay-resilience.mjs          # 中继韧性 5 条
```

按改动范围另加：`test-mobile-skin-injection.mjs`、`verify-skin-rev.mjs`、`verify-mobile-skin.mjs`（移动端注入），以及端到端访问（浏览器/手机实测）。

**注意**：上述测试通过，只说明**已覆盖的情形**符合预期，**不代表整个公网服务不存在其他安全风险**。

## 它是怎么工作的

DSH 的 Web GUI 有三道闸：**Host/Origin 围栏**（只认本机 Host）、**鉴权**（进程启动令牌 → 签名 cookie；令牌只出现在 `dsh web` 启动日志里，桌面应用不打印）、以及外网暴露时必须自己加的口令。

本方案**不动 DSH 的任何配置**，加了一个本机的"鉴权中继"（`tools/dsh-auth-relay.mjs`）：

1. 中继监听 `0.0.0.0:19388`；
2. 转发给 `127.0.0.1:19387`（DSH 本体），把 `Host`/`Origin` 改写成回环地址 —— 围栏认为请求来自本机；
3. 自己签一个 cookie 注入请求：密钥是持久保存在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` secret，cookie 格式（`dsh-auth-<sha256(authority) base64url>`，值 `v1.<payload>.<hmac>`）与 DSH 的实现一致；
4. 前面加一道自己的口令闸（登录页 → HMAC 签名的 `dsh-relay-session` cookie，72 小时；连错 5 次开始指数退避）；
5. **`/github` 路径免口令直通**到本机 webhook 监听器（`127.0.0.1:3081`）—— GitHub 不会带口令，那条路的安全性由 GitHub 自己的 HMAC 签名保证。所以**一条隧道同时服务 GUI 和 webhook**；
6. **窄屏时给首页注入一份移动端样式**（`mobile-skin.css`）：DSH 的前端是桌面优先的，两个主样式表里一个宽度断点都没有，手机上偏挤。中继在返回 `text/html` 时解码 body（上游带 gzip）、把 `<style data-relay="mobile-skin" data-skin-rev="…">` 插到 `</head>` 前，再去掉 `content-encoding`/`transfer-encoding` 以明文回传，并强制 `cache-control: no-store`（样式改动必须立刻生效，否则手机上看到的还是旧样式）。样式层内部包了 `@media (max-width: 820px)`，**桌面端行为完全不变**；CSS/JS 等非 HTML 资源一个字都不碰。

### 手机上确认"我拿到的是最新样式"

刷新页面后看**页面源代码**（不是开发者工具），搜 `data-skin-rev`：值应该等于 `node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha1').update(f.readFileSync('webhook-projects/github-review/mobile-skin.css','utf8')).digest('hex').slice(0,8))"` 的输出。不一致 = 浏览器缓存了旧 HTML（正常情况下已经被 `no-store` 禁掉）。

**已验证**：直连 `127.0.0.1:19387/` 返回 401；走中继 `127.0.0.1:19388/` 返回 200 且页面带 `__DSH_BOOT__`；从内网地址 `http://<你的内网IP>:19388/` 同样 200。

### 中继的两个真实故障（都已在 2026-10-10 修掉）

- **ECONNRESET 直接把进程干崩**：客户端中途断开（手机切后台、浏览器取消请求）→ socket 抛错无人接 → 整个中继退出，表现为"早上起来手机连不上，但隧道还在跑"。修法：所有 socket 挂 `guard()` 吃掉 `ECONNRESET`/`EPIPE`，加 `server.on('clientError')` 与 `uncaughtException`/`unhandledRejection` 兜底。回归：`node tools/test-relay-resilience.mjs`（半截请求/中断 POST ×20 后必须存活）。
- **注入时 `Content-Length` 与 `Transfer-Encoding` 冲突**：上游是分块传输，自己定长度就得把这些头一起删掉，否则客户端直接 `HTTPParserError`。

## 文件

| 文件 | 作用 |
|---|---|
| `tools/dsh-auth-relay.mjs` | 中继本体（Node 内置模块，无依赖）：口令闸 + DSH cookie 注入 + `/github` 直通 + **移动端样式注入** |
| `webhook-projects/github-review/mobile-skin.css` | 移动端样式覆盖层（窄屏才生效）；中继把它注入首页 `</head>` 前 |
| `tools/test-relay-auth.mjs` | 口令闸自测（未登录/错口令/正确口令/伪造会话/`/github` 直通），6 条断言 |
| `tools/test-github-signature.mjs` | **Webhook 验签自测**：无签名/错密钥/篡改正文/格式错误/正确签名/非 PR 事件，6 条断言。**改转发或适配器后必跑** |
| `tools/test-relay-resilience.mjs` | 韧性自测：半截请求 / 中断 POST ×20 后中继必须存活（对应 2026-10-10 修掉的 ECONNRESET 崩溃） |
| `tools/test-mobile-skin-injection.mjs` | 样式注入自测：标记存在、位置正确、CSS 资源未被误注入、长度一致 |
| `tools/verify-mobile-skin.mjs` | 移动端样式**生效性**验收：读计算后样式（挂件已隐藏、按钮尺寸、无横向溢出） |
| `tools/verify-sidebar-overlay.mjs` | 悬浮侧栏验收：手机收起态保留原生、展开态侧栏 fixed + 内容满宽、**桌面零影响** |
| `tools/shot-dsh-mobile.mjs` | 在指定视口（默认手机 390×844）截图 DSH GUI，用于目视验收移动端 |
| `phone-access/start-dsh-relay.ps1` | 幂等启动脚本（已在监听就跳过） |
| `phone-access/startup-relay.cmd` | 登录自启入口（**已废弃**，Startup 目录现在为空） |
| `webhook-projects/github-review/start-webhook-tunnel.ps1` | 隧道自启 + 自动把公网域名写回 GitHub webhook（现在指向中继 19388） |
| `tools/probe-dsh-auth.mjs` | 诊断脚本：直接打 19387，验证自签 cookie 是否被接受 |

手动启动：

```powershell
node tools\dsh-auth-relay.mjs --listen 0.0.0.0:19388 --target 127.0.0.1:19387 --webhook 127.0.0.1:3081
```

自测：

```powershell
node tools\test-relay-auth.mjs http://<你的内网IP>:19388
node tools\test-relay-auth.mjs https://<隧道域名>.trycloudflare.com
```

杀掉中继（关闭手机访问；GitHub webhook 也会一起断，因为它现在走同一条隧道）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dsh-auth-relay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 前提与边界

- **电脑必须开着，DSH 必须开着。** 关机 / 退出应用 → 手机访问和 GitHub webhook 都停。
- **睡眠 = 断线，而且外面叫不醒它。** 本机只支持 S0 低电量待机（Modern Standby，无 S3）：睡眠时网卡还连着，但**所有进程被冻结**，中继不响应、GitHub 投递失败。已经按这个前提改了电源设置：**插电时永不睡眠**（`powercfg /change standby-timeout-ac 0`），**电池保持 5 分钟睡眠**。所以：
  - 想随时用 → **插着电**（关屏 15 分钟不影响，屏黑进程照跑）；
  - 电池状态下 5 分钟就睡，手机就断了；
  - **合盖仍可能触发睡眠**，没动这个设置（要的话：`powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` + `powercfg /setactive SCHEME_CURRENT`）；
  - 回滚睡眠设置：`powercfg /change standby-timeout-ac 15`。
- **公网入口是临时隧道**：域名每次重启换一个，GitHub webhook 会自动跟着改（自启脚本），但**手机上的书签要重新拿一次新域名** —— 从 `~/.dsh/logs/webhook-tunnel.log` 里抓，或直接问我要。
- **口令是唯一防线**：中继对每个未登录请求都回登录页，连错 5 次起指数退避（上限 60 秒）。但口令一旦泄露（比如截图外传）等于把 DSH 交出去，改口令走 `tools/set-credential-ref.mjs` + 重启中继。
- 局域网入口的 IP 是 WLAN 的，DHCP 重新分配或换网络会变。

## 日常使用（2026-10-09 定稿：按需启动，无任何自启）

**用法就一步：先打开 DSH，再双击桌面上的「手机访问DSH.cmd」。**

双击后它自己做三件事，然后显示地址和口令：

```
正在准备手机访问（中继 + 隧道）…
  中继 19388：正在启动…
  隧道：检查/建立中（首次约 15 秒）…
  ✓ 准备完成
```

1. 先探 `127.0.0.1:3081`——**DSH 没开就直接告诉你"请先打开 DSH"**，不做无用功；
2. 中继（19388）没在听 → 起中继；
3. 跑隧道脚本（幂等 + 文件锁）：隧道健康就**复用域名**（实测重复双击域名不变），不健康才重建，并写状态文件 + 同步 GitHub webhook。

**没有任何后台常驻**：登录自启删了、空闲守护进程关了、计划任务注册不了。代价是每次重启电脑后要手动点一次；**好处是不会再有"自启跑早了/顺序不对/静默失效"这类问题**。

可选开关：`-SkipBootstrap` 只查看不动任何东西；`-Diagnose` 打印路径与匹配详情（排查用）。

### 历史：为什么放弃了三条自动路径

| 方案 | 结果 |
|---|---|
| 登录自启（Startup） | 在 DSH **之前**执行，探到 3081 没监听就退出 → 重启后隧道永远不建。后来加了轮询，又和另一个触发源**撞车**互相杀隧道（一秒换两次域名）。已删。 |
| DSH 启动插件 `plugins/dsh-tunnel-boot` | **从未在真实启动里触发过**：bundle 写法（`dsh.bundle.patch`）与 profile patch 里的绝对路径写法都试了，改成显式 `file:///` URL 后**仍然**没有日志（16:03、16:07 两次真实重启为证）。放弃。 |
| 计划任务 / 空闲守护 | `Register-ScheduledTask` 要管理员（`Access is denied`）；空闲守护进程能工作（实测 11 秒恢复），但按用户要求关掉了。 |

插件与守护的代码都还留在工作区（`plugins/dsh-tunnel-boot/`、`phone-access/ensure-ingress.ps1`），以后要用可以捡回来；profile patch 里那条 `dsh-tunnel-boot-abs` 也还在（不生效，但无害）。

### 两个仍然成立的坑

> ⚠️ **`~/.dsh/profiles/desktop/cordis.patch.yml` 改动后必须校验**：`node tools/validate-profile-yaml.mjs`。
> 它曾因"注释与 YAML 粘在同一行"整体解析失败，而 loader 的 `loadOptionalPatches` **静默跳过**——症状是"新加的条目完全没生效、且没有任何报错"。拆行工具：`node tools/fix-profile-patch-splits.mjs`。根因（用 `Get-Content -Raw` + `Set-Content` 回写含中文注释的文件会吃掉换行）已写进 `AGENTS.md`。

> ⚠️ profile patch 里的插件条目，`name` 必须是**显式 `file:///` URL**：写 `'C:/.../index.js'` 在 Windows 上会被 Node 的 ESM 加载器拒绝。而 `dsh --dump-config` 只做 YAML 组装、**不真的 import**，会把这种名字显示成 `file:///C:/...`，看着像已规范化——**不能拿 dump-config 当"能加载"的证据**。

`logs/tunnel-boot.log` 是插件写的启动日志（判断它有没有真的触发的唯一凭据）。

**并发保护**：隧道脚本有文件锁（`~/.dsh/logs/webhook-tunnel.lock`，超 5 分钟视为陈旧），因为触发源可能有多个，同时跑会互相杀隧道（2026-10-09 实测：一秒内换了两次域名）。

**健康判据**：从"metrics 端口 20241 有响应"改成"**状态文件域名 == 日志末域名 且 cloudflared 进程在**"（20241 可能被别的实例占用，会把死隧道误判成健康）。

**历史 bug 供参考**：更早只有登录自启，而它在 DSH 之前执行，探到 3081 没监听就 `exit 0` —— 重启后隧道永远起不来，状态文件还留着旧域名，于是"手机连不上、桌面脚本显示旧值"。

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 手机打不开页面 | 不同网段 / 中继没跑 / **隧道没起来** | 看 `~/.dsh/logs/dsh-relay.log` 与 `webhook-autostart.log`；确认 `netstat -ano \| findstr "19388 3081"`。**2026-10-09 已修**：见下方"启动顺序"一节，正常不需要手动干预 |
| **重启后域名没变、但手机连不上** | 隧道根本没起来：老版登录自启在 DSH 之前跑，探到 3081 没监听就退出；状态文件还留着上次的旧域名，桌面脚本于是显示旧值 | **2026-10-09 已修**（轮询等 DSH）。临时救急：手动跑一次 `phone-access\start-dsh-relay.ps1` |
| 提示要口令、输入后没反应 | 口令错或会话 cookie 被清 | 重输；或 `node tools\test-relay-auth.mjs <url>` 判定 |
| 页面 401 且**不是**登录页 | 中继没在跑（直连到了 DSH 本体） | 说明你访问的端口不对，或中继挂了 |
| 外网域名变了 | 隧道重启 | 双击桌面「手机访问DSH.cmd」拿新值（它读 `~/.dsh/logs/webhook-tunnel-url.txt`，该文件由隧道脚本每次写入）；GitHub 侧已自动同步 |
| 桌面脚本显示"没找到隧道域名" | 历史 bug：脚本用 `Join-Path $env:DSH_HOME ...` 拼路径，而 `DSH_HOME` 为空时 `Join-Path` 抛终止错误 → 路径变 null。**2026-10-09 已修**：改成字符串拼接 + 回退到 `~/.dsh\logs`，并新增 `-Diagnose` 开关 | 用 `powershell -File phone-access\phone-access.ps1 -Diagnose` 看实际路径；若域名确实为空，跑 `start-webhook-tunnel.ps1` 重建隧道 |
| 页面能开但对话无响应 | `/api` 通道被拒 | 跑 `node tools/probe-dsh-auth.mjs` 对照；中继日志里看 upstream error |
| GitHub 投递变 400/无签名 | webhook 的 secret 被 PATCH 清掉了（改 url/content_type 时必须同时带 secret） | `node tools\sync-webhook-secret.mjs`（从凭据库 ref 读回并同步到 GitHub hook，三字段一起发） |
| IP 变了 | DHCP 重新分配 | 重新查地址：`node -e "const os=require('os');for(const [n,l] of Object.entries(os.networkInterfaces()))for(const i of l||[])if(i.family==='IPv4'&&!i.internal)console.log(n,i.address)"` |
