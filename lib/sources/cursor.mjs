/**
 * Cursor 来源：`%APPDATA%/Cursor/User/globalStorage/state.vscdb`（cursorDiskKV 表）。
 *
 * 实测结论（本机 28 GB 的库）：
 *  - 表 `composerHeaders` 每行一个会话，`value` 是 `{type:'head', name, createdAt,...}`，
 *    `name` 就是会话标题（比首条提问可读得多）；
 *  - 会话正文不在 `composerData` 的 `conversationMap`（那是空的），而在
 *    `bubbleId:<composerId>:<bubbleId>` 这些独立行里；
 *  - 顺序只有 `composerData.fullConversationHeadersOnly` 靠得住（按时间排的
 *    bubbleId 列表，带 `type:1 用户 / 2 助手` 与 `grouping.toolCallId`）；
 *  - 一个 composer 前缀下可能躺着 60 万条 bubble 行（大量空占位/分支残留），
 *    直接 `SELECT ... WHERE key >= ? AND key < ?` 把所有行读进内存会 OOM。
 *    因此这里只按 headers 里的 bubbleId 做**点查**，且用 `json_extract` 在
 *    SQLite 侧取字段，绝不把整行 300KB 的 value 拉进 JS。
 *  - 工具气泡（`grouping.toolCallId`）的 `text` 实测为空——Cursor 不把工具参数/
 *    结果写进 bubble，所以这类气泡直接跳过（内容都在助手的叙述文本里）。
 *  - 关掉标签页会留下 `fullConversationHeadersOnly` 为空的 composer 壳，
 *    这类 `empty` 条目在发现阶段就过滤掉，不导入。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { synthesizeSession } from '../vendor/convert.mjs'
import { candidates, expandHome, manualRootOf } from '../roots.mjs'
import { firstLine, stripInjected } from '../util.mjs'

export const id = 'cursor'
export const label = 'Cursor'

/** 用于识别「标题其实是一串 UUID」的情况。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 默认库路径（跨平台候选里的第一个）。 */
export function defaultDbPath() {
  return candidates('cursor')[0]
}

/** 实际使用的库路径：配置 > 手动选择 > 环境变量 > 平台默认。 */
export function dbPathOf(config = {}) {
  const explicit = expandHome(config.cursorDb)
  if (explicit) return explicit
  const manual = manualRootOf(config, 'cursor')
  if (manual) return manual
  const env = expandHome(process.env.CURSOR_DB)
  if (env) return env
  return defaultDbPath()
}

function workspaceRoot(dbPath) {
  return path.join(path.dirname(path.dirname(dbPath)), 'workspaceStorage')
}

/**
 * 载入 `node:sqlite`（Node 22.19+/24 内置）。缺失时返回 null，由插件上报不可用。
 */
export async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return mod?.DatabaseSync ? mod : null
  } catch {
    return null
  }
}

/** `file:///d%3A/code/Buddy` → `d:\\code\\Buddy`。 */
function folderUriToPath(folder) {
  if (typeof folder !== 'string' || !folder) return null
  let s = folder
  if (s.startsWith('file:///')) s = s.slice(8)
  try {
    s = decodeURIComponent(s)
  } catch { /* 保留原样 */ }
  if (/^[A-Za-z]:\//.test(s)) s = s[0] + ':' + s.slice(2).replace(/\//g, '\\')
  return s
}

/** 建立 workspace hash → 项目路径 的映射（只读 workspace.json，很快）。 */
async function loadWorkspaceMap(dbPath) {
  const map = new Map()
  const root = workspaceRoot(dbPath)
  let dirs = []
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return map
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    try {
      const raw = await fsp.readFile(path.join(root, d.name, 'workspace.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const p = folderUriToPath(parsed?.folder)
      if (p) map.set(d.name, p)
    } catch { /* 这个 workspace 没记录项目 */ }
  }
  return map
}

/**
 * 读 composer 的头部列表。heads 为空 = 这个 composer 一条气泡都没有（空会话）。
 * @param {any} db 已打开的库
 * @param {string} cid composerId
 * @returns {{heads: any[]}}
 */
function readComposer(db, cid) {
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${cid}`)
    if (!row?.value) return { heads: [] }
    const parsed = JSON.parse(row.value)
    const heads = Array.isArray(parsed?.fullConversationHeadersOnly) ? parsed.fullConversationHeadersOnly : []
    return { heads }
  } catch {
    return { heads: [] }
  }
}

/**
 * 未命名 composer 的首条提问（当标题用）。只做两次点查，不拉整行 value。
 * @param {any} db 已打开的库
 * @param {string} cid composerId
 * @returns {string} 首条人类提问的头一句，取不到返回 ''
 */
function peekFirstPrompt(db, cid) {
  const data = readComposer(db, cid)
  if (!data.heads.length) return ''
  const first = data.heads.find((h) => h?.type === 1 && h?.bubbleId)
  if (!first) return ''
  try {
    const row = db.prepare("SELECT json_extract(value,'$.text') AS text FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${cid}:${first.bubbleId}`)
    const text = typeof row?.text === 'string' ? row.text : ''
    if (!text.trim()) return ''
    return firstLine(stripInjected(text), 80)
  } catch {
    return ''
  }
}

/**
 * 发现 Cursor 会话。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal, log?: Function}} [opts]
 */
export async function discover(config = {}, opts = {}) {
  const errors = []
  const entries = []
  const dbPath = dbPathOf(config)
  const sqlite = await loadSqlite()
  if (!sqlite) {
    errors.push('node:sqlite 不可用（需要 Node 22.19+）：无法读取 Cursor 的 SQLite 库')
    return { root: dbPath, entries, errors }
  }
  let db
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    errors.push(`打开 ${dbPath} 失败：${String(err?.message ?? err)}`)
    return { root: dbPath, entries, errors }
  }
  try {
    const workspaceMap = await loadWorkspaceMap(dbPath)
    const rows = db.prepare(`
      SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent,
             substr(value, 1, 400) AS head
      FROM composerHeaders
    `).all()
    for (const row of rows) {
      if (opts.signal?.aborted) break
      const cid = String(row.composerId ?? '')
      if (!cid || cid === 'empty-state-draft') continue
      let head = null
      try {
        head = JSON.parse(row.head)
      } catch { /* head 截断就退回整行 */ }
      if (!head) {
        try {
          head = JSON.parse(db.prepare('SELECT value FROM composerHeaders WHERE composerId = ?').get(cid)?.value ?? '')
        } catch { head = null }
      }
      const name = typeof head?.name === 'string' ? head.name.trim() : ''
      // Cursor 对未命名的 composer 会把 name 写成 composerId（一串 UUID）。
      // 那种「标题」等于没有，交给后续用首条提问命名。
      const usableName = name && !UUID_RE.test(name) ? name : ''
      if (row.isArchived === 1 && config.cursorIncludeArchived !== true) {
        entries.push({ skipped: 'archived', composerId: cid, name, createdAt: row.createdAt })
        continue
      }
      if (row.isSubagent === 1 && config.cursorIncludeSubagents !== true) {
        entries.push({ skipped: 'subagent', composerId: cid, name, createdAt: row.createdAt })
        continue
      }
      const composer = readComposer(db, cid)
      if (composer.heads.length === 0) {
        // 一条气泡都没有的空 composer（Cursor 关掉标签页会留下这种壳）。
        // 导入进来只会得到「无内容」的会话，直接过滤掉。
        entries.push({ skipped: 'empty', composerId: cid, name, createdAt: row.createdAt })
        continue
      }
      entries.push({
        source: id,
        composerId: cid,
        workspaceId: String(row.workspaceId ?? ''),
        // 没有 name 的 composer 退化成 UUID，等于没名字：改用首条提问当标题。
        explicitTitle: usableName || peekFirstPrompt(db, cid) || null,
        createdAt: Number(row.createdAt) || null,
        lastUpdatedAt: Number(row.lastUpdatedAt) || null,
        projectPath: workspaceMap.get(String(row.workspaceId ?? '')) ?? null,
      })
    }
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
  return { root: dbPath, entries, errors }
}

/**
 * 转换单个 Cursor 会话。
 * @param {object} entry discover 条目
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function convert(entry, config = {}, opts = {}) {
  const dbPath = dbPathOf(config)
  const sqlite = await loadSqlite()
  if (!sqlite) throw new Error('node:sqlite 不可用')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const cid = entry.composerId
    const dataRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${cid}`)
    let heads = []
    let composerData = null
    if (dataRow?.value) {
      try {
        composerData = JSON.parse(dataRow.value)
        heads = Array.isArray(composerData.fullConversationHeadersOnly) ? composerData.fullConversationHeadersOnly : []
      } catch { heads = [] }
    }
    const bubbleStmt = db.prepare(`
      SELECT json_extract(value,'$.text') AS text
      FROM cursorDiskKV WHERE key = ?
    `)
    const turns = []
    let cur = null
    let textBubbles = 0
    let emptyBubbles = 0
    const typeCounts = {}
    for (const h of heads) {
      if (opts.signal?.aborted) break
      const btype = h?.type === 1 ? 'user' : 'assistant'
      typeCounts[btype] = (typeCounts[btype] ?? 0) + 1
      const row = bubbleStmt.get(`bubbleId:${cid}:${h?.bubbleId}`)
      const text = typeof row?.text === 'string' ? row.text : ''
      if (!text.trim()) {
        emptyBubbles++
        continue
      }
      textBubbles++
      if (btype === 'user') {
        const prompt = stripInjected(text)
        if (!prompt) continue
        cur = { prompt, steps: [] }
        turns.push(cur)
        continue
      }
      if (!cur) continue
      cur.steps.push({ content: [{ type: 'text', text: stripInjected(text) }], toolCalls: [], toolResults: [] })
    }
    // 丢掉只有提问、没有任何回复的轮次尾巴（Cursor 里很常见：用户点了发送就关了）
    const kept = turns.filter((t) => t.steps.length > 0 || t.prompt.trim().length > 0)
    const createdAt = Number(composerData?.createdAt ?? entry.createdAt) || Date.now()
    const sourceId = entry.composerId
    const meta = { version: 0, id: `import-${sourceId}`, createdAt }
    const cwd = entry.projectPath ?? null
    if (cwd) meta.cwd = cwd
    const converted = synthesizeSession({
      meta,
      turns: kept,
      title: null,
      provider: 'cursor',
      model: 'cursor-agent',
      skipped: emptyBubbles,
      records: heads.length,
      typeCounts,
    })
    return {
      meta: converted.meta,
      events: converted.events,
      title: entry.explicitTitle,
      prompt: kept[0]?.prompt ?? '',
      cwd,
      createdAt,
      turns: kept.length,
      records: heads.length,
      toolCalls: converted.toolCalls,
      skipped: emptyBubbles,
      typeCounts,
      repaired: converted.repaired,
      stat: { heads: heads.length, textBubbles, emptyBubbles },
      streaming: false,
    }
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
}

/** 会话稳定标识。 */
export function sourceIdOf(entry) {
  return String(entry.composerId ?? '')
}