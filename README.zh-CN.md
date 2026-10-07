# Readest 解锁版构建

[English](README.md) | 中文

自动构建**解除客户端付费门控**的 [Readest](https://github.com/readest/readest)，并发布到本仓库的 Releases。

本仓库是一份构建配方，而不是源码树。它不包含任何上游代码：每次 CI 都现场 checkout 上游 tag，套用 `tools/` 里的补丁脚本，校验结果，然后编译，并把安装包上传到这里。上游可以随意重写任何东西，不会给谁带来合并冲突。

## 已解锁的客户端功能

下面五项功能全部经由同一个判定函数——`apps/readest-app/src/utils/access.ts` 里的 `isCustomizationAllowed()`。构建补丁把它强制改为返回 `true`，因此对任何账号（包括未登录的免费账号）都开放：

| 功能 | 在应用里的含义 |
| --- | --- |
| 第三方云同步 | WebDAV、S3 兼容存储桶、Google Drive、OneDrive、iCloud Drive 都可以配置并使用。 |
| 分章朗读（TTS）音频下载 | 朗读音频可以按章节下载到本地，供离线收听。 |
| Audiobookshelf 离线下载 | Audiobookshelf 的书籍与有声书可以存到设备上离线使用。 |
| 受信设备配对 | Nearby BookDrop 传书不再需要为每一次传输确认。 |
| 自定义翻译器 | 使用你自己的 OpenAI 兼容接口或你自己的 DeepL Key 进行翻译。 |

## 未解锁的功能

以下项目由服务端根据账号令牌（token）判定，客户端构建无法改变这一点，本项目也不作此宣称：

- Readest Cloud 的存储配额与上传上限
- AI 翻译的每日字符额度
- Send-to-Readest 专属邮箱地址

最后一项有一处需要说明：它的门控走的是本构建所打开的那个判定函数，因此这道门控的**客户端一半**也一并打开了。结果是 Send-to-Readest 面板会向官方服务器索取邮箱地址，并在服务器拒绝该账号时显示加载失败——而未打补丁的构建在这里显示的是升级卡片。能力本身仍然由服务端决定。

## 自定义服务器地址

设置（Misc 面板）里新增了 **Server URL** 与一个可选的 Supabase 匿名密钥。两者都留空（默认）时，应用使用官方 Readest 服务器。

填写 URL 会把整套后端都搬到自建实例：Web/API 源、Node API 源、账号后端，以及应用为导出的批注所生成的网页链接。匿名密钥是可选的，只有当自建实例跑自己的 Supabase（其密钥与官方项目不同）时才需要填；实例沿用官方项目密钥、或根本不跑账号系统时留空即可。**Reset** 会清空两者并回到官方服务器。改动后应用会重新加载——API 地址与 Supabase 客户端只在启动时解析一次。

未覆盖的部分：Web 字体与已发布封面的 CDN 域名，以及 Web 版链接的 readest.com 落地页。桌面端只在取可选资源时用到前者，缺失也能正常降级。

## 发布产物

`<V>` 是上游版本号，例如 `0.12.12`。每个 release 的 tag 是 `v<V>-unlocked`，所有产物都按 `Readest-<V>-<platform>-<arch or variant>-<type>.<ext>` 命名：

```
Windows   x64 / arm64              安装包 + sig、便携 zip
macOS     x64 / arm64 / universal  dmg、更新用 tarball + sig
Linux     x64 / arm64              AppImage + sig、deb、rpm
Android   replace / coexist        arm64-v8a、armeabi-v7a、universal（各自 + sig）
iOS       arm64                    未签名 ipa（需自签安装）
```

| 平台 | 产物 |
| --- | --- |
| Windows | `Readest-<V>-windows-<arch>-setup.exe` 及其 `.sig`；`Readest-<V>-windows-<arch>-portable.zip` |
| macOS | `Readest-<V>-macos-<variant>.dmg`；`Readest-<V>-macos-<variant>-updater.tar.gz` 及其 `.sig` |
| Linux | `Readest-<V>-linux-<arch>.AppImage` 及其 `.sig`；`Readest-<V>-linux-<arch>.deb`；`Readest-<V>-linux-<arch>.rpm` |
| Android | `Readest-<V>-android-<family>-<abi>.apk` 及其 `.sig` |
| iOS | `Readest-<V>-ios-arm64.ipa` |

Windows 安装包与 Linux AppImage 本身就是更新产物，因此带签名。Windows 便携 zip 不会自更新：更新器下载的是清单指向的文件并把它当作可执行程序启动，而 zip 无法充当这个产物。iOS 的 IPA 是第二个例外，原因不同：Tauri 的更新器根本不支持 iOS，所以没有东西需要签名，也没有东西可以写进清单。其余平台仍然自更新。

### 两个 Android 版本家族

两个家族安装后都叫 **Readest**，唯一区别是 application id。

| 家族 | Application id | 行为 |
| --- | --- | --- |
| 替换版 | `com.bilingify.readest` | 与官方应用相同的身份。要在替换官方应用、或从未安装过官方应用时选它；之后从备份恢复的数据会落在同一个位置。必须先卸载官方应用——见下文。 |
| 并存版 | `com.hirofumo.readest.unlocked` | 与官方应用并存安装，书库从空开始。 |

应用内的「关于」对话框会说明当前安装的是哪一个。

两个家族使用同一份自行生成的 Android 密钥签名。该密钥不是上游的密钥，因此两个家族都无法就地更新官方应用，官方应用也无法就地更新这两个家族中的任何一个。签名与已安装应用不一致时 Android 会拒绝安装，所以必须先卸载官方版本——这会清除应用本地数据，除非从备份恢复——或者改用并存版。

桌面端的情况不同：桌面构建同样保留上游的 identifier，因此读取的是官方应用用过的同一个应用数据目录，书库、设置与阅读进度无需重新导入即可延续。这是 identifier 未改动的结果，而不是另外做过验证的保证。

### iOS 版本是未签名的

本仓库没有 Apple 证书，因此 iOS 产物是一个**诚实的未签名 IPA**：单独拿出来什么也装不上。它就是应用本体（为 arm64 设备归档并打包为 `Payload/Readest.app`），签名是你那一侧的事——用 AltStore、SideStore、Sideloadly 或 Xcode，配上你自己的 Apple ID 与描述文件。

签出来的应用能用到什么，取决于你用来签名的账号。App Groups 对免费的个人团队不可用，而阅读小组件与分享扩展都依赖它，因此除非用付费团队签名，这两个功能预计会缺功能或直接不可用。这个包保留上游的 bundle id `com.bilingify.readest`，所以想覆盖设备上的 App Store 版本，得先删掉那个版本。

**以上这些都没有在 CI 上做过真机验证。** 流水线证明的是包在结构上正确（见[验证](#验证)），而不是它装得上、跑得起来。第一次装到设备上，请当作你自己的测试。

## 流水线如何工作

触发方式：

| 触发 | 说明 |
| --- | --- |
| 定时 | 每天 03:00 UTC。上游没有新版本的日子只花掉一个很轻的 `detect` job。 |
| `workflow_dispatch` | 输入 `ref`（上游 tag、分支或 sha；留空表示上游最新 release 的 tag）与 `force`（即使该版本的 release 已存在也重新构建）。 |

Job：

| Job | 职责 |
| --- | --- |
| detect | 解析要构建的上游版本；若该版本的 release 已存在，则整次运行直接跳过。 |
| prepare | 先建好 release，各构建分支只需上传产物。 |
| build | Windows（`x64`、`arm64`）、macOS（`x64`、`arm64`、`universal`）与 Linux（`x64`、`arm64`）的矩阵。 |
| build_android | 单独的 job：job 级 `if` 读不到 matrix 上下文，而且未配置签名密钥时必须整体跳过 Android。 |
| build_ios | 单独的 macOS job：先补齐上游 checkout 里没有的 Xcode 工程，再产出未签名的 arm64 IPA，并对包内容做断言。不需要任何密钥——这里没有 Apple 证书。 |
| manifest | 发布 `latest.json` 与 `latest-coexist.json`，由各分支上传的 `.sig` 文件汇总而成，并附上上游的 `release-notes.json`，供应用内「最近更新」视图使用。 |
| summary | 汇总各分支的结果。 |

每条分支都做同样的事：在解析出的 ref 上 checkout 上游、运行 `tools/unlock.mjs`、断言源码补丁、编译、断言编译产物、上传自己的产物。

打补丁是**锚点式**的，锚点移动时会刻意让构建失败。悄悄发布一个仍被锁住的包，是唯一绝不能出现的结局，因此锚点缺失或有歧义都算硬失败，而不是警告。只有两个纯装饰性补丁例外：它们尽力而为、只发警告——为了一个碍眼的小徽标而拒绝发布可用的构建，是不划算的。

## 自更新

应用从本仓库的 releases 自更新，而不是从 readest.com。

每个 release 都会发布签名后的更新清单——替换版 Android 家族与桌面构建用 `latest.json`，并存版 Android 家族用 `latest-coexist.json`——以及 Tauri 更新器用来校验的 `.sig` 文件；校验所用的公钥已编译进应用内。上面提到的 Windows 便携 zip 与 iOS 的 IPA 是例外，都不会自更新。对应的私钥只保存在本仓库的 secrets 中，绝不会随构建分发。请务必保存好这份私钥与它的口令：由于配对的公钥已编译进应用内，一旦丢失，将来的任何 release 都无法签名，已安装的应用也会停止接受更新。

## 验证

三层彼此独立的检查，每一层都不比它实际检查的内容更强：

1. **源码断言。** `tools/verify.mjs` 在打补丁之后、昂贵的原生编译之前运行，因此补丁坏掉时几秒钟就会失败，而不是等很久之后。
2. **编译产物。** `tools/check-bundle.mjs` 在前端编译完成后运行，把 `__READEST_UNLOCKED__` 构建标记与实际发布的 JavaScript 对照。这是「改对了文件」和「发布的包确实已解锁」之间的区别。包则是被读出来、而不是被信任的：每个 Android APK 都解包核对 `applicationId`、ABI 与签名证书，iOS 的 IPA 同样核对 bundle id、版本号、架构、内嵌扩展与「确实未签名」。
3. **CI 失败。** 任一断言失败，该 job 就失败并且不产出任何产物，因此不会发布一个只打了一半补丁的 release。

被补丁修改的模块还会在运行时设置 `globalThis.__READEST_UNLOCKED__ = true`，这正是第 2 层可行的原因，也是已安装构建可以被检查的依据。

## 校验下载

有两件相互独立的事可以校验，它们回答的是不同的问题。

**文件在传输中没有损坏。** 每个 release 都会发布 `SHA256SUMS`，格式就是 `shasum` 的输出，标准工具可直接使用：

```bash
gh release download v0.12.12-unlocked --repo hirofumo/readest-unlocked --pattern SHA256SUMS
# 再下载你需要的那个产物，然后：
sha256sum -c SHA256SUMS --ignore-missing      # 或：shasum -a 256 -c SHA256SUMS --ignore-missing
```

**文件确实是在这里构建的。** 每个 release 还带构建来源证明（build provenance attestation），由 GitHub 用与本次 workflow 运行绑定的短期证书签名：

```bash
gh attestation verify Readest-0.12.12-windows-x64-setup.exe --repo hirofumo/readest-unlocked
```

只有当文件确实出自本仓库的某次 workflow 运行时，这条命令才会成功，并会告诉你它来自哪个提交、哪一次运行。它**不**宣称代码本身无害——要看那个，去读补丁：每个 release 还附带 `unlock.patch`（相对上游提交的完整 diff）与 `BUILD.md`（写明上游提交、本仓库提交、构建期变量，以及如何校验下载）。

## 安装

这些产物没有代码签名证书。

- **Windows**：首次运行时 SmartScreen 会警告。安装包会自更新；便携 zip 不会。
- **macOS**：首次打开会被 Gatekeeper 拦下。执行 `xattr -cr /Applications/Readest.app`，然后再打开应用。
- **Android**：选择 APK 前请先看上面的[两个 Android 版本家族](#两个-android-版本家族)。
- **iOS**：IPA 是未签名的，必须先用自己的 Apple ID 签名才能安装——见上面的 [iOS 版本是未签名的](#ios-版本是未签名的)，其中包括免费 Apple ID 做不到的事。
- **Android 自动更新**：产物命名是稳定的，因此 [Obtainium](https://github.com/ImranR98/Obtainium) 可以直接跟随本仓库——把 `https://github.com/hirofumo/readest-unlocked` 添加为 GitHub 源，再用正则限定到你已安装的那个 APK，例如 `Readest-[\d.]+-android-replace-arm64-v8a\.apk` 或 `Readest-[\d.]+-android-coexist-universal\.apk`。请选与设备上已装家族匹配的那条：两个家族的 application id 不同，无法互相更新。

## 自托管

设置里的 **Server URL** 可以把客户端指向你自己的 Readest 实例。服务端用上游的：[readest/docker](https://github.com/readest/readest/tree/main/docker) 提供 `compose.yaml`，能拉起应用、API 与一套 Supabase，其 README 记录了全部环境变量。

选构建之前值得知道一件事：`SELF_HOSTED=true` 是**上游自己的**开关，且他们发布的镜像默认就把它设为 `true`——上游本来就为自托管部署解锁 premium 客户端功能，无论是否登录。本项目只是把同一条规则应用到桌面、Android 与 iOS 构建上（上游不发布这几种），并没有另外发明一套规则。

补丁接通了哪几个面，见 [TECHNICAL.md](TECHNICAL.md) 第 9 节：API 源、Node API 源、账号后端，以及导出批注时构建的网页链接。未覆盖：网页字体与已发布封面的 CDN 域名。

### 完全不用账号

这里没有任何东西要求 Readest 账号。未登录时应用维护本地书库，同步可以走 WebDAV 或 S3 兼容存储——两者都属于第三方同步，在本构建中均已解锁。只有 Readest Cloud、Send-to-Readest 邮箱与共享批注才需要账号后端。

## 许可与合规

Readest 采用 **AGPL-3.0** 许可，本仓库的脚本与这里发布的二进制同样如此。完整的许可证文本见 [LICENSE](LICENSE)。

AGPL 要求分发修改版本的人提供 Corresponding Source，并附带醒目的「文件已被修改」声明。本仓库就是那份源码：它包含完整的补丁脚本与确切的构建配方。补丁触及的每个文件都在原处用 `[readest-unlocked]` 注释标明了所做的改动，只有三份 JSON 文件例外——`tauri.conf.json` 与两份 locale 文件无法承载注释，它们由 About 对话框中的声明覆盖。

发布的二进制保留上游的版权声明、许可证文本与项目标识。这里没有任何东西移除或替换它们。

本项目与 Readest 及 Bilingify LLC 无隶属关系，也未获其背书或支持。「Readest」及其徽标归其所有者所有，此处仅用于说明本构建派生自什么。本构建的支持来自本仓库，而不是上游。

如果这个构建对你有用，真正值得支持的是上游：Readest 是一个活跃开发中的阅读器，背后有真实的基础设施，而它的付费方案正是这些开销的来源。这里没有改变 readest.com 用户的任何约定——解锁只作用于本仓库的构建，而同样的功能对任何自建服务器的人本来也是免费的。阅读、同步或阅读器界面的 bug 属于[上游的 issue 跟踪](https://github.com/readest/readest/issues)，不该提在这里；这里只负责一件事：补丁失效了。

这些构建按「原样」提供，不附带任何担保，仅供个人使用。使用应用所对接的任何第三方服务时，你需要自行遵守其许可与条款。

## 仓库结构

```
.github/workflows/build-unlocked.yml   流水线
.github/workflows/preflight.yml        每日针对上游自己分支跑补丁 + 断言
helpers/android-keystore.sh            每次 `tauri android init` 之后写入 Android 签名配置
tools/unlock.mjs                       补丁器
tools/coexist.mjs                      把 checkout 切换为并存版 Android 身份
tools/coexist-android.mjs              把已提交的 src-tauri/gen/android 工程改指向该身份
tools/verify.mjs                       源码断言
tools/check-bundle.mjs                 编译产物断言
tools/make-manifest.mjs                汇总签名后的更新清单
tools/make-checksums.mjs               由 release 的 digest 生成 SHA256SUMS
tools/make-build-info.mjs              写出随 release 发布的 BUILD.md
tools/report-failure.mjs               为失败的运行开启——或复用——一个 issue
tools/resolve-upstream.mjs             上游版本解析
README.md                              英文版（默认落地页）
README.zh-CN.md                        中文翻译（本文件）
LICENSE                                AGPL-3.0
```
