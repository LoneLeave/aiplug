/**
 * Claude Code 来源：`~/.claude/projects/<项目slug>/<sessionId>.jsonl`。
 * 转换复用 vendor/convert.mjs（与 dsh-claude-move 同一套状态机），因此事件纪律
 * 天然与宿主一致；本模块只负责「发现 + 大文件流式 + 标题/cwd/时间提取」。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClaudeStreamConverter, convertClaudeJsonl } from '../vendor/convert.mjs'
import { expandHome, firstExistingCandidate, manualRootOf } from '../roots.mjs'
import { firstLine, pathSlug } from '../util.mjs'

export const id = 'claude'
export const label = 'Claude'

/** Claude 数据根目录。 */
export function home(config = {}) {
  const explicit = expandHome(config.claudeHome)
  if (explicit) return explicit
  // 面板里手动选过的目录优先于环境变量与平台默认（换机器 / 配置放在非默认位置时用得上）。
  const manual = manualRootOf(config, 'claude')
  if (manual) return manual
  const env = process.env.CLAUDE_CONFIG_DIR
  if (typeof env === 'string' && env.trim()) return env.trim()
  return firstExistingCandidate('claude')
}

/**
 * 发现全部 transcript。
 * @param {object} config 插件配置
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{root: string, entries: object[], errors: string[]}>}
 */
export async function discover(config = {}, opts = {}) {
  const root = path.join(home(config), 'projects')
  const entries = []
  const errors = []
  let projectDirs = []
  try {
    projectDirs = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    errors.push(`读取 ${root} 失败：${String(err?.message ?? err)}`)
    return { root, entries, errors }
  }
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue
    const dirPath = path.join(root, pd.name)
    let files = []
    try {
      files = await fsp.readdir(dirPath, { withFileTypes: true })
    } catch (err) {
      errors.push(`读取 ${dirPath} 失败：${String(err?.message ?? err)}`)
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      if (opts.signal?.aborted) return { root, entries, errors }
      const full = path.join(dirPath, f.name)
      let st
      try {
        st = await fsp.stat(full)
      } catch (err) {
        errors.push(`stat ${full} 失败：${String(err?.message ?? err)}`)
        continue
      }
      entries.push({
        source: id,
        path: full,
        projectSlug: pd.name,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        // 目录名是 cwd 的 slug，仅作兜底（真实 cwd 从 transcript 里读）
        guessedCwd: null,
      })
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { root, entries, errors }
}

/** 读文件前缀，猜第一条人类提问（大文件流式路径下用于命名）。 */
async function peekPrompt(file, bytes = 262144) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    // 最后一行可能被截断，丢掉
    lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec?.type !== 'user') continue
      const content = rec?.message?.content
      let text2 = ''
      if (typeof content === 'string') text2 = content
      else if (Array.isArray(content)) {
        text2 = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      }
      const cand = firstLine(text2)
      if (cand) return cand
    }
    return ''
  } catch {
    return ''
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/**
 * 把一份 transcript 转成 DSH 事件。
 * 超过 streamThresholdBytes 的文件走流式（readFileSync 在 ~512MB 会直接
 * 抛 ERR_STRING_TOO_LONG，本机确实存在 600MB+ 的 transcript）。
 * @param {object} entry discover 的条目
 * @param {object} config 插件配置
 * @returns {Promise<object>} 转换结果 + 命名素材
 */
export async function convert(entry, config = {}) {
  const streamThreshold = Number(config.streamThresholdBytes ?? 200 * 1024 * 1024)
  const useStream = entry.sizeBytes > streamThreshold
  if (!useStream) {
    const raw = await fsp.readFile(entry.path, 'utf8')
    const converted = convertClaudeJsonl(raw, {})
    return {
      meta: converted.meta,
      events: converted.events,
      title: converted.title,
      prompt: converted.turns?.[0]?.prompt ?? '',
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
  // 流式：分块喂给同一个状态机，keepTurns=false 避免再存一份完整回合结构
  const batches = []
  const converter = createClaudeStreamConverter({
    keepTurns: false,
    onBatch: (events) => { batches.push(events) },
  })
  const prompt = await peekPrompt(entry.path)
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(entry.path, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 })
    rs.on('data', (chunk) => {
      try {
        converter.feed(chunk)
      } catch (err) {
        rs.destroy(err)
      }
    })
    rs.on('error', reject)
    rs.on('end', resolve)
  })
  const result = converter.end()
  return {
    meta: result.meta,
    events: batches.flat(),
    title: result.title,
    prompt,
    cwd: result.meta?.cwd ?? null,
    createdAt: result.meta?.createdAt ?? Math.round(entry.mtimeMs),
    turns: Number(result.turns) || 0,
    records: result.records ?? 0,
    toolCalls: result.toolCalls ?? 0,
    skipped: result.skipped ?? 0,
    skippedLines: result.skippedLines ?? [],
    typeCounts: result.typeCounts ?? {},
    repaired: result.repaired,
    streaming: true,
  }
}

/** 会话稳定标识（用于生成 DSH 会话 id）。 */
export function sourceIdOf(entry) {
  const base = path.basename(entry.path).replace(/\.jsonl$/i, '')
  return base || pathSlug(entry.path)
}
