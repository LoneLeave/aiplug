/**
 * WorkBuddy 来源：`~/.workbuddy/projects/<项目slug>/<会话id>.jsonl`
 * （同名 `.meta.json` 提供 cwd/createdAt）。
 *
 * 行结构（实测）：
 *   {type:'message', role:'user', content:[{type:'input_text',text}], timestamp, id}
 *   {type:'reasoning', rawContent:[{type:'reasoning_text',text}], timestamp}
 *   {type:'message', role:'assistant', content:[{type:'output_text',text}], timestamp}
 *   {type:'function_call', callId, name, arguments:'<json 字符串>', timestamp}
 *   {type:'function_call_result', callId, status, output:{type:'text',text}, timestamp}
 *   {type:'file-history-snapshot', ...}  ← 忽略
 *
 * 这里自己拼「回合中间结构」再交给 vendor 的 synthesizeSession，事件纪律与其他源一致。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { synthesizeSession } from '../vendor/convert.mjs'
import { expandHome, firstExistingCandidate, manualRootOf } from '../roots.mjs'
import { firstLine, stripInjected } from '../util.mjs'

export const id = 'workbuddy'
export const label = 'WorkBuddy'

/** WorkBuddy 数据根目录。 */
export function home(config = {}) {
  const explicit = expandHome(config.workbuddyHome)
  if (explicit) return explicit
  const manual = manualRootOf(config, 'workbuddy')
  if (manual) return manual
  return firstExistingCandidate('workbuddy')
}

/** 从消息行里抽纯文本。 */
function textOf(line) {
  const blocks = Array.isArray(line?.content) ? line.content : []
  const parts = []
  for (const b of blocks) {
    if (!b) continue
    if (typeof b.text === 'string') parts.push(b.text)
    else if (typeof b.content === 'string') parts.push(b.content)
  }
  return parts.join('\n')
}

/** reasoning 行取推理文本。 */
function reasoningOf(line) {
  const blocks = Array.isArray(line?.rawContent) ? line.rawContent : []
  const parts = []
  for (const b of blocks) {
    if (b && typeof b.text === 'string') parts.push(b.text)
    else if (b && typeof b.reasoning === 'string') parts.push(b.reasoning)
  }
  if (parts.length === 0 && Array.isArray(line?.content)) {
    for (const b of line.content) if (b && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** 解析一份 WorkBuddy jsonl。 */
export function parseWorkbuddyJsonl(raw) {
  const lines = raw.split('\n')
  const turns = []
  const typeCounts = {}
  let skipped = 0
  let cur = null
  let pendingReasoning = []
  let cwd = null
  let createdAt = null
  const callSteps = new Map()
  // 会话级唯一 callId 集合，以及「原始 callId → 本次唯一 callId」的映射。
  const usedCallIds = new Set()
  const pendingCallIds = new Map()

  const ts = (line, fallback) => {
    const t = Date.parse(line?.timestamp ?? '')
    return Number.isFinite(t) ? t : fallback
  }

  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    turns.push(cur)
    callSteps.clear()
  }

  const openStep = () => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (pendingReasoning.length > 0) {
      step.content.push({ type: 'reasoning', text: pendingReasoning.join('\n\n') })
      pendingReasoning = []
    }
    cur.steps.push(step)
    return step
  }

  for (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (!rec || typeof rec !== 'object') { skipped++; continue }
    const type = typeof rec.type === 'string' ? rec.type : 'unknown'
    typeCounts[type] = (typeCounts[type] ?? 0) + 1
    if (createdAt === null) createdAt = ts(rec, null)
    if (typeof rec.cwd === 'string' && rec.cwd.trim()) cwd = rec.cwd.trim()

    if (type === 'file-history-snapshot') continue

    if (type === 'message' && rec.role === 'user') {
      const text = stripInjected(textOf(rec))
      if (!text) continue
      openTurn(text)
      continue
    }

    if (type === 'reasoning') {
      const text = reasoningOf(rec).trim()
      if (text && cur) pendingReasoning.push(text)
      continue
    }

    if (type === 'message' && rec.role === 'assistant') {
      if (!cur) continue
      const text = textOf(rec).trim()
      const step = openStep()
      if (text) step.content.push({ type: 'text', text })
      continue
    }

    if (type === 'function_call') {
      if (!cur) continue
      // 同一段里连续的工具调用挂到当前 step；没有 step 就先开一个空的
      const step = cur.steps.length > 0 ? cur.steps[cur.steps.length - 1] : openStep()
      const rawId = String(rec.callId ?? rec.id ?? '')
      if (!rawId) continue
      // WorkBuddy 的 callId 会重复（同一工具被并行调用时只带工具名+序号，甚至完全相同的
      // 服务端 id）。DSH 要求每个 tool/call 的 callId 唯一，这里做会话级去重。
      let callId = rawId
      if (usedCallIds.has(callId)) {
        let n = 2
        while (usedCallIds.has(`${rawId}#${n}`)) n++
        callId = `${rawId}#${n}`
      }
      usedCallIds.add(callId)
      const args = typeof rec.arguments === 'string' ? rec.arguments : JSON.stringify(rec.arguments ?? {})
      const call = { id: callId, name: String(rec.name ?? 'tool'), arguments: args }
      // 同一对象既进 content（声明）又进 toolCalls（产生 tool/call 事件），
      // 保证读取时 v0→v1 校验能对上 advertised 生命周期。
      step.content.push(call)
      step.toolCalls.push(call)
      // 结果行只带原始 callId，这里用「原始 → 本次唯一 id」的映射回填。
      callSteps.set(rawId, step)
      pendingCallIds.set(rawId, callId)
      continue
    }

    if (type === 'function_call_result') {
      const rawId = String(rec.callId ?? '')
      const callId = pendingCallIds.get(rawId) ?? rawId
      const step = callSteps.get(rawId)
      if (!step) continue
      let text = ''
      const out = rec.output
      if (typeof out === 'string') text = out
      else if (out && typeof out.text === 'string') text = out.text
      else if (out !== undefined) text = JSON.stringify(out)
      step.toolResults.push({
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: rec.status !== undefined && rec.status !== 'completed',
      })
      continue
    }
  }

  // 收尾：把还在等推理的尾巴挂到最后一个 step（否则会丢）
  if (pendingReasoning.length > 0 && cur && cur.steps.length > 0) {
    cur.steps[cur.steps.length - 1].content.unshift({ type: 'reasoning', text: pendingReasoning.join('\n\n') })
  }

  return { turns, cwd, createdAt, skipped, typeCounts }
}

/**
 * 发现全部 WorkBuddy 会话。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function discover(config = {}, opts = {}) {
  const root = path.join(home(config), 'projects')
  const entries = []
  const errors = []
  let dirs = []
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    errors.push(`读取 ${root} 失败：${String(err?.message ?? err)}`)
    return { root, entries, errors }
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    if (opts.signal?.aborted) break
    const dirPath = path.join(root, d.name)
    let files = []
    try {
      files = await fsp.readdir(dirPath, { withFileTypes: true })
    } catch (err) {
      errors.push(`读取 ${dirPath} 失败：${String(err?.message ?? err)}`)
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const full = path.join(dirPath, f.name)
      let st
      try {
        st = await fsp.stat(full)
      } catch (err) {
        errors.push(`stat ${full} 失败：${String(err?.message ?? err)}`)
        continue
      }
      let metaCwd = null
      let metaCreatedAt = null
      try {
        const metaRaw = await fsp.readFile(full.replace(/\.jsonl$/i, '.meta.json'), 'utf8')
        const meta = JSON.parse(metaRaw)
        metaCwd = typeof meta?.cwd === 'string' ? meta.cwd : null
        metaCreatedAt = Number(meta?.createdAt) || null
      } catch { /* 没有 meta 就用 transcript 里的 cwd */ }
      entries.push({
        source: id,
        path: full,
        projectSlug: d.name,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        explicitTitle: null,
        metaCwd,
        metaCreatedAt,
      })
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { root, entries, errors }
}

/**
 * 转换一份 WorkBuddy transcript。
 * @param {object} entry discover 条目
 */
export async function convert(entry) {
  const raw = await fsp.readFile(entry.path, 'utf8')
  const parsed = parseWorkbuddyJsonl(raw)
  const sourceId = sourceIdOf(entry)
  const cwd = parsed.cwd ?? entry.metaCwd ?? null
  // createdAt 必须是「非负安全整数」毫秒：fs.stat 的 mtimeMs 是浮点，直接写
  // 会被后端拒绝（session metadata createdAt must be a non-negative safe integer）。
  const pickTime = (...cands) => {
    for (const c of cands) {
      const n = Number(c)
      if (Number.isFinite(n) && n > 0) return Math.round(n)
    }
    return Date.now()
  }
  const createdAt = pickTime(parsed.createdAt, entry.metaCreatedAt, entry.mtimeMs)
  const meta = { version: 0, id: `import-${sourceId}`, createdAt }
  if (cwd) meta.cwd = cwd
  const model = 'workbuddy'
  const converted = synthesizeSession({
    meta,
    turns: parsed.turns,
    title: null,
    provider: 'workbuddy',
    model,
    skipped: parsed.skipped,
    records: parsed.skipped + Object.values(parsed.typeCounts).reduce((a, b) => a + b, 0),
    typeCounts: parsed.typeCounts,
  })
  return {
    meta: converted.meta,
    events: converted.events,
    title: null,
    prompt: parsed.turns[0]?.prompt ?? '',
    cwd,
    createdAt,
    turns: parsed.turns.length,
    records: converted.records,
    toolCalls: converted.toolCalls,
    skipped: converted.skipped,
    typeCounts: converted.typeCounts,
    repaired: converted.repaired,
    streaming: false,
  }
}

/** 会话稳定标识。 */
export function sourceIdOf(entry) {
  return path.basename(entry.path).replace(/\.jsonl$/i, '')
}

export { firstLine }
