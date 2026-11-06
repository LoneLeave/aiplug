/**
 * 导入编排：扫描（只读，产出清单）与执行（真正写入 DSH）。
 *
 * 扫描只看「有什么、导入过没有、还会不会变」，不写任何东西；执行才走
 * convert → 命名 → 分组 → 落盘 → 挂工作区 → 记台账。
 *
 * 幂等靠 `<DSH_HOME>/ai-import/imports.json` 台账：同一条源记录重跑时，
 *  - 台账里有且源没变  → 跳过；
 *  - 台账里有且源变长了（回合数增加）→ 用 tailSessionEvents 只追加新回合；
 *  - 台账里没有        → 新建会话。
 * `force` 则无视台账重新导入（并沿用台账里的 sessionId，仍是同一条会话）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendSession, listPersistedIds, persistSession } from './persist.mjs'
import { loadLedger, saveLedger, sourceKey } from './store.mjs'
import { buildTitle, makeTitleDeduper } from './naming.mjs'
import { ensureGroupWorkspace, planGroup, resolveSessionCwd } from './grouping.mjs'
import { candidates as candidatesOf, readManualRoots } from './roots.mjs'
import { safeIdPart, firstLine, fmtDateTime, headline } from './util.mjs'
import { appendTitleEvent, tailSessionEvents } from './vendor/convert.mjs'

import * as claude from './sources/claude.mjs'
import * as codex from './sources/codex.mjs'
import * as cursor from './sources/cursor.mjs'
import * as trae from './sources/trae.mjs'
import * as workbuddy from './sources/workbuddy.mjs'

const FILE_SOURCES = [claude, codex, workbuddy, cursor]

/** DSH 主目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 本次要跑的来源列表。
 * @param {object} config 插件配置
 */
export function activeSources(config = {}) {
  const list = [...FILE_SOURCES]
  if (config.includePromptOnlySources === true) list.push(trae)
  return list
}

/** 源条目的稳定路径（用于台账 key 与去重）。 */
function entryPath(entry) {
  return entry.path ?? entry.dbPath ?? entry.composerId ?? entry.workspaceHash ?? ''
}

/** 源记录的「是否变化」指纹。 */
function fingerprintOf(entry) {
  if (typeof entry.sizeBytes === 'number' || typeof entry.mtimeMs === 'number') {
    return `${entry.sizeBytes ?? 0}:${Math.round(entry.mtimeMs ?? 0)}`
  }
  if (entry.composerId) return `${entry.lastUpdatedAt ?? 0}`
  if (entry.workspaceHash) return `${entry.promptCount ?? 0}`
  return ''
}

/**
 * 会话 id：`import-<来源>-<源标识 slug>`。
 * 加来源前缀是为了不撞上 dsh-claude-move 已经导入的 `import-<uuid>` 那批会话。
 */
function desiredSessionId(source, entry) {
  let raw = ''
  try {
    raw = source.sourceIdOf(entry) ?? ''
  } catch {
    raw = ''
  }
  let slug = safeIdPart(String(raw).replace(/[.]jsonl?$/i, ''))
  if (!slug) slug = safeIdPart(path.basename(entryPath(entry)).replace(/[.]jsonl?$/i, ''))
  if (!slug) slug = safeIdPart(String(Date.now()))
  return `import-${source.id}-${slug}`
}

/**
 * 扫描明细里显示的标题。
 *
 * 早前这里直接回退到文件名（`3b1eb283-….jsonl`），用户看到的就是一堆 UUID，
 * 完全看不出是哪个对话。现在按「源自带标题 → 首条真实提问 → 文件名」取，
 * 提问靠读文件开头一小段（不整份解析，扫描要快）。
 * @param {object} entry discover 条目
 * @returns {string}
 */
function entryLabel(entry) {
  const named = String(entry.explicitTitle ?? entry.name ?? '').trim()
  if (named && !isMachineName(named)) return named
  const peeked = peekHeadline(entry)
  if (peeked) return peeked
  const fallback = path.basename(entryPath(entry)) || entry.composerId || ''
  const bare = fallback.replace(/\.jsonl$/i, '')
  if (isMachineName(bare)) {
    // 文件名/composerId 本身就是机器标识：显示出来等于没名字，用日期兜底。
    const when = fmtDateTime(entry.createdAt ?? entry.lastUpdatedAt ?? entry.mtimeMs ?? null)
    const source = String(entry.source ?? '')
    return when ? `${SOURCE_LABELS[source] ?? source} ${when}` : bare
  }
  return bare
}

/** 「标题其实是一串机器名」：UUID、Codex 的 rollout-* 文件名、长 hex 文件名。 */
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MACHINE_NAME = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|rollout-[\w:.-]+|[0-9a-f]{24,})$/i

/** 该名字是否只是机器标识，不适合当标题显示。 */
function isMachineName(name) {
  return UUID_ONLY.test(name) || MACHINE_NAME.test(name)
}

/** 来源 id → 显示名（扫描明细兜底标题用）。 */
const SOURCE_LABELS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', workbuddy: 'WorkBuddy', trae: 'Trae' }

/** 读文件开头一段，提炼第一条非噪声提问（同步 IO，最多 128 KB）。 */
function peekHeadline(entry) {
  const file = entry?.path
  if (!file || !String(file).endsWith('.jsonl')) return ''
  let text
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(128 * 1024)
      const { bytesRead } = fs.readSync(fd, buf, 0, buf.length, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
  // 只留完整行，最后一行可能被截断
  const lines = text.split('\n')
  lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const raw = extractPrompt(rec)
    if (!raw) continue
    // 先跳到第一条非噪声行，再压到第一个句末标点：列表里一行放得下比复述整段更有用。
    const cleaned = headline(firstLine(raw, 80), 56)
    if (cleaned) return cleaned
  }
  return ''
}

/** 从一行记录里取出「可能是人类提问」的原文（各家 schema 不同）。 */
function extractPrompt(rec) {
  if (!rec || typeof rec !== 'object') return ''
  const blocks = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const b of content) {
      if (b && typeof b.text === 'string' && (b.type === 'text' || b.type === 'input_text')) parts.push(b.text)
    }
    return parts.join('\n')
  }
  // Claude / WorkBuddy：{type:'message'|'user', message|content}
  if (rec.type === 'user') return blocks(rec.message?.content ?? rec.content)
  if (rec.type === 'message' && rec.role === 'user') return blocks(rec.content)
  // Codex：{type:'response_item', payload:{type:'message', role:'user', content:[{type:'input_text'}]}}
  const p = rec.payload
  if (p && p.type === 'message' && p.role === 'user') return blocks(p.content)
  return ''
}

/**
 * 扫描所有来源，产出导入清单（只读）。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal, log?: (msg: string) => void}} [opts]
 */
export async function scanAll(config = {}, opts = {}) {
  const homeDir = config.homeDir || dshHome()
  const ledger = await loadLedger(homeDir)
  // 手动选过的目录（`ai-import/roots.json`）优先于平台默认：换机器/配置不在默认
  // 位置时，用户可以在面板里指一个目录，这里把它合进 config 交给各源。
  const manualRoots = await readManualRoots(homeDir)
  const effective = { ...config, homeDir, manualRoots }
  const log = opts.log ?? (() => {})
  const sources = []
  for (const source of activeSources(effective)) {
    if (opts.signal?.aborted) break
    log(`扫描 ${source.label}…`)
    let discovered
    try {
      discovered = await source.discover(effective, { signal: opts.signal })
    } catch (err) {
      sources.push({
        id: source.id,
        label: source.label,
        root: '',
        rootFrom: 'missing',
        candidates: candidatesOf(source.id),
        found: 0,
        importable: 0,
        fresh: 0,
        changed: 0,
        known: 0,
        filtered: 0,
        errors: [`扫描失败：${String(err?.message ?? err)}`],
        entries: [],
      })
      continue
    }
    const entries = discovered?.entries ?? []
    const rows = []
    let importable = 0
    let fresh = 0
    let changed = 0
    let known = 0
    let filtered = 0
    for (const entry of entries) {
      if (entry?.skipped) {
        filtered++
        rows.push({ kind: 'filtered', reason: entry.skipped, label: entry.name || entry.composerId || '' })
        continue
      }
      importable++
      const key = sourceKey(source.id, entryPath(entry))
      const prev = ledger.entries[key]
      const fp = fingerprintOf(entry)
      let state = 'new'
      if (prev) state = prev.fingerprint && fp && prev.fingerprint === fp ? 'known' : 'changed'
      if (state === 'new') fresh++
      else if (state === 'changed') changed++
      else known++
      rows.push({
        kind: state,
        key,
        label: entryLabel(entry),
        path: entryPath(entry),
        projectPath: entry.projectPath ?? null,
        sizeBytes: entry.sizeBytes ?? null,
        turns: prev?.turns ?? null,
        sessionId: prev?.sessionId ?? null,
      })
    }
    sources.push({
      id: source.id,
      label: source.label,
      root: discovered?.root ?? '',
      rootFrom: manualRoots[source.id] ? 'manual' : 'auto',
      candidates: candidatesOf(source.id),
      found: entries.length,
      importable,
      fresh,
      changed,
      known,
      filtered,
      errors: discovered?.errors ?? [],
      entries: rows,
    })
  }
  return { homeDir, sources }
}

/** 把扫描结果压成一行人读摘要（工具与命令共用）。 */
export function summarizeScan(report) {
  const lines = []
  let totalFresh = 0
  let totalChanged = 0
  let totalKnown = 0
  for (const s of report.sources) {
    totalFresh += s.fresh
    totalChanged += s.changed
    totalKnown += s.known
    lines.push(
      `${s.label}: 发现 ${s.found} 条（可导入 ${s.importable}，新增 ${s.fresh}，有更新 ${s.changed}，已导入 ${s.known}` +
      `${s.filtered ? `，过滤 ${s.filtered}` : ''}）`,
    )
    if (s.errors?.length) for (const e of s.errors.slice(0, 3)) lines.push(`  ! ${e}`)
  }
  lines.push('')
  lines.push(`合计：新增 ${totalFresh}，有更新 ${totalChanged}，已导入 ${totalKnown}`)
  return lines.join('\n')
}

/**
 * 执行导入。
 * @param {any} ctx 插件上下文（用来取 sessionPersistence / workspaceRegistry）
 * @param {object} config 插件配置
 * @param {object} [options]
 * @param {boolean} [options.dryRun] 只跑转换不落盘
 * @param {boolean} [options.force] 无视台账重新导入
 * @param {string[]|null} [options.only] 只跑这些来源 id
 * @param {Array<{source: string, key: string, dir?: string, title?: string}>|null} [options.picks]
 *   逐条挑选：只导这些台账键（`source:path`），并可给每条指定目标文件夹
 * @param {number} [options.limit] 每个来源最多导入多少条
 * @param {AbortSignal} [options.signal]
 * @param {(msg: string) => void} [options.log]
 */
export async function runImport(ctx, config = {}, options = {}) {
  const homeDir = config.homeDir || dshHome()
  const log = options.log ?? (() => {})
  const ledger = await loadLedger(homeDir)
  const manualRoots = await readManualRoots(homeDir)
  const effective = { ...config, homeDir, manualRoots }
  const sp = ctx?.get?.('sessionPersistence')
  const registry = ctx?.get?.('workspaceRegistry')
  if (!sp && options.dryRun !== true) {
    throw new Error('sessionPersistence 服务不可用：无法写入会话（插件需在 harness 内运行）')
  }
  const persisted = sp ? await listPersistedIds(sp) : new Set()
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  // 逐条挑选（面板向导）：`picks` 给出「台账键 → 目标文件夹/标题」。
  // 给了 picks 就只导这些条目，并按 `dir` 覆盖默认的「每来源一个工作区」。
  const picks = new Map()
  if (Array.isArray(options.picks)) {
    for (const pick of options.picks) {
      if (!pick || typeof pick.key !== 'string' || pick.key === '') continue
      picks.set(pick.key, {
        dir: typeof pick.dir === 'string' && pick.dir.trim() !== '' ? path.resolve(pick.dir.trim()) : null,
        title: typeof pick.title === 'string' && pick.title.trim() !== '' ? pick.title.trim() : null,
      })
    }
  }
  const pickedOnly = picks.size > 0

  const rows = []
  const groupCache = new Map()
  const dedupers = new Map()
  let created = 0
  let appended = 0
  let skipped = 0
  let failed = 0

  for (const source of activeSources(effective)) {
    if (options.signal?.aborted) break
    if (only && !only.has(source.id)) continue
    let discovered
    try {
      discovered = await source.discover(effective, { signal: options.signal })
    } catch (err) {
      rows.push({ source: source.id, status: 'failed', title: '', error: `扫描失败：${String(err?.message ?? err)}` })
      failed++
      continue
    }
    let queue = (discovered?.entries ?? []).filter((e) => !e?.skipped)
    if (pickedOnly) {
      queue = queue.filter((entry) => picks.has(sourceKey(source.id, entryPath(entry))))
    }
    if (Number.isFinite(options.limit) && options.limit > 0) queue = queue.slice(0, options.limit)
    log(`${source.label}: 待处理 ${queue.length} 条`)

    for (const entry of queue) {
      if (options.signal?.aborted) break
      const key = sourceKey(source.id, entryPath(entry))
      const prev = ledger.entries[key]
      const fp = fingerprintOf(entry)
      if (prev && !options.force && prev.fingerprint && fp && prev.fingerprint === fp) {
        skipped++
        continue
      }
      const label = entryLabel(entry)
      try {
        const conv = await source.convert(entry, effective, { signal: options.signal })
        // 空会话（没有提问也没有正文）直接跳过：Cursor 里大量 draft / 被清空的
        // composer 会解析成 0 轮，导入进来只是噪声。
        if (!conv || (conv.turns === 0 && !String(conv.prompt ?? '').trim())) {
          skipped++
          rows.push({ source: source.id, status: 'empty', label, reason: '无有效对话内容' })
          continue
        }
        const pick = picks.get(key) ?? null
        const plan = planGroup({
          homeDir,
          source: source.id,
          sourceLabel: source.label,
          projectPath: conv.cwd,
          dir: pick?.dir ?? null,
          title: pick?.title ?? null,
        })
        // cwd 两个分支都要用（续写也要写 header），所以放在分支之前算。
        const cwd = await resolveSessionCwd(conv.cwd, plan.dir)
        const existing = prev?.sessionId && persisted.has(prev.sessionId) ? prev.sessionId : null
        const isAppend = Boolean(existing) && !options.force && Number.isFinite(prev?.turns) && conv.turns > prev.turns

        if (isAppend) {
          const tail = tailSessionEvents(conv, { fromTurn: prev.turns + 1, fromSeq: prev.events ?? 0 })
          if (tail.events.length === 0) {
            skipped++
            ledger.entries[key] = { ...prev, fingerprint: fp }
            continue
          }
          if (options.dryRun !== true) {
            await appendSession(sp, existing, tail.events, { ...conv.meta, id: existing, cwd })
            ledger.entries[key] = {
              ...prev,
              fingerprint: fp,
              turns: conv.turns,
              events: (prev.events ?? 0) + tail.events.length,
              importedAt: new Date().toISOString(),
            }
            const group = await ensureGroupWorkspace({ registry, plan, cache: groupCache })
            if (group?.attachSession) {
              try { await group.attachSession(existing) } catch { /* 已挂过就算了 */ }
            }
          }
          appended++
          rows.push({
            source: source.id, status: 'appended', sessionId: existing, title: prev.title ?? '',
            group: plan.title, turns: conv.turns, events: tail.events.length, label,
          })
          continue
        }

        // 会话 id：优先复用台账里的（force 重导时保持同一条会话），否则新算，并避开既有 id。
        let sessionId = prev?.sessionId ?? desiredSessionId(source, entry)
        if (!persisted.has(sessionId)) {
          // 全新 id，直接可用
        } else if (!prev?.sessionId) {
          let n = 2
          while (persisted.has(`${sessionId}-${n}`)) n++
          sessionId = `${sessionId}-${n}`
        }
        // 去重桶要带上「台账里同一分组已经用掉的标题」，否则重跑（或分批导入）时
        // 新会话会再拿到一次同样的标题，和已有会话撞名。
        let titleer = dedupers.get(plan.dir)
        if (!titleer) {
          titleer = makeTitleDeduper()
          for (const rec of Object.values(ledger.entries)) {
            if (rec?.group === plan.title && typeof rec.title === 'string') titleer.take(rec.title, null)
          }
          dedupers.set(plan.dir, titleer)
        }
        const baseTitle = buildTitle({
          sourceLabel: source.label,
          explicitTitle: conv.title ?? entry.explicitTitle ?? null,
          prompt: conv.prompt ?? '',
          createdAt: conv.createdAt ?? null,
          prefixSource: config.titlePrefixSource !== false,
        })
        const title = prev?.title ?? titleer.take(baseTitle, conv.createdAt ?? null)

        // 标题事件：synthesizeSession 自带的那条（源标题）先摘掉，换成去重后的。
        const events = conv.events ?? []
        while (events.length > 0 && events[events.length - 1]?.type === 'session/title') events.pop()
        appendTitleEvent(conv, title)

        if (options.dryRun !== true) {
          await persistSession(sp, { ...conv.meta, id: sessionId, cwd }, conv.events)
          persisted.add(sessionId)
          const group = await ensureGroupWorkspace({ registry, plan, cache: groupCache })
          if (group?.attachSession) {
            try {
              await group.attachSession(sessionId)
            } catch (err) {
              rows.push({
                source: source.id, status: 'failed', sessionId, title, group: plan.title,
                error: `挂工作区失败：${String(err?.message ?? err)}`,
              })
              failed++
              // 会话本身已经写进去了，台账照样记，避免下次重复导入
            }
          }
          ledger.entries[key] = {
            sessionId,
            source: source.id,
            sourcePath: entryPath(entry),
            title,
            group: plan.title,
            // 目录也记下来：面板向导要按「文件夹 → 会话」聚合，光有标题不够
            groupDir: plan.dir,
            groupTitle: plan.title,
            createdAt: conv.createdAt ?? null,
            importedAt: new Date().toISOString(),
            turns: conv.turns,
            events: conv.events.length,
            fingerprint: fp,
          }
          await saveLedger(homeDir, ledger)
        }
        created++
        rows.push({
          source: source.id, status: 'created', sessionId, title, group: plan.title,
          turns: conv.turns, events: conv.events.length,
          toolCalls: conv.toolCalls ?? 0, streaming: conv.streaming === true, label,
        })
        log(`✓ ${title}`)
      } catch (err) {
        failed++
        rows.push({ source: source.id, status: 'failed', label, error: String(err?.message ?? err) })
        log(`✗ [${source.label}] ${label} —— ${String(err?.message ?? err)}`)
      }
    }
  }

  if (options.dryRun !== true) await saveLedger(homeDir, ledger)
  return { created, appended, skipped, failed, rows, homeDir }
}

/**
 * 只读预览：把一条源记录转换成「可读的消息列表」，供面板向导展示。
 *
 * 不落盘、不写台账；大文件走流式时也只取前 `maxTurns` 轮，避免把整份
 * 几十 MB 的 transcript 读进内存。
 *
 * @param {object} config 插件配置
 * @param {{source: string, key: string}} pick 来源 id + 台账键（`source:path`）
 * @param {{maxTurns?: number, maxText?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, source: string, key: string, label: string,
 *   title: string|null, createdAt: number|null, cwd: string|null, turns: number,
 *   totalTurns: number, toolCalls: number, truncated: boolean,
 *   messages: Array<{role: string, turn: number, text: string, tool?: string}>}>}
 */
export async function previewEntry(config = {}, pick = {}, options = {}) {
  const homeDir = config.homeDir || dshHome()
  const manualRoots = await readManualRoots(homeDir)
  const effective = { ...config, homeDir, manualRoots }
  const sourceId = String(pick.source ?? '')
  const key = String(pick.key ?? '')
  const source = activeSources(effective).find((item) => item.id === sourceId)
  if (!source) throw new Error(`未知来源：${sourceId}`)
  if (key === '') throw new Error('key 不能为空')

  const discovered = await source.discover(effective, { signal: options.signal })
  // 台账键就是 `source:path`，且同一会话只可能对应一个源记录，直接比对即可。
  const entry = (discovered?.entries ?? []).find(
    (item) => !item?.skipped && sourceKey(source.id, entryPath(item)) === key,
  )
  if (!entry) throw new Error(`在 ${source.label} 里找不到这条记录（可能已消失）`)

  const conv = await source.convert(entry, effective, { signal: options.signal })
  const maxTurns = Number.isFinite(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : 20
  const maxText = Number.isFinite(options.maxText) && options.maxText > 0 ? options.maxText : 4000
  // 各源 convert 返回的 `turns` 有的是数组、有的只是计数，唯一统一的是事件流，
  // 所以预览直接折事件——与真正落盘的内容一致，不会出现「预览和导入不一样」。
  const events = Array.isArray(conv?.events) ? conv.events : []
  const totalTurns = Number.isFinite(conv?.turns) ? conv.turns : countTurns(events)
  const messages = []
  let truncated = false
  for (const event of events) {
    const turnNo = Number.isFinite(event?.data?.turn) ? event.data.turn : null
    if (turnNo !== null && turnNo > maxTurns) {
      truncated = true
      continue
    }
    if (event?.type === 'user/message') {
      const text = clip(blocksText(event.data?.content), maxText)
      if (text !== '') messages.push({ role: 'user', turn: turnNo, text })
    } else if (event?.type === 'assistant/message') {
      for (const block of Array.isArray(event.data?.message?.content) ? event.data.message.content : []) {
        if (block?.type === 'text' || block?.type === 'reasoning') {
          const text = clip(block.text, maxText)
          if (text !== '') messages.push({ role: block.type === 'reasoning' ? 'thinking' : 'assistant', turn: turnNo, text })
        } else if (block?.type === 'tool-call') {
          messages.push({ role: 'tool', turn: turnNo, text: clip(block.arguments, 400), tool: String(block.name ?? '') })
        }
      }
    }
  }
  return {
    ok: true,
    source: source.id,
    key,
    label: entryLabel(entry),
    title: conv?.title ?? entry.explicitTitle ?? null,
    createdAt: conv?.createdAt ?? null,
    cwd: conv?.cwd ?? entry.projectPath ?? null,
    turns: totalTurns,
    totalTurns,
    toolCalls: conv?.toolCalls ?? 0,
    events: events.length,
    shownTurns: Math.min(totalTurns, maxTurns),
    truncated,
    messages,
  }
}

/** `content` 块数组里的纯文本部分。 */
function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** 事件流里出现了多少轮（`turn/start` 的条数）。 */
function countTurns(events) {
  let n = 0
  for (const event of events) if (event?.type === 'turn/start') n += 1
  return n
}

/** 把文本压到 `max` 个字符，去掉多余空白。 */
function clip(text, max) {
  const flat = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (flat === '') return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 执行结果的人读摘要。 */
export function summarizeRun(result) {
  const lines = []
  const byStatus = { created: [], appended: [], failed: [] }
  for (const r of result.rows ?? []) {
    if (byStatus[r.status]) byStatus[r.status].push(r)
  }
  lines.push(`新建 ${result.created} 条，续写 ${result.appended} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条`)
  if (byStatus.created.length > 0) {
    lines.push('')
    lines.push('新建：')
    for (const r of byStatus.created.slice(0, 200)) {
      const meta = [`${r.turns} 轮`, r.streaming ? '流式' : null].filter(Boolean).join('，')
      lines.push(`  · [${r.source}] ${r.title}　（${r.group}，${meta}）`)
    }
  }
  if (byStatus.appended.length > 0) {
    lines.push('')
    lines.push('续写：')
    for (const r of byStatus.appended.slice(0, 100)) lines.push(`  · [${r.source}] ${r.title}（+${r.events} 事件）`)
  }
  if (byStatus.failed.length > 0) {
    lines.push('')
    lines.push('失败：')
    for (const r of byStatus.failed.slice(0, 50)) lines.push(`  · [${r.source}] ${r.label || r.sessionId || ''} —— ${r.error}`)
  }
  return lines.join('\n')
}
