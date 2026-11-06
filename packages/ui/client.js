/**
 * dsh-ai-import-ui —— Client 半边。
 *
 * 两种入口，共用同一份页面实现：
 *   1) shell.overlay   → 右下角悬浮按钮 + 右侧抽屉（主形态）
 *   2) settings.section → 「设置 → AI 对话导入」页
 *
 * 纯 React + 宿主主题 token（--dsw-alias-*），不 import 任何 Harness Client 包，
 * 不往 document.body 追加节点，样式全部 aii- 前缀。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-import-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const SECTION_ID = 'ai-import'
    const NAMESPACE = 'dsh-ai-import-ui'
    const API = '/api/ai-import'
    const POLL_MS = 800
    const ENTRY_LIMIT = 300
    const ROW_LIMIT = 200

    /* ------------------------------------------------------------- 文案 */

    const ZH = {
      nav: 'AI 对话导入',
      fab: 'AI 导入',
      title: 'AI 对话导入',
      sub:
        '把本机 Claude Code / Codex / WorkBuddy / Cursor / Trae 的历史对话导入 DSH。' +
        '每个来源汇总到一个工作区，重跑只追加新增回合。',
      rescan: '重新扫描',
      scanAgain: '扫描中…',
      importBtn: '开始导入',
      importing: '导入中…',
      cancel: '取消',
      neverScanned: '尚未扫描',
      scannedAt: '扫描于 {0}',
      sources: '来源',
      selectAll: '全选',
      selectNone: '全不选',
      found: '发现 {0}',
      fresh: '新增',
      changed: '有更新',
      known: '已导入',
      filtered: '过滤',
      options: '导入选项',
      dryRun: '只预演（转换但不落盘）',
      dryRunHint: '用来确认能转出多少会话、多少事件，不会写任何文件。',
      force: '强制重导（忽略台账）',
      forceHint: '会为已知会话再生成一份副本，通常只在排查问题时使用。',
      limit: '每个来源最多导入',
      limitPlaceholder: '不限',
      limitUnit: '条',
      progress: '进度',
      currentSource: '正在处理：{0}',
      stateDone: '已完成 {0}/{1} 个来源',
      doneTitle: '导入完成',
      cancelledTitle: '已取消',
      errorTitle: '导入失败',
      resultCreated: '新建 {0}',
      resultAppended: '追加 {0}',
      resultSkipped: '跳过 {0}',
      resultFailed: '失败 {0}',
      rows: '会话明细',
      colState: '状态',
      colSession: '会话',
      colGroup: '工作区',
      colSize: '规模',
      statusCreated: '新建',
      statusAppended: '追加',
      statusSkipped: '跳过',
      statusFailed: '失败',
      statusEmpty: '空会话',
      turns: '{0} 轮',
      events: '{0} 事件',
      entries: '待导入明细',
      entriesCount: '（{0} 条）',
      collapse: '收起',
      expand: '展开',
      moreEntries: '仅显示前 {0} 条',
      noEntries: '没有待导入的条目',
      noSources: '没有发现可导入的来源，检查一下各来源的家目录是否存在。',
      loading: '正在读取本机历史…',
      refreshSessions: '刷新会话列表',
      sessionsRefreshed: '会话列表已刷新',
      routesMissing: '界面接口未就绪（插件的 Host 半边没注册路由，或 webServer 不可用）。',
      errorPrefix: '出错：{0}',
      emptyState: '暂无数据',
      root: '目录',
      close: '关闭',
      pickRoot: '换目录',
      pickRootTitle: '为「{0}」选择数据目录',
      pickRootHint: '留空则恢复自动探测。选中目录后点「使用此目录」，也可以直接粘贴路径。',
      pickRootPlaceholder: '例如 ~/.claude 或 D:\\data\\claude',
      useThisDir: '使用此目录',
      resetRoot: '恢复自动',
      up: '上一级',
      detected: '认出：{0}',
      notDetected: '这个目录看起来不是已知来源的数据根',
      rootManual: '手动指定',
      rootAuto: '自动探测',
      rootMissing: '未找到',
      manualRootsHint: '换电脑或历史不在默认位置时，可以在这里手动指定目录。',
      browseEmpty: '这个目录下没有子目录',
      browseLoading: '正在读取目录…',
      modeSimple: '简版',
      modeWizard: '逐条挑选',
      wizardHint: '上排三栏：左边挑来源，中间勾对话，右边挑归档文件夹；下面整条是预览。都定了再点导入。',
      wizFolders: '文件夹',
      wizPending: '待导入来源',
      wizImported: '已导入',
      wizNoFolders: '还没有文件夹',
      wizNewFolder: '新建文件夹',
      wizNewFolderPlaceholder: '文件夹名',
      wizCreate: '建立',
      wizTarget: '归档到',
      wizAssign: '把勾选的归到这里',
      wizClearAssign: '取消归档指定',
      wizAssigned: '归入「{0}」',
      wizPickNone: '先勾选对话',
      wizEntries: '对话',
      wizNoEntries: '这里还没有对话',
      wizPreview: '预览',
      wizPreviewEmpty: '点左边的对话，这里显示内容',
      wizPreviewNone: '这个会话没有可读的对话内容（只有工具调用或空壳），导入后会是空会话。',
      wizPreviewLoading: '正在读取内容…',
      wizImportPicked: '导入勾选的 {0} 条',
      wizSelectedCount: '已勾选 {0} 条',
      wizTurns: '共 {0} 轮',
      wizTruncated: '（只显示前 {0} 轮）',
      wizTool: '工具',
      wizThinking: '思考',
      wizUser: '用户',
      wizAssistant: '助手',
      wizAll: '全选',
      wizNone: '全不选',
      wizFolderEmpty: '这个文件夹里还没有已导入的对话',
      wizGroupArchived: '已归档',
      wizGroupPending: '待导入',
      wizFolderHint: '勾选下面的对话，再点右栏「归档到」，就能把它们放进这个文件夹。',
      wizRefresh: '刷新文件夹',
      wizRename: '改名',
      wizRenamePrompt: '新的文件夹名',
      wizCreated: '已建立「{0}」',
      wizAssignedNote: '已归入「{0}」（{1} 条）',
      wizUnassigned: '已取消归档指定',
      guideOpen: '使用指引',
      guideTitle: '第一次用？四步就能跑通',
      guideStep: '第 {0} / {1} 步',
      guidePrev: '上一步',
      guideNext: '下一步',
      guideDone: '开始使用',
      guideSkip: '不再显示',
      guide1Title: '① 这个面板做什么',
      guide1Body:
        '把本机 Claude Code、Codex、Cursor、WorkBuddy、Trae 的历史对话读出来，转成 DSH 会话。只读原始文件，不会改动或删除它们。',
      guide2Title: '② 先确认扫到的来源',
      guide2Body:
        '打开面板会自动扫描一次；没扫到、或路径不对，就点那个来源底下的「换目录」手动指到它的数据目录（例如 ~/.claude、~/.codex）。选过的目录会记住。',
      guide3Title: '③ 挑一种导入方式',
      guide3Body:
        '简版：勾来源 → 点「开始导入」，一次性导入。逐条挑选：进三栏界面，先看内容再勾，还能建文件夹把对话归进去。两种都能开「只预演」先看结果、不落盘。',
      guide4Title: '④ 导入之后',
      guide4Body:
        '每个来源一个工作区（如「Claude 对话」），逐条挑选里建的文件夹也会成为工作区。导入过的会话记在台账里，再扫一次只追加新回合，不会重复导入。',
      noSourcesHint:
        '没扫到可导入的对话时：先确认对应助手在本机用过；再点该来源的「换目录」指到它的数据目录；最后「重新扫描」。也可以点上面的「使用指引」看一遍流程。',
      totalsLabel: '扫描结果',
    }

    const EN = {
      nav: 'AI imports',
      fab: 'AI import',
      title: 'AI imports',
      sub:
        'Import local Claude Code / Codex / WorkBuddy / Cursor / Trae histories into DSH. ' +
        'Each source becomes one workspace; re-running only appends new turns.',
      rescan: 'Rescan',
      scanAgain: 'Scanning…',
      importBtn: 'Start import',
      importing: 'Importing…',
      cancel: 'Cancel',
      neverScanned: 'Not scanned yet',
      scannedAt: 'Scanned at {0}',
      sources: 'Sources',
      selectAll: 'All',
      selectNone: 'None',
      found: '{0} found',
      fresh: 'New',
      changed: 'Changed',
      known: 'Imported',
      filtered: 'Filtered',
      options: 'Options',
      dryRun: 'Dry run (convert, write nothing)',
      dryRunHint: 'Reports how many sessions and events would be produced without touching disk.',
      force: 'Force re-import (ignore ledger)',
      forceHint: 'Creates a second copy of known sessions; normally only for debugging.',
      limit: 'Max per source',
      limitPlaceholder: 'no limit',
      limitUnit: 'sessions',
      progress: 'Progress',
      currentSource: 'Working on: {0}',
      stateDone: '{0}/{1} sources processed',
      doneTitle: 'Import finished',
      cancelledTitle: 'Cancelled',
      errorTitle: 'Import failed',
      resultCreated: '{0} created',
      resultAppended: '{0} appended',
      resultSkipped: '{0} skipped',
      resultFailed: '{0} failed',
      rows: 'Sessions',
      colState: 'State',
      colSession: 'Session',
      colGroup: 'Workspace',
      colSize: 'Size',
      statusCreated: 'created',
      statusAppended: 'appended',
      statusSkipped: 'skipped',
      statusFailed: 'failed',
      statusEmpty: 'empty',
      turns: '{0} turns',
      events: '{0} events',
      entries: 'Pending items',
      entriesCount: ' ({0})',
      collapse: 'Collapse',
      expand: 'Expand',
      moreEntries: 'showing first {0}',
      noEntries: 'Nothing to import',
      noSources: 'No importable source found; check that each source home directory exists.',
      loading: 'Reading local histories…',
      refreshSessions: 'Refresh session list',
      sessionsRefreshed: 'Session list refreshed',
      routesMissing: 'The UI API is unavailable (host routes not registered, or webServer missing).',
      errorPrefix: 'Error: {0}',
      emptyState: 'No data',
      root: 'Path',
      close: 'Close',
      pickRoot: 'Change',
      pickRootTitle: 'Choose the data directory for {0}',
      pickRootHint: 'Leave empty to fall back to auto-detection. Pick a folder, or paste a path.',
      pickRootPlaceholder: 'e.g. ~/.claude or D:\\data\\claude',
      useThisDir: 'Use this folder',
      resetRoot: 'Use auto',
      up: 'Up',
      detected: 'Detected: {0}',
      notDetected: 'This folder does not look like a known source root',
      rootManual: 'manual',
      rootAuto: 'auto-detected',
      rootMissing: 'not found',
      manualRootsHint: 'On another machine, or when histories live elsewhere, point at the folder here.',
      browseEmpty: 'No sub-folders here',
      browseLoading: 'Reading folder…',
      modeSimple: 'Simple',
      modeWizard: 'Pick one by one',
      wizardHint: 'Top row: pick a source on the left, tick chats in the middle, pick a folder on the right. The full-width panel below previews content. Import when ready.',
      wizFolders: 'Folders',
      wizPending: 'Sources to import',
      wizImported: 'Imported',
      wizNoFolders: 'No folders yet',
      wizNewFolder: 'New folder',
      wizNewFolderPlaceholder: 'folder name',
      wizCreate: 'Create',
      wizTarget: 'Archive to',
      wizAssign: 'Move checked here',
      wizClearAssign: 'Clear target',
      wizAssigned: 'into {0}',
      wizPickNone: 'Check some chats first',
      wizEntries: 'Chats',
      wizNoEntries: 'No chats here',
      wizPreview: 'Preview',
      wizPreviewEmpty: 'Click a chat on the left to preview it',
      wizPreviewNone: 'This chat has no readable messages (tool calls or an empty shell only); importing it would create an empty session.',
      wizPreviewLoading: 'Reading…',
      wizImportPicked: 'Import {0} checked',
      wizSelectedCount: '{0} checked',
      wizTurns: '{0} turns',
      wizTruncated: ' (first {0} turns only)',
      wizTool: 'tool',
      wizThinking: 'thinking',
      wizUser: 'user',
      wizAssistant: 'assistant',
      wizAll: 'All',
      wizNone: 'None',
      wizFolderEmpty: 'Nothing imported into this folder yet',
      wizGroupArchived: 'Imported',
      wizGroupPending: 'To import',
      wizFolderHint: 'Check chats below, then click "File into" on the right to put them in this folder.',
      wizRefresh: 'Refresh folders',
      wizRename: 'Rename',
      wizRenamePrompt: 'New folder name',
      wizCreated: 'Created {0}',
      wizAssignedNote: 'Target set to {0} ({1})',
      wizUnassigned: 'Target cleared',
      guideOpen: 'Guide',
      guideTitle: 'First time? Four steps',
      guideStep: 'Step {0} of {1}',
      guidePrev: 'Back',
      guideNext: 'Next',
      guideDone: 'Start',
      guideSkip: "Don't show again",
      guide1Title: '1. What this panel does',
      guide1Body:
        'Reads local Claude Code, Codex, Cursor, WorkBuddy and Trae histories and converts them into DSH sessions. Source files are only read, never modified or deleted.',
      guide2Title: '2. Check the detected sources',
      guide2Body:
        'The panel scans once when it opens. If a source is missing or points to the wrong place, use "Change folder" under that source to pick its data directory (e.g. ~/.claude, ~/.codex). Choices are remembered.',
      guide3Title: '3. Pick an import mode',
      guide3Body:
        'Quick: tick sources and press Import. Per-chat: open the three-column view, read before you tick, and create folders to file chats into. Both support "Dry run" so you can see the result without writing.',
      guide4Title: '4. After importing',
      guide4Body:
        'Each source becomes one workspace (e.g. "Claude chats"); folders you create in the per-chat view become workspaces too. Imported sessions are recorded, so rescanning only appends new turns.',
      noSourcesHint:
        'Nothing importable found: first make sure the tool was actually used on this machine, then use "Change folder" on that source to point at its data directory, and rescan. The guide above walks through the same flow.',
      totalsLabel: 'Scan result',
    }

    const DICTS = { zh: ZH, en: EN }

    function format(template, args) {
      return String(template).replace(/\{(\d+)\}/g, (whole, index) => {
        const value = args[Number(index)]
        return value === undefined || value === null ? '' : String(value)
      })
    }

    function safeGet(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    function activeLocale(locale) {
      try {
        const snapshot = locale && locale.getSnapshot ? locale.getSnapshot() : null
        if (snapshot && snapshot.active) return String(snapshot.active)
      } catch {
        /* 老 shell 没有这个服务 */
      }
      try {
        return String(navigator.language || '')
      } catch {
        return ''
      }
    }

    function createTranslator(ctx) {
      const locale = safeGet(ctx, 'locale')
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        try {
          const disposers = []
          for (const code of Object.keys(DICTS)) disposers.push(locale.register(NAMESPACE, code, DICTS[code]))
          if (typeof ctx.effect === 'function') {
            ctx.effect(
              () => () => {
                for (const dispose of disposers.reverse()) {
                  try {
                    dispose?.()
                  } catch {
                    /* ignore */
                  }
                }
              },
              'ai-import-ui: locale dictionaries',
            )
          }
          const bound = locale.bind(NAMESPACE)
          return (key, ...args) => {
            // 宿主 locale 的 bind() 期望第二个参数是「具名参数对象」（配合 `{name}` 占位），
            // 而本插件词典用的是位置占位 `{0}`。直接把位置参数塞进去会踩两个坑：
            //   · 参数是 0/''（falsy）时宿主 `if (!params) return template` → 原样吐出 `{0}`；
            //   · 参数是数字/字符串时 `name in params` 抛 TypeError。
            // 所以摊成数字键对象 `{0: v, 1: v}`（`'0' in {0: v}` 成立），
            // 再兜一层：结果里还残留 `{n}` 就交给内置词典重填。
            const params =
              args.length === 0
                ? undefined
                : Object.fromEntries(args.map((value, index) => [String(index), value]))
            try {
              const text = bound(key, params)
              if (typeof text === 'string' && text !== '' && text !== key && !/\{\d+\}/.test(text)) {
                return text
              }
            } catch {
              /* 落到内置词典 */
            }
            const dict = activeLocale(locale).toLowerCase().startsWith('zh') ? ZH : EN
            return format(dict[key] ?? EN[key] ?? key, args)
          }
        } catch {
          /* 回退内置词典 */
        }
      }
      return (key, ...args) => {
        const dict = activeLocale(locale).toLowerCase().startsWith('zh') ? ZH : EN
        return format(dict[key] ?? EN[key] ?? key, args)
      }
    }

    /* ------------------------------------------------------------- 样式 */

    const CSS = `
.aii-root { display: flex; flex-direction: column; gap: 16px; padding: 0 0 32px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.aii-head { display: flex; align-items: flex-start; gap: 16px; }
.aii-head-text { min-width: 0; }
.aii-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.aii-sub { margin-top: 6px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 72ch; }
.aii-meta { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.aii-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.aii-empty-hint { margin-top: 6px; font-size: 12px; line-height: 19px; max-width: 72ch; }
.aii-actions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
.aii-btn { cursor: pointer; font: inherit; font-size: 13px; line-height: 20px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.aii-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.aii-btn:disabled { opacity: .5; cursor: not-allowed; }
.aii-btn--primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.aii-btn--small { padding: 2px 8px; font-size: 12px; }
.aii-link { cursor: pointer; font: inherit; font-size: 12px; line-height: 18px; padding: 0; border: 0; background: none; color: var(--dsw-alias-brand-primary); }
.aii-link:hover:not(:disabled) { text-decoration: underline; }
.aii-link:disabled { opacity: .5; cursor: not-allowed; }
.aii-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-base); }
.aii-card-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aii-card-title { font-size: 13px; font-weight: 600; }
.aii-card-tools { margin-left: auto; display: flex; gap: 12px; align-items: center; }
.aii-list { list-style: none; margin: 0; padding: 0; }
.aii-row { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.aii-row:first-child { border-top: 0; }
.aii-row--off { opacity: .62; }
.aii-row-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.aii-check { margin: 0; width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; flex-shrink: 0; }
.aii-row-label { font-size: 13px; font-weight: 600; }
.aii-row-path { margin-left: 25px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.aii-badges { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.aii-badge { font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.aii-badge--fresh { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.aii-badge--changed { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.aii-badge--failed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.aii-row-side { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.aii-entries { margin: 8px 0 0 25px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); max-height: 220px; overflow: auto; }
.aii-entry { display: flex; gap: 8px; padding: 1px 0; }
.aii-entry-kind { flex-shrink: 0; width: 44px; color: var(--dsw-alias-state-warn-primary); }
.aii-entry-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-entry-path { flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
.aii-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.aii-option { display: flex; gap: 10px; align-items: flex-start; }
.aii-option-text { min-width: 0; }
.aii-option-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.aii-input { font: inherit; font-size: 13px; line-height: 20px; width: 88px; padding: 3px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.aii-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.aii-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
.aii-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.aii-stat--created { color: var(--dsw-alias-state-success-primary); }
.aii-stat--appended { color: var(--dsw-alias-brand-primary); }
.aii-stat--failed { color: var(--dsw-alias-state-error-primary); }
.aii-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.aii-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.aii-table td { padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.aii-table tr:last-child td { border-bottom: 0; }
.aii-cell-title { max-width: 42ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-cell-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.aii-empty { padding: 18px 14px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.aii-banner { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; background: var(--dsw-alias-bg-base); }
.aii-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.aii-activity { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-all; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.aii-error-detail { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }

/* 初次使用指引 */
.aii-guide { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.aii-guide-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.aii-guide-title { font-size: 14px; line-height: 20px; font-weight: 600; }
.aii-guide-step { margin-left: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.aii-guide-body { font-size: 13px; line-height: 21px; }
.aii-guide-h { font-size: 13px; line-height: 20px; font-weight: 600; margin-bottom: 4px; }
.aii-guide-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.aii-guide-dots { display: flex; gap: 6px; align-items: center; }
.aii-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-border-l2); }
.aii-dot--on { background: var(--dsw-alias-brand-primary); }
.aii-guide-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 键盘可达性：面板里可点的东西都带上焦点环 */
.aii-btn:focus-visible, .aii-link:focus-visible, .aii-check:focus-visible, .aii-fab:focus-visible,
.aii-folder:focus-visible, .aii-input:focus-visible, .aii-picker-path:focus-visible, .aii-picker-dir:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}

/* 手动选目录 */
.aii-picker { margin: 8px 0 0 25px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 8px; }
.aii-picker-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.aii-picker-path { flex: 1; min-width: 160px; font: inherit; font-size: 12px; line-height: 18px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.aii-picker-dirs { list-style: none; margin: 0; padding: 0; max-height: 190px; overflow: auto; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.aii-picker-dir { font-size: 12px; line-height: 18px; padding: 3px 8px; cursor: pointer; display: flex; gap: 8px; align-items: center; }
.aii-picker-dir:hover { background: var(--dsw-alias-bg-layer-2); }
.aii-picker-dir-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-picker-dir-tag { flex-shrink: 0; font-size: 11px; color: var(--dsw-alias-state-success-primary); }
.aii-picker-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.aii-root-tag { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.aii-root-tag--manual { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }

/* 悬浮层：整层点击穿透，只有按钮与抽屉自己接管指针事件 */
.aii-layer { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.aii-fab { position: absolute; right: 20px; bottom: 74px; pointer-events: auto; display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.aii-fab:hover { background: var(--dsw-alias-bg-layer-2); }
.aii-fab-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dsw-alias-brand-primary); flex-shrink: 0; }
.aii-drawer { position: absolute; right: 16px; top: 16px; bottom: 16px; width: 480px; max-width: calc(100vw - 32px); pointer-events: auto; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.28); overflow: hidden; }
/* 切到「逐条挑选」时抽屉要宽得多，三栏才放得下 */
.aii-drawer--wide { width: min(1040px, calc(100vw - 32px)); }
.aii-drawer-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0; background: var(--dsw-alias-bg-layer-1); }
.aii-drawer-head .aii-title { font-size: 15px; line-height: 22px; }
.aii-drawer-head .aii-card-tools { gap: 8px; }
.aii-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 24px; }
.aii-drawer-body .aii-root { gap: 12px; padding: 0; }
.aii-drawer-body .aii-actions { flex-wrap: wrap; justify-content: flex-end; }

/* 向导：三栏（左 文件夹、中 对话、右 预览） */
.aii-stack { display: flex; flex-direction: column; gap: 12px; }
.aii-wiz-opts { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; line-height: 20px; }
.aii-wiz-opts label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.aii-wiz { display: grid; grid-template-columns: 190px minmax(0,1fr) 224px; gap: 0; height: 46vh; min-height: 320px; max-height: 560px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.aii-wiz-preview { display: flex; flex-direction: column; height: 34vh; min-height: 160px; max-height: 380px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.aii-wiz-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); }
.aii-wiz-col:last-child { border-right: 0; }
.aii-wiz-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex-shrink: 0; }
.aii-wiz-head .aii-card-title { font-size: 13px; line-height: 18px; }
.aii-wiz-head .aii-link { font-size: 12px; line-height: 18px; }
.aii-wiz-body { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.aii-wiz-foot { padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex-shrink: 0; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.aii-wiz-group { display: flex; align-items: center; gap: 8px; padding: 6px 6px 2px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.aii-folder { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer; }
.aii-folder:hover { background: var(--dsw-alias-bg-layer-2); }
.aii-folder--on { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.aii-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-folder-count { font-size: 12px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
.aii-chat { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.aii-chat:hover { background: var(--dsw-alias-bg-layer-2); }
.aii-chat--on { background: var(--dsw-alias-bg-layer-2); }
.aii-chat--archived { cursor: default; }
.aii-chat-body { flex: 1; min-width: 0; }
.aii-chat-title { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.aii-chat--archived .aii-chat-title { color: var(--dsw-alias-label-secondary); }
.aii-chat-meta { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.aii-chat-tag { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.aii-msg { padding: 8px 10px; border-radius: 8px; font-size: 13px; line-height: 20px; white-space: pre-wrap; word-break: break-word; }
.aii-msg + .aii-msg { margin-top: 6px; }
.aii-msg--user { background: var(--dsw-alias-bg-layer-2); }
.aii-msg--assistant { background: transparent; border-left: 2px solid var(--dsw-alias-border-l2); border-radius: 0 6px 6px 0; }
.aii-msg--thinking { background: transparent; border-left: 2px solid var(--dsw-alias-state-idle-primary); border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-secondary); font-style: italic; }
.aii-msg--tool { background: transparent; border-left: 2px solid var(--dsw-alias-state-warn-primary); border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 17px; }
.aii-msg-role { font-size: 11px; line-height: 15px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
`

    /* ------------------------------------------------------------- 工具 */

    function timeText(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function badgeClass(kind) {
      return `aii-badge aii-badge--${kind}`
    }

    function statusText(t, status) {
      switch (status) {
        case 'created':
          return t('statusCreated')
        case 'appended':
          return t('statusAppended')
        case 'skipped':
          return t('statusSkipped')
        case 'empty':
          return t('statusEmpty')
        default:
          return t('statusFailed')
      }
    }

    function statusClass(status) {
      if (status === 'created') return 'aii-badge aii-badge--fresh'
      if (status === 'failed') return 'aii-badge aii-badge--failed'
      return 'aii-badge'
    }

    function sizeText(row) {
      const parts = []
      if (Number.isFinite(row.turns)) parts.push(String(row.turns) + 'T')
      if (Number.isFinite(row.events)) parts.push(String(row.events) + 'E')
      return parts.join(' · ')
    }

    /* ------------------------------------------------------------- 页面 */

    // 抽屉要跟着「简版 / 逐条挑选」变宽，但模式状态在页面组件里、抽屉在悬浮层组件里，
    // 所以放一个极小的模块级订阅点：两边读写的是同一个值。
    const MODE_LISTENERS = new Set()
    let GLOBAL_MODE = 'simple'

    function setGlobalMode(next) {
      const value = next === 'wizard' ? 'wizard' : 'simple'
      if (value === GLOBAL_MODE) return
      GLOBAL_MODE = value
      for (const listener of Array.from(MODE_LISTENERS)) listener(value)
    }

    function useGlobalMode() {
      const [value, setValue] = useState(GLOBAL_MODE)
      useEffect(() => {
        const listener = (next) => setValue(next)
        MODE_LISTENERS.add(listener)
        setValue(GLOBAL_MODE)
        return () => {
          MODE_LISTENERS.delete(listener)
        }
      }, [])
      return value
    }

    // 初次使用指引：第一次打开抽屉时自动展开，之后可在页头「使用指引」重新打开。
    const GUIDE_KEY = 'dsh-ai-import-ui.guide.seen'
    let GUIDE_SHOWN_THIS_SESSION = false
    const GUIDE_STEPS = [
      ['guide1Title', 'guide1Body'],
      ['guide2Title', 'guide2Body'],
      ['guide3Title', 'guide3Body'],
      ['guide4Title', 'guide4Body'],
    ]

    function createPage(t, ctx, options) {
      const compact = Boolean(options && options.compact)

      return function AiImportSection() {
        const [data, setData] = useState(null)
        const [loading, setLoading] = useState(false)
        const [error, setError] = useState('')
        const [selected, setSelected] = useState(null)
        const [dryRun, setDryRun] = useState(false)
        const [force, setForce] = useState(false)
        const [limit, setLimit] = useState('')
        const [job, setJob] = useState(null)
        const [openSource, setOpenSource] = useState(null)
        const [note, setNote] = useState('')
        // 手动选目录：picker 记录正在给哪个来源挑目录，目录内容走 /browse。
        const [picker, setPicker] = useState(null)
        // 视图形态：简版（按来源一把导） / 逐条挑选（三栏向导）
        const [mode, setMode] = useState('simple')
        // 初次使用指引
        const [guideOpen, setGuideOpen] = useState(false)
        const [guideStep, setGuideStep] = useState(0)

        // 抽屉在悬浮层组件里，三栏要更宽，所以把模式同步到模块级订阅点
        useEffect(() => {
          setGlobalMode(mode)
        }, [mode])
        const mounted = useRef(true)

        useEffect(() => {
          mounted.current = true
          return () => {
            mounted.current = false
          }
        }, [])

        // 本机没记过「已看过指引」就自动展开一次；localStorage 不可用时退化成每次会话一次。
        useEffect(() => {
          let seen = false
          try {
            seen = window.localStorage.getItem(GUIDE_KEY) === '1'
          } catch {
            seen = GUIDE_SHOWN_THIS_SESSION
          }
          if (!seen) {
            GUIDE_SHOWN_THIS_SESSION = true
            setGuideOpen(true)
          }
        }, [])

        const closeGuide = useCallback((remember) => {
          setGuideOpen(false)
          if (!remember) return
          try {
            window.localStorage.setItem(GUIDE_KEY, '1')
          } catch {
            /* 存不进就算了，下次再弹一次 */
          }
        }, [])

        const load = useCallback(async (refresh) => {
          setLoading(true)
          setError('')
          try {
            const response = await fetch(`${API}/index${refresh ? '?refresh=1' : ''}`, {
              headers: { accept: 'application/json' },
            })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (mounted.current) setData(json)
          } catch (err) {
            if (mounted.current) setError(t('errorPrefix', String((err && err.message) || err)))
          } finally {
            if (mounted.current) setLoading(false)
          }
        }, [])

        useEffect(() => {
          void load(false)
        }, [load])

        const sources = useMemo(() => (data && Array.isArray(data.sources) ? data.sources : []), [data])

        const autoSelected = useMemo(() => {
          const set = new Set()
          for (const source of sources) {
            if (source.fresh + source.changed > 0) set.add(source.id)
          }
          return set
        }, [sources])

        const chosen = selected ?? autoSelected
        const jobRunning = Boolean(job && job.status === 'running')
        const busy = loading || jobRunning

        const toggle = useCallback(
          (id) => {
            setSelected((current) => {
              const next = new Set(current ?? autoSelected)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          },
          [autoSelected],
        )

        const totalSelected = chosen.size

        // 统一提交入口：简版按来源，向导按逐条 picks。
        const submit = useCallback(async (payload) => {
          setError('')
          setNote('')
          try {
            const response = await fetch(`${API}/import`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (!mounted.current) return
            const picksCount = Array.isArray(payload.picks) ? payload.picks.length : 0
            setJob({
              jobId: json.jobId,
              status: 'running',
              dryRun,
              force,
              total: picksCount > 0 ? picksCount : Array.isArray(payload.sources) ? payload.sources.length : 0,
              done: 0,
              current: null,
              currentProcessed: 0,
              currentTotal: null,
              activity: null,
              created: 0,
              appended: 0,
              skipped: 0,
              failed: 0,
              rows: [],
            })
          } catch (err) {
            if (mounted.current) setError(t('errorPrefix', String((err && err.message) || err)))
          }
        }, [dryRun, force])

        const start = useCallback(() => {
          const ids = Array.from(chosen)
          if (ids.length === 0) return
          const payload = { sources: ids, dryRun, force }
          const parsed = Number(limit)
          if (Number.isFinite(parsed) && parsed > 0) payload.limit = Math.floor(parsed)
          void submit(payload)
        }, [chosen, dryRun, force, limit, submit])

        // 向导提交：picks 里每条带 key + 目标文件夹。
        const startPicks = useCallback(
          (picks) => {
            if (!Array.isArray(picks) || picks.length === 0) return
            const payload = { picks, dryRun, force }
            const parsed = Number(limit)
            if (Number.isFinite(parsed) && parsed > 0) payload.limit = Math.floor(parsed)
            void submit(payload)
          },
          [dryRun, force, limit, submit],
        )

        const cancel = useCallback(async () => {
          if (!job) return
          try {
            await fetch(`${API}/job?job=${encodeURIComponent(job.jobId)}`, { method: 'DELETE' })
          } catch {
            /* 取消失败就等它自己跑完 */
          }
        }, [job])

        const jobId = job ? job.jobId : null
        const jobStatus = job ? job.status : null

        // 向导组件只依赖 t/ctx，数据走 props —— 否则每次重扫都会生成新组件类型，
        // React 会卸载重挂，勾选状态全丢。
        const Wizard = useMemo(() => createWizard(t, ctx), [])

        useEffect(() => {
          if (jobId === null || jobStatus !== 'running') return undefined
          let stopped = false
          const tick = async () => {
            try {
              const response = await fetch(`${API}/progress?job=${encodeURIComponent(jobId)}`, {
                headers: { accept: 'application/json' },
              })
              if (!response.ok) return
              const json = await response.json()
              if (stopped || !mounted.current) return
              setJob(json)
            } catch {
              /* 单次轮询失败不影响下一次 */
            }
          }
          const timer = setInterval(() => void tick(), POLL_MS)
          void tick()
          return () => {
            stopped = true
            clearInterval(timer)
          }
        }, [jobId, jobStatus])

        const settled = jobStatus === 'done' || jobStatus === 'cancelled'
        useEffect(() => {
          if (!settled) return
          void load(true)
          const sessions = safeGet(ctx, 'sessions')
          try {
            if (sessions && typeof sessions.refresh === 'function') {
              sessions.refresh()
              if (mounted.current) setNote(t('sessionsRefreshed'))
            }
          } catch {
            /* 老 shell 没有会话服务 */
          }
        }, [settled])

        const refreshSessions = useCallback(() => {
          const sessions = safeGet(ctx, 'sessions')
          try {
            if (sessions && typeof sessions.refresh === 'function') {
              sessions.refresh()
              setNote(t('sessionsRefreshed'))
              return
            }
          } catch {
            /* fall through */
          }
          try {
            window.location.reload()
          } catch {
            /* ignore */
          }
        }, [])

        /* ---------------------------------------------------- 手动选目录 */

        const openPicker = useCallback(
          (source) => {
            const start = (source && (source.manualRoot || source.root || source.candidates?.[0])) || ''
            setPicker({ source: source.id, label: source.label, path: start, listing: null, busy: false, error: '' })
            void browseTo(start)
          },
          [],
        )

        async function browseTo(target) {
          setPicker((current) => (current === null ? current : { ...current, busy: true, error: '' }))
          try {
            const response = await fetch(`${API}/browse?path=${encodeURIComponent(target || '')}`, {
              headers: { accept: 'application/json' },
            })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (!mounted.current) return
            setPicker((current) =>
              current === null
                ? current
                : { ...current, path: json.path ?? target, listing: json, busy: false, error: json.error ?? '' },
            )
          } catch (err) {
            if (!mounted.current) return
            setPicker((current) =>
              current === null ? current : { ...current, busy: false, error: String((err && err.message) || err) },
            )
          }
        }

        const applyRoot = useCallback(
          async (sourceId, dir) => {
            try {
              const response = await fetch(`${API}/root`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: sourceId, dir: dir ?? '' }),
              })
              if (response.status === 404) throw new Error(t('routesMissing'))
              const json = await response.json()
              if (!response.ok || json.ok !== true) throw new Error(json.error || `HTTP ${response.status}`)
              if (!mounted.current) return
              setPicker(null)
              setNote(dir ? t('rootManual') : t('rootAuto'))
              await load(true)
            } catch (err) {
              if (!mounted.current) return
              setPicker((current) =>
                current === null ? current : { ...current, busy: false, error: String((err && err.message) || err) },
              )
            }
          },
          [load],
        )

        /* ---------------------------------------------------------- 片段 */

        function renderEntryList(source) {
          const entries = source.entries.filter((entry) => entry.kind === 'new' || entry.kind === 'changed')
          if (entries.length === 0) return h('div', { className: 'aii-entries' }, t('noEntries'))
          const shown = entries.slice(0, ENTRY_LIMIT)
          return h(
            'div',
            { className: 'aii-entries' },
            shown.map((entry, index) =>
              h(
                'div',
                { className: 'aii-entry', key: `${entry.key}-${index}` },
                h('span', { className: 'aii-entry-kind' }, entry.kind === 'new' ? t('fresh') : t('changed')),
                h('span', { className: 'aii-entry-label', title: entry.path }, entry.label),
                h('span', { className: 'aii-entry-path', title: entry.path }, entry.projectPath ?? ''),
              ),
            ),
            entries.length > shown.length
              ? h('div', { className: 'aii-note' }, t('moreEntries', shown.length))
              : null,
          )
        }

        function renderPicker(source) {
          if (picker === null || picker.source !== source.id) return null
          const listing = picker.listing
          const detected = listing && listing.detected ? listing.detected : null
          const dirs = listing && Array.isArray(listing.dirs) ? listing.dirs : []
          return h(
            'div',
            { className: 'aii-picker' },
            h('div', { className: 'aii-picker-hint' }, t('pickRootHint')),
            h(
              'div',
              { className: 'aii-picker-row' },
              h('input', {
                className: 'aii-picker-path',
                value: picker.path ?? '',
                placeholder: t('pickRootPlaceholder'),
                spellCheck: false,
                onChange: (event) => {
                  const next = event.target.value
                  setPicker((current) => (current === null ? current : { ...current, path: next }))
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void browseTo(picker.path ?? '')
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-btn aii-btn--small',
                  disabled: !listing || !listing.parent,
                  onClick: () => void browseTo((listing && listing.parent) || picker.path || ''),
                },
                t('up'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-btn aii-btn--small aii-btn--primary',
                  onClick: () => void applyRoot(source.id, listing?.path ?? picker.path ?? ''),
                },
                t('useThisDir'),
              ),
              h(
                'button',
                { type: 'button', className: 'aii-btn aii-btn--small', onClick: () => void applyRoot(source.id, '') },
                t('resetRoot'),
              ),
              h(
                'button',
                { type: 'button', className: 'aii-btn aii-btn--small', onClick: () => setPicker(null) },
                t('close'),
              ),
            ),
            detected
              ? h(
                  'div',
                  { className: 'aii-picker-hint' },
                  detected.source ? t('detected', detected.hint || detected.source) : t('notDetected'),
                )
              : null,
            picker.busy ? h('div', { className: 'aii-picker-hint' }, t('browseLoading')) : null,
            picker.error ? h('div', { className: 'aii-error-detail' }, picker.error) : null,
            h(
              'ul',
              { className: 'aii-picker-dirs' },
              dirs.length === 0
                ? h('li', { className: 'aii-picker-dir' }, h('span', { className: 'aii-picker-dir-name' }, t('browseEmpty')))
                : dirs.map((dir) =>
                    h(
                      'li',
                      {
                        key: dir.path,
                        className: 'aii-picker-dir',
                        onClick: () => void browseTo(dir.path),
                        title: dir.path,
                      },
                      h('span', { className: 'aii-picker-dir-name' }, dir.name),
                      dir.source ? h('span', { className: 'aii-picker-dir-tag' }, dir.source) : null,
                    ),
                  ),
            ),
          )
        }

        function renderSource(source) {
          const checked = chosen.has(source.id)
          const importable = source.fresh + source.changed
          const expanded = openSource === source.id
          const rootTag = source.manualRoot
            ? h('span', { className: 'aii-root-tag aii-root-tag--manual' }, t('rootManual'))
            : source.root
              ? h('span', { className: 'aii-root-tag' }, t('rootAuto'))
              : h('span', { className: 'aii-root-tag' }, t('rootMissing'))
          return h(
            'li',
            { className: `aii-row${checked ? '' : ' aii-row--off'}`, key: source.id },
            h(
              'div',
              { className: 'aii-row-main' },
              h('input', {
                type: 'checkbox',
                className: 'aii-check',
                checked,
                disabled: busy,
                onChange: () => toggle(source.id),
              }),
              h('span', { className: 'aii-row-label' }, source.label),
              h(
                'span',
                { className: 'aii-badges' },
                source.fresh > 0
                  ? h('span', { className: badgeClass('fresh') }, `${t('fresh')} ${source.fresh}`)
                  : null,
                source.changed > 0
                  ? h('span', { className: badgeClass('changed') }, `${t('changed')} ${source.changed}`)
                  : null,
                source.known > 0 ? h('span', { className: 'aii-badge' }, `${t('known')} ${source.known}`) : null,
                source.filtered > 0
                  ? h('span', { className: 'aii-badge' }, `${t('filtered')} ${source.filtered}`)
                  : null,
                source.errors.length > 0 ? h('span', { className: badgeClass('failed') }, `${source.errors.length}`) : null,
              ),
              h(
                'span',
                { className: 'aii-row-side' },
                importable > 0
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'aii-link',
                        onClick: () => setOpenSource(expanded ? null : source.id),
                      },
                      (expanded ? t('collapse') : t('entries')) + t('entriesCount', importable),
                    )
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'aii-row-path' },
              rootTag,
              h('span', null, ' '),
              h('span', null, source.manualRoot || source.root || ''),
              h('span', null, ' '),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-link',
                  disabled: busy,
                  onClick: () => (picker && picker.source === source.id ? setPicker(null) : openPicker(source)),
                },
                t('pickRoot'),
              ),
            ),
            renderPicker(source),
            source.errors.length > 0
              ? h(
                  'div',
                  { className: 'aii-error-detail' },
                  source.errors.slice(0, 3).map((message, index) => h('div', { key: index }, message)),
                )
              : null,
            expanded ? renderEntryList(source) : null,
          )
        }

        function renderGuide() {
          if (!guideOpen) return null
          const total = GUIDE_STEPS.length
          const step = Math.min(Math.max(guideStep, 0), total - 1)
          const [titleKey, bodyKey] = GUIDE_STEPS[step]
          const last = step + 1 >= total
          return h(
            'section',
            { className: 'aii-guide' },
            h(
              'div',
              { className: 'aii-guide-head' },
              h('span', { className: 'aii-guide-title' }, t('guideTitle')),
              h('span', { className: 'aii-guide-step' }, t('guideStep', step + 1, total)),
            ),
            h(
              'div',
              { className: 'aii-guide-body' },
              h('div', { className: 'aii-guide-h' }, t(titleKey)),
              h('div', null, t(bodyKey)),
            ),
            h(
              'div',
              { className: 'aii-guide-foot' },
              h(
                'span',
                { className: 'aii-guide-dots', 'aria-hidden': 'true' },
                GUIDE_STEPS.map((_, index) =>
                  h('span', {
                    key: String(index),
                    className: `aii-dot${index === step ? ' aii-dot--on' : ''}`,
                  }),
                ),
              ),
              h(
                'span',
                { className: 'aii-guide-actions' },
                step > 0
                  ? h(
                      'button',
                      { type: 'button', className: 'aii-btn', onClick: () => setGuideStep(step - 1) },
                      t('guidePrev'),
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'aii-link', onClick: () => closeGuide(true) },
                  t('guideSkip'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'aii-btn aii-btn--primary',
                    onClick: () => (last ? closeGuide(true) : setGuideStep(step + 1)),
                  },
                  last ? t('guideDone') : t('guideNext'),
                ),
              ),
            ),
          )
        }

        function renderJob() {
          if (!job) return null
          const total = job.total || 0
          const done = job.done || 0
          // 来源内部的细粒度进度只在「还有来源在跑」时计入；最后一个来源跑完后 done 已含它，再叠加就会超过 100%。
          const running = job.status === 'running'
          const inside = running && job.currentTotal ? Math.min((job.currentProcessed || 0) / job.currentTotal, 0.99) : 0
          const raw = total > 0 ? ((done + inside) / total) * 100 : 0
          const percent = job.status === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(raw)))
          const rows = Array.isArray(job.rows) ? job.rows : []
          const shownRows = rows.slice(0, ROW_LIMIT)
          const heading =
            job.status === 'running'
              ? t('progress')
              : job.status === 'done'
                ? t('doneTitle')
                : job.status === 'cancelled'
                  ? t('cancelledTitle')
                  : t('errorTitle')
          return h(
            'section',
            { className: 'aii-card' },
            h(
              'div',
              { className: 'aii-card-head' },
              h('span', { className: 'aii-card-title' }, heading),
              h(
                'span',
                { className: 'aii-card-tools' },
                job.status === 'running'
                  ? h('button', { type: 'button', className: 'aii-btn aii-btn--small', onClick: cancel }, t('cancel'))
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'aii-btn aii-btn--small', onClick: refreshSessions },
                  t('refreshSessions'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'aii-body' },
              h('div', { className: 'aii-bar' }, h('div', { className: 'aii-bar-fill', style: { width: `${percent}%` } })),
              h(
                'div',
                { className: 'aii-stats' },
                h('span', null, t('stateDone', done, total)),
                job.current ? h('span', null, t('currentSource', job.current)) : null,
                h('span', { className: 'aii-stat--created' }, t('resultCreated', job.created ?? 0)),
                h('span', { className: 'aii-stat--appended' }, t('resultAppended', job.appended ?? 0)),
                h('span', null, t('resultSkipped', job.skipped ?? 0)),
                h('span', { className: 'aii-stat--failed' }, t('resultFailed', job.failed ?? 0)),
                job.dryRun ? h('span', null, t('dryRun')) : null,
              ),
              job.error ? h('div', { className: 'aii-error-detail' }, job.error) : null,
              job.activity
                ? h(
                    'div',
                    { className: 'aii-activity' },
                    job.currentTotal ? `${job.currentProcessed || 0}/${job.currentTotal} · ` : '',
                    job.activity,
                  )
                : null,
              shownRows.length > 0
                ? h(
                    'table',
                    { className: 'aii-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, t('colState')),
                        h('th', null, t('colSession')),
                        h('th', null, t('colGroup')),
                        h('th', null, t('colSize')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      shownRows.map((row, index) =>
                        h(
                          'tr',
                          { key: `${row.sessionId ?? row.label ?? index}-${index}` },
                          h('td', null, h('span', { className: statusClass(row.status) }, statusText(t, row.status))),
                          h(
                            'td',
                            null,
                            h('div', { className: 'aii-cell-title', title: row.label ?? row.title ?? '' }, row.title ?? row.label ?? ''),
                            row.sessionId ? h('div', { className: 'aii-cell-mono' }, row.sessionId) : null,
                            row.error ? h('div', { className: 'aii-error-detail' }, row.error) : null,
                            row.reason ? h('div', { className: 'aii-error-detail' }, row.reason) : null,
                          ),
                          h('td', { className: 'aii-note' }, row.group ?? ''),
                          h('td', { className: 'aii-note' }, sizeText(row)),
                        ),
                      ),
                    ),
                  )
                : null,
              rows.length > shownRows.length
                ? h('div', { className: 'aii-note' }, t('moreEntries', shownRows.length))
                : null,
            ),
          )
        }

        /* ---------------------------------------------------------- 渲染 */

        const totals = data ? data.totals : null
        const metaText = [
          data && data.scannedAt ? t('scannedAt', timeText(data.scannedAt)) : t('neverScanned'),
          note,
        ]
          .filter((part) => part !== '')
          .join(' · ')

        // 扫描结果单列一行 chip：塞在灰色小字里不好扫读
        const totalChips = totals
          ? [
              ['fresh', totals.fresh, 'fresh'],
              ['changed', totals.changed, 'changed'],
              ['known', totals.known, ''],
              ['filtered', totals.filtered, ''],
            ]
              .filter(([, value]) => Number(value) > 0)
              .map(([key, value, tone]) =>
                h(
                  'span',
                  { key, className: `aii-badge${tone ? ` aii-badge--${tone}` : ''}` },
                  `${t(key)} ${value}`,
                ),
              )
          : []

        return h(
          'div',
          { className: 'aii-root' },
          h('style', { key: 'aii-style' }, CSS),
          h(
            'div',
            { className: 'aii-head' },
            h(
              'div',
              { className: 'aii-head-text' },
              compact ? null : h('h1', { className: 'aii-title' }, t('title')),
              compact ? null : h('div', { className: 'aii-sub' }, t('sub')),
              h('div', { className: 'aii-meta' }, metaText),
              totalChips.length > 0
                ? h('div', { className: 'aii-chips', title: t('totalsLabel') }, totalChips)
                : null,
            ),
            h(
              'div',
              { className: 'aii-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-link',
                  onClick: () => {
                    setGuideStep(0)
                    setGuideOpen(true)
                  },
                },
                t('guideOpen'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-link',
                  onClick: () => setMode(mode === 'wizard' ? 'simple' : 'wizard'),
                  disabled: jobRunning,
                },
                mode === 'wizard' ? t('modeSimple') : t('modeWizard'),
              ),
              h(
                'button',
                { type: 'button', className: 'aii-btn', onClick: () => void load(true), disabled: busy },
                loading ? t('scanAgain') : t('rescan'),
              ),
              mode === 'simple'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'aii-btn aii-btn--primary',
                      onClick: () => void start(),
                      disabled: busy || totalSelected === 0,
                    },
                    jobRunning ? t('importing') : t('importBtn'),
                  )
                : null,
            ),
          ),
          error ? h('div', { className: 'aii-banner' }, error) : null,
          renderGuide(),
          mode === 'wizard'
            ? h(Wizard, { data, busy, startPicks, dryRun, force, limit, setDryRun, setForce, setLimit })
            : null,
          mode === 'simple'
            ? h(
                'div',
                { className: 'aii-stack' },
                h(
                  'section',
                  { className: 'aii-card' },
                  h(
                    'div',
                    { className: 'aii-card-head' },
                    h('span', { className: 'aii-card-title' }, t('sources')),
                    h(
                      'span',
                      { className: 'aii-card-tools' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'aii-link',
                          onClick: () => setSelected(new Set(sources.map((source) => source.id))),
                          disabled: busy || sources.length === 0,
                        },
                        t('selectAll'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'aii-link',
                          onClick: () => setSelected(new Set()),
                          disabled: busy || sources.length === 0,
                        },
                        t('selectNone'),
                      ),
                    ),
                  ),
                  sources.length === 0
                    ? h(
                        'div',
                        { className: 'aii-empty' },
                        h('div', null, loading ? t('loading') : t('noSources')),
                        loading ? null : h('div', { className: 'aii-empty-hint' }, t('noSourcesHint')),
                      )
                    : h('ul', { className: 'aii-list' }, sources.map(renderSource)),
                ),
                h(
                  'section',
                  { className: 'aii-card' },
                  h('div', { className: 'aii-card-head' }, h('span', { className: 'aii-card-title' }, t('options'))),
                  h(
              'div',
              { className: 'aii-body' },
              h(
                'label',
                { className: 'aii-option' },
                h('input', {
                  type: 'checkbox',
                  className: 'aii-check',
                  checked: dryRun,
                  disabled: jobRunning,
                  onChange: (event) => setDryRun(event.target.checked),
                }),
                h(
                  'span',
                  { className: 'aii-option-text' },
                  h('div', null, t('dryRun')),
                  h('div', { className: 'aii-option-hint' }, t('dryRunHint')),
                ),
              ),
              h(
                'label',
                { className: 'aii-option' },
                h('input', {
                  type: 'checkbox',
                  className: 'aii-check',
                  checked: force,
                  disabled: jobRunning,
                  onChange: (event) => setForce(event.target.checked),
                }),
                h(
                  'span',
                  { className: 'aii-option-text' },
                  h('div', null, t('force')),
                  h('div', { className: 'aii-option-hint' }, t('forceHint')),
                ),
              ),
              h(
                'label',
                { className: 'aii-option' },
                h('input', {
                  type: 'number',
                  className: 'aii-input',
                  min: 1,
                  step: 1,
                  value: limit,
                  placeholder: t('limitPlaceholder'),
                  disabled: jobRunning,
                  onChange: (event) => setLimit(event.target.value),
                }),
                h(
                  'span',
                  { className: 'aii-option-text' },
                  h('div', null, `${t('limit')}（${t('limitUnit')}）`),
                ),
              ),
            ),
                ),
              )
            : null,
          renderJob(),
        )
      }
    }

    /* ------------------------------------------------------- 三栏向导 */

    // 左：文件夹（含「待导入」虚拟文件夹）→ 中：该文件夹里的对话 → 右：预览 + 新建文件夹 + 归入
    function createWizard(t, ctx) {
      return function AiImportWizard(props) {
        const api = props || {}
        const [folders, setFolders] = useState(null)
        const [folderError, setFolderError] = useState('')
        const [folderLoading, setFolderLoading] = useState(false)
        const [active, setActive] = useState('')
        const [checked, setChecked] = useState(new Set())
        const [targets, setTargets] = useState({})
        const [preview, setPreview] = useState(null)
        const [folderDetail, setFolderDetail] = useState(null)
        const [newName, setNewName] = useState('')
        const [note, setNote] = useState('')
        const mounted = useRef(true)

        useEffect(() => {
          mounted.current = true
          return () => {
            mounted.current = false
          }
        }, [])

        const loadFolders = useCallback(async () => {
          setFolderLoading(true)
          setFolderError('')
          try {
            const response = await fetch(`${API}/folders`, { headers: { accept: 'application/json' } })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (mounted.current) setFolders(Array.isArray(json.folders) ? json.folders : [])
          } catch (err) {
            if (mounted.current) setFolderError(t('errorPrefix', String((err && err.message) || err)))
          } finally {
            if (mounted.current) setFolderLoading(false)
          }
        }, [])

        useEffect(() => {
          void loadFolders()
        }, [loadFolders])

        // 点开一个归档文件夹时，拉它里面已导入的会话
        const openFolder = useCallback(async (dir) => {
          setFolderDetail({ dir, loading: true, sessions: [] })
          try {
            const response = await fetch(`${API}/folders?dir=${encodeURIComponent(dir)}`, {
              headers: { accept: 'application/json' },
            })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (mounted.current) setFolderDetail({ dir, loading: false, sessions: Array.isArray(json.sessions) ? json.sessions : [] })
          } catch (err) {
            if (mounted.current)
              setFolderDetail({ dir, loading: false, sessions: [], error: t('errorPrefix', String((err && err.message) || err)) })
          }
        }, [])

        const data = api.data
        const sources = useMemo(() => (data && Array.isArray(data.sources) ? data.sources : []), [data])
        const pendingBySource = useMemo(() => {
          const map = new Map()
          for (const source of sources) {
            const entries = (source.entries ?? []).filter((entry) => entry.kind === 'new' || entry.kind === 'changed')
            if (entries.length > 0) map.set(source.id, { source, entries })
          }
          return map
        }, [sources])

        // 上排左栏：待导入的来源，每个来源一条；上排右栏：磁盘上已有的归档文件夹。
        const sourceItems = useMemo(() => {
          const items = []
          for (const [id, bucket] of pendingBySource) {
            items.push({
              key: `pending:${id}`,
              kind: 'pending',
              name: `${bucket.source.label}（${bucket.entries.length}）`,
              count: bucket.entries.length,
              sourceId: id,
            })
          }
          return items
        }, [pendingBySource])

        const folderItems = useMemo(() => {
          const items = []
          for (const folder of folders ?? []) {
            items.push({
              key: `dir:${folder.dir}`,
              kind: 'folder',
              name: folder.name,
              count: folder.sessions,
              dir: folder.dir,
              exists: folder.exists,
            })
          }
          return items
        }, [folders])

        const navItems = useMemo(() => sourceItems.concat(folderItems), [sourceItems, folderItems])

        const activeItem = useMemo(
          () => navItems.find((item) => item.key === active) ?? navItems[0] ?? null,
          [navItems, active],
        )
        const activeKey = activeItem ? activeItem.key : ''

        // 默认选中的是文件夹时，也把它里面的会话拉出来
        useEffect(() => {
          if (!activeItem || activeItem.kind !== 'folder' || !activeItem.dir) return
          if (folderDetail && folderDetail.dir === activeItem.dir) return
          void openFolder(activeItem.dir)
        }, [activeItem, folderDetail, openFolder])

        // 中栏「待导入」= 所有来源里还没导入的条目（跨来源一起列，方便一次勾选后归档到同一文件夹）
        const pendingAll = useMemo(() => {
          const rows = []
          for (const bucket of pendingBySource.values()) {
            for (const entry of bucket.entries) rows.push({ ...entry, pendingSource: bucket.source.label })
          }
          return rows
        }, [pendingBySource])

        // 中栏：待导入的是扫描条目，已归档的是台账里的会话
        const chatItems = useMemo(() => {
          if (!activeItem) return []
          if (activeItem.kind === 'pending') {
            const bucket = pendingBySource.get(activeItem.sourceId)
            return bucket ? bucket.entries : []
          }
          const folder = (folders ?? []).find((item) => item.dir === activeItem.dir)
          const archived =
            folderDetail && folderDetail.dir === activeItem.dir
              ? (folderDetail.sessions ?? []).map((row) => ({ imported: true, archived: true, ...row }))
              : folder && Array.isArray(folder.items)
                ? folder.items.map((row) => ({ imported: true, archived: true, ...row }))
                : []
          // 选中文件夹时也把各来源待导入的对话列出来：勾选后点「归档到」就直接进这个文件夹
          return archived.concat(pendingAll)
        }, [activeItem, pendingBySource, pendingAll, folders, folderDetail])

        const toggleCheck = useCallback((key) => {
          setChecked((current) => {
            const next = new Set(current)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        }, [])

        const checkAll = useCallback(
          (on) => {
            setChecked((current) => {
              const next = new Set(current)
              for (const item of chatItems) {
                const key = item.key ?? item.sessionId
                if (!key || item.imported) continue
                if (on) next.add(key)
                else next.delete(key)
              }
              return next
            })
          },
          [chatItems],
        )

        const openPreview = useCallback(async (item) => {
          if (!item || item.imported) return
          const cut = String(item.key ?? '').indexOf(':')
          const source =
            cut > 0
              ? String(item.key).slice(0, cut)
              : activeItem && activeItem.kind === 'pending'
                ? activeItem.sourceId
                : ''
          setPreview({ key: item.key, loading: true, error: '', data: null })
          try {
            const url = `${API}/preview?source=${encodeURIComponent(source)}&key=${encodeURIComponent(item.key)}&turns=20&chars=3000`
            const response = await fetch(url, { headers: { accept: 'application/json' } })
            if (response.status === 404) throw new Error(t('routesMissing'))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const json = await response.json()
            if (mounted.current) setPreview({ key: item.key, loading: false, error: '', data: json })
          } catch (err) {
            if (mounted.current)
              setPreview({ key: item.key, loading: false, error: t('errorPrefix', String((err && err.message) || err)), data: null })
          }
        }, [activeItem])

        const createFolder = useCallback(async () => {
          const name = newName.trim()
          if (name === '') return
          setNote('')
          try {
            const response = await fetch(`${API}/folder`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'create', name }),
            })
            if (response.status === 404) throw new Error(t('routesMissing'))
            const json = await response.json().catch(() => null)
            if (!response.ok) throw new Error((json && json.error) || `HTTP ${response.status}`)
            if (!mounted.current) return
            setNewName('')
            // 不跳到新文件夹：它还是空的，跳过去反而看不到刚勾选的对话。
            setNote(t('wizCreated', json.name))
            await loadFolders()
          } catch (err) {
            if (mounted.current) setNote(t('errorPrefix', String((err && err.message) || err)))
          }
        }, [newName, loadFolders])

        const assignChecked = useCallback((item) => {
          if (!item || item.kind !== 'folder') return
          if (checked.size === 0) {
            setNote(t('wizPickNone'))
            return
          }
          setTargets((current) => {
            const next = { ...current }
            for (const key of checked) next[key] = { dir: item.dir, title: item.name }
            return next
          })
          // 归档只是记下目标，会话还在原来源里等着导入。右栏常驻文件夹列表，
          // 中栏在文件夹视图里同时列「已归档 + 待导入」，所以不用再切走视图。
          setNote(`${t('wizAssigned', item.name)} · ${t('wizSelectedCount', checked.size)}`)
        }, [checked])

        const clearTargets = useCallback(() => {
          setTargets((current) => {
            const next = { ...current }
            for (const key of checked) delete next[key]
            return next
          })
          setNote(t('wizUnassigned'))
        }, [checked])

        const doImport = useCallback(() => {
          if (checked.size === 0) return
          const picks = []
          for (const key of checked) {
            const target = targets[key]
            // key 就是 sourceKey(source, path) = `${source}:${path}`，来源永远取前缀，
            // 不能取「当前左栏选中的来源」——勾选可以跨来源累积，那样会把先勾的标错来源。
            const cut = key.indexOf(':')
            const sourceId = cut > 0 ? key.slice(0, cut) : activeItem && activeItem.kind === 'pending' ? activeItem.sourceId : ''
            picks.push({
              key,
              source: sourceId,
              dir: target ? target.dir : null,
              title: target ? target.title : null,
            })
          }
          api.startPicks(picks)
        }, [checked, targets, activeItem, api])

        /* --------------------------------------------------------- 片段 */

        // 上排左栏：待导入的来源（点它 = 中栏换成这个来源的对话列表）
        function renderSources() {
          return h(
            'div',
            { className: 'aii-wiz-col' },
            h(
              'div',
              { className: 'aii-wiz-head' },
              h('span', { className: 'aii-card-title' }, t('wizPending')),
            ),
            h(
              'div',
              { className: 'aii-wiz-body' },
              sourceItems.length === 0 ? h('div', { className: 'aii-note' }, t('wizNoEntries')) : null,
              sourceItems.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: `aii-folder${item.key === activeKey ? ' aii-folder--on' : ''}`,
                    onClick: () => {
                      setActive(item.key)
                      setPreview(null)
                    },
                    title: item.name,
                  },
                  h('span', { className: 'aii-folder-name' }, item.name),
                  h('span', { className: 'aii-folder-count' }, String(item.count ?? 0)),
                ),
              ),
            ),
          )
        }

        // 上排右栏：磁盘上已有的归档文件夹 + 新建 + 把勾选的归进来
        function renderFolders() {
          const isFolder = activeItem && activeItem.kind === 'folder'
          return h(
            'div',
            { className: 'aii-wiz-col' },
            h(
              'div',
              { className: 'aii-wiz-head' },
              h('span', { className: 'aii-card-title' }, t('wizFolders')),
              h('span', { style: { flex: 1 } }),
              h(
                'button',
                { type: 'button', className: 'aii-link', onClick: () => void loadFolders(), disabled: folderLoading },
                folderLoading ? '…' : t('wizRefresh'),
              ),
            ),
            h(
              'div',
              { className: 'aii-wiz-body' },
              folderError ? h('div', { className: 'aii-note' }, folderError) : null,
              folderItems.length === 0 ? h('div', { className: 'aii-note' }, t('wizNoFolders')) : null,
              folderItems.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: `aii-folder${item.key === activeKey ? ' aii-folder--on' : ''}`,
                    onClick: () => {
                      setActive(item.key)
                      if (item.dir) void openFolder(item.dir)
                    },
                    title: item.dir ?? '',
                  },
                  h('span', { className: 'aii-folder-name' }, item.name),
                  h('span', { className: 'aii-folder-count' }, String(item.count ?? 0)),
                ),
              ),
            ),
            h(
              'div',
              { className: 'aii-wiz-foot' },
              h('input', {
                className: 'aii-input',
                value: newName,
                placeholder: t('wizNewFolderPlaceholder'),
                onChange: (event) => setNewName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void createFolder()
                },
                style: { flex: '1 1 60px', minWidth: '60px' },
              }),
              h(
                'button',
                { type: 'button', className: 'aii-btn aii-btn--small', onClick: () => void createFolder() },
                t('wizCreate'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-btn aii-btn--small aii-btn--primary',
                  onClick: () => assignChecked(activeItem),
                  disabled: !isFolder || checked.size === 0,
                  title: t('wizAssign'),
                },
                t('wizTarget'),
              ),
              isFolder
                ? h(
                    'button',
                    { type: 'button', className: 'aii-link', onClick: () => clearTargets() },
                    t('wizClearAssign'),
                  )
                : null,
            ),
          )
        }

        function renderMiddle() {
          const isPending = activeItem && activeItem.kind === 'pending'
          const checkable = chatItems.filter((item) => !item.imported).length

          // 选中文件夹时：先列「已归档」，再列各来源的「待导入」（带勾选框，可勾完直接归档进来）
          const buildChatNodes = () => {
            const nodes = []
            let lastGroup = ''
            chatItems.forEach((item, index) => {
              const group = item.imported ? 'archived' : 'pending'
              if (!isPending && group !== lastGroup) {
                nodes.push(
                  h(
                    'div',
                    { key: `group-${group}`, className: 'aii-wiz-group' },
                    t(group === 'archived' ? 'wizGroupArchived' : 'wizGroupPending'),
                  ),
                )
                lastGroup = group
              }
              const key = item.key ?? item.sessionId ?? String(index)
              const isChecked = checked.has(key)
              const target = targets[key]
              nodes.push(
                h(
                  'div',
                  {
                    key: `${key}-${index}`,
                    className: `aii-chat${isChecked ? ' aii-chat--on' : ''}${item.imported ? ' aii-chat--archived' : ''}`,
                  },
                  item.imported
                    ? null
                    : h('input', {
                        type: 'checkbox',
                        className: 'aii-check',
                        checked: isChecked,
                        onChange: () => toggleCheck(key),
                      }),
                  h(
                    'div',
                    {
                      className: 'aii-chat-body',
                      onClick: () => void openPreview(item),
                      style: { cursor: item.imported ? 'default' : 'pointer' },
                    },
                    h(
                      'div',
                      { className: 'aii-chat-title', title: item.path ?? item.title ?? '' },
                      item.label ?? item.title ?? key,
                    ),
                    h(
                      'div',
                      { className: 'aii-chat-meta' },
                      item.imported
                        ? `${item.source ?? ''} · ${item.turns ?? 0}`
                        : (() => {
                            // 扫描不为「未导入」的条目算轮数（Cursor 连体积也没有），
                            // 所以少什么就省什么，别显示成「0 轮」骗人。
                            const parts = []
                            if (item.turns !== undefined && item.turns !== null) parts.push(`${item.turns} 轮`)
                            if ((item.sizeBytes ?? 0) > 0) parts.push(`${Math.round(item.sizeBytes / 1024)} KB`)
                            return parts.length > 0 ? parts.join(' · ') : String(item.pendingSource ?? item.source ?? '')
                          })(),
                    ),
                  ),
                  target ? h('span', { className: 'aii-chat-tag' }, target.title) : null,
                ),
              )
            })
            if (!isPending && checkable > 0) {
              nodes.unshift(h('div', { key: 'folder-hint', className: 'aii-wiz-group' }, t('wizFolderHint')))
            }
            return nodes
          }
          return h(
            'div',
            { className: 'aii-wiz-col' },
            h(
              'div',
              { className: 'aii-wiz-head' },
              h(
                'span',
                { className: 'aii-card-title' },
                activeItem ? activeItem.name : t('wizEntries'),
              ),
              h('span', { style: { flex: 1 } }),
              checkable > 0
                ? h(
                    'button',
                    { type: 'button', className: 'aii-link', onClick: () => checkAll(true) },
                    t('wizAll'),
                  )
                : null,
              checkable > 0
                ? h(
                    'button',
                    { type: 'button', className: 'aii-link', onClick: () => checkAll(false) },
                    t('wizNone'),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'aii-wiz-body' },
              chatItems.length === 0
                ? h('div', { className: 'aii-note' }, isPending ? t('wizNoEntries') : t('wizFolderEmpty'))
                : buildChatNodes(),
            ),
            h(
              'div',
              { className: 'aii-wiz-foot' },
              h('span', { className: 'aii-note' }, t('wizSelectedCount', checked.size)),
              h('span', { style: { flex: 1 } }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aii-btn aii-btn--small aii-btn--primary',
                  onClick: () => doImport(),
                  disabled: checked.size === 0 || api.busy,
                },
                api.busy ? t('importing') : t('wizImportPicked', checked.size),
              ),
            ),
          )
        }

        // 下排整条：对话预览（「归档到」已挪到右栏底部，这里只负责看内容）
        function renderPreview() {
          const shown = preview && preview.data ? preview.data : null
          return h(
            'div',
            { className: 'aii-wiz-preview' },
            h(
              'div',
              { className: 'aii-wiz-head' },
              h('span', { className: 'aii-card-title' }, t('wizPreview')),
              h('span', { style: { flex: 1 } }),
              shown ? h('span', { className: 'aii-chat-meta' }, shown.title || '') : null,
            ),
            h(
              'div',
              { className: 'aii-wiz-body' },
              preview === null
                ? h('div', { className: 'aii-note' }, t('wizPreviewEmpty'))
                : preview.loading
                  ? h('div', { className: 'aii-note' }, t('wizPreviewLoading'))
                  : preview.error
                    ? h('div', { className: 'aii-banner' }, preview.error)
                    : h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'aii-chat-meta', style: { marginBottom: '6px' } },
                          [
                            shown && shown.title ? shown.title : '',
                            t('wizTurns', (shown && shown.totalTurns) || 0),
                            shown && shown.truncated ? t('wizTruncated', shown.shownTurns || 0) : '',
                          ]
                            .filter((part) => part !== '')
                            .join(' · '),
                        ),
                        (shown && shown.messages && shown.messages.length > 0
                          ? shown.messages
                          : []
                        ).map((message, index) =>
                          h(
                            'div',
                            { key: `${index}`, className: `aii-msg aii-msg--${message.role}` },
                            h(
                              'div',
                              { className: 'aii-msg-role' },
                              message.role === 'user'
                                ? t('wizUser')
                                : message.role === 'assistant'
                                  ? t('wizAssistant')
                                  : message.role === 'thinking'
                                    ? t('wizThinking')
                                    : `${t('wizTool')}${message.tool ? ` · ${message.tool}` : ''}`,
                            ),
                            message.text,
                          ),
                        ),
                        shown && Array.isArray(shown.messages) && shown.messages.length === 0
                          ? h('div', { className: 'aii-note' }, t('wizPreviewNone'))
                          : null,
                      ),
            ),
            note ? h('div', { className: 'aii-wiz-foot' }, h('span', { className: 'aii-note' }, note)) : null,
          )
        }

        return h(
          'div',
          { className: 'aii-root', style: { gap: '10px' } },
          h('div', { className: 'aii-sub' }, t('wizardHint')),
          h(
            'div',
            { className: 'aii-wiz-opts' },
            h(
              'label',
              { title: t('dryRunHint') },
              h('input', {
                type: 'checkbox',
                className: 'aii-check',
                checked: Boolean(api.dryRun),
                onChange: () => api.setDryRun && api.setDryRun(!api.dryRun),
              }),
              h('span', null, t('dryRun')),
            ),
            h(
              'label',
              { title: t('forceHint') },
              h('input', {
                type: 'checkbox',
                className: 'aii-check',
                checked: Boolean(api.force),
                onChange: () => api.setForce && api.setForce(!api.force),
              }),
              h('span', null, t('force')),
            ),
            h(
              'label',
              null,
              h('span', null, t('limit')),
              h('input', {
                className: 'aii-input',
                style: { width: '96px' },
                value: api.limit ?? '',
                placeholder: t('limitPlaceholder'),
                onChange: (event) => api.setLimit && api.setLimit(event.target.value),
              }),
              h('span', null, t('limitUnit')),
            ),
          ),
          // 上排高度由 CSS 定死（46vh，320–560px 之间）：写 auto 的话，
          // 文件夹视图里 70 行会把这排撑到几千像素高，预览直接被推到屏幕外。
          h(
            'div',
            { className: 'aii-wiz' },
            renderSources(),
            renderMiddle(),
            renderFolders(),
          ),
          renderPreview(),
        )
      }
    }

    /* ------------------------------------------------ 悬浮按钮 + 抽屉 */

    function createOverlay(t, ctx) {
      return function AiImportOverlay() {
        const [mounted, setMounted] = useState(false)
        const [open, setOpen] = useState(false)
        const Page = useMemo(() => createPage(t, ctx, { compact: true }), [])
        // 三栏向导需要更宽的抽屉，简版保持原宽度
        const mode = useGlobalMode()

        useEffect(() => {
          if (!open) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [open])

        const toggleOpen = () => {
          setMounted(true)
          setOpen((current) => !current)
        }

        return h(
          'div',
          { className: 'aii-layer' },
          h('style', { key: 'aii-style' }, CSS),
          open
            ? null
            : h(
                'button',
                { type: 'button', className: 'aii-fab', onClick: toggleOpen, title: t('nav') },
                h('span', { className: 'aii-fab-dot' }),
                h('span', null, t('fab')),
              ),
          mounted
            ? h(
                'aside',
                { className: `aii-drawer${mode === 'wizard' ? ' aii-drawer--wide' : ''}`, style: { display: open ? 'flex' : 'none' } },
                h(
                  'div',
                  { className: 'aii-drawer-head' },
                  h('span', { className: 'aii-title' }, t('title')),
                  h(
                    'span',
                    { className: 'aii-card-tools' },
                    h('button', { type: 'button', className: 'aii-btn aii-btn--small', onClick: () => setOpen(false) }, t('close')),
                  ),
                ),
                h('div', { className: 'aii-drawer-body' }, h(Page, null)),
              )
            : null,
        )
      }
    }

    /* ------------------------------------------------------------- 插件 */

    return {
      name: 'ai-import-ui-panel',
      inject: ['slots'],
      apply(ctx) {
        const t = createTranslator(ctx)
        const Overlay = createOverlay(t, ctx)
        const Section = createPage(t, ctx, {})

        // 两个入口各自独立兜底：任一处注册失败都不能连累另一处，也不能让整个条目崩掉。
        const mount = (label, register) => {
          try {
            register()
          } catch (error) {
            try {
              console.warn(`[dsh-ai-import-ui] ${label} 注册失败`, error)
            } catch {
              /* ignore */
            }
          }
        }

        // 主形态：右下角悬浮按钮 + 抽屉（frame-wide overlay，整层默认点击穿透）
        mount('shell.overlay', () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: SECTION_ID, order: 300 }, Overlay),
          ),
        )

        // 次形态：设置页里也放一份
        mount('settings.section', () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: SECTION_ID, order: 230, label: () => t('nav') },
              Section,
            ),
          ),
        )
      },
    }
  },
})
