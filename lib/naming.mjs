/**
 * 会话命名：这是 dsh-claude-move 做得最差的地方（它把标题全留成
 * `import-<uuid>`），本插件的命名优先级：
 *
 *  1. 源自带的真实标题（Claude 的 custom-title / ai-title、Codex 的
 *     session_index.thread_name、Cursor 的 composer name、WorkBuddy 的 meta）；
 *  2. 首条「人类提问」的第一行（已剥离 system-reminder / AGENTS.md 之类的注入噪声）；
 *  3. `<来源> <日期 时间>`；
 *  4. `<来源> 会话 <序号>`。
 *
 * 最后统一加 `[来源] ` 前缀（可按配置关掉），并在同一分组内做去重后缀，
 * 避免出现一堆同名会话。
 */
import { fmtDateTime, headline, isNoiseLine, oneLine, stripInjected } from './util.mjs'

const MAX_TITLE = 80
/** 从首条提问提炼时收得更紧：列表里一行放得下比「完整复述第一句」更有用。 */
const MAX_HEADLINE = 56

/**
 * 从首条提问里提炼标题：逐行找第一条「不是注入噪声」的实质内容，
 * 再压成一句话（取第一个句末标点之前的部分）。
 *
 * 直接照搬首行会出现两种坏标题：
 *  - `[WorkBuddy] @skill:"腾讯新闻"`（技能前缀）；
 *  - `[Claude] 先核实当前实验状态，再写交接。后台还有 2 个进程在跑…`（整段正文）。
 * @param {string} prompt 原始首条提问
 * @param {number} max 最大字符数
 * @returns {string}
 */
function headlineFromPrompt(prompt, max) {
  const cleaned = stripInjected(prompt ?? '')
  if (!cleaned) return ''
  for (const raw of cleaned.split('\n')) {
    const line = oneLine(raw).replace(/^[#>*\-\s]+/, '').trim()
    if (!line || isNoiseLine(line)) continue
    return headline(line, max)
  }
  return ''
}

/**
 * 组装单个会话标题。
 * @param {object} input
 * @param {string} input.sourceLabel 来源显示名，如 `Claude`
 * @param {string|null} [input.explicitTitle] 源自带标题
 * @param {string|null} [input.prompt] 首条人类提问
 * @param {number|null} [input.createdAt] 会话创建时间（ms）
 * @param {number} [input.index] 同批次序号（兜底用）
 * @param {boolean} [input.prefixSource] 是否加来源前缀
 * @returns {string}
 */
export function buildTitle({ sourceLabel, explicitTitle, prompt, createdAt, index = 0, prefixSource = true }) {
  let core = oneLine(explicitTitle ?? '')
  if (!core) core = headlineFromPrompt(prompt ?? '', MAX_HEADLINE)
  if (!core) {
    const when = fmtDateTime(createdAt)
    core = when || `会话 ${index + 1}`
  }
  let title = prefixSource ? `[${sourceLabel}] ${core}` : core
  if (title.length > MAX_TITLE + 12) title = title.slice(0, MAX_TITLE + 11) + '…'
  return title
}

/**
 * 分组内去重：同名标题追加序号后缀（` · #2`、` · #3`…）。
 * 早前用「 · 时间」在时间相同的情况下会生成 `X · 12:37 · 12:37` 这种重复文案。
 */
export function makeTitleDeduper() {
  const used = new Map()
  return {
    /**
     * @param {string} title 候选标题
     * @param {number|null} _createdAt 创建时间（保留参数位，当前未使用）
     * @returns {string} 去重后的标题
     */
    take(title, _createdAt) {
      const n = used.get(title) ?? 0
      used.set(title, n + 1)
      return n === 0 ? title : `${title} · #${n + 1}`
    },
  }
}
