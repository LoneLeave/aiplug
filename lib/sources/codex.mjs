/**
 * Codex / ChatGPT CLI 来源：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * 另含 `~/.codex/archived_sessions/`（已归档会话，一并导入）。
 *
 * 标题优先取 `~/.codex/session_index.jsonl` 的 `thread_name`，但只采信**全局唯一**
 * 的名字：Codex 的自动化任务（`Guardian review` / `每周回顾`）会给十几个互不相关
 * 的会话写同一个名字，直接用会让一屏全是同名。不唯一或没有索引项时回退到首条
 * 真实提问。
 * 转换复用 vendor 的 convertCodexJsonl。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertCodexJsonl } from '../vendor/convert.mjs'
import { expandHome, firstExistingCandidate, manualRootOf } from '../roots.mjs'
import { firstLine } from '../util.mjs'

export const id = 'codex'
export const label = 'Codex'

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Codex 数据根目录。 */
export function home(config = {}) {
  const explicit = expandHome(config.codexHome)
  if (explicit) return explicit
  const manual = manualRootOf(config, 'codex')
  if (manual) return manual
  const env = process.env.CODEX_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return firstExistingCandidate('codex')
}

/**
 * 读 session_index.jsonl：uuid → thread_name。
 *
 * 注意：`thread_name` 并不总是「这轮对话的真实标题」——Codex 的周期性/自动化
 * 任务（`Guardian review`、`每周回顾`、`hi`）会把同一个名字写给很多互不相关的
 * 会话（实测：12 个会话共用 `Guardian review`）。直接拿来当标题会让一整屏都是
 * 同名会话。所以**只在名字全局唯一时**才采信它，其余回退到首条真实提问。
 * @param {string} root Codex 数据根
 * @returns {Promise<{unique: Map<string,string>, duplicated: Set<string>, all: Map<string,string>}>}
 */
async function loadThreadNames(root) {
  const all = new Map()
  const counts = new Map()
  const file = path.join(root, 'session_index.jsonl')
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return { unique: new Map(), duplicated: new Set(), all }
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec && typeof rec.id === 'string' && typeof rec.thread_name === 'string' && rec.thread_name.trim()) {
        const name = rec.thread_name.trim()
        all.set(rec.id.toLowerCase(), name)
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    } catch { /* 跳过畸形行 */ }
  }
  const duplicated = new Set()
  for (const [name, n] of counts) if (n > 1) duplicated.add(name)
  const unique = new Map()
  for (const [key, name] of all) if (!duplicated.has(name)) unique.set(key, name)
  return { unique, duplicated, all }
}

async function walkJsonl(dir, out, errors, signal) {
  let items
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') errors.push(`读取 ${dir} 失败：${String(err?.message ?? err)}`)
    return
  }
  for (const item of items) {
    if (signal?.aborted) return
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      await walkJsonl(full, out, errors, signal)
      continue
    }
    if (!item.isFile() || !item.name.endsWith('.jsonl')) continue
    let st
    try {
      st = await fsp.stat(full)
    } catch (err) {
      errors.push(`stat ${full} 失败：${String(err?.message ?? err)}`)
      continue
    }
    out.push({ path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs })
  }
}

/**
 * 发现全部 rollout。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function discover(config = {}, opts = {}) {
  const root = home(config)
  const errors = []
  const raw = []
  await walkJsonl(path.join(root, 'sessions'), raw, errors, opts.signal)
  const archived = []
  await walkJsonl(path.join(root, 'archived_sessions'), archived, errors, opts.signal)
  const threadNames = await loadThreadNames(root)

  const entries = []
  for (const item of [...raw, ...archived]) {
    const name = path.basename(item.path)
    if (!/^rollout-.*\.jsonl$/i.test(name)) continue
    const m = UUID_RE.exec(name)
    const uuid = m ? m[1].toLowerCase() : null
    entries.push({
      source: id,
      path: item.path,
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs,
      threadUuid: uuid,
      explicitTitle: uuid ? (threadNames.unique.get(uuid) ?? null) : null,
      suggestedName: uuid ? (threadNames.all.get(uuid) ?? null) : null,
      archived: item.path.includes(`${path.sep}archived_sessions${path.sep}`),
    })
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { root, entries, errors }
}

/**
 * 转换一份 rollout。
 * 注意：codex 没有流式入口，超大文件直接按「跳过」上报（由 runner 判定）。
 * @param {object} entry discover 的条目
 */
export async function convert(entry) {
  const raw = await fsp.readFile(entry.path, 'utf8')
  const converted = convertCodexJsonl(raw, {})
  const prompt = converted.turns?.[0]?.prompt ?? ''
  return {
    meta: converted.meta,
    events: converted.events,
    title: entry.explicitTitle ?? converted.title ?? null,
    prompt,
    cwd: converted.meta?.cwd ?? null,
    createdAt: converted.meta?.createdAt ?? Math.round(entry.mtimeMs),
    turns: Array.isArray(converted.turns) ? converted.turns.length : Number(converted.turns) || 0,
    records: converted.records ?? 0,
    toolCalls: converted.toolCalls ?? 0,
    skipped: converted.skipped ?? 0,
    skippedLines: converted.skippedLines ?? [],
    typeCounts: converted.typeCounts ?? {},
    repaired: converted.repaired,
    streaming: false,
  }
}

/** 会话稳定标识。 */
export function sourceIdOf(entry) {
  if (entry.threadUuid) return entry.threadUuid
  const m = UUID_RE.exec(path.basename(entry.path))
  return m ? m[1].toLowerCase() : path.basename(entry.path).replace(/\.jsonl$/i, '')
}

export { firstLine }
