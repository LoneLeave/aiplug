/**
 * 通用小工具：路径 slug、注入噪声剥离、标题取词、时间格式化。
 * 这里刻意零依赖（只用 node:path/node:fs 的类型无关字符串处理），
 * 以便被任意 source 模块复用而不引入循环依赖。
 */

/** Windows/Unix 路径 → Claude-Code 风格 slug：`D:\\code\\Buddy` → `D--code-Buddy`。 */
export function pathSlug(p) {
  return String(p ?? '')
    .replace(/[\\/:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** 压成单行、折叠空白。 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim()
}

/**
 * 剥离 harness 注入的「伪用户输入」：system-reminder 块、user_info、project_context、
 * project_layout、environment_context、AGENTS.md 说明、<INSTRUCTIONS> 等。
 * 这些块在各家 CLI 的 transcript 里都以「用户消息」形式存在，直接当标题会全是噪声。
 * @param {string} text 原始文本
 * @returns {string} 剥离后的文本
 */
export function stripInjected(text) {
  let s = String(text ?? '')
  if (!s) return ''
  // 整段式容器：只要出现就整块删掉（含嵌套）。用循环直到稳定，容忍嵌套同名标签。
  const containers = [
    'system-reminder', 'user_info', 'project_context', 'project_layout',
    'environment_context', 'user_instructions', 'INSTRUCTIONS', 'environment_details',
    'harness_context', 'context', 'available_tools', 'tools', 'reminder',
  ]
  // WorkBuddy 会把提问包在 `<user_query>` 里；这类「包装标签」只剥外壳、保留里面的
  // 文字（不能像上面那样连内容一起删）。
  s = s.replace(/<\s*user_query\s*>/gi, '').replace(/<\s*\/\s*user_query\s*>/gi, '')
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const tag of containers) {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi')
      const next = s.replace(re, '')
      if (next !== s) { s = next; changed = true }
    }
    // 自闭合/无闭合的单行标签
    const next2 = s.replace(/<[A-Za-z_][\w-]*(?:\s[^>]*)?\/>/g, '')
    if (next2 !== s) { s = next2; changed = true }
    if (!changed) break
  }
  // AGENTS.md / CLAUDE.md 之类的指令前言（Codex 会把它塞进第一条 user message）。
  // 必须先做「整段丢弃」再做「删首行」：否则删掉标题那行后，正文里的
  // `# 全局 AGENTS 指令` 会变成新的第一行，冒充成人类提问。
  s = s.replace(/^\s*#\s*(AGENTS|CLAUDE)\.md instructions[\s\S]*$/i, '')
  s = s.replace(/^\s*#\s*(AGENTS|CLAUDE)\.md instructions[^\n]*\n?/i, '')
  s = s.replace(/<[^>]*INSTRUCTIONS[^>]*>/gi, '')
  s = s.replace(/<\/?user_instructions>/gi, '')
  // Codex 的「审批评审」子会话：整条 user 消息都是 harness 生成的转写评估模板
  // （`The following is the Codex agent history … >>> TRANSCRIPT START …`），
  // 里面没有一句人话。整段丢弃，否则标题会变成 `text(r.output);` 这种代码碎片。
  s = s.replace(/^\s*The following is the Codex agent history[\s\S]*$/i, '')
  s = s.replace(/^\s*Automation(?: ID)?\s*:[\s\S]*$/i, '')
  // @skill:"名称" / @mcp:... 之类的技能/工具前缀（WorkBuddy、Codex 会把它们
  // 放在提问第一行）。剥掉前缀行，否则标题会变成 `[WorkBuddy] @skill:"腾讯新闻"`。
  s = s.replace(/^\s*(?:@[A-Za-z][\w.-]*\s*[:：]\s*(?:"[^"]*"|'[^']*'|[^\n]*)\n?)+/i, '')
  return s.trim()
}

/**
 * 明显不像「会话标题」的行：注入前言、技能前缀、harness 自生成的评审/审阅模板、
 * 纯 XML 标签行。
 */
const NOISE_LINE = /^(?:@[A-Za-z][\w.-]*\s*[:：]|(?:AGENTS|CLAUDE)\.md instructions\b|<\/?[A-Za-z]|RETAINED USER INSTRUCTIONS|USER INSTRUCTIONS|USER CONTEXT|The following is the Codex agent history|>>>\s*TRANSCRIPT (?:START|END)|TRANSCRIPT (?:START|END)|Host notice:|Host: Retained source order|Retained source order:|You are an? (?:AI|assistant|reviewer|guardian)\b|请?根据以下(?:对话|记录)|<<|\[?(?:System|SYSTEM)\]?\s*[:：]|(?:assistant|user|system|tool|developer|human)\s*[:：]|(?:tool|exec)\s+\w+\s+call\s*:|Files mentioned by the user\s*:|description\s*:|Automation:)/i

/**
 * 判断一行是否是注入噪声（不该拿来当标题）。
 * @param {string} line 单行文本
 * @returns {boolean}
 */
export function isNoiseLine(line) {
  const s = oneLine(line)
  if (!s) return true
  // `[3] user: …` 这类编号行去掉编号后再判断，否则永远不命中。
  return NOISE_LINE.test(s.replace(/^\[\d+\]\s*/, ''))
}

/** 句末标点（用于把长首问截成「第一句」）。英文句点要求后跟空白，避免切断小数/域名。 */
const SENTENCE_END = /[。！？；!?;]|\.(?=\s|$)/

/**
 * 把一行压成「一句话标题」：优先取第一个句末标点之前的部分，
 * 太短的句子（< 8 字符，多半是「OK」这种）保持整行。
 */
export function headline(line, max = 60) {
  const window = line.slice(0, max + 1)
  const m = SENTENCE_END.exec(window)
  if (m && m.index >= 8) return window.slice(0, m.index + 1).trim()
  if (line.length > max) return line.slice(0, max).replace(/[\s,，.。:：;；、]+$/, '') + '…'
  return line
}

/**
 * 取「第一行有意义的话」当标题核心：跳过空行、markdown 标题符号与注入噪声行，
 * 截断到 max 字符。
 * @param {string} text 原始文本
 * @param {number} max 最大字符数
 * @returns {string}
 */
export function firstLine(text, max = 60) {
  const cleaned = stripInjected(text)
  if (!cleaned) return ''
  for (const raw of cleaned.split('\n')) {
    // Codex 的「历史评审」转写会把每行编号成 `[1] user: …`，编号不是内容。
    let line = oneLine(raw).replace(/^\[\d+\]\s*/, '').replace(/^[#>*\-\s]+/, '').trim()
    if (!line || isNoiseLine(line)) continue
    if (line.length > max) line = line.slice(0, max).replace(/[\s,，.。:：;；]+$/, '') + '…'
    return line
  }
  return ''
}

/** 本地时区 `YYYY-MM-DD HH:mm`。 */
export function fmtDateTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (x, w = 2) => String(x).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 本地时区 `YYYY-MM-DD`。 */
export function fmtDate(ms) {
  return fmtDateTime(ms).slice(0, 10)
}

/** 粗略材料大小（人读）。 */
export function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`
  return `${(v / 1073741824).toFixed(2)} GB`
}

/** 会话 id 安全化：只保留 [A-Za-z0-9_-]，超长截断。 */
export function safeIdPart(s, max = 64) {
  return String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, max)
}

/** 依据文件名/目录名猜一个可读项目名。 */
export function projectLabelOf(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '')
  if (!s) return ''
  const seg = s.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return seg
}
