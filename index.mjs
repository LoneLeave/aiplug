// SPDX-License-Identifier: Apache-2.0
/**
 * dsh-ai-import —— 把本机其它 AI 编码助手的**历史对话**导入 DSH。
 *
 * 覆盖来源：Claude Code、Codex CLI、WorkBuddy、Cursor（正文可解析）；
 * Trae 只能导「提问清单」（本地不落助手回复）。
 *
 * 与 dsh-claude-move 的差别就在用户最在意的两点：
 *  - 分组：按「(来源, 项目目录)」各建一个工作区（`<DSH_HOME>/ai-import/groups/<来源>/<项目slug>`），
 *    而不是把所有会话塞进一个目录；
 *  - 命名：优先源自带标题（Claude custom-title / Codex thread_name / Cursor composer name），
 *    其次首条人类提问（已剥离 system-reminder 等注入噪声），组内重名自动加时间后缀。
 *
 * 只消费公开服务：tools；sessionPersistence / workspaceRegistry / commands 经 ctx.get 取，
 * 缺了也能装（只是届时不能写入）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { dshHome, runImport, scanAll, summarizeRun, summarizeScan } from './lib/runner.mjs'
import { loadLedger, ledgerPath } from './lib/store.mjs'

export const name = 'ai-import'

export const inject = ['tools']

/** 插件配置（可在 cordis.patch.yml 里覆盖）。 */
export const Config = Schema.object({
  claudeHome: Schema.string().description('Claude Code 数据根（不填则按 面板手动 > $CLAUDE_CONFIG_DIR > 平台默认 ~/.claude 解析）'),
  codexHome: Schema.string().description('Codex 数据根（不填则按 面板手动 > $CODEX_HOME > 平台默认 ~/.codex 解析）'),
  workbuddyHome: Schema.string().description('WorkBuddy 数据根（不填则按 面板手动 > 平台默认 ~/.workbuddy 解析）'),
  cursorDb: Schema.string().description('Cursor 的 state.vscdb 路径（不填则按 面板手动 > $CURSOR_DB > 平台默认位置解析）'),
  traeHome: Schema.string().description('Trae 的 workspaceStorage 目录（仅 includePromptOnlySources 时用到）'),
  homeDir: Schema.string().description('DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）'),
  includePromptOnlySources: Schema.boolean().default(false)
    .description('是否导入只有提问、没有回复的来源（目前仅 Trae）'),
  cursorIncludeArchived: Schema.boolean().default(false)
    .description('是否导入 Cursor 里已归档的会话'),
  cursorIncludeSubagents: Schema.boolean().default(false)
    .description('是否导入 Cursor 的子代理会话'),
  codexIncludeInternal: Schema.boolean().default(false)
    .description('是否导入 Codex 的内部线程（guardian_review / subagent，标题多为同一串，默认跳过）'),
  titlePrefixSource: Schema.boolean().default(true)
    .description('会话标题是否加 `[来源] ` 前缀'),
  streamThresholdBytes: Schema.number().default(200 * 1024 * 1024)
    .description('超过该大小的 transcript 走流式解析'),
})

const SOURCE_IDS = ['claude', 'codex', 'workbuddy', 'cursor', 'trae']

/** 扫描结果的输出结构（给工具用）。 */
const scanSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    homeDir: { type: 'string' },
    totals: {
      type: 'object',
      additionalProperties: true,
      properties: {
        fresh: { type: 'integer' },
        changed: { type: 'integer' },
        known: { type: 'integer' },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          root: { type: 'string' },
          found: { type: 'integer' },
          importable: { type: 'integer' },
          fresh: { type: 'integer' },
          changed: { type: 'integer' },
          known: { type: 'integer' },
          filtered: { type: 'integer' },
          errors: { type: 'array', items: { type: 'string' } },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  },
}

/** 导入结果的输出结构。 */
const runSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    created: { type: 'integer' },
    appended: { type: 'integer' },
    skipped: { type: 'integer' },
    failed: { type: 'integer' },
    rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
}

/** 渲染扫描结果：默认只给人读摘要，detail=full 才逐条列。 */
function renderScan(args, value) {
  const lines = [summarizeScan(value)]
  if (args?.detail === 'full') {
    for (const s of value.sources ?? []) {
      const rows = (s.entries ?? []).filter((e) => e.kind !== 'filtered')
      if (rows.length === 0) continue
      lines.push('')
      lines.push(`── ${s.label}（${rows.length}）`)
      for (const r of rows.slice(0, 300)) {
        const tag = r.kind === 'new' ? '新' : r.kind === 'changed' ? '变' : '旧'
        lines.push(`  ${tag} · ${r.label || r.path}${r.projectPath ? `　[${r.projectPath}]` : ''}`)
      }
      if (rows.length > 300) lines.push(`  … 其余 ${rows.length - 300} 条省略`)
    }
  }
  return [{ text: lines.join('\n') }]
}

function renderRun(args, value) {
  return [{ text: summarizeRun(value) }]
}

function makeScanTool(ctx, config) {
  return defineTool({
    name: 'ai_import_scan',
    description:
      'Scan local AI-assistant histories (Claude Code / Codex / WorkBuddy / Cursor / Trae) and report what is importable into DSH, without writing anything. Returns per-source counts (fresh / changed / already-imported / filtered). Use ai_import_run to actually import. ' +
      '（扫描本机各 AI 助手的历史对话，只读、不写：返回每个来源的 新增/有更新/已导入/被过滤 数量。真正导入请用 ai_import_run。）',
    parameters: {
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: "可选：'summary' 只返回计数（默认），'full' 逐条列出来源条目。",
      },
    },
    output: { schema: scanSchema, render: renderScan },
    async execute(args, exec) {
      const report = await scanAll(config, { signal: exec?.signal })
      const totals = { fresh: 0, changed: 0, known: 0 }
      for (const s of report.sources) {
        totals.fresh += s.fresh
        totals.changed += s.changed
        totals.known += s.known
      }
      return { ...report, totals }
    },
  })
}

function makeRunTool(ctx, config) {
  return defineTool({
    name: 'ai_import_run',
    description:
      'Import local AI-assistant histories into DSH: converts each transcript into a DSH session, gives it a readable title (source-provided title first, else first human prompt with injected noise stripped), and attaches it to a per-(source, project) workspace group. Idempotent via <DSH_HOME>/ai-import/imports.json; re-runs only append newly added turns. ' +
      '（把本机 AI 助手的历史对话真正导入 DSH：生成会话、按其来源命名、挂到「来源 · 项目」分组工作区。幂等：重跑只追加新增回合。sources 可限定来源，dryRun 只转换不落盘。）',
    parameters: {
      sources: {
        type: 'array',
        items: { type: 'string', enum: SOURCE_IDS },
        description: '可选：限定来源，缺省为全部可用来源（含 Trae 时需插件配置开启）。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时只做转换、不写任何会话（用于核对命名与分组）。',
      },
      force: {
        type: 'boolean',
        description: '可选：true 时无视台账重新导入（仍写回同一会话 id）。',
      },
      limit: {
        type: 'integer',
        description: '可选：每个来源最多处理多少条（便于先小批量试跑）。',
      },
    },
    output: { schema: runSchema, render: renderRun },
    async execute(args, exec) {
      return await runImport(ctx, config, {
        only: args?.sources,
        dryRun: args?.dryRun === true,
        force: args?.force === true,
        limit: args?.limit,
        signal: exec?.signal,
      })
    },
  })
}

/** `/import-ai` 的文本输出。 */
async function handleCommand(ctx, config, invocation) {
  const raw = String(invocation?.rawInput ?? '').trim()
  const [verb = 'scan', ...rest] = raw.split(/\s+/).filter(Boolean)
  const flags = new Set(rest.filter((t) => t.startsWith('-')))
  const dryRun = flags.has('--dry-run') || flags.has('--dryrun')
  const force = flags.has('--force')
  const detail = flags.has('--full') ? 'full' : 'summary'
  const only = rest.filter((t) => !t.startsWith('-'))

  if (verb === 'status') {
    const homeDir = config.homeDir || dshHome()
    const ledger = await loadLedger(homeDir)
    const entries = Object.values(ledger.entries ?? {})
    const bySource = new Map()
    for (const e of entries) {
      const k = e.source ?? '?'
      bySource.set(k, (bySource.get(k) ?? 0) + 1)
    }
    const lines = [`台账：${ledgerPath(homeDir)}`, `已导入会话 ${entries.length} 条`]
    for (const [k, n] of bySource) lines.push(`  · ${k}: ${n}`)
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'run') {
    const result = await runImport(ctx, config, {
      only: only.length > 0 ? only : null,
      dryRun,
      force,
      signal: invocation?.signal,
    })
    return { kind: 'success', text: (dryRun ? '（dry-run，未写入）\n' : '') + summarizeRun(result) }
  }

  // 默认 scan
  const report = await scanAll(config, { signal: invocation?.signal })
  const totals = { fresh: 0, changed: 0, known: 0 }
  for (const s of report.sources) {
    totals.fresh += s.fresh
    totals.changed += s.changed
    totals.known += s.known
  }
  const text = renderScan({ detail }, { ...report, totals }).map((b) => b.text).join('\n')
  return {
    kind: 'success',
    text: text + '\n\n导入：/import-ai run　（先小批量：/import-ai run 5 --dry-run）',
  }
}

/**
 * 取服务：已经有了就直接用，还没有就等 `internal/service` 事件（收到的是服务名）。
 * @param {any} ctx Cordis 上下文
 * @param {string} serviceName 服务名
 * @param {(svc: any) => void} fn 拿到服务后的回调
 */
function withService(ctx, serviceName, fn) {
  const existing = ctx.get?.(serviceName)
  if (existing !== undefined && existing !== null) {
    fn(existing)
    return
  }
  const off = ctx.on?.('internal/service', (name) => {
    if (name !== serviceName) return
    const service = ctx.get?.(serviceName)
    if (service !== undefined && service !== null) {
      off?.()
      fn(service)
    }
  })
}

/**
 * 挂载插件。
 * @param {any} ctx Cordis 上下文
 * @param {object} config 插件配置
 */
export function apply(ctx, config = {}) {
  const resolved = { ...(config ?? {}) }
  ctx.tools.register(makeScanTool(ctx, resolved))
  ctx.tools.register(makeRunTool(ctx, resolved))

  withService(ctx, 'commands', (commands) => {
    if (typeof commands?.register !== 'function') return
    commands.register({
      name: 'import-ai',
      description: '导入本机其它 AI 助手的历史对话到 DSH（scan / run / status）',
      input: { hint: '[scan|run|status] [--dry-run] [--force] [--full] [来源...]' },
      handler: async (invocation) => {
        try {
          return await handleCommand(ctx, resolved, invocation)
        } catch (err) {
          return { kind: 'error', text: `/import-ai 失败：${String(err?.message ?? err)}` }
        }
      },
    })
  })
}
