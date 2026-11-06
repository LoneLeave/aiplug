/**
 * dsh-ai-import-ui —— Host 半边。
 *
 * 只做三件事：暴露 /api/ai-import/* 路由、缓存一次扫描结果、把导入跑成可轮询的后台任务。
 * 真正的扫描/转换/落盘逻辑全部复用 dsh-ai-import 的 lib/runner.mjs，这里不重复实现。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { groupsRoot } from 'dsh-ai-import/lib/grouping.mjs'
import { loadLedger } from 'dsh-ai-import/lib/store.mjs'
import { previewEntry, runImport, scanAll } from 'dsh-ai-import/lib/runner.mjs'
import {
  browse as browseDir,
  candidates as candidatesOf,
  expandHome,
  readManualRoots,
  writeManualRoot,
} from 'dsh-ai-import/lib/roots.mjs'

export const name = 'ai-import-ui'
/** webServer 用来注册 HTTP 路由；拿不到就整页不可用（client 会显示提示）。 */
export const inject = ['webServer']

const API_PREFIX = '/api/ai-import'
const INDEX_TTL_MS = 30_000
const JOB_RETENTION = 10
const BODY_LIMIT_BYTES = 64 * 1024

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
  })
}

/** 与本机 GUI 同源才允许写操作（防 DNS rebinding / 跨站 POST）。 */
function isTrustedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  let host = ''
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true
  const headerHost = String(req.headers.host ?? '').replace(/:\d+$/, '')
  return headerHost !== '' && headerHost === host
}

function finitePositive(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function pickSourceIds(value) {
  if (!Array.isArray(value)) return null
  const ids = value.filter((item) => typeof item === 'string' && item.length > 0)
  return ids.length > 0 ? ids : null
}

function jobView(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    dryRun: job.dryRun,
    force: job.force,
    limit: job.limit ?? null,
    sources: job.sources,
    total: job.total,
    done: job.done,
    current: job.current,
    currentProcessed: job.currentProcessed ?? 0,
    currentTotal: job.currentTotal ?? null,
    activity: job.activity ?? null,
    created: job.created,
    appended: job.appended,
    skipped: job.skipped,
    failed: job.failed,
    rows: job.rows,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
  }
}

/** 文件夹名清洗：只允许当层目录名，不允许穿越。 */
function safeFolderName(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return ''
  if (raw === '.' || raw === '..') return ''
  if (/[\\\\/:*?"<>|]/.test(raw)) return ''
  return raw.slice(0, 60)
}

/** 归档根目录下所有文件夹（一层），附带其中已导入的会话数。 */
async function listFolders(homeDir, ledger) {
  const root = groupsRoot(homeDir)
  let names = []
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    names = entries.filter((item) => item.isDirectory() && !item.name.startsWith('.')).map((item) => item.name)
  } catch {
    names = []
  }
  // 台账里出现过的目录也算（目录可能被用户删了，但会话还在列表里）
  const known = new Map()
  for (const record of Object.values(ledger?.entries ?? {})) {
    if (record?.groupDir) known.set(record.groupDir, record.groupTitle ?? path.basename(record.groupDir))
  }
  for (const [dir] of known) {
    const base = path.basename(dir)
    if (base && !names.includes(base) && path.dirname(dir) === root) {
      if (fs.existsSync(dir)) names.push(base)
    }
  }
  names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return names.map((name) => {
    const dir = path.join(root, name)
    const sessions = Object.values(ledger?.entries ?? {}).filter((record) => record?.groupDir === dir)
    return {
      name,
      dir,
      sessions: sessions.length,
      exists: fs.existsSync(dir),
      // 内置的「每来源一个工作区」目录也列出来，方便把会话塞进去
    }
  })
}

/** 目录里已落盘的会话（靠台账；台账里没有的是外部会话，不列）。 */
function folderSessions(ledger, dir) {
  return Object.values(ledger?.entries ?? {})
    .filter((record) => record?.groupDir === dir)
    .map((record) => ({
      sessionId: record.sessionId ?? null,
      title: record.title ?? null,
      source: record.source ?? null,
      turns: record.turns ?? null,
      importedAt: record.importedAt ?? null,
    }))
    .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN'))
}

/* ------------------------------------------------------------------- plugin */

export function apply(ctx) {
  const jobs = new Map()
  const cache = { index: null, at: 0 }

  async function buildIndex(force) {
    if (!force && cache.index !== null && Date.now() - cache.at < INDEX_TTL_MS) return cache.index
    const report = await scanAll({}, {})
    const manualRoots = await readManualRoots(report.homeDir ?? undefined)
    const totals = { found: 0, fresh: 0, changed: 0, known: 0, filtered: 0, importable: 0 }
    const sources = (report.sources ?? []).map((source) => {
      const entries = (source.entries ?? []).map((entry) => ({
        kind: entry.kind,
        key: entry.key,
        label: entry.label,
        path: entry.path,
        projectPath: entry.projectPath ?? null,
        turns: entry.turns ?? null,
        sizeBytes: entry.sizeBytes ?? null,
        sessionId: entry.sessionId ?? null,
      }))
      const summary = {
        id: source.id,
        label: source.label,
        root: source.root ?? null,
        rootFrom: source.rootFrom ?? 'auto',
        manualRoot: manualRoots[source.id] ?? null,
        candidates: Array.isArray(source.candidates) ? source.candidates : candidatesOf(source.id),
        found: source.found ?? entries.length,
        fresh: source.fresh ?? 0,
        changed: source.changed ?? 0,
        known: source.known ?? 0,
        filtered: source.filtered ?? 0,
        importable: source.importable ?? (source.fresh ?? 0) + (source.changed ?? 0),
        errors: Array.isArray(source.errors) ? source.errors.map(String) : [],
        entries,
      }
      totals.found += summary.found
      totals.fresh += summary.fresh
      totals.changed += summary.changed
      totals.known += summary.known
      totals.filtered += summary.filtered
      totals.importable += summary.importable
      return summary
    })
    const index = {
      ok: true,
      scannedAt: new Date().toISOString(),
      homeDir: report.homeDir ?? null,
      totals,
      sources,
    }
    cache.index = index
    cache.at = Date.now()
    return index
  }

  function trimJobs() {
    if (jobs.size <= JOB_RETENTION) return
    const finished = [...jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    while (jobs.size > JOB_RETENTION && finished.length > 0) {
      const job = finished.shift()
      jobs.delete(job.jobId)
    }
  }

  async function startJob(body) {
    const requested = pickSourceIds(body?.sources)
    const dryRun = body?.dryRun === true
    const force = body?.force === true
    const limit = finitePositive(body?.limit)
    // 逐条挑选：向导里勾中的键 + 各自的目标文件夹。给了就只导这些条目。
    const picks = Array.isArray(body?.picks)
      ? body.picks
          .filter((item) => item && typeof item.key === 'string' && item.key !== '')
          .map((item) => ({
            key: item.key,
            source: typeof item.source === 'string' ? item.source : '',
            dir: typeof item.dir === 'string' && item.dir.trim() !== '' ? item.dir.trim() : null,
            title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null,
          }))
      : []
    const job = {
      jobId: randomUUID(),
      status: 'running',
      dryRun,
      force,
      limit: limit ?? null,
      sources: requested ?? [],
      picks,
      total: picks.length > 0 ? new Set(picks.map((pick) => pick.source)).size : (requested?.length ?? 0),
      done: 0,
      current: null,
      created: 0,
      appended: 0,
      skipped: 0,
      failed: 0,
      rows: [],
      error: null,
      startedAt: Date.now(),
      controller: new AbortController(),
    }
    jobs.set(job.jobId, job)
    trimJobs()

    // 先回 jobId，再后台跑：与 dsh-claude-move 的做法一致。
    void (async () => {
      try {
        const ids = requested ?? (await buildIndex(false)).sources.map((source) => source.id)
        job.sources = ids
        job.total = ids.length
        for (const id of ids) {
          if (job.controller.signal.aborted) break
          // 逐条挑选时，把该来源的 picks 传下去（含目标文件夹）。
          // 该来源一条都没被选中就整段跳过——否则 picks 会被当成「没指定」而全导。
          const mine = picks.length > 0
            ? picks.filter((pick) => pick.source === '' || pick.source === id)
            : null
          if (picks.length > 0 && mine.length === 0) {
            job.done += 1
            continue
          }
          job.current = id
          job.currentProcessed = 0
          job.currentTotal = null
          const result = await runImport(ctx, {}, {
            only: [id],
            dryRun,
            force,
            limit,
            picks: mine ?? undefined,
            signal: job.controller.signal,
            log: (message) => {
              const text = String(message)
              job.activity = text
              job.activityAt = Date.now()
              const queued = /待处理 (\d+) 条/.exec(text)
              if (queued !== null) job.currentTotal = Number(queued[1])
              if (text.startsWith('✓') || text.startsWith('✗')) job.currentProcessed += 1
            },
          })
          job.created += result.created ?? 0
          job.appended += result.appended ?? 0
          job.skipped += result.skipped ?? 0
          job.failed += result.failed ?? 0
          for (const row of result.rows ?? []) {
            job.rows.push({
              source: row.source ?? id,
              status: row.status ?? 'failed',
              sessionId: row.sessionId ?? null,
              title: row.title ?? null,
              group: row.group ?? null,
              turns: row.turns ?? null,
              events: row.events ?? null,
              toolCalls: row.toolCalls ?? null,
              label: row.label ?? null,
              error: row.error ?? null,
              reason: row.reason ?? null,
            })
          }
          job.done += 1
        }
        job.status = job.controller.signal.aborted ? 'cancelled' : 'done'
      } catch (err) {
        job.status = 'error'
        job.error = String(err?.message ?? err)
      } finally {
        job.current = null
        job.finishedAt = Date.now()
        // 会话集可能变了，下次读索引强制重扫。
        cache.index = null
        cache.at = 0
      }
    })()

    return job
  }

  const routes = []

  function route(path, handler) {
    routes.push(
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (err) {
            try {
              sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
            } catch {
              try {
                res.destroy()
              } catch {
                /* 连接已断，忽略 */
              }
            }
          }
        },
      }),
    )
  }

  // 单条会话预览：给向导右栏用。只读，不落盘。
  route(`${API_PREFIX}/preview`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const source = url.searchParams.get('source') ?? ''
    const key = url.searchParams.get('key') ?? ''
    const maxTurns = finitePositive(url.searchParams.get('turns')) ?? 20
    const maxText = finitePositive(url.searchParams.get('chars')) ?? 4000
    if (source === '' || key === '') return sendJson(res, 400, { ok: false, error: 'source 与 key 必填' })
    const preview = await previewEntry({}, { source, key }, { maxTurns, maxText })
    sendJson(res, 200, preview)
  })

  // 归档文件夹：列出 / 新建 / 改名 / 删除（只删工作区登记，不删目录与会话）。
  route(`${API_PREFIX}/folders`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const homeDir = cache.index?.homeDir ?? (await scanAll({}, {})).homeDir
    const ledger = await loadLedger(homeDir)
    const folders = await listFolders(homeDir, ledger)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const dir = url.searchParams.get('dir') ?? ''
    const detail = dir === '' ? null : folderSessions(ledger, path.resolve(dir))
    sendJson(res, 200, { ok: true, root: groupsRoot(homeDir), folders, sessions: detail })
  })

  route(`${API_PREFIX}/folder`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err?.message ?? err) })
    }
    const action = typeof body?.action === 'string' ? body.action : 'create'
    const homeDir = cache.index?.homeDir ?? (await scanAll({}, {})).homeDir
    const root = groupsRoot(homeDir)

    if (action === 'create') {
      const name = safeFolderName(body?.name)
      if (name === '') return sendJson(res, 400, { ok: false, error: '名字不合法（不能为空、不能含 \\\\ / : * ? " < > |）' })
      const dir = path.join(root, name)
      if (!dir.startsWith(root + path.sep)) return sendJson(res, 400, { ok: false, error: '路径越界' })
      if (fs.existsSync(dir)) return sendJson(res, 409, { ok: false, error: '同名文件夹已存在', dir })
      await fsp.mkdir(dir, { recursive: true })
      return sendJson(res, 200, { ok: true, name, dir, root })
    }

    if (action === 'rename') {
      const dir = path.resolve(String(body?.dir ?? ''))
      const title = String(body?.title ?? '').trim()
      if (title === '') return sendJson(res, 400, { ok: false, error: '新名字不能为空' })
      if (!dir.startsWith(root + path.sep)) return sendJson(res, 400, { ok: false, error: '只能改归档目录里的文件夹' })
      const registry = ctx.get('workspaceRegistry')
      const entity = registry ? await registry.resolveByPath(dir).catch(() => undefined) : undefined
      if (!entity) return sendJson(res, 404, { ok: false, error: '这个文件夹还没有对应的工作区' })
      if (typeof entity.rename === 'function') await entity.rename(title)
      else if (typeof entity.setTitle === 'function') await entity.setTitle(title)
      return sendJson(res, 200, { ok: true, dir, title })
    }

    return sendJson(res, 400, { ok: false, error: `未知操作：${action}` })
  })

  route(`${API_PREFIX}/index`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const force = url.searchParams.get('refresh') === '1'
    const index = await buildIndex(force)
    sendJson(res, 200, index)
  })

  route(`${API_PREFIX}/import`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err?.message ?? err) })
    }
    const job = await startJob(body)
    sendJson(res, 200, { ok: true, jobId: job.jobId })
  })

  route(`${API_PREFIX}/progress`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const jobId = url.searchParams.get('job') ?? ''
    const job = jobs.get(jobId)
    if (job === undefined) return sendJson(res, 404, { ok: false, error: 'unknown job' })
    sendJson(res, 200, { ok: true, ...jobView(job) })
  })

  route(`${API_PREFIX}/job`, async (req, res) => {
    if (req.method !== 'DELETE') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const jobId = url.searchParams.get('job') ?? ''
    const job = jobs.get(jobId)
    if (job === undefined) return sendJson(res, 404, { ok: false, error: 'unknown job' })
    job.controller.abort()
    sendJson(res, 200, { ok: true, jobId: job.jobId, status: job.status })
  })

  route(`${API_PREFIX}/roots`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const homeDir = cache.index?.homeDir ?? (await scanAll({}, {})).homeDir
    const manualRoots = await readManualRoots(homeDir)
    const sources = ['claude', 'codex', 'workbuddy', 'cursor', 'trae'].map((id) => ({
      id,
      manualRoot: manualRoots[id] ?? null,
      candidates: candidatesOf(id),
      resolved: manualRoots[id] ?? candidatesOf(id)[0] ?? null,
    }))
    sendJson(res, 200, { ok: true, homeDir, sources })
  })

  // 目录浏览：只读、每次现算，用来替代系统「选择文件夹」对话框。
  route(`${API_PREFIX}/browse`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const target = url.searchParams.get('path') ?? ''
    const listing = await browseDir(target)
    sendJson(res, 200, { ok: true, ...listing })
  })

  // 记住某个来源的手动目录（dir 为空 = 取消手动指定，回到自动探测）。
  route(`${API_PREFIX}/root`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!isTrustedOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err?.message ?? err) })
    }
    const sourceId = typeof body?.source === 'string' ? body.source : ''
    if (sourceId === '') return sendJson(res, 400, { ok: false, error: 'source is required' })
    const dir = typeof body?.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : null
    const homeDir = cache.index?.homeDir ?? (await scanAll({}, {})).homeDir
    if (dir !== null) {
      const listing = await browseDir(dir)
      if (listing.error !== undefined) {
        return sendJson(res, 400, { ok: false, error: `目录不可读：${listing.error}` })
      }
    }
    let roots
    try {
      roots = await writeManualRoot(homeDir, sourceId, dir)
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
    }
    // 目录变了，索引必须重扫。
    cache.index = null
    cache.at = 0
    sendJson(res, 200, { ok: true, source: sourceId, dir, roots })
  })

  ctx.effect(() => () => {
    for (const dispose of routes.splice(0).reverse()) {
      try {
        dispose?.()
      } catch {
        /* 注销失败不该影响卸载 */
      }
    }
    for (const job of jobs.values()) {
      try {
        job.controller.abort()
      } catch {
        /* ignore */
      }
    }
    jobs.clear()
  }, 'ai-import-ui: http routes')
}
