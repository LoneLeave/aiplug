/**
 * Codex / ChatGPT CLI 来源：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)`
 * 另含 `~/.codex/archived_sessions/`（已归档会话，一并导入）。
 *
 * 新版 Codex 会把 rollout 压成 zstd（`rollout-*.jsonl.zst`），旧版只写 `.jsonl`，
 * 所以两种都要认：`.zst` 先解压再交给 vendor 的 convertCodexJsonl。
 *
 * 标题有三处来源，按可信度取：
 *  1. `state_5.sqlite` 的 `threads.name/title`（Codex 自己算的标题，135/159 有值）；
 *  2. `session_index.jsonl` 的 `thread_name`；
 *  3. 首条真实提问。
 * 1 与 2 都只采信**全局唯一**的名字：Codex 的自动化任务（`Guardian review` 45 条、
 * `每周回顾` 8 条）会把同一个名字写给一堆互不相关的会话，直接用会让一屏全是同名。
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { convertCodexJsonl } from '../vendor/convert.mjs'
import { expandHome, firstExistingCandidate, manualRootOf } from '../roots.mjs'
import { firstLine } from '../util.mjs'

export const id = 'codex'
export const label = 'Codex'

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
/** `rollout-….jsonl` 或 `rollout-….jsonl.zst`。 */
const ROLLOUT_RE = /^rollout-.*\.jsonl(?:\.zst)?$/i
const ZST_RE = /\.zst$/i

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

/** zstd 解压（Node 22.15+ / 24 的 `node:zlib` 自带；缺失时给出可读错误）。 */
function zstdDecompress(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd（需要 22.15+ / 24.9+）：无法解压 .jsonl.zst')
  }
  return zlib.zstdDecompressSync(buf)
}

/**
 * 流式解压文件开头一段，够提炼标题就停（大文件上千行，没必要整份读完）。
 * @param {string} file `.jsonl.zst` 或 `.jsonl`
 * @param {number} [wantChars] 需要的正文字符数
 */
async function readHead(file, wantChars = 400 * 1024) {
  const handle = await fsp.open(file, 'r')
  try {
    const chunk = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
    if (bytesRead <= 0) return ''
    const head = chunk.subarray(0, bytesRead)
    if (!ZST_RE.test(file)) return head.toString('utf8')

    const decoder = zlib.createZstdDecompress()
    return await new Promise((resolve) => {
      const parts = []
      let total = 0
      const done = (value) => {
        decoder.removeAllListeners()
        try { decoder.destroy() } catch { /* 已关闭 */ }
        resolve(value)
      }
      decoder.on('data', (piece) => {
        parts.push(piece)
        total += piece.length
        // 半个帧也能解出开头，够用就主动收工
        if (total >= wantChars) done(Buffer.concat(parts).toString('utf8'))
      })
      decoder.on('end', () => done(Buffer.concat(parts).toString('utf8')))
      decoder.on('error', () => done(Buffer.concat(parts).toString('utf8')))
      decoder.end(head)
    })
  } finally {
    await handle.close()
  }
}

/** 从一段 JSONL 文本里找「人类提问」候选（Codex 的 response_item/message/user）。 */
function promptsFromText(text) {
  const lines = text.split('\n')
  lines.pop() // 末尾可能是半行
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const p = rec?.payload
    if (rec?.type !== 'response_item' || p?.type !== 'message' || p?.role !== 'user') continue
    const parts = []
    for (const block of Array.isArray(p.content) ? p.content : []) {
      if (block && typeof block.text === 'string' && (block.type === 'text' || block.type === 'input_text')) {
        parts.push(block.text)
      }
    }
    const joined = parts.join('\n').trim()
    if (joined) out.push(joined)
  }
  return out
}

/**
 * 读 session_index.jsonl：uuid → thread_name。
 *
 * 注意：`thread_name` 并不总是「这轮对话的真实标题」——Codex 的周期性/自动化
 * 任务会把同一个名字写给很多互不相关的会话（实测：45 个会话共用
 * `Guardian review`）。所以**只在名字全局唯一时**才采信它。
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

/**
 * 读 `state_5.sqlite` 的 `threads` 表：uuid → 标题 / 首条提问 / 线程种类。
 *
 * 这是 Codex 桌面端自己维护的会话表，标题质量比 `session_index.jsonl` 好得多
 * （135/159 有 `title`，84 有 `name`）。同样只采信全局唯一的名字。
 * 库不存在或 `node:sqlite` 不可用时静默返回空表，由上层回退。
 * @param {string} root Codex 数据根
 */
async function loadThreadTitles(root) {
  const empty = { byId: new Map(), byRollout: new Map(), firstPrompt: new Map(), kind: new Map() }
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return empty
  }
  if (!sqlite?.DatabaseSync) return empty
  const file = path.join(root, 'state_5.sqlite')
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const rows = db.prepare('select id, rollout_path, name, title, first_user_message, thread_source from threads').all()
    // 只统计「真人对话」里的重名：被过滤掉的内部线程（Guardian review 45 条）会把
    // 唯一性判断全带偏。自动化任务（`每周回顾`）本来就该同名，不算重名。
    const counts = new Map()
    for (const row of rows) {
      if (!isImportableKind(row.thread_source)) continue
      const label = pickLabel(row)
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    for (const row of rows) {
      const uuid = typeof row.id === 'string' ? row.id.toLowerCase() : ''
      const rollout = typeof row.rollout_path === 'string' ? path.basename(row.rollout_path).toLowerCase() : ''
      const label = pickLabel(row)
      const kind = typeof row.thread_source === 'string' ? row.thread_source : ''
      // 标题：真人对话里只采信全局唯一的，否则一屏全是 `Guardian review`。
      if (label && (kind === 'automation' || counts.get(label) === 1)) {
        if (uuid) empty.byId.set(uuid, label)
        if (rollout) empty.byRollout.set(rollout, label)
      }
      // 首条提问：即便重名也照样能用（它是内容，不是名字），给没标题的条目兜底，
      // 而且不必解压 rollout——省掉几十次 zstd 解压。
      const first = typeof row.first_user_message === 'string' ? row.first_user_message.trim() : ''
      if (first) {
        if (uuid) empty.firstPrompt.set(uuid, first)
        if (rollout) empty.firstPrompt.set(rollout, first)
      }
      // 会话种类：`user` 是真人对话；`subagent`/`guardian_review`/`automation` 是
      // Codex 自己派生出来的内部线程（实测 159 条里 110 条属此列）。
      if (kind) {
        if (uuid) empty.kind.set(uuid, kind)
        if (rollout) empty.kind.set(rollout, kind)
      }
    }
  } catch {
    return empty
  } finally {
    try { db?.close() } catch { /* 已关闭 */ }
  }
  return empty
}

/** 从 threads 行里取一个可用的标题（`name` 优先，它更短更像标题）。 */
function pickLabel(row) {
  for (const key of ['name', 'title']) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 该 `thread_source` 属不属于「真人对话」。
 *
 * Codex 除了用户自己开的会话，还会为内部用途生成线程：`guardian_review`（审批评审，
 * 实测 42 条，全部同名 `Guardian review`）、`subagent`（子代理，60 条，标题就是
 * 一段英文任务提示）、`automation`（定时任务，8 条，同名 `每周回顾`，正文是
 * `Automation: …` 加一句固定提示）。这些导进来只是噪声：内容里没有一句人话，
 * 标题也全是同一串。默认跳过，需要时用 `codexIncludeInternal` 打开。
 */
function isInternalKind(kind) {
  return kind === 'guardian_review' || kind === 'subagent' || kind === 'automation'
}

/** 该种类是否「默认可导入」。 */
function isImportableKind(kind) {
  return !isInternalKind(kind)
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
    if (!item.isFile() || !/\.jsonl(\.zst)?$/i.test(item.name)) continue
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
  const threadTitles = await loadThreadTitles(root)
  const includeInternal = config.codexIncludeInternal === true
  const internal = []

  const entries = []
  for (const item of [...raw, ...archived]) {
    const name = path.basename(item.path)
    if (!ROLLOUT_RE.test(name)) continue
    const m = UUID_RE.exec(name)
    const uuid = m ? m[1].toLowerCase() : null
    // 内部线程（guardian_review / subagent）默认跳过：实测 159 条里有 110 条，
    // 导进来只会塞满一屏 `Guardian review`。需要时用 `codexIncludeInternal` 打开。
    const kind = (uuid && threadTitles.kind.get(uuid)) || threadTitles.kind.get(name.toLowerCase()) || ''
    if (!includeInternal && isInternalKind(kind)) {
      // 记成一条 `skipped` 条目而不是直接丢掉：上层靠这个字段统计「过滤 N 条」，
      // 让用户知道这里少了东西、以及为什么少（面板会显示 N 条过滤）。
      internal.push({
        source: id,
        path: item.path,
        keyPath: item.path.replace(ZST_RE, ''),
        name,
        sizeBytes: item.sizeBytes,
        mtimeMs: item.mtimeMs,
        threadUuid: uuid,
        skipped: `internal:${kind}`,
      })
      continue
    }
    const fromDb = (uuid && threadTitles.byId.get(uuid)) || threadTitles.byRollout.get(name.toLowerCase()) || null
    const fromIndex = uuid ? (threadNames.unique.get(uuid) ?? null) : null
    // threads.first_user_message：有标题的条目也可能用它做兜底预览，没标题的更是全靠它。
    const firstPrompt = ((uuid && threadTitles.firstPrompt.get(uuid)) || threadTitles.firstPrompt.get(name.toLowerCase()) || '')
    entries.push({
      source: id,
      path: item.path,
      // 台账键用去掉 `.zst` 的路径：Codex 何时压缩不该让历史记录变成「新增」。
      keyPath: item.path.replace(ZST_RE, ''),
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs,
      threadUuid: uuid,
      compressed: ZST_RE.test(item.path),
      explicitTitle: fromDb ?? fromIndex,
      promptHint: firstPrompt ? firstLine(firstPrompt, 80) : '',
      suggestedName: uuid ? (threadNames.all.get(uuid) ?? null) : null,
      archived: item.path.includes(`${path.sep}archived_sessions${path.sep}`),
    })
  }
  // 仍然没标题也没 hint 的条目（threads 表里 first_user_message 为空）：解压文件头提炼。
  // 每条要试多个 user 消息——头几条常是 `<environment_context>`、AGENTS.md 之类注入前言，
  // `firstLine` 把它们剥空后要继续看下一条。
  const needPeek = entries.filter((entry) => !entry.explicitTitle && !entry.promptHint)
  const limit = 4
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, needPeek.length) }, async () => {
      while (cursor < needPeek.length) {
        if (opts.signal?.aborted) return
        const entry = needPeek[cursor++]
        try {
          for (const prompt of promptsFromText(await readHead(entry.path))) {
            const line = firstLine(prompt, 80)
            if (line) {
              entry.promptHint = line
              break
            }
          }
        } catch { /* 读不出来就交给上层兜底 */ }
      }
    }),
  )
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { root, entries: [...entries, ...internal], errors }
}

/**
 * 转换一份 rollout（`.jsonl.zst` 先解压）。
 * 注意：codex 没有流式入口，超大文件整份读进内存；导入是串行的，不会叠加。
 * @param {object} entry discover 的条目
 */
export async function convert(entry) {
  const buf = await fsp.readFile(entry.path)
  const raw = entry.compressed || ZST_RE.test(entry.path) ? zstdDecompress(buf).toString('utf8') : buf.toString('utf8')
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
  return m ? m[1].toLowerCase() : path.basename(entry.path).replace(/\.jsonl(\.zst)?$/i, '')
}