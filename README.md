# Readest Unlocked Build

跟随上游 [readest/readest](https://github.com/readest/readest) 自动构建**解除客户端付费门控**的 Readest，并发布到本仓库的 Releases。

本仓库**不包含上游源码**。每次构建时 checkout 上游 tag，现场打补丁，然后编译——所以上游怎么改都不会产生合并冲突。

---

## 解锁了什么

Readest 的客户端付费功能全部经由一个判定函数（`apps/readest-app/src/utils/access.ts` 的 `isCustomizationAllowed`）。本仓库把它改成恒为真，因此下列功能对任何账号（包括未登录的免费账号）开放：

| 功能 | 说明 |
| --- | --- |
| 第三方云同步 | WebDAV、S3 兼容存储桶、Google Drive、OneDrive、iCloud Drive |
| 朗读音频离线下载 | 按章节把 Read Aloud 音频存到本地 |
| Audiobookshelf 离线下载 | 把 ABS 的书籍/有声书存到设备 |
| 受信设备配对 | Nearby BookDrop 传书免每次确认 |
| 自定义翻译器 | 用你自己的 OpenAI 兼容接口或 DeepL Key |

**解锁不到的**（由上游服务端按 JWT 判定，客户端无法也不应绕过）：

- Readest Cloud 的存储配额与上传上限；
- AI 翻译的每日字符额度；
- Send-to-Readest 专属邮箱（地址分配与转发都在服务端）。

---

## 工作原理

```
每天 03:00 UTC（或手动触发）
   │
   ├─ detect    读上游 releases/latest，解析版本号；已有同名 release 就直接结束
   ├─ prepare   建好 release，供各平台上传
   └─ build     四个矩阵任务，各自：checkout 上游 → 打补丁 → 校验 → 编译 → 上传
        ├─ windows-x86_64   NSIS 安装包 + 便携 exe
        ├─ android          universal APK + arm64 APK（需签名密钥，缺失则自动跳过）
        ├─ linux-x86_64     AppImage + deb
        └─ macos-universal  dmg（未签名）
```

`tools/` 各脚本职责：

| 文件 | 职责 |
| --- | --- |
| `unlock.mjs` | 打补丁。**锚点式**：上游把目标代码改掉了就立刻报错退出，绝不静默产出一个仍被锁的包 |
| `verify.mjs` | 源码级断言（补丁在不在、Tauri 配置对不对） |
| `check-bundle.mjs` | 产物级断言：在 `out/` 里找到 `__READEST_UNLOCKED__` 才算数 |
| `resolve-upstream.mjs` | 解析上游最新版本、判断是否需要重建 |

补丁分两类。

**语义补丁 —— 锚点失配即报错，绝不产出仍被锁的包**

1. `src/utils/access.ts` — `isCustomizationAllowed()` 恒返回 `true`，并在文件末尾写入 `__READEST_UNLOCKED__` 构建标记。全部六个判定函数（云同步 / 朗读离线 / ABS 离线 / 受信配对 / 自定义翻译器 / 邮件收书）都经由它。
2. `src-tauri/tauri.conf.json` — 清空 `plugins.updater.endpoints`（**关键**：留着官方更新源的话，下一次「检查更新」会把解锁版覆盖回官方版，门控就回来了），并关闭 `createUpdaterArtifacts`（本仓库没有 Tauri 签名私钥）。
3. 写 `.env.local` — `NEXT_PUBLIC_SELF_HOSTED=true` 等，作为上游自带解锁路径的双保险。

**装饰补丁 —— 尽力而为，锚点失配只警告不阻断**

4. `src/app/library/components/SettingsMenu.tsx` — 隐藏「Upgrade to Readest Premium」菜单项。
5. `src/app/reader/components/tts/TTSPlayerSheet.tsx` — 未登录时不再给「Offline Audio」行挂 Premium 徽标。

装饰补丁找不到锚点时构建照常成功，并在 Actions 摘要里标注；语义补丁找不到锚点时**整个 job 失败**——这是刻意的安全失败，宁可红叉也不要悄悄发一个被锁的包。

`identifier` 与 `productName` **保持不变**（`com.bilingify.readest` / `Readest`），所以安装后会直接沿用你原有的书库、设置与阅读进度，等同替换官方版。

---

## 使用

### 手动触发一次构建

```bash
gh workflow run build-unlocked.yml --repo hirofumo/readest-unlocked
# 指定上游 ref（分支 / tag / sha）：
gh workflow run build-unlocked.yml --repo hirofumo/readest-unlocked -f ref=main -f force=true
```

### Android 签名密钥（本仓库已配置）

Android 需要一份自签名密钥；缺失时 `Build android` 这个 job 会自动跳过，其余平台不受影响。本仓库的三个 Secret 已经配好：

```
ANDROID_KEY_ALIAS      签名别名
ANDROID_KEY_PASSWORD   密钥口令
ANDROID_KEY_BASE64     .jks 文件的 base64
```

本地备份在 `secrets/`（已被 git 忽略，**绝不要提交**）——丢了它，已安装的用户就无法覆盖安装新版本，只能卸载重装。重新生成（需要 JDK 的 `keytool`）：

```bash
keytool -genkeypair -v -keystore readest-unlocked.jks -alias readest \
  -keyalg RSA -keysize 2048 -validity 10000 -storetype JKS
# Windows PowerShell 取 base64：
[Convert]::ToBase64String([IO.File]::ReadAllBytes("readest-unlocked.jks"))
# macOS / Linux 取 base64：
base64 -w0 readest-unlocked.jks
```

本仓库使用 JKS 格式（keytool 会建议迁移到 PKCS12，忽略该建议即可：Gradle 侧按 JKS 读取）。

### 安装提示

- **Windows**：安装包未签名，SmartScreen 会拦一次，选「更多信息 → 仍要运行」。
- **macOS**：未签名，首次打开会被 Gatekeeper 拦下，执行 `xattr -cr /Applications/Readest.app` 后再打开。
- **Android**：需与已安装的官方版使用同一签名才能覆盖安装；签名不同时先卸载官方版（书库数据在应用目录内，卸载会一并清除，建议先用备份功能导出）。

---

## 验证解锁真的生效

1. 设置 → 云同步：WebDAV / S3 等条目不再有 Premium 徽标，可以展开配置并同步。
2. 开发者控制台执行 `window.__READEST_UNLOCKED__`，返回 `true`。
3. 设置 → 检查更新：不会提示安装官方新版本。

---

## 上游改动导致失败时

红叉是**设计好的安全失败**，不是 bug。典型情况：上游重写了 `access.ts` 或调整了 Tauri 配置结构。

修法：

1. 看日志里 `[unlock] ERROR: ... anchor not found` 打印的期望片段；
2. 对照上游新代码更新 `tools/unlock.mjs` 里的锚点与替换文本；
3. 提交后再跑一次：

```bash
gh workflow run build-unlocked.yml --repo hirofumo/readest-unlocked -f force=true
```

---

## 本地复现一次构建

```bash
git clone --depth 1 -b v0.12.12 --recurse-submodules https://github.com/readest/readest.git readest
cd readest
node ../2026-10-06-readest-unlocked-build/tools/unlock.mjs --root .
node ../2026-10-06-readest-unlocked-build/tools/verify.mjs --root .
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm --filter @readest/readest-app build
node ../2026-10-06-readest-unlocked-build/tools/check-bundle.mjs --root .
```

原生打包（`pnpm tauri build`）需要各平台工具链：Windows 需 MSVC + WebView2，Linux 需 GTK/WebKit 与 CEF 版 tauri CLI，macOS 需 Xcode 命令行工具。

---

## 许可与合规

Readest 采用 **AGPL-3.0**。修改自用与再分发均被授权，条件是对应源码可得：本仓库公开存放全部补丁脚本与构建配方，Releases 中的产物即由这些脚本从上游源码构建而来。产物保留上游的 `LICENSE`、版权声明与项目标识，不冒充官方发布，也不修改任何服务端行为。

本仓库不是官方项目。构建由 upstream 作者之外的人（自动流程）产出，请自行评估风险。

---

## 目录结构

```
.github/workflows/build-unlocked.yml   流水线
tools/unlock.mjs                       补丁器
tools/verify.mjs                       源码断言
tools/check-bundle.mjs                 产物断言
tools/resolve-upstream.mjs             上游版本解析
```
