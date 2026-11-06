/**
 * 各来源数据目录的「跨机兜底」解析。
 *
 * 早前每个来源都硬编码了一套 Windows 路径（`~/.claude`、`%APPDATA%/Cursor/...`），
 * 换一台电脑（macOS / Linux / 用户把配置放在别处）就完全扫不到东西，
 * 而且面板上也说不清「到底在找哪个目录」。
 *
 * 这里统一解决三件事：
 *  1. 候选路径按平台给出（Windows / macOS / Linux），逐个探测，取第一个真实存在的；
 *  2. 用户在面板里手动选过的目录（存在 `<DSH_HOME>/ai-import/roots.json`）优先级最高；
 *  3. `detectSource()` 能认出一个目录属于哪个来源，供「手动选择目录」时自动判定。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 取环境变量；`HOME` / `USERPROFILE` 缺失时回退到 `os.homedir()`，这样 Windows 上输入 `$HOME/x` 也能用。 */
function envValue(name) {
  const direct = process.env[name]
  if (direct) return direct
  if (name === 'HOME' || name === 'USERPROFILE') return os.homedir()
  if (name === 'XDG_CONFIG_HOME') return path.join(os.homedir(), '.config')
  return undefined
}

/** `~/x`、`%APPDATA%`、`$HOME`、`${XDG_CONFIG_HOME}` 展开成绝对路径。 */
export function expandHome(input) {
  let s = String(input ?? '').trim()
  if (!s) return ''
  if (s === '~') s = os.homedir()
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2))
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => envValue(name) ?? m)
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => envValue(name) ?? m)
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => envValue(name) ?? m)
  return s
}

function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

/**
 * 某个来源的候选根目录（按优先级）。
 * @param {string} id 来源 id
 * @returns {string[]} 绝对路径数组（可能为空）
 */
export function candidates(id) {
  const home = os.homedir()
  switch (id) {
    case 'claude':
      return [
        path.join(home, '.claude'),
        path.join(home, '.config', 'claude'),
        path.join(home, 'Library', 'Application Support', 'Claude'),
      ]
    case 'codex':
      return [
        path.join(home, '.codex'),
        path.join(home, '.config', 'codex'),
        path.join(home, 'Library', 'Application Support', 'Codex'),
      ]
    case 'workbuddy':
      return [
        path.join(home, '.workbuddy'),
        path.join(home, '.config', 'workbuddy'),
        path.join(home, 'Library', 'Application Support', 'WorkBuddy'),
        path.join(appDataDir(), 'WorkBuddy'),
      ]
    case 'cursor':
      return [
        path.join(appDataDir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.cursor', 'User', 'globalStorage', 'state.vscdb'),
      ]
    case 'trae':
      return [
        path.join(appDataDir(), 'Trae', 'User', 'workspaceStorage'),
        path.join(appDataDir(), 'Trae CN', 'User', 'workspaceStorage'),
        path.join(home, '.config', 'Trae', 'User', 'workspaceStorage'),
        path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'workspaceStorage'),
      ]
    default:
      return []
  }
}

/** 环境变量里用户自己指过的目录（与各家 CLI 一致）。 */
function envOverride(id) {
  if (id === 'claude') return expandHome(process.env.CLAUDE_CONFIG_DIR)
  if (id === 'codex') return expandHome(process.env.CODEX_HOME)
  if (id === 'workbuddy') return expandHome(process.env.WORKBUDDY_HOME)
  if (id === 'cursor') return expandHome(process.env.CURSOR_DB)
  return ''
}

/** 台账文件：用户手动选过的目录。 */
export function rootsFile(homeDir) {
  return path.join(homeDir, 'ai-import', 'roots.json')
}

/**
 * 读手动选目录台账。
 * @param {string} homeDir DSH 主目录
 * @returns {Promise<Record<string, string>>} 来源 id → 目录
 */
export async function readManualRoots(homeDir) {
  if (!homeDir) return {}
  try {
    const raw = await fsp.readFile(rootsFile(homeDir), 'utf8')
    const parsed = JSON.parse(raw)
    const out = {}
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写手动选目录台账（值为空则删除该项）。
 * @param {string} homeDir DSH 主目录
 * @param {string} id 来源 id
 * @param {string|null} dir 目录（null/空 = 取消手动指定，回到自动探测）
 */
export async function writeManualRoot(homeDir, id, dir) {
  const all = await readManualRoots(homeDir)
  const clean = typeof dir === 'string' ? expandHome(dir) : ''
  if (clean) all[id] = clean
  else delete all[id]
  const file = rootsFile(homeDir)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
  return all
}

async function exists(p) {
  if (!p) return false
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

function existsSync(p) {
  if (!p) return false
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * 同步版候选探测（各家 `discover()` 里的 `home()` 是同步函数，只能走这条）。
 * @param {string} id 来源 id
 * @returns {string} 第一个真实存在的候选，都不存在则返回第一个候选（或空串）
 */
export function firstExistingCandidate(id) {
  const list = candidates(id)
  for (const candidate of list) if (existsSync(candidate)) return candidate
  return list[0] ?? ''
}

/**
 * 取「手动选过的目录」（来自 `roots.json`，由 `scanAll`/`runImport` 提前读好塞进 config）。
 * @param {object} config 插件配置
 * @param {string} id 来源 id
 * @returns {string}
 */
export function manualRootOf(config, id) {
  const roots = config?.manualRoots
  const value = roots && typeof roots === 'object' ? roots[id] : ''
  return typeof value === 'string' ? expandHome(value) : ''
}

/**
 * 汇总一个已解析目录的来源信息，附带候选清单，供面板显示「在找哪些目录」。
 * @param {string} id 来源 id
 * @param {string} root 当前实际使用的根目录
 * @param {string} from 来源（manual|config|env|default|missing）
 */
export function rootInfo(id, root, from) {
  return { root, from, candidates: candidates(id) }
}

/**
 * 解析某个来源实际要读的根目录。
 *
 * 优先级：手动选择 > 插件配置 > 环境变量 > 平台默认候选（取第一个存在的）>
 * 平台默认候选的第一个（不存在也返回，好让面板把「我在找哪儿」说清楚）。
 * @param {string} id 来源 id
 * @param {object} config 插件配置（可含 `<id>Home` / `cursorDb` / `traeHome` / `homeDir`）
 * @returns {Promise<{root: string, from: string}>} from = manual|config|env|default|missing
 */
export async function resolveRoot(id, config = {}) {
  const configKey = { claude: 'claudeHome', codex: 'codexHome', workbuddy: 'workbuddyHome', cursor: 'cursorDb', trae: 'traeHome' }[id]
  const explicit = configKey ? expandHome(config[configKey]) : ''
  if (explicit) return { root: explicit, from: 'config' }

  const env = envOverride(id)
  if (env) return { root: env, from: 'env' }

  const manual = await readManualRoots(config.homeDir)
  if (manual[id]) return { root: manual[id], from: 'manual' }

  const list = candidates(id)
  for (const candidate of list) {
    if (await exists(candidate)) return { root: candidate, from: 'default' }
  }
  return { root: list[0] ?? '', from: 'missing' }
}

/**
 * 认出一个目录属于哪个来源（供「手动选择目录」时自动判定）。
 * @param {string} dir 用户选中的目录
 * @returns {Promise<{source: string|null, hint: string}>}
 */
export async function detectSource(dir) {
  const p = expandHome(dir)
  if (!p) return { source: null, hint: '' }
  const base = path.basename(p).toLowerCase()

  // Cursor / Trae：直接指向 state.vscdb，或指向含 state.vscdb 的目录
  if (/(^|\/)state\.vscdb$/i.test(p) || /\.vscdb$/i.test(base)) {
    const parent = path.basename(path.dirname(path.dirname(p))).toLowerCase()
    if (parent.includes('trae')) return { source: 'trae', hint: 'Trae 工作区库' }
    if (parent.includes('cursor') || base === 'state.vscdb') return { source: 'cursor', hint: 'Cursor 数据库' }
    return { source: 'cursor', hint: 'vscdb 数据库（按 Cursor 处理）' }
  }
  if (await exists(path.join(p, 'state.vscdb'))) {
    return { source: 'cursor', hint: '含 state.vscdb 的目录（Cursor 全局库）' }
  }

  // Codex：session_index.jsonl，或 sessions/ 与 archived_sessions/ 同时存在。
  // 注意顺序：Claude 自己的根目录下也有 sessions/，所以「只有 sessions/」不足以判成 Codex，
  // 必须先看 projects/（见下），最后才把裸 sessions/ 当弱线索。
  if (await exists(path.join(p, 'session_index.jsonl'))) {
    return { source: 'codex', hint: 'Codex 数据根（含 session_index.jsonl）' }
  }
  const hasSessions = await exists(path.join(p, 'sessions'))
  const hasArchived = await exists(path.join(p, 'archived_sessions'))
  if (hasSessions && hasArchived) return { source: 'codex', hint: 'Codex 数据根（sessions/ + archived_sessions/）' }

  // VS Code 系（Cursor / Trae）的自家目录：`~/.cursor` 下也有 projects/，但它不是
  // Claude 的 transcript，本插件对这两个来源只认 state.vscdb，所以先在这里拦下来。
  if (/^(?:\.?cursor|\.?trae)/i.test(base)) {
    const family = /trae/i.test(base) ? 'trae' : 'cursor'
    const label = family === 'trae' ? 'Trae' : 'Cursor'
    const dbProbe = [
      path.join(p, 'User', 'globalStorage', 'state.vscdb'),
      path.join(p, 'globalStorage', 'state.vscdb'),
      path.join(p, 'state.vscdb'),
    ]
    for (const candidate of dbProbe) {
      if (await exists(candidate)) return { source: family, hint: `${label} 数据库（${candidate}）` }
    }
    return { source: family, hint: `${label} 目录，但没找到 state.vscdb（可以再往下选到 User/globalStorage）` }
  }

  // Claude / WorkBuddy：projects/<slug>/*.jsonl，靠同名 .meta.json 区分 WorkBuddy
  const projects = path.join(p, 'projects')
  if (await exists(projects)) {
    let dirs = []
    try { dirs = await fsp.readdir(projects, { withFileTypes: true }) } catch { dirs = [] }
    for (const d of dirs.slice(0, 40)) {
      if (!d.isDirectory()) continue
      let files = []
      try { files = await fsp.readdir(path.join(projects, d.name)) } catch { continue }
      if (files.some((f) => f.endsWith('.meta.json'))) return { source: 'workbuddy', hint: 'WorkBuddy 数据根（projects/*.meta.json）' }
      if (files.some((f) => f.endsWith('.jsonl'))) {
        // Claude transcript 每条消息带 `parentUuid`/`sessionId` 字段
        try {
          const sample = files.find((f) => f.endsWith('.jsonl'))
          const head = await fsp.readFile(path.join(projects, d.name, sample), 'utf8')
          if (head.includes('"parentUuid"') || head.includes('"sessionId"')) {
            return { source: 'claude', hint: 'Claude 数据根（projects/*.jsonl）' }
          }
        } catch { /* 读不到就继续猜 */ }
        return { source: 'workbuddy', hint: '含 projects/*.jsonl 的目录（按 WorkBuddy 处理）' }
      }
    }
    return { source: 'claude', hint: '含 projects/ 的目录（按 Claude 处理）' }
  }

  // 直接指向 projects 目录本身（下面通常是按项目 slug 分层的子目录）
  if (base === 'projects') {
    let files = []
    try { files = await fsp.readdir(p) } catch { files = [] }
    if (files.some((f) => f.endsWith('.jsonl'))) return { source: 'claude', hint: 'projects/ 目录' }
    for (const name of files.slice(0, 40)) {
      let inner = []
      try { inner = await fsp.readdir(path.join(p, name)) } catch { continue }
      if (inner.some((f) => f.endsWith('.meta.json'))) return { source: 'workbuddy', hint: 'projects/ 目录（含 *.meta.json）' }
      if (inner.some((f) => f.endsWith('.jsonl'))) return { source: 'claude', hint: 'projects/ 目录（含 *.jsonl）' }
    }
  }

  // 弱线索：只有 sessions/ 但什么都没有（Claude 的根目录也有 sessions/，
  // 这时 projects/ 分支已经先命中，走到这里的多半是 Codex 的残缺根）。
  if (hasSessions) return { source: 'codex', hint: '含 sessions/ 的目录（按 Codex 处理）' }

  return { source: null, hint: '' }
}

/**
 * 列一个目录的子目录，供面板「选择目录」用。
 * @param {string} dir 目标目录（空 = 用户主目录）
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{path: string, parent: string|null, dirs: Array<{name: string, path: string, source: string|null, hint: string}>, detected: object, error?: string}>}
 */
export async function browse(dir, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 200
  const target = expandHome(dir) || os.homedir()
  let entries
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch (err) {
    return { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), dirs: [], detected: { source: null, hint: '' }, error: String(err?.message ?? err) }
  }
  const dirs = []
  // 注意：`~/.claude`、`~/.codex`、`~/.workbuddy` 这些恰好是点开头的隐藏目录，
  // 所以这里**不能**过滤点开头目录，否则用户在面板里根本选不中来源根。
  const SKIP = new Set(['node_modules', '.git', '.cache', '__pycache__', 'System Volume Information', '$Recycle.Bin'])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (SKIP.has(e.name)) continue
    dirs.push({ name: e.name, path: path.join(target, e.name) })
    if (dirs.length >= limit) break
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  // 只对「名字看起来像某个来源」的子目录做真探测：满目录逐个探测太慢，
  // 而其余目录用户点进去时 detectSource 会再说一次。
  const SUSPECT = /^(?:\.?(?:claude|codex|workbuddy|cursor|trae|vscode)|AppData|Library|\.config|projects|sessions)$/i
  for (const dir of dirs) {
    if (!SUSPECT.test(dir.name)) continue
    try {
      const found = await detectSource(dir.path)
      dir.source = found.source
      dir.hint = found.hint
    } catch {
      dir.source = null
      dir.hint = ''
    }
  }
  const detected = await detectSource(target)
  return {
    path: target,
    parent: path.dirname(target) === target ? null : path.dirname(target),
    dirs,
    detected,
  }
}