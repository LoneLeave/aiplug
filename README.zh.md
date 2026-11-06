# dsh-ai-import

把本机上其它 AI 编程助手的对话历史批量导入 DeepSeek Harness（DSH），并**按来源自动归档、按内容自动命名**。

支持：Claude Code、Codex CLI、WorkBuddy、Cursor（Trae 可选，仅有提问）。

有图形界面：右下角「AI 导入」悬浮按钮，或「设置 → AI 对话导入」。

## 用法

装好并重启 DSH 后，在会话里输入：

```
/import-ai              扫一遍，看有多少能导入
/import-ai full         逐个列出条目（来源、项目、标题、轮数）
/import-ai run 5 --dry-run   先试跑 5 条，不写盘
/import-ai run          正式导入全部
/import-ai run cursor   只导入某个来源
/import-ai run --force  已导入的重导一遍（新建，不覆盖）
/import-ai status       看台账位置与已导入计数
```

同样的能力也暴露为两个工具，供 agent 调用：

- `ai_import_scan({ detail: "summary" | "full" })`
- `ai_import_run({ sources?: string[], dryRun?: boolean, force?: boolean, limit?: number })`

图形界面（`dsh-ai-import-ui` 包）走同一套 `scanAll` / `runImport` 与同一本台账，可以和命令行混用。

### 图形界面怎么用（给第一次用的人）

1. 打开 DSH 网页界面，右下角有一个「**AI 导入**」按钮（在「🐳 Claude 迁移」上方），点开是右侧抽屉。
   也可以在「设置 → AI 对话导入」里打开同一份界面。
2. 抽屉上半部分是五个来源卡片，每张卡片显示：来源名、**来源路径**（`手动指定` / `自动探测` / `未找到`）、
   一行统计「新增 N · 已导入 M · 过滤 K」。**没找到的**或者**找到的不是你想导的那个**，
   点这张卡片路径右边的「**换目录**」。
3. 「换目录」面板：顶部是路径输入框（可以直接粘贴 `D:\backup\claude`、`~/Library/Application Support/Claude`），
   回车即浏览；下面列出该目录的子目录，能识别出来源的会带一个灰色小标签；点目录名逐层进入，
   点「**使用此目录**」保存。想恢复默认就点「**恢复自动**」。
4. 勾选要导入的来源，按需要勾「**只预演**（不写盘，只看看会导成什么标题）」、「**强制重导**」、限制条数。
5. 点「**开始导入**」→ 进度条按来源推进，下面一行显示当前来源正在处理第几条（`3/18 · Claude: 待处理 18 条`）。
6. 完成后结果表逐条列出标题与状态（新建 / 追加 / 跳过 / 失败）。导入的会话会出现在 DSH 会话列表里，
   按来源归到一个工作区：`Claude 对话`、`Codex 对话`、`Cursor 对话`、`WorkBuddy 对话`。
7. 中途想停就点「**取消**」。

改了来源目录后只想确认能不能扫到，勾「只预演」点一次即可，不会写任何文件。

### 逐条挑选（向导）

面板顶部有「**逐条挑选**」按钮，切过去是「上排三栏 + 下排整条预览」（抽屉会自动加宽到 ~1040px，字号也跟着放大）：

1. **上排左：来源**。每个有新增/更新的来源一条（`Codex（3）` 这种）。点它，中栏就列出它的候选对话。
2. **上排中：对话**。当前来源的候选对话，每条前面有勾选框；点一条，下排就显示它的内容。
   如果是点右栏的文件夹进来的，中栏上面列**已归档**的会话（灰色、不可勾选），下面接着列**各来源还没导的候选**
   （带勾选框，顶部有「全选/全不选」）。底部显示「已勾选 N 条」和「**导入勾选的 N 条**」。
3. **上排右：文件夹**。`<DSH_HOME>/ai-import/groups` 里已有的文件夹 + 底部四件套：
   输入框 + 「**建立**」新建文件夹、「**归档到**」把当前勾选的都指向这个文件夹、「**取消归档指定**」清空指定。
4. **下排整条：预览**。消息流按你的提问 / 助手回复 / 思考过程 / 工具调用分开着色，标题栏显示这条对话的名字。

向导顶部还有一条「**导入选项**」：只预演 / 强制重导 / 每个来源最多导入多少条，和简版是同一套设置。

**导进一个已有的文件夹**：点右栏那个文件夹 → 中栏勾几条待导入的 → 右栏底部「归档到」→ 「导入勾选的 N 条」。
新会话直接落进这个文件夹（不会另建一个），导入后它就出现在中栏上面的「已归档」段里。

两个容易误解的地方：新建文件夹后**不会**自动跳过去（那里还是空的）；点「归档到」后**不会**切走视图，
因为文件夹列表常驻右栏、中栏本来就同时显示两段，被指定的行上会出现「归入「X」」标签。
空壳会话（只有工具调用、没有一句人话）预览会提示「导入后会是空会话」，仍然可以导，但列表里会是空的
（这类会话在列表里也只显示来源，不显示「0 轮」）。

### 第一次打开

首次打开面板顶部会自动展开一张**四步指引卡**（做什么 → 先确认来源 → 挑导入方式 → 导入之后），
点「下一步」翻页、点「不再显示」以后不再自动弹。页头的「**使用指引**」按钮随时能把它重新打开。
换电脑或换账号后如果一张来源卡片都没有，照着指引第 2 步用「**换目录**」手动指定即可。

## 命名规则（按优先级）

1. 来源自带的标题：Claude 的 `custom-title` / `ai-title` 记录、Codex 的 `session_index.jsonl` 的 `thread_name`、Cursor 的 composer `name`；
2. 首条人类提问的第一行（自动剥掉 `<system-reminder>`、`<user_info>`、`<project_layout>`、`# AGENTS.md instructions`、`@skill:"…"`、Codex 的评审转写模板之类注入噪声），再压到第一个句末标点，最多 56 字；
3. `<来源> <日期 时间>`；
4. `<来源> 会话 N`。

默认加 `[Claude]` / `[Codex]` / `[WorkBuddy]` / `[Cursor]` 前缀（`titlePrefixSource: false` 可关闭）。同一分组内重名会自动追加 ` · #n`，不会出现一堆同名会话。

两个「看起来是标题、其实不是」的坑已经处理掉：

- **Codex 的 `thread_name` 有重复值**：`Guardian review`（12 次）、`每周回顾`（8 次）、`hi`（2 次）是自动化任务的固定名，不是会话内容。只有在整个 index 里**只出现一次**的名字才当作标题，重复的一律退回首问或日期。
- **Cursor 未命名的 composer**：`name` 字段就是一串 UUID，等于没有名字，改用它自己的首条提问。

## 分组规则

**每个来源一个工作区**（不再按项目拆）：

| 来源 | 目录 | 工作区标题 |
| --- | --- | --- |
| Claude Code | `<DSH_HOME>/ai-import/groups/claude` | `Claude 对话` |
| Codex | `<DSH_HOME>/ai-import/groups/codex` | `Codex 对话` |
| WorkBuddy | `<DSH_HOME>/ai-import/groups/workbuddy` | `WorkBuddy 对话` |
| Cursor | `<DSH_HOME>/ai-import/groups/cursor` | `Cursor 对话` |
| Trae | `<DSH_HOME>/ai-import/groups/trae` | `Trae 对话` |

会话本身的 `cwd` 仍指向真实项目目录，所以在 DSH 里打开它会带正确的项目上下文；只有在原项目目录已被删除时才回退到分组目录。

旧版本按 `(来源, 项目)` 拆成很多工作区；升级后同一来源的会话都会并到一个工作区里，已有工作区不会被删除，只是新导入的会话不再进去。

上面四张是**默认**归档位置。导入时也可以用向导把某几条指定到别的文件夹（`groups/` 下的任意子目录），
文件夹名就是工作区标题，可以随时用 `POST /api/ai-import/folder`（`action:'rename'`）改名。

## 写入与幂等

- 会话经 `sessionPersistence` 服务落盘（和 DSH 自己建的会话同一套格式），写前过 `validateSessionEvents` 校验，保证能续聊。
- 台账：`<DSH_HOME>/ai-import/imports.json`，记录 源 key → 会话 id / fingerprint / 轮数。
- 重复运行只处理新增或有变化的文件；源文件轮数变多时**追加**到原会话（`tailSessionEvents` + `appendSession`），不新建。
- 大文件（默认 > 200 MB）走流式转换，避免 `readFileSync` 的字符串上限（约 512 MB 字符）炸掉。
- 会话 id 形如 `import-claude-<uuid>`，带来源前缀，不会撞上 dsh-claude-move 已导入的 `import-<uuid>`。

## 工具生命周期不变式（改动前必读）

DSH 读会话时会强制校验工具调用的生命周期（`dsh-session-persistence-jsonl/lib/worker.cjs`
的 `Relationships.tool`，v4 走 `assertV4LifecycleRelationships`）。规则：

1. `assistant/message` 的 content 里必须先出现 `{type:'tool-call', id, name, arguments}` 声明；
2. 紧随其后的 `tool/call` 必须满足 `name` 与 `arguments` **严格相等**（`!==` 比较），且该声明未被 `started`；
3. `tool/result` 之后生命周期被 `delete`，**所以同一 callId 跨轮复用是合法的**。

违反任一条，DSH 会拒绝打开整份会话，报
`tool/call <id> has no advertised tool lifecycle` 或
`tool/call <id> does not match one advertised tool call`。

历史坑：`dedupeToolCallIds` 为满足「callId 全会话唯一」把重复 id 改成 `<id>#2`、`<id>#3`，
却没同步 `assistant/message` 里的声明块，于是这些会话一打开就报上面的错。现在的实现是：
按 FIFO 认领「属于这一次」的声明块，改名时同时改 `id`，并对齐 `name` / `arguments`。

`validateSessionEvents`（`lib/vendor/convert.mjs`）已内置同一套生命周期检查，作为落盘前的闸门。

## 会话标题与投影缓存（为什么导入后列表显示「未命名」）

DSH 的会话列表对**未打开**（cold）的会话只读投影缓存，不读日志：

- `@deepseek-ai/dsh-api-session-controller` 的 `summarizeCold` → `projectionsFor(header, void 0)`
  → `sessionProjectionCache.cachedSnapshot(header)`；
- 拿不到记录时 `title` 为空，界面退化成 `"session.untitled": "未命名"`
  （`dsh-client-ui-workspace/lib/client.js` 的 `displayTitle`）。

而缓存只在 `Session` 实例被 dispose/checkpoint 时才写（`coldSnapshot` / `write`），
导入出来的会话从来没走过 live 路径 —— 所以**导入历史必然全都没有缓存记录**，
列表里一片「未命名」。这不是标题事件缺失的问题：日志里 `session/title` 事件本来就有。

修法（`lib/projcache.mjs`）：把日志折成缓存行并落盘到
`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`。语义必须与宿主逐条对齐：

- 文档顶层 `version` 必须等于 `projectionCacheDomainSpec.version`（当前 **7**）；
- `record.identity` 要与 header 的 `formatVersion / createdAt / cwd / isSeeded` **全等**
  （`currentLifecycleMatches`；缺 `formatVersion` 的记录永不匹配）；
- `title` 单元 `stateVersion: 1`，值取最后一个 `session/title` 的 `data.title`；
- `sessionListMetadata` 单元 `stateVersion: 1`：`blank` 只被 `turn/start` 置 false，
  `lastPromptAt` 取 `user/message` 且 `data.source.kind === 'user'` 的 `time`。

`persistSession` / `appendSession` 落盘后都会调 `refreshProjectionCache` 写这一份；
写失败只忽略（缓存是派生数据）。

注意两条运维事实：

1. 缓存服务把 domain 一次性读进内存（`openPerRecordUnit` → `loadAll` → Map），
   **外部写文件对已运行的宿主无效，要重启 app 才可见**；
2. 缓存行只可能旧、不可能错（`viewCheckpoint` 按 `ver` 与 schema 过滤），
   所以只写 `title` 与 `sessionListMetadata` 两个键是安全的，其余键靠合并保留。

## 修复工具（`<DSH_HOME>/ai-import/tools`）

| 脚本 | 用途 |
| --- | --- |
| `repair-sessions.mjs` | 扫描/修复已落盘会话的声明块；`--dry` 只报告，`--only=<子串>` 限定会话 |
| `verify-session.mjs` | 用 DSH 自己的校验 worker 读一个会话文件，判定能否打开 |
| `verify-all.mjs` | 批量校验所有 `import-` 会话 |
| `check-gate.mjs` | 用插件自己的 `validateSessionEvents` 扫会话，`--all` 全量 |
| `e2e-claude.mjs` | 端到端回归：转换真实转录 → 落盘前归一 → 交 DSH 校验 |
| `title-audit.mjs` | 统计导入会话的标题事件与投影缓存覆盖情况 |
| `backfill-titles.mjs` | 回填投影缓存；日志里没有标题的会话会派生一条并**追加真事件**（`--dry` 只报告） |
| `verify-projcache.mjs` | 用宿主的 `checkpointRecord` zod schema 校验回填的缓存文档 |

会话文件是多帧拼接 zstd，必须按帧解压（`zstdDecompressSync(buf.slice(off), {info:true})`
配 `engine.bytesWritten` 推进），只重压改动过的帧。追加事件的方式要与宿主
`encodeEventBatch` 一致：`JSON + '\n'` 压成**一个** zstd 帧（`ZSTD_c_checksumFlag: 1`），
追加到文件尾。


## 配置（cordis patch）

```yaml
- override:
    id: ai-import
    config:
      claudeHome: ~/.claude          # 也可以写 $HOME/x、%APPDATA%/x
      codexHome: ~/.codex
      workbuddyHome: ~/.workbuddy
      cursorDb: ~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb
      includePromptOnlySources: false   # true 时连 Trae 的「只有提问」也导入
      cursorIncludeArchived: false
      cursorIncludeSubagents: false
      titlePrefixSource: true
      streamThresholdBytes: 209715200
```

**这些路径全都可以不填。** 不填时按下面的顺序找一个存在的：

1. 本节 `config` 里显式写死的值（优先级最高，给多开/特殊安装的人用）；
2. 面板里「换目录」存下来的手动路径 —— 写进 `<DSH_HOME>/ai-import/roots.json`，形如
   `{"claude":"D:\\data\\claude","cursor":"E:\\Cursor\\state.vscdb"}`；
3. 环境变量：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`CURSOR_DB`；
4. 按平台猜的默认位置（见下表）。

## 换一台电脑也能用（兜底策略）

本机之外常见的几种情况都已经兜住：

- **路径不同**：`lib/roots.mjs` 里给每个来源列了 Windows / macOS / Linux 的候选路径，逐个 `existsSync`，
  取第一个存在的。`~`、`%APPDATA%`、`$HOME`、`${XDG_CONFIG_HOME}` 都会展开。
- **装在别处 / 用便携版 / 多账号**：面板里点「换目录」，在输入框填路径或用目录树点进去，点「使用此目录」
  即记住（存 `roots.json`），下次扫描直接用。识别到目录属于哪个来源会实时提示。
- **Cursor / Trae 找不到数据库**：目录选择器会提示「再往下选到 `User/globalStorage`」，
  选中 `state.vscdb` 所在目录即可。
- **缺 SQLite 驱动**：Cursor / Trae 需要 Node 内置 `node:sqlite`。Node 版本够但没有该模块时，
  这两个来源会报错但不影响其它三个来源；面板里能直接看到错误文本。
- **缺宿主服务**：所有写路由都在 `sessionPersistence` 缺失时返回明确错误，不会炸掉宿主或整个面板。

## 数据源位置（本机实测，作为默认值的参考）

| 来源 | 位置 | 正文完整度 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 完整 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` + `archived_sessions/` | 完整 |
| WorkBuddy | `~/.workbuddy/projects/*/*.jsonl` | 完整 |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（`composerHeaders` + `cursorDiskKV` 的 `bubbleId:`） | 完整（工具气泡无文本，跳过） |
| Trae | `%APPDATA%/Trae*/User/workspaceStorage/*/state.vscdb` | **仅用户提问**，无助手回复 |

## 许可

`lib/vendor/convert.mjs` 取自 dsh-claude-move（vendored from [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)），Apache-2.0 AND MIT。

**本地改动**（与上游不同，升级上游时不要直接覆盖）：

- codex / workbuddy 两个分支在把工具调用推入 `step.toolCalls` 之前，先以同一对象推入
  `step.content`，使 `assistant/message` 带上声明块；
- `validateSessionEvents` 增加了工具生命周期检查（见上文「工具生命周期不变式」）。
