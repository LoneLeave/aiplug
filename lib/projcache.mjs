/**
 * 投影缓存回填：让「导入的会话」在会话列表里有标题。
 *
 * 背景：DSH 的会话列表对**未打开**（cold）的会话只读投影缓存
 * （`dsh-api-session-controller` 的 `summarizeCold` → `projectionsFor(header, void 0)`
 * → `sessionProjectionCache.cachedSnapshot(header)`）；拿不到记录时
 * `title` 为空，界面退化成 `"session.untitled": "未命名"`。
 * 导入出来的会话从来没走过 live 路径（没有 Session 实例被 dispose），
 * 所以从来没有写过这条缓存记录 —— 于是列表里一片「未命名」。
 *
 * 本模块把「日志里的事实」折成缓存行并落盘。语义必须与宿主逐条对齐，
 * 否则行要么被 schema 丢弃（`viewCheckpoint` 静默跳过），要么整份文档被
 * 当成 invalid 挪走（domain spec 的 `invalidRecords: 'backup-and-skip'`）：
 *
 *  - 文档顶层 `version` 必须等于 domain version（当前 7），见
 *    `@deepseek-ai/dsh-session-projection-cache` 的 `projectionCacheDomainSpec`。
 *  - `record.identity` 是日志身份见证：`formatVersion / createdAt / cwd / isSeeded`
 *    与 header 必须全等（`currentLifecycleMatches`）；**缺 formatVersion 的记录
 *    一律不匹配**，列表就永远看不到它。
 *  - `title` 单元 stateVersion 1，stateSchema 为 `z.string().min(1).nullable()`；
 *    值来自最后一个 `session/title` 事件的 `data.title`。
 *  - `sessionListMetadata` 单元 stateVersion 1，init `{blank:true,lastPromptAt:null}`，
 *    `blank` 只会被 `turn/start` 置 false，`lastPromptAt` 取
 *    `user/message` 且 `data.source.kind === 'user'` 的事件的 `time`。
 *
 * 一个会话里最后一次 `session/title` 之前若还有别的写入者，这里只写我们算出的
 * 两个键，其余键（tokenUsage/todos/...）保持不动：缓存行只可能旧，不可能错。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** domain version；与 projectionCacheDomainSpec.version 保持一致。 */
export const PROJCACHE_DOMAIN_VERSION = 7

const TITLE_STATE_VERSION = 1
const LIST_METADATA_STATE_VERSION = 1

/** DSH 家目录（与宿主同源：优先 DSH_HOME）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 投影缓存 `sessions` 表在磁盘上的目录（storage-json 的 per-record 布局）。 */
export function projcacheDir(home = dshHome()) {
  return join(home, 'storages', 'session_projcache', 'sessions')
}

/** 事件里 user 文本（兼容 `data.content` 与 `data.message.content` 两种形状）。 */
export function messageText(event) {
  const data = event?.data ?? {}
  const content = Array.isArray(data.content)
    ? data.content
    : Array.isArray(data?.message?.content)
      ? data.message.content
      : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 从一段用户输入里取一个可读标题（单行、去标记行、限长）。 */
export function deriveTitleFromText(text, maxCodePoints = 48) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !line.startsWith('<') && !line.startsWith('```'))
  const first = lines[0] ?? ''
  const points = [...first]
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints).join('')}…` : first
}

/** 会话来源标签（用于派生标题的前缀，与插件既有命名风格一致）。 */
export function sourceLabel(sessionId, cwd) {
  const match = /^import-(claude|codex|workbuddy|cursor|trae)-/.exec(String(sessionId))
  if (match !== null) return match[1][0].toUpperCase() + match[1].slice(1)
  if (/claudecode/i.test(String(cwd ?? ''))) return 'Claude'
  return 'Imported'
}

/**
 * 把日志折成缓存行（只算我们知道的两个键）。
 * @param events 该会话的全部事件（seq 升序）。
 * @returns `{ rows, lastSeq }`，`rows.title` 仅在日志里有非空标题时存在。
 */
export function foldListRows(events) {
  let title = null
  let titleSeq = -1
  let blank = true
  let lastPromptAt = null
  let lastSeq = -1
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (event.type === 'session/title') {
      const value = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
      if (value.length > 0) {
        title = value
        titleSeq = event.seq
      }
      continue
    }
    if (event.type === 'turn/start') blank = false
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') lastPromptAt = event.time
  }
  const rows = {
    sessionListMetadata: {
      ver: LIST_METADATA_STATE_VERSION,
      seq: lastSeq,
      val: { blank, lastPromptAt },
    },
  }
  if (title !== null) rows.title = { ver: TITLE_STATE_VERSION, seq: titleSeq, val: title }
  return { rows, lastSeq }
}

/** header → 缓存身份见证。 */
export function identityOf(header) {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    cwd: header.cwd,
    isSeeded: header.isSeeded ?? false,
    inheritedEventCount: 0,
  }
}

/** 已存在的记录是否属于同一个会话生命周期（不匹配就不能继承它的行）。 */
function sameLifecycle(stored, expected) {
  return (
    stored !== undefined &&
    stored.formatVersion === expected.formatVersion &&
    stored.createdAt === expected.createdAt &&
    stored.cwd === expected.cwd &&
    (stored.isSeeded ?? false) === expected.isSeeded
  )
}

/**
 * 生成一份缓存文档：同生命周期的旧记录保留下它的其它行，只覆盖我们算出的键。
 * @param existing 已存在的文档（没有则 undefined）。
 */
export function buildDocument(header, rows, existing) {
  const identity = identityOf(header)
  const kept = sameLifecycle(existing?.record?.identity, identity) ? { ...existing.record.rows } : {}
  return { version: PROJCACHE_DOMAIN_VERSION, record: { identity, rows: { ...kept, ...rows } } }
}

/**
 * 写一份缓存文档（原子替换）。返回写不写、写到哪。
 * @returns `{ path, wrote, inherited }`
 */
export function writeProjectionCache(header, rows, options = {}) {
  const dir = options.dir ?? projcacheDir()
  const path = join(dir, `${header.id}.json`)
  let existing
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      existing = undefined
    }
  }
  const document = buildDocument(header, rows, existing)
  const inherited = Object.keys(document.record.rows).length > Object.keys(rows).length
  if (options.dry === true) return { path, wrote: false, inherited }
  mkdirSync(dir, { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return { path, wrote: true, inherited }
}
