# dsh-ai-import-ui

`dsh-ai-import` 的可视化界面。两种入口、一份实现：

- **右下角「AI 导入」悬浮按钮 → 右侧抽屉**（主入口，任何页面都能点开）
- **设置 → AI 对话导入**（同一个组件，`compact` 变体，去掉大标题）

在里面扫描本机 AI 助手历史（Claude Code / Codex / WorkBuddy / Cursor / Trae）、按来源勾选、看逐来源进度、看结果表，不用再命令行跑工具。

```
┌ Host 半边 index.mjs ─────────────────────────────┐
│ GET    /api/ai-import/index?refresh=1  扫描结果   │
│ POST   /api/ai-import/import          起任务      │
│ GET    /api/ai-import/progress?job=   进度/结果   │
│ DELETE /api/ai-import/job?job=        取消        │
│ GET    /api/ai-import/roots           当前根目录  │
│ GET    /api/ai-import/browse?path=    列子目录    │
│ POST   /api/ai-import/root            记住根目录  │
│ GET    /api/ai-import/preview        会话预览    │
│ GET    /api/ai-import/folders        文件夹树    │
│ POST   /api/ai-import/folder         建/改文件夹 │
└──────────────────────────────────────────────────┘
                     ↕ 复用
        dsh-ai-import/lib/runner.mjs   scanAll() / runImport()
        dsh-ai-import/lib/roots.mjs    candidates() / browse() / 手动根目录
┌ Client 半边 client.js ───────────────────────────┐
│ ctx.slots.register('shell.overlay',              │
│   { id:'ai-import', order:300 })  → 悬浮层       │
│ ctx.slots.register('settings.section',           │
│   { id:'ai-import', order:230, label })          │
└──────────────────────────────────────────────────┘
```

跨机使用靠 `roots.mjs`：每个来源先看 `config`，再看面板里存的
`<DSH_HOME>/ai-import/roots.json`，再看环境变量，最后按平台猜默认路径
（Windows / macOS / Linux 各有一套候选）。面板上的「换目录」就是写这个文件。

两个 slot 各自用 `try/catch` 包住（`apply()` 里的 `mount()` 辅助函数）：一处注册失败只在 console 留
`[dsh-ai-import-ui] <label> 注册失败`，不会把另一处或整个 slot 带崩。

## 为什么是独立包

`@deepseek-ai/dsh-client-modules` 把「这个包不是 client 包」的判定按 Loader specifier 缓存到**下次启动**。
给已在运行的 `dsh-ai-import` 追加 `dsh.client` 必须重启宿主才生效；而新装一个包（新的 Loader entry）
会被增量扫描直接捡起来。所以界面单独成包，装完刷新页面即可。

## 设计约束（改动前必读）

- 两个入口都是 slot 里的 React 组件，**不是** iframe、不往 `document.body` 追加节点。
- 不 `require` 任何 `@deepseek-ai/dsh-client-*` 包（内部改动会让整个 slot blank 掉）；只 `require('react')`。
- 颜色只用宿主 token `--dsw-alias-*`（bg-base / bg-layer-1 / bg-layer-2 / border-l1 / border-l2 /
  brand-primary / label-primary / label-secondary / state-success-primary / state-warn-primary /
  state-error-primary），不写死深浅色，明暗主题自动跟随。
- 类名一律 `aii-` 前缀。
- 悬浮层：`shell.overlay` 宿主容器已经是 `position:absolute; inset:0; pointer-events:none`，且只给
  **直接子元素**开 `pointer-events:auto`。所以 `.aii-layer` 自己保持 `pointer-events:none`，
  `.aii-fab` / `.aii-drawer` 显式 `pointer-events:auto` —— 抽屉关着时整层不拦点击。
- `.aii-fab` 用 `bottom: 74px`，给 `dsh-claude-move` 的 `#cm-open`（`right:16px; bottom:16px`）让位。
  实测两个按钮矩形不重叠（视口 756×488 时 y=376..414 vs 437..472）。再往下挪之前先量一次。

## 两种导入形态：简版 / 逐条挑选

面板头部有个切换按钮：

- **简版**（默认）：按来源勾选 → 开始导入。整源一次跑完，落进 `<来源> 对话` 工作区。
- **逐条挑选**（向导）：三栏布局，适合「只想导其中几条、还想自己定归档文件夹」。

向导是「上排三栏 + 下排整条预览」：

| 位置 | 内容 | 能做什么 |
| --- | --- | --- |
| 上排左 | 每个有新增/更新的来源（`<来源>（N）`） | 点来源，中栏列出它的候选对话 |
| 上排中 | 当前来源的候选对话（带勾选框）/ 当前文件夹里「已归档」（灰、无勾选框）+ 各来源「待导入」（带勾选框） | 勾选要导的；点一条在下排预览；底部显示「已勾选 N 条」与「导入勾选的 N 条」 |
| 上排右 | `ai-import/groups` 下的每个文件夹 + 底部四件套（输入框 / 「建立」/「归档到」/「取消归档指定」） | 点文件夹看里面已导入的会话；「归档到」把勾选的都指向当前文件夹 |
| 下排整条 | 选中对话的消息流（user / assistant / thinking / tool 四个角色） | 判断这条值不值得导；标题栏显示该对话名 |

切到向导时悬浮抽屉会**自动加宽**（`.aii-drawer--wide`，`width: min(1040px, calc(100vw - 32px))`，实测 726px），
靠模块级模式订阅（`MODE_LISTENERS` / `setGlobalMode` / `useGlobalMode`）把页面里的 `mode` 传给悬浮层；
切回简版自动还原 480px。向导顶部的「导入选项」条（只预演 / 强制重导 / 每来源上限）与简版是同一套
`dryRun` / `force` / `limit` 状态，由页面 props 透传给 `createWizard`。

**把新对话导进已有文件夹**：点右栏任一文件夹 → 中栏会同时列出该文件夹里**已归档**的会话（灰色、不可勾选）
和各来源的**待导入**候选（带勾选框，顶部给全选/全不选）→ 勾几条 → 右栏底部「归档到」→ 「导入勾选的 N 条」。
落盘走的还是同一个 `POST /import` 的 `picks`（`dir` 指到该文件夹），不会另建新文件夹。

几个刻意的行为（改动时别改回去）：

- **新建文件夹后不自动跳过去** —— 新文件夹是空的，跳过去就看丢刚勾选的对话。只在底部给一句「已建立「X」」。
- **点「归档到」后不切走视图** —— 文件夹列表常驻右栏，中栏在文件夹视图里本来就同时列「已归档 + 待导入」，
  所以不需要再切回来源列表；归档只记下 `targets[key] = {dir,title}`，中栏行上会出现「归入「X」」标签。
- **上排固定高度、各栏内部滚动** —— `.aii-wiz { height:46vh; min-height:320px; max-height:560px }`、
  `.aii-wiz-preview { height:34vh; ... }`。别改回 `height:auto`：文件夹视图有几十行时会把上排撑到几千像素，
  下排预览被顶到屏幕外（实测过 3493px）。
- **未导入条目的元信息只显示已知项** —— 扫描不为 `kind:'new'` 的条目算 `turns`（Cursor 连 `sizeBytes` 都没有），
  所以只展示「N 轮」/「N KB」中能确定的，两者都没有就退回显示来源标签，别退化成「0 轮 · 0 KB」看着像空会话。
- 预览折的是**事件流**，不是各源的 `turns`：WorkBuddy 的 `turns` 是数字、Claude 是数组，只有折事件才和真正落盘的内容一致。
- 空壳会话（只有工具调用）预览会显示「导入后会是空会话」的提示，仍可导入。

## 初次使用指引

首次打开面板（`localStorage` 里没有 `dsh-ai-import-ui.guide.seen = '1'`）会自动在顶部展开一张四步指引卡：

1. 这个面板做什么（只读扫描、不删原文件、与原 AI 客户端无关）
2. 先确认扫到的来源（没有卡片时怎么「换目录」）
3. 挑一种导入方式（简版 / 逐条挑选）
4. 导入之后（落到哪个工作区、台账去重、重复导入只追加）

卡片上是「第 n / 4 步」+ 四个圆点 + 「上一步 / 不再显示 / 下一步」（最后一步变「开始使用」）。
点「不再显示」写 `localStorage`，以后不再自动弹；页头的「使用指引」按钮永远能把卡片重新打开（从第 1 步起）。
`localStorage` 不可用（隐私模式/被禁）时退化成「每个会话弹一次」。

页面头部还多了一行扫描结果 chips（新增 / 有更新 / 已导入 / 被过滤，数量为 0 的不显示），
空态时给一句「先确认用过 → 换目录 → 重新扫描 → 也可看使用指引」的提示。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ai-import/index[?refresh=1]` | 扫描结果，缓存 30 秒；`refresh=1` 强制重扫 |
| POST | `/api/ai-import/import` | body `{sources?, dryRun?, force?, limit?}` → `{jobId}`，后台跑 |
| GET | `/api/ai-import/progress?job=<id>` | 任务快照（不含 AbortController 句柄） |
| DELETE | `/api/ai-import/job?job=<id>` | 取消（abort 信号透传给 `runImport`） |
| GET | `/api/ai-import/roots` | 五源的 `manualRoot` / `candidates` / `resolved` |
| GET | `/api/ai-import/browse?path=<dir>` | 列子目录（跳过 node_modules/.git），带 `detected` 来源提示 |
| POST | `/api/ai-import/root` | body `{source, dir}`；`dir` 为空 = 取消手动；写完强制重扫 |
| GET | `/api/ai-import/preview?source=&key=&turns=&chars=` | 折事件流预览一条会话（`turns` 默认 20、`chars` 默认 4000） |
| GET | `/api/ai-import/folders[?dir=<dir>]` | 列 `ai-import/groups` 下的文件夹；带 `dir` 时附该文件夹里的会话 |
| POST | `/api/ai-import/folder` | body `{action:'create'|'rename', name?, dir?, title?}`；建目录 / 改工作区标题 |

写路由都过 `isTrustedOrigin()`（只允许本机 origin），body 上限 64 KiB。

`POST /api/ai-import/import` 支持两种粒度：

- 按来源：body `{sources?, dryRun?, force?, limit?}`
- 逐条挑：body `{picks:[{key, source?, dir?, title?}], dryRun?, force?}` —— `picks` 非空时**只导这些 key**，
  `dir`/`title` 指定归档文件夹（缺席则按来源落到 `<来源> 对话`）。注意「某来源没被挑中」时不能给它传空数组，
  否则 `runImport` 会当成「没指定 picks」而全量导入（Host 侧已用 `mine.length === 0 → skip` 挡住）。

`runImport` 一次只支持按来源过滤、没有逐条进度回调，所以进度按「逐来源各跑一次」实现：
`done/total` 是来源粒度，`job.activity` / `currentProcessed` / `currentTotal` 来自 `log` 回调
（`✓`/`✗` 行数 + `待处理 N 条`），是来源内部的细粒度进度；行明细在每次来源完成后追加。

**装好了但面板不出现？先看 profile 的 patch 层。** 插件市场的开关会把
`- id: ai-import` / `- id: ai-import-ui` + `disabled: true` 写进
`C:\Users\123\.dsh\profiles\<profile>\cordis.patch.yml`。patch 在 bundle 列表之后应用，所以
`plugin_manager` 里显示 `enabled:true` 也可能仍然被它关着；用 `plugin_manager set_bundle` 切换只会改
profile 的 `package.json`，**不会**改这条 patch。症状是 `/api/ai-import/*` 全 404、boot HTML 里没有
`dsh-ai-import-ui` 的 client 模块。改法：把这两行改成 `disabled: false`（或直接删掉两行），profile 会在
一秒内自己重放，不用重启 app。

## 安装与改完怎么生效

```powershell
# 装（会写进 profile 的 dependencies 与 bundles）
# plugin_manager install_bundle target = file:<本目录>
```

**注意安装结果是真实目录拷贝，不是 link**：`plugin_manager` 会把本目录复制到
`C:\Users\123\.dsh\profiles\desktop\node_modules\dsh-ai-import-ui\`。所以改完源码必须同步一次：

```powershell
Copy-Item "<本目录>\client.js" "C:\Users\123\.dsh\profiles\desktop\node_modules\dsh-ai-import-ui\client.js" -Force
```

生效条件不同：

- **Host 半边（`index.mjs`）**：注册时载入内存，改文件**不会**自动热更新。但**不需要重启 app**——
  对 bundle 做一次禁用/启用就会重建 Loader 条目、从磁盘重新 `import` 这个 `index.mjs`：

  ```
  plugin_manager set_bundle target=dsh-ai-import-ui enabled=false
  plugin_manager set_bundle target=dsh-ai-import-ui enabled=true
  ```

  两次都应返回 `application: "applied"`。之后新路由立刻可用（实测 `GET /api/ai-import/browse`
  从 404 变 200，且不打断当前会话）。注意要用 **bundle 名** `dsh-ai-import-ui` 走 `set_bundle`；
  用 `set_plugin` 配 `ai-import-ui` 会报 `unknown-plugin`。
- **Client 半边（`client.js`）**：`dsh-client-hmr` 每 500ms 轮询每个 bundle 的
  `mtime/ctime/size`，变了就 `clientModules.rebuilt(id)` 重读并推 SSE `/plugins/events`。
  所以 `Copy-Item` 之后**刷新页面**就有新字节，不用重启。若是同尺寸同 mtime 的巧合，
  `(Get-Item client.js).LastWriteTime = Get-Date` touch 一下即可。

验证新字节真的送达：跑 `node check-bundle.mjs`（或手动照做）。要点是 boot HTML 里
`<link rel="preload" href="plugins/??A,B,C&rev=<hex>">` 是**一整组共享一个 rev**：

- 单包直取 `/plugins/dsh-ai-import-ui/client.js` 是 **404**；
- 自己拼 `/plugins/??dsh-ai-import-ui/client.js&rev=<组 rev>` 也是 **404**（组里少一个模块就整条不通）；
- 必须**照抄那条 preload 的完整 href**（含该组全部模块路径）再 `GET`，然后在返回体里
  确认新字符串。实测这条响应 ≈4.3 MB / 29 个模块，`check-bundle.mjs` 会顺带打印模块数与命中情况。

`rev` 必须每次从 `GET /?nocache=<random>` 现抓，拿上一次的 rev 一定 404。

## 本地探针工具（不在包里，只用于开发）

| 脚本 | 用途 |
| --- | --- |
| `smoke.mjs` | 用替身 React 跑组件渲染，检查渲染树里没有 `undefined`/`NaN`/`[object Object]` 文本或 className |
| `cdp.mjs` | 极简 CDP 客户端（`openPage(appUrl, port)` → `{evaluate, waitFor, close}`） |
| `inspect-dom.mjs` | 真机查悬浮层/按钮/抽屉是否存在、有没有 `slot entry crashed` |
| `inspect-dom2.mjs` | 几何与 computed style（按钮位置、宿主层 z-index、点击穿透） |
| `inspect-run.mjs` | 端到端：开抽屉 → 勾来源 → 开着「只预演」→ 点开始 → 轮询到完成 → 查结果表 |
| `inspect-settings.mjs` | 走「账号菜单 → 设置 → AI 对话导入」确认设置页渲染正常 |
| `inspect-root.mjs` | 点「换目录」→ 读 picker 的起始路径、目录数、识别提示，截图 `picker.png` |
| `inspect-root2.mjs` | 连点「上一级」，逐层打印路径与带来源标签的子目录 |
| `inspect-root3.mjs` | 完整写入链路（可逆）：选 `.claude` → 使用此目录 → 恢复自动；校验卡片标签与 `roots.json` |
| `inspect-unavailable.mjs` | 确认「无本地正文」那张卡已彻底移除 |
| `inspect-wizard.mjs` | 真机走「逐条挑选」：切向导 → 查三栏/左栏/中栏 → 勾选 → 预览 → 新建文件夹 → 点进去 → 「归档到」→ 查 `aii-chat-tag`。env：`CDP_PORT` / `DSH_TOKEN` / `TEST_FOLDER` |
| `inspect-wizard-wide.mjs` | 量向导改版：简版/向导抽屉宽度、各栏字号、`.aii-wiz-opts` 选项条（勾选与上限回读）、文件夹视图的 `.aii-wiz-group` 与已归档行无复选框 |
| `inspect-wizard-into-folder.mjs` | 真机把一条**新**对话导进**已有**文件夹（先勾选 → 点进文件夹 → 归档到 → 导入 → 回读 `?dir=` 断言 `count`） |
| `check-bundle.mjs` | 从 boot HTML 抓 token 与整组 preload href，取回 client 字节并断言 `aii-drawer--wide`/`aii-wiz-opts`/`aii-wiz-group`/`MODE_LISTENERS`/`pendingAll`/`wizFolderHint`/`aii-wiz-preview`/`renderFolders`/`aii-guide`/`guide.seen`/`aii-chips` 都在 |
| `inspect-guide.mjs` | 真机验初次使用指引：清 `localStorage` → 自动展开 → 翻译步骤 → 「不再显示」写入标记 → 刷新不再弹 → 页头「使用指引」重开；顺带断言向导主按钮是「导入勾选的 0 条」而不是残留 `{0}`（env：`CDP_PORT` / `DSH_TOKEN`） |
| `inspect-wizard-picks.mjs` | 跨来源勾选后拦截 `fetch('/import')`，断言 `picks[i].source` 与 key 前缀一致（防「先勾的那批被标错来源」）。拦截后 reject，不写盘 |
| `inspect-wizard-import.mjs` | 真机点「导入勾选的 1 条」**真落盘**，再 `fetch('/folders')` 与 `?dir=` 回读该文件夹的会话，断言 `count>=1` |
| `cleanup-wizard-test.mjs` | 按 `--session=<id> --folder=<名>` 精确清掉上面的验收数据（会话目录 + projcache + 台账 key + 文件夹 + 工作区），默认 dry-run，`--apply` 才删 |
| `backfill-groupdir.mjs` | 给缺少 `groupDir`/`groupTitle` 的旧台账记录回填，只处理「`group === '<来源> 对话'`」这种必然可推的情况，其余只报告 |
| `route-test.mjs` | 假宿主直接跑 10 条路由（index/browse/root/import/progress/取消/错误方法），**要在安装目录跑** |
| `title-test.mjs` | `buildTitle` 的 6 个用例（注入剥离、技能前缀、长首问、源自带标题、日期兜底） |

> `lib/*.mjs` 是 link 到 `C:\Users\123\.dsh\plugins\dsh-ai-import\`，改完即刻生效；
> `index.mjs` / `client.js` / 探针脚本是拷贝，改完要 `Copy-Item` 到安装目录才跑得到新版。
> 需要 import 兄弟包 `dsh-ai-import` 的脚本（`route-test.mjs`、`title-test.mjs` 里的绝对路径除外）
> 也必须在安装目录下运行，工作区里没有 `node_modules` 解析路径。

跑法（本机没有 playwright，用无头 Edge）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --no-first-run --remote-debugging-port=9223 --user-data-dir="$env:TEMP\aii-cdp" about:blank
node inspect-run.mjs "http://127.0.0.1:3080/?token=<web-token>" 9223
```

Web GUI 的 token 在 `C:\Users\123\AppData\Roaming\dsh-tauri\logs\desktop\dsh-web.log` 里。

## 卸载

用 `plugin_manager` 的 `remove_bundle`（target `dsh-ai-import-ui`）。不要手改
`profiles/desktop/package.json`。

## 与命令行工具的关系

界面只调 `scanAll` / `runImport`，与 `ai_import_scan` / `ai_import_run` 工具、`/import-ai` 命令
走的是同一套逻辑与同一本台账（`<DSH_HOME>/ai-import/imports.json`），所以面板导入与命令行导入
可以混用，重跑都只追加新增回合。

## 台账字段的兼容性

台账每条记录除 `group`（工作区标题）外，还有 `groupDir` / `groupTitle`。**这两项是「逐条挑选」
上线时才加的**，先前的记录只有 `group`，于是 `GET /folders` 的 `sessions` 计数会漏掉它们
（面板里 `claude`/`codex`/`cursor` 显示 0，只有向导时代导过的 `workbuddy` 显示 9）。

`backfill-groupdir.mjs` 补的就是这两个字段，判定规则不猜：`source` 已知 且 `group === '<来源> 对话'`
（默认归档规则必然成立）才写；`group` 是别的自定义名（如 `论文归档`）而 `groupDir` 缺失时只报告、不猜，
因为无法反推目录。默认 dry-run，`--apply` 才写（写前先手动备份一份台账）。