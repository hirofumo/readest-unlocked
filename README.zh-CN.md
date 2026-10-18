# Readest 解锁版构建

[English](README.md) | 中文

本仓库自动构建 [Readest](https://github.com/readest/readest) 的**解锁版**：去掉客户端的付费限制，产物发布在本仓库的 [Releases](https://github.com/hirofumo/readest-unlocked/releases)。

本仓库只放构建脚本，既不含上游源码，也不是 fork。每个版本都是取一个确切的上游 tag，套上 `tools/` 里的补丁脚本构建出来的；相对该 tag 的完整 diff 会作为 `unlock.patch` 随 release 一起发布。改了什么始终看得见，不需要凭信任。

## 已解锁的客户端功能

这五项功能走的是同一个客户端付费判定。本构建让这个判定恒为 true，所以任何账号都能用，没登录也一样。

| 功能 | 在应用里的具体表现 |
| --- | --- |
| 第三方云同步 | 可以配置并使用 WebDAV、S3 兼容存储桶、Google Drive、OneDrive 与 iCloud Drive。 |
| 朗读音频分章下载（TTS） | 朗读音频可以按章下载到本地，离线也能听。 |
| Audiobookshelf 离线下载 | Audiobookshelf 的电子书与有声书可以存到设备上离线使用。 |
| 受信设备配对 | Nearby BookDrop 传书不再逐次弹确认。 |
| 自定义翻译 | 可以用自己的 OpenAI 兼容接口，或自己的 DeepL 密钥翻译。 |

## 没有解锁的部分

下面这些由服务端根据账号令牌（token）决定，客户端构建改不了，本项目也不声称能改：

- Readest Cloud 的存储配额与上传上限
- AI 翻译每天的字符额度
- Send-to-Readest 的专属邮箱地址

最后一项要补一句：它的判定有一部分正好走本构建放开的那个客户端检查，所以客户端这一半也跟着打开了。结果是 Send-to-Readest 面板照常向官方服务器索取邮箱地址，账号被服务器拒绝时面板显示加载失败；而未打补丁的构建在这里显示的是升级卡片。能力本身仍由服务端决定。

## 下载与安装

`<V>` 是上游版本号，例如 `0.12.16`。每个 release 的 tag 是 `v<V>-unlocked`，产物都按 `Readest-<V>-<platform>-<arch or variant>-<type>.<ext>` 命名，其中 `<type>` 是产物类型（`setup`、`portable`、`updater` 等）：

| 平台 | 架构 / 变体 | 产物 |
| --- | --- | --- |
| Windows | x64、arm64 | `Readest-<V>-windows-<arch>-setup.exe` 及其 `.sig`；`Readest-<V>-windows-<arch>-portable.zip` |
| macOS | x64、arm64 | `Readest-<V>-macos-<arch>.dmg`；`Readest-<V>-macos-<arch>-updater.tar.gz` 及其 `.sig` |
| Linux | x64、arm64 | `Readest-<V>-linux-<arch>.AppImage` 及其 `.sig`；`Readest-<V>-linux-<arch>.deb`；`Readest-<V>-linux-<arch>.rpm` |
| Android | 替换版 / 并存版，各含 arm64-v8a、armeabi-v7a、x86_64、x86 | `Readest-<V>-android-<family>-<abi>.apk` 及其 `.sig` |
| iOS | arm64 | `Readest-<V>-ios-arm64.ipa`（未签名，需自行签名） |

Windows 安装包和 Linux AppImage 同时充当安装包与更新包——更新器直接下载这两个文件并验签，所以它们带 `.sig`；macOS 的 dmg 只负责安装，更新走单独的 `updater.tar.gz`。Windows 便携版 zip 不能自更新：更新器会下载清单指向的文件，并把它当可执行程序启动，zip 当不了这个角色。iOS 的 IPA 是第二个例外，原因不同：Tauri 更新器不支持 iOS，所以既没有东西要签名，也没有东西能写进清单。其余平台都能自更新。

每个平台按架构出包：没有 macOS 通用包，也没有 Android 通用 APK；Android 另外分了替换版与并存版，每个 ABI 单独发布，方便你挑一份和手头设备匹配的。

这些产物没有代码签名证书。

- **Windows**：首次运行会被 SmartScreen 警告一次；便携版 zip 不能自更新，想要更新就用安装包。
- **macOS**：首次打开会被 Gatekeeper 拦下。执行 `xattr -cr /Applications/Readest.app`，然后再打开一次。
- **Android**：挑 APK 之前先看下面的 [Android 替换版与并存版](#android-替换版与并存版)。
- **iOS**：IPA 未签名，必须先用你自己的 Apple ID 签名才能安装——见下面的 [iOS 版本是未签名的](#ios-版本是未签名的)，里面也写了免费 Apple ID 做不到哪些事。
- **Android 自更新**：产物命名是稳定的，[Obtainium](https://github.com/ImranR98/Obtainium) 可以直接跟随本仓库——把 `https://github.com/hirofumo/readest-unlocked` 添加为 GitHub 源，再用正则限定到已安装的那个 APK，例如 `Readest-[\d.]+-android-replace-arm64-v8a\.apk` 或 `Readest-[\d.]+-android-coexist-armeabi-v7a\.apk`。正则里的家族（replace / coexist）和 ABI 都要跟设备上已安装的那个包对上：两个家族的应用 ID 不同，不能互相更新。

### Android 替换版与并存版

Android 会发布两种包，装出来都叫 **Readest**，不同之处在应用 ID 和能否与官方版并存。

| 包 | 应用 ID | 行为 |
| --- | --- | --- |
| 替换版 | `com.bilingify.readest` | 和官方应用同一个身份。要覆盖官方应用，或者从来没装过官方应用，就选它；之后从备份恢复的数据也会落回原来的位置。装之前必须先卸载官方应用——见下文。 |
| 并存版 | `com.hirofumo.readest.unlocked` | 与官方应用并存安装，书库从空开始。 |

装的是哪一种包，可以在应用的「关于」对话框里看到。

两种包用同一把自行生成的 Android 密钥签名。这把密钥不是上游的，所以这两个包都覆盖不了官方版，官方版也覆盖不了它们。签名与已安装版本不一致时，Android 会拒绝安装，因此必须先卸载官方版本（这会清掉应用本地数据，除非从备份恢复），或者改用并存版。

桌面端是另一回事：桌面构建沿用上游的应用 ID，读的是官方应用那个应用数据目录，书库、设置和阅读进度不用重新导入就能接着用。这是应用 ID 未改的自然结果，并没有单独验证过。

**该下哪个 APK，谁能自更新。** 四个 ABI 分开发布：`arm64-v8a` 给现在的手机和平板，`armeabi-v7a` 给较老的 32 位 ARM 设备，`x86_64` / `x86` 给模拟器和 x86 机器。替换版和并存版是同一个应用、两个不同的应用 ID，所以先定用哪一种，再选 ABI。每个 ABI 都能在应用内更新：应用会按当前设备取对应的清单键（`android-arm64`、`android-armv7`、`android-x86_64`、`android-x86`），而每份清单里这四个键都有，各自指向为该 ABI 构建的包。这套清单键的映射是本构建补丁的一部分——未打补丁的上游构建只会取三个键：64 位 ARM 取 `android-arm64`，32 位 ARM 取 `android-armv7`，其余架构（`x86_64`、`x86`）一律取 `android-legacy`。本仓库不发布 `android-legacy` 指向的包，所以那两个架构永远等不到更新。

### iOS 版本是未签名的

本仓库没有 Apple 证书，因此 iOS 产物是一份**未签名**的 IPA——这一点必须说清楚：单独拿出来什么都装不上。它就是应用本体（按 arm64 归档，打包成 `Payload/Readest.app`），签名那一步在你这边完成——用 AltStore、SideStore、Sideloadly 或 Xcode，配上你自己的 Apple ID 与描述文件。

签出来能用多少功能，取决于你签名用的账号。免费的个人开发者团队用不了 App Groups，而阅读小组件和分享扩展都依赖它，所以除非用付费团队签名，这两个功能会缺一块，严重的直接不可用。这个包沿用上游的 Bundle ID `com.bilingify.readest`，所以想覆盖设备上已有的 App Store 版 Readest，得先删掉那一份。

**以上这些都没有在 CI 上做过真机验证。** 构建能证明的是包在结构上没问题（见 [发布是怎么验证的](#发布是怎么验证的)），而不是它装得上、跑得起来。第一次装到设备上，就把它当作你自己的测试。

## 校验下载

有两件相互独立的事可以校验，它们回答的是不同问题。

**文件完整送达。** 每个 release 都会发布 `SHA256SUMS`，格式就是 `shasum` 的输出，标准工具可以直接读：

```bash
gh release download v0.12.16-unlocked --repo hirofumo/readest-unlocked --pattern SHA256SUMS
# 再下载你要的那一个产物，然后：
sha256sum -c SHA256SUMS --ignore-missing      # 或：shasum -a 256 -c SHA256SUMS --ignore-missing
```

**文件确实是在这里构建的。** 每个 release 还带有构建来源 attestation——GitHub 用绑定到本次 workflow 运行的短期证书为它签名：

```bash
gh attestation verify Readest-0.12.16-windows-x64-setup.exe --repo hirofumo/readest-unlocked
```

任何产物都能这样验，Android 的 APK 与 iOS 的 IPA 也一样。只有文件确实出自本仓库的某次 workflow 运行，这条命令才会通过，并告诉你它来自哪个 commit、哪一次运行。它**不**保证代码本身无害——要判断那一点，得去读补丁：每个 release 还附带 `unlock.patch`（相对上游 commit 的完整 diff）与 `BUILD.md`（写明上游 commit、本仓库的 commit、构建期变量，以及如何校验下载）。

## 自更新

应用从本仓库的 releases 自更新，而不是从 readest.com。

每个 release 都会发布签名过的更新清单与对应的 `.sig` 文件：替换版 Android 与桌面构建用 `latest.json`，并存版 Android 用 `latest-coexist.json`；`.sig` 由 Tauri 更新器校验，校验用的公钥已经编译进应用。上面提到的 Windows 便携版 zip 和 iOS IPA 是例外，走不了自更新。私钥只保存在本仓库的 secrets 里，绝不会进入构建产物——一旦连同口令一起丢失，将来任何 release 都签不出来，已安装的应用也会停止接受更新。

## 自托管

自托管分成两半：客户端这边用设置里的入口指向你自己的服务器，服务端自己跑一个。

### 在设置里指向你的服务器

设置里有**自托管**这一项（**自定义 → 自托管**，点进去是二级页面），形态和 WebDAV 面板一致。

连接时会先用应用自己的 fetch 助手对服务器地址发一次 GET 做探测，所以探测结果就是应用实际会拿到的结果；只有地址不通或服务端返回 5xx 才会拒绝连接。

地址一旦生效，整套后端都会切到自建实例：Web 与 API 地址、Node API 地址、账号后端，以及应用为导出批注生成的网页链接。匿名密钥可以留空，只有自建实例跑着自己的 Supabase（密钥与官方项目不同）时才需要填；实例沿用官方项目密钥、或者根本不跑账号系统，留空即可。

断开时不会清掉已填内容——地址还留着，想连回来点一下就行——然后回到官方服务器。连接与断开都会重载应用（API 地址和 Supabase 客户端只在启动时解析一次），顺序都是先弹一条 toast 提示，再重载。

没有覆盖的部分：Web 字体与已发布封面的 CDN 域名，以及 Web 版会链接到的 readest.com 页面。桌面端只有前一类资源走 CDN，取不到也能正常降级。

### 自己跑一个服务端

服务端用上游的：[readest/docker](https://github.com/readest/readest/tree/main/docker) 提供 `compose.yaml`，能一次拉起应用、API 与一套 Supabase，环境变量见它自己的 README。

在决定用哪个构建之前，有件事值得知道：`SELF_HOSTED=true` 是**上游自己的**开关，而且他们发布的镜像默认就打开它——上游本来就为自托管部署解锁 premium 客户端功能，登录与否都一样。本项目只是把同一条规则用在桌面、Android 和 iOS 构建上（这几种上游不发布），没有另外发明一条规则。

### 完全不用账号

这里没有任何一步需要 Readest 账号。没有登录用户时，应用维护本地书库，同步可以走 WebDAV 或 S3 兼容存储——两者都属于第三方同步，本构建都已解锁。需要账号后端的只有 Readest Cloud、Send-to-Readest 邮箱和共享批注。

## 发布流程

本仓库每天检查一次上游。上游一旦发布了本仓库还没有对应 release 的版本，就会为上面表格里的每个平台各构建一份，以 `v<V>-unlocked` 发布出去；上游没有新版本的日子，只花掉这一次检查。也可以手动触发重建，还能指定要构建的上游 tag、分支或 commit。

每个 release 都出自同一套步骤：checkout 上游 tag、套用 `tools/` 里的补丁脚本、断言源码已按要求修改、编译、断言编译产物、把每个包读回来核对，最后才上传。

补丁如果对不上上游代码，构建会直接失败而不是跳过：悄悄发布一个仍然锁着的包，是本项目唯一不能接受的结果。

## 发布是怎么验证的

从补丁到发布之间立着三道检查，每一道都只说它真正测到的东西：

1. **源码。** 补丁对源码的所有断言都在编译之前跑完，所以补丁一旦对不上上游代码，几秒钟就会失败，而不是等编译跑完。
2. **编译产物。** 会去应用真正要发布的 JavaScript 里搜 `__READEST_UNLOCKED__` 构建标记——这正是「改对了文件」与「发布的包确实已解锁」之间的区别。被补丁的模块还会在运行时设置 `globalThis.__READEST_UNLOCKED__ = true`，所以已经装上的构建也能用同样方式检查。
3. **包本身。** 文件是被读出来的，不是被信任的：每个 Android APK 都解开核对应用 ID、包含的 ABI 与签名证书；iOS 的 IPA 同样核对 Bundle ID、版本号、架构、内嵌扩展，并确认它确实未签名。

任何一道检查失败都会让构建失败并且不产出任何产物，所以只打了一半补丁的 release 不会被发布出去。

## 许可与合规

Readest 使用 **AGPL-3.0** 许可，本仓库的脚本和这里发布的二进制也一样。完整许可证文本见 [LICENSE](LICENSE)。

AGPL 要求分发修改版本的人提供 Corresponding Source（对应源码），并醒目标明文件已被修改。本仓库就是那份源码：完整的补丁脚本、确切的构建步骤都在这里。补丁动过的每个文件都在原处留了一行 `[readest-unlocked]` 注释说明改了什么；只有三份 JSON 文件写不进注释（`tauri.conf.json` 和两份 locale 文件），它们的修改说明写在「关于」对话框里。

发布的二进制保留上游的版权声明、许可证文本与项目标识，这里没有任何东西移除或替换它们。

本项目与 Readest 及 Bilingify LLC 没有隶属关系，也未获其背书或支持。「Readest」及其标识归其所有者所有，此处只用来说明本构建派生自何处。本构建的支持来自本仓库，不是上游。

如果这个构建对你有用，真正值得支持的是上游：Readest 是一个仍在活跃开发的阅读器，背后有真实的基础设施开销，付费方案正是用来支撑它的。这里没有改变 readest.com 用户的任何既有约定——解锁只作用于本仓库的构建，而同样的功能对任何自建服务器的人本来也是免费的。阅读、同步或阅读器界面的问题属于[上游的 issue 跟踪](https://github.com/readest/readest/issues)，不该提到这里；本构建自身的问题——下载下来不好用、某次发布失败——才属于这里。

这些构建按「原样」提供，不附带任何担保，仅供个人使用。使用应用对接的任何第三方服务时，你需要自行遵守其许可与条款。

## 仓库里有什么

```
.github/workflows/   构建与发布流程，以及每天对上游的检查
tools/               补丁脚本，以及组装一次发布的工具
helpers/             少量按平台划分的构建辅助脚本
LICENSE              AGPL-3.0
```

这里的补丁脚本就是这些二进制的 Corresponding Source。它们是普通的 Node.js 文件，本身没有构建步骤，对上游文件所做的每处改动也都就地标注，所以可以从头读到尾，不用先跑任何东西。
