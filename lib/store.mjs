/**
 * 导入台账（幂等）：`<DSH_HOME>/ai-import/imports.json`。
 * 结构：{ version: 1, entries: { [sourceKey]: { sessionId, source, sourcePath, title,
 *   createdAt, importedAt, turns, events } } }
 * sourceKey 由「来源 + 源文件绝对路径」构成，因此同一份 transcript 重跑不会重复导入。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export function ledgerPath(homeDir) {
  return path.join(homeDir, 'ai-import', 'imports.json')
}

/**
 * 读取台账（不存在/损坏都当作空台账，并保留损坏文件备份）。
 * @param {string} homeDir DSH 主目录
 * @returns {Promise<{version: number, entries: Record<string, any>}>}
 */
export async function loadLedger(homeDir) {
  const file = ledgerPath(homeDir)
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: parsed.version ?? 1, entries: parsed.entries }
    }
    return { version: 1, entries: {} }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: 1, entries: {} }
    // 损坏：另存一份，再从空台账开始（绝不覆盖用户还有用的东西）
    try {
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* 忽略 */ }
    return { version: 1, entries: {} }
  }
}

/**
 * 写入台账（原子替换）。
 * @param {string} homeDir DSH 主目录
 * @param {{version: number, entries: Record<string, any>}} ledger 台账
 */
export async function saveLedger(homeDir, ledger) {
  const file = ledgerPath(homeDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 源条目的稳定 key。 */
export function sourceKey(source, sourcePath) {
  return `${source}:${String(sourcePath).replace(/\\/g, '/').toLowerCase()}`
}
