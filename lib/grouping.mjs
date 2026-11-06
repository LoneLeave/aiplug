/**
 * 分组：**每个来源一个工作区**（Claude 一个档案、Codex 一个档案……）。
 *
 * 早前按「(来源, 项目目录)」分组，结果一次导入会造出十几个
 * `Claude · Buddy` / `Claude · Fansy` 之类的工作区，在侧栏里滚半天也看不全，
 * 用户明确要求「每个软件的对话全都在一个档案里」。
 *
 * 目录落在 `<DSH_HOME>/ai-import/<来源>/`，标题是 `<来源> 对话`。
 * 用自管目录而不是用户真实项目目录，是因为 `WorkspaceRegistry.create` 以
 * 「canonical 路径唯一」为主键——两个来源指向同一个项目目录时会互相吞并。
 *
 * 会话 header 的 cwd 另算：真实项目目录还在的话，cwd 就用真实目录（这样在
 * DSH 里恢复该会话仍在正确的工作目录），否则回退到上面那个来源目录。
 * Tauri 版 dsh-workspace 的 attachSession 是「relaxed explicit workspace
 * membership」，只校验 cwd 能 realpath 且是目录，不要求与工作区路径相同。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 分组目录根。 */
export function groupsRoot(homeDir) {
  return path.join(homeDir, 'ai-import', 'groups')
}

async function isDirectory(p) {
  if (!p) return false
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * 求一个来源条目的分组定义（纯计算，不建目录）。
 *
 * 分组键只取来源 id：同一来源的所有会话进同一个工作区。`projectPath`
 * 仍然接收但只用于决定会话 cwd，不再影响分组。
 * @param {object} input
 * @param {string} input.homeDir DSH 主目录
 * @param {string} input.source 来源 id（claude/codex/...）
 * @param {string} input.sourceLabel 来源显示名
 * @param {string|null} [input.projectPath] 源会话记录的项目目录（仅备用）
 * @param {string|null} [input.dir] 用户指定的目标文件夹（面板向导里新建/选择的归档目录）
 * @param {string|null} [input.title] 该文件夹对应的工作区标题
 * @returns {{dir: string, title: string, groupKey: string}}
 */
export function planGroup({ homeDir, source, sourceLabel, projectPath = null, dir = null, title = null }) {
  if (dir) {
    const target = path.resolve(dir)
    const label = title && String(title).trim() !== '' ? String(title).trim() : path.basename(target)
    return { dir: target, title: label, groupKey: target, projectPath, custom: true }
  }
  const fallback = path.join(groupsRoot(homeDir), source)
  return { dir: fallback, title: `${sourceLabel} 对话`, groupKey: source, projectPath, custom: false }
}

/**
 * 确保分组工作区存在并返回它（内含 mkdir + create 幂等）。
 * @param {object} input
 * @param {any} input.registry workspaceRegistry 服务
 * @param {object} input.plan planGroup 的结果
 * @param {Map<string, any>} input.cache 目录 → 工作区实体 的缓存
 * @returns {Promise<any>} 工作区实体（registry 不可用时返回 null）
 */
export async function ensureGroupWorkspace({ registry, plan, cache }) {
  if (!registry) return null
  const hit = cache.get(plan.dir)
  if (hit) return hit
  await fs.mkdir(plan.dir, { recursive: true })
  let entity
  try {
    entity = await registry.resolveByPath(plan.dir)
  } catch {
    entity = undefined
  }
  try {
    if (!entity) entity = await registry.create(plan.dir, plan.title)
    // 已有工作区时顺手把标题对齐（老版本按项目分组的标题会残留）
    else if (typeof entity?.rename === 'function' && entity.title !== plan.title) await entity.rename(plan.title)
  } catch {
    /* 标题对齐失败不影响导入 */
  }
  cache.set(plan.dir, entity)
  return entity
}

/**
 * 决定会话 header 的 cwd：真实项目目录还在就用它，否则回退到来源目录
 * （attachSession 要求 cwd 能 realpath 且是目录）。
 * @param {string|null} projectPath 源记录的项目目录
 * @param {string} groupDir 分组目录（调用前应已 mkdir）
 * @returns {Promise<string>}
 */
export async function resolveSessionCwd(projectPath, groupDir) {
  if (await isDirectory(projectPath)) {
    try {
      return await fs.realpath(projectPath)
    } catch {
      return projectPath
    }
  }
  return groupDir
}

/**
 * 旧版按「来源/项目」分组的遗留目录（`ai-import/groups/<来源>/<项目slug>`）。
 * 新版的分组目录是 `ai-import/groups/<来源>`，所以这里直接返回根目录，
 * 供清理工具判断哪些子目录该删。
 * @param {string} homeDir DSH 主目录
 * @returns {string}
 */
export function legacyGroupsRoot(homeDir) {
  return groupsRoot(homeDir)
}