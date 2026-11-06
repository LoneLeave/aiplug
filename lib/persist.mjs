/**
 * 会话落盘：把合成好的 DSH 事件日志写进宿主会话存储。
 *
 * 这套逻辑照抄自 dsh-claude-move（同为 Apache-2.0 AND MIT），因为它踩过的坑
 * 全在这里：
 *  - header.version 必须等于后端**当前**格式版本（不能按常量猜，也不能硬编码）；
 *  - header.isSeeded 必须显式 false（undefined 会被序列化丢掉，产物不可读）；
 *  - assistant/message 自格式 v2 起必须带 data.stream = []（缺了能写能读，但
 *    resume/fork 会抛 invalid settlement fields）；
 *  - tool/result 自格式 v4 起是一等 tool 角色消息，<4 要折回 v3 包裹形状；
 *  - 写入前必须过 validateSessionEvents：每个 tool/call 恰好一条 tool/result，
 *    否则该会话续聊永久 400。
 */
import { conformToolResultForm, validateSessionEvents } from './vendor/convert.mjs'
import { foldListRows, writeProjectionCache } from './projcache.mjs'

/**
 * 落盘后顺手刷新该会话的投影缓存（会话列表的标题就从这里读）。
 *
 * 为什么必须做：DSH 的 cold 会话列表只读 `session_projcache` 的持久化记录，
 * 而导入出来的会话从来不走 live 路径，没有 dispose 时的 checkpoint ——
 * 不补这一下，列表里就永远是「未命名」（`"session.untitled"`）。
 *
 * 缓存是派生数据：写失败只记一笔，绝不让导入失败。
 *
 * @param {object} header 已规范化的会话头（需要 version/createdAt/cwd/isSeeded）
 * @param {object[]} events 已落盘的事件（用于折出 title 与 sessionListMetadata 行）
 * @returns {{wrote: boolean, reason?: string}}
 */
export function refreshProjectionCache(header, events) {
  try {
    if (!header || typeof header.id !== 'string' || header.id.length === 0) {
      return { wrote: false, reason: 'header 无效' }
    }
    if (header.version !== 4) return { wrote: false, reason: `非当前格式 version=${header.version}` }
    const { rows } = foldListRows(events)
    writeProjectionCache(header, rows)
    return { wrote: true }
  } catch (error) {
    return { wrote: false, reason: error?.message ?? String(error) }
  }
}


const shapeCache = new WeakMap()
const versionCache = new WeakMap()

/**
 * 探测持久化服务是 handle 基线还是旧的服务级 append 基线。
 * @param {any} sp sessionPersistence 服务
 * @returns {'handle'|'legacy'|'unknown'}
 */
export function detectPersistenceShape(sp) {
  if (!sp) return 'unknown'
  const cached = shapeCache.get(sp)
  if (cached) return cached
  let shape = 'unknown'
  if (typeof sp.open === 'function') shape = 'handle'
  else if (typeof sp.append === 'function') shape = 'legacy'
  shapeCache.set(sp, shape)
  return shape
}

function notePersistenceShape(sp, shape) {
  shapeCache.set(sp, shape)
}

function isSessionHandle(v) {
  return v !== null && typeof v === 'object'
    && typeof v.append === 'function'
    && typeof v.flush === 'function'
    && typeof v.close === 'function'
}

/**
 * 当前会话格式版本：先问后端自报的 generationFormat.currentVersion，
 * 回退宿主 @deepseek-ai/dsh-session 的 SESSION_FORMAT_VERSION，都拿不到返回 null。
 * @param {any} sp sessionPersistence 服务
 * @returns {Promise<number|null>}
 */
export async function currentFormatVersion(sp) {
  const cached = versionCache.get(sp)
  if (cached !== undefined) return cached
  let version = null
  const backend = sp?.generationFormat
  if (backend && typeof backend === 'object'
    && Number.isSafeInteger(backend.currentVersion) && backend.currentVersion >= 0) {
    version = backend.currentVersion
  } else {
    try {
      const mod = await import('@deepseek-ai/dsh-session')
      if (Number.isSafeInteger(mod.SESSION_FORMAT_VERSION) && mod.SESSION_FORMAT_VERSION >= 0) {
        version = mod.SESSION_FORMAT_VERSION
      }
    } catch {
      // 宿主包不可解析：保持原 header（后端读取时会响亮拒绝，绝不静默写坏）
    }
  }
  versionCache.set(sp, version)
  return version
}

/** header 规范化：盖当前格式版本 + 显式 isSeeded。 */
export async function normalizeHeader(sp, meta) {
  const header = { ...meta }
  const version = await currentFormatVersion(sp)
  if (typeof version === 'number' && version >= 0) header.version = version
  if (header.isSeeded === undefined) header.isSeeded = false
  return header
}

/** 事件批规范化：补 assistant/message.stream、补空 model。 */
export function normalizeEvents(events, formatVersion) {
  const needsStream = typeof formatVersion === 'number' && formatVersion >= 2
  let changed = false
  const out = events.map((event) => {
    if (event?.type !== 'assistant/message') return event
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return event
    const source = data.message?.source
    const fixModel = source !== null && typeof source === 'object'
      && source.kind === 'model'
      && (typeof source.model !== 'string' || source.model.length === 0)
    const fixStream = needsStream && !Array.isArray(data.stream)
    if (!fixModel && !fixStream) return event
    changed = true
    const nextData = { ...data }
    if (fixStream) nextData.stream = []
    if (fixModel) {
      nextData.message = {
        ...data.message,
        source: {
          ...source,
          model: typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : 'unknown',
        },
      }
    }
    return { ...event, data: nextData }
  })
  return changed ? out : events
}

/** 已持久化的会话 id 集合。 */
export async function listPersistedIds(sp) {
  const ids = new Set()
  if (!sp) return ids
  try {
    const list = await sp.list()
    for (const element of list ?? []) {
      const id = element?.header?.id ?? element?.id
      if (typeof id === 'string' && id.length > 0) ids.add(id)
    }
  } catch {
    // list 不可用（老基线）就当作空集合，由调用方用 create 的失败兜底
  }
  return ids
}

/**
 * 在助手消息里「声明」每个工具调用。
 *
 * DSH 的会话格式升级校验（session-format-v0-to-v1）要求：每个 `tool/call`
 * 事件必须由同一 step 的助手消息 content 里的一条 `{type:'tool-call', id,
 * name, arguments}` 块先行声明（内部叫 advertised lifecycle），
 * 否则读取时报 `tool/call <id> has no advertised tool lifecycle`。
 *
 * Claude 源由 vendored 转换器的 mapContentBlock 自带这一步；Codex 与
 * WorkBuddy 只给出 toolCalls 数组，缺少声明块，因此这里统一补齐。
 * @param {object[]} events 合成事件（就地改写）
 * @returns {object[]} 同一个数组
 */
export function advertiseToolCalls(events) {
  const assistantByStep = new Map()
  for (const ev of events) {
    if (ev?.type !== 'assistant/message') continue
    const d = ev.data
    if (d && typeof d.turn === 'number' && typeof d.step === 'number') {
      assistantByStep.set(`${d.turn}:${d.step}`, d)
    }
  }
  let added = 0
  for (const ev of events) {
    if (ev?.type !== 'tool/call') continue
    const d = ev.data
    if (!d || typeof d.callId !== 'string') continue
    const holder = assistantByStep.get(`${d.turn}:${d.step}`)
    const message = holder?.message
    if (!message || !Array.isArray(message.content)) continue
    const already = message.content.some((b) => b && b.type === 'tool-call' && b.id === d.callId)
    if (already) continue
    message.content.push({
      type: 'tool-call',
      id: d.callId,
      name: d.name,
      arguments: d.arguments,
    })
    added++
  }
  return events
}

/**
 * 让 tool/call 的 callId 在整条会话里唯一。
 *
 * Claude Code 的 transcript 会跨轮复用同一个 tool_use id（尤其是一条长会话被
 * 中断后续写），dsh-claude-move 的合成器按 step 声明调用、不做全局去重，
 * 于是 `validateSessionEvents` 报 `duplicate tool/call ...`。这里在落盘前统一
 * 重命名重复项，并同步改写对应 tool/result 的 toolCallId（结果通过
 * `sourceEventSeqs` 指向 call 的 seq，改名不破坏配对）。
 * @param {object[]} events 合成事件（就地改写）
 * @returns {object[]} 同一个数组
 */
export function dedupeToolCallIds(events) {
  const seen = new Set()
  const callIdBySeq = new Map()
  // 原始 id → 尚未被认领的声明块队列（FIFO）。
  // 同一个 tool_use id 被跨轮复用时，每个 step 都会各自声明一次；去重改名时
  // 必须把「属于这一次」的声明块一起改名，否则校验器按 callId 查生命周期表
  // 查不到，报 `tool/call <id> has no advertised tool lifecycle`。
  const pendingDecls = new Map()
  let renamed = 0
  for (const ev of events) {
    if (ev?.type === 'assistant/message') {
      const content = ev.data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool-call' || typeof block.id !== 'string' || block.id.length === 0) continue
          const queue = pendingDecls.get(block.id)
          if (queue) queue.push(block)
          else pendingDecls.set(block.id, [block])
        }
      }
      continue
    }
    if (ev?.type !== 'tool/call') continue
    const data = ev.data
    const id = data?.callId
    if (typeof id !== 'string' || id.length === 0) continue
    const queue = pendingDecls.get(id)
    const declared = queue !== undefined && queue.length > 0 ? queue.shift() : undefined
    if (declared !== undefined) {
      // 校验器对声明做严格相等比较：pending.name !== data.name ||
      // pending.arguments !== data.arguments 直接抛 "does not match one advertised
      // tool call"。声明块与调用本该是同一份数据，这里兜底对齐。
      if (declared.name !== data.name) declared.name = data.name
      if (declared.arguments !== data.arguments) declared.arguments = data.arguments
    }
    let next = id
    if (seen.has(next)) {
      let n = 2
      while (seen.has(`${id}#${n}`)) n++
      next = `${id}#${n}`
      data.callId = next
      if (declared !== undefined) declared.id = next
      renamed++
    }
    seen.add(next)
    callIdBySeq.set(ev.seq, next)
  }
  if (renamed === 0) return events
  for (const ev of events) {
    if (ev?.type !== 'tool/result') continue
    const ref = Array.isArray(ev.sourceEventSeqs) ? ev.sourceEventSeqs[0] : undefined
    const nextId = ref === undefined ? undefined : callIdBySeq.get(ref)
    if (!nextId) continue
    const msg = ev.data?.message
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'tool' && typeof msg.toolCallId === 'string') {
      ev.data.message = {
        ...msg,
        toolCallId: nextId,
        ...(msg.source && typeof msg.source === 'object' ? { source: { ...msg.source, callId: nextId } } : {}),
      }
      continue
    }
    const block = Array.isArray(msg.content) ? msg.content[0] : undefined
    if (block && block.type === 'tool-result') {
      ev.data.message = {
        ...msg,
        content: [{ ...block, toolCallId: nextId }, ...msg.content.slice(1)],
        ...(msg.source && typeof msg.source === 'object' ? { source: { ...msg.source, callId: nextId } } : {}),
      }
    }
  }
  return events
}

/**
 * create + append 一份完整会话日志。
 * @param {any} sp sessionPersistence 服务
 * @param {object} meta 会话 header（id/createdAt/cwd）
 * @param {object[]} events 合成的 DSH 事件
 * @returns {Promise<{id: string, events: number}>}
 */
export async function persistSession(sp, meta, events) {
  if (!sp || typeof sp.create !== 'function') {
    throw new Error('sessionPersistence 服务不可用（或缺少 create）')
  }
  dedupeToolCallIds(events)
  advertiseToolCalls(events)
  const issues = validateSessionEvents(events)
  if (issues.length > 0) {
    throw new Error(`拒绝落盘：事件不满足续聊协议不变式 —— ${issues.slice(0, 5).join('; ')}`)
  }
  const handleShape = detectPersistenceShape(sp) === 'handle'
  const header = await normalizeHeader(sp, meta)
  const created = await sp.create(header)
  if (isSessionHandle(created)) {
    notePersistenceShape(sp, 'handle')
    let prepared = events
    try {
      if (events.length > 0) {
        const version = await currentFormatVersion(sp)
        prepared = normalizeEvents(conformToolResultForm(events, version), version)
        await created.append(prepared)
      }
      await created.flush()
    } finally {
      await created.close()
    }
    refreshProjectionCache(header, prepared)
    return { id: header.id, events: events.length }
  }
  notePersistenceShape(sp, 'legacy')
  if (typeof sp.append !== 'function') {
    throw new Error('sessionPersistence 服务不可用：既没有 handle 也没有 append')
  }
  const legacyEvents = conformToolResultForm(events, 0)
  await sp.append(meta.id, legacyEvents)
  refreshProjectionCache(header, legacyEvents)
  return { id: meta.id, events: events.length }
}

/**
 * 往**已存在**的会话尾部追加事件（增量导入用）。
 *
 * 与 persistSession 的区别只有两条：不 create、校验时用实际起始 seq。
 * 注意 events 必须已经由 `tailSessionEvents` 重编号过（seq 从现有末尾续上）。
 *
 * @param {any} sp sessionPersistence 服务
 * @param {string} id 会话 id
 * @param {object[]} events 续写事件（seq 已对齐）
 * @param {object} [meta] 会话头草稿（有就顺手刷新投影缓存）
 * @returns {Promise<{id: string, events: number}>}
 */
export async function appendSession(sp, id, events, meta) {
  if (!sp || typeof id !== 'string' || id.length === 0) {
    throw new Error('续写失败：会话 id 为空')
  }
  if (!Array.isArray(events) || events.length === 0) return { id, events: 0 }
  const startSeq = Number.isSafeInteger(events[0]?.seq) ? events[0].seq : 0
  dedupeToolCallIds(events)
  advertiseToolCalls(events)
  const issues = validateSessionEvents(events, startSeq)
  if (issues.length > 0) {
    throw new Error(`拒绝续写：事件不满足续聊协议不变式 —— ${issues.slice(0, 5).join('; ')}`)
  }
  const version = await currentFormatVersion(sp)
  const prepared = normalizeEvents(conformToolResultForm(events, version), version)
  const handleShape = detectPersistenceShape(sp) === 'handle'
  // 续写只折「尾巴」：没有 turn/start 就不动 sessionListMetadata，
  // 免得把 blank 折回 true；title 行缺省时由写缓存时的合并保留旧值。
  const refresh = async () => {
    if (meta === undefined) return
    if (!prepared.some((event) => event?.type === 'turn/start')) return
    refreshProjectionCache(await normalizeHeader(sp, { ...meta, id }), prepared)
  }
  if (handleShape) {
    const handle = await sp.open(id, 'write')
    if (!isSessionHandle(handle)) {
      throw new Error(`续写失败：open(${id},'write') 返回的不是可写句柄`)
    }
    try {
      await handle.append(prepared)
      await handle.flush()
    } finally {
      await handle.close()
    }
    await refresh()
    return { id, events: events.length }
  }
  if (typeof sp.append !== 'function') {
    throw new Error('sessionPersistence 服务不可用：既没有 handle 也没有 append')
  }
  await sp.append(id, conformToolResultForm(events, 0))
  await refresh()
  return { id, events: events.length }
}
