/**
 * Trae 来源（国际版 + 国内版都扫）：`%APPDATA%/Trae/User/workspaceStorage/<hash>/state.vscdb`
 * （国内版是 `%APPDATA%/Trae CN/...`）。
 *
 * 实测：Trae 的本地库只留下**用户提问**，没有助手回复——
 *  - `ChatStore` 只有 UI 状态（`turnsHeight` / `turnsIsExpand` / `diffCodeBlockStatus`）；
 *  - `icube-ai-agent-storage-input-history` 是 `[{inputText, parsedQuery, multiMedia}]`，
 *    即输入框历史；
 *  - IndexedDB / CacheStorage 里没有对话正文。
 * 所以本源的导入形态只能是「问题清单」，默认关闭（`includePromptOnlySources`），
 * 开启后每个工作区一条会话，标题注明「仅提问」。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { synthesizeSession } from '../vendor/convert.mjs'
import { candidates, expandHome, manualRootOf } from '../roots.mjs'
import { stripInjected } from '../util.mjs'

export const id = 'trae'
export const label = 'Trae'

/** 候选根目录（国际版在前，国内版带上；跨平台由 roots.mjs 给）。 */
export function roots(config = {}) {
  const manual = manualRootOf(config, 'trae')
  if (manual) return [manual]
  const explicit = expandHome(config.traeHome)
  if (explicit) return [explicit]
  return candidates('trae')
}

async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return mod?.DatabaseSync ? mod : null
  } catch {
    return null
  }
}

function folderUriToPath(folder) {
  if (typeof folder !== 'string' || !folder) return null
  let s = folder
  if (s.startsWith('file:///')) s = s.slice(8)
  try { s = decodeURIComponent(s) } catch { /* 原样 */ }
  if (/^[A-Za-z]:\//.test(s)) s = s[0] + ':' + s.slice(2).replace(/\//g, '\\')
  return s
}

/**
 * 发现 Trae 工作区（每个 state.vscdb 一个）。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function discover(config = {}, opts = {}) {
  const errors = []
  const entries = []
  const sqlite = await loadSqlite()
  if (!sqlite) {
    errors.push('node:sqlite 不可用（需要 Node 22.19+）：无法读取 Trae 的 SQLite 库')
    return { root: roots(config).join(' | '), entries, errors }
  }
  for (const root of roots(config)) {
    let dirs = []
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (opts.signal?.aborted) return { root, entries, errors }
      const wsDir = path.join(root, d.name)
      const dbPath = path.join(wsDir, 'state.vscdb')
      try {
        await fsp.access(dbPath)
      } catch {
        continue
      }
      let projectPath = null
      try {
        const raw = await fsp.readFile(path.join(wsDir, 'workspace.json'), 'utf8')
        projectPath = folderUriToPath(JSON.parse(raw)?.folder)
      } catch { /* 没有 workspace.json */ }
      let prompts = []
      let db
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get('icube-ai-agent-storage-input-history')
        if (row?.value) {
          const parsed = JSON.parse(String(row.value))
          const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.value) ? parsed.value : [])
          prompts = list.map((x) => (typeof x === 'string' ? x : x?.inputText)).filter((t) => typeof t === 'string' && t.trim())
        }
      } catch (err) {
        errors.push(`读取 ${dbPath} 失败：${String(err?.message ?? err)}`)
      } finally {
        try { db?.close() } catch { /* 忽略 */ }
      }
      if (prompts.length === 0) continue
      entries.push({
        source: id,
        dbPath,
        workspaceHash: d.name,
        projectPath,
        prompts,
        promptCount: prompts.length,
        explicitTitle: null,
        createdAt: null,
      })
    }
  }
  return { root: roots(config)[0] ?? '', entries, errors }
}

/**
 * 转换 Trae 工作区（只有提问，没有回复）。
 * @param {object} entry discover 条目
 */
export async function convert(entry) {
  const turns = []
  for (const raw of entry.prompts ?? []) {
    const prompt = stripInjected(raw)
    if (!prompt) continue
    turns.push({ prompt, steps: [] })
  }
  const createdAt = Date.now()
  const meta = { version: 0, id: `import-trae-${entry.workspaceHash}`, createdAt }
  const cwd = entry.projectPath ?? null
  if (cwd) meta.cwd = cwd
  const converted = synthesizeSession({
    meta,
    turns,
    title: null,
    provider: 'trae',
    model: 'trae',
    skipped: 0,
    records: entry.promptCount ?? turns.length,
    typeCounts: { prompt: turns.length },
  })
  return {
    meta: converted.meta,
    events: converted.events,
    title: entry.projectPath ? `仅提问 · ${path.basename(entry.projectPath)}` : '仅提问',
    prompt: turns[0]?.prompt ?? '',
    cwd,
    createdAt,
    turns: turns.length,
    records: entry.promptCount ?? turns.length,
    toolCalls: 0,
    skipped: 0,
    promptOnly: true,
    streaming: false,
  }
}

/** 会话稳定标识。 */
export function sourceIdOf(entry) {
  return `trae-${entry.workspaceHash}`
}
