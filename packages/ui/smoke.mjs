/**
 * 渲染冒烟测试：不依赖浏览器，也不依赖 react-dom。
 * 用替身 React 把 client.js 里的组件函数真跑一遍（含「数据已加载 + 有任务结果」分支），
 * 检查是否抛错、是否出现 undefined/NaN 之类的坏值。
 *
 * 运行：node smoke.mjs
 */
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ----------------------------------------------------------- 替身 React */

function createElement(type, props, ...children) {
  const flat = []
  const push = (child) => {
    if (child === null || child === undefined || child === false) return
    if (Array.isArray(child)) {
      for (const item of child) push(item)
      return
    }
    flat.push(child)
  }
  for (const child of children) push(child)
  return { type, props: props ?? {}, children: flat }
}

// 状态队列是「每次渲染各取一份」的：替身不展开子组件，所以单独渲染向导前要先换一批值。
let currentQueue = []
function setQueue(queue) {
  currentQueue = Array.isArray(queue) ? queue.slice() : []
}

function makeReact() {
  const React = {
    createElement,
    useState(initial) {
      const value = currentQueue.length > 0 ? currentQueue.shift() : initial
      return [value, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useEffect() {},
  }
  return React
}

/* ------------------------------------------------------------- 假数据 */

const INDEX = {
  ok: true,
  scannedAt: new Date().toISOString(),
  homeDir: 'C:\\Users\\123\\.dsh',
  totals: { found: 310, fresh: 67, changed: 3, known: 92, filtered: 151, importable: 70 },
  sources: [
    {
      id: 'claude',
      label: 'Claude Code',
      root: 'C:\\Users\\123\\.claude\\projects',
      found: 220,
      fresh: 60,
      changed: 2,
      known: 40,
      filtered: 118,
      importable: 62,
      errors: [],
      entries: [
        { kind: 'new', key: 'a', label: 'Fix parser bug', path: 'C:\\x\\a.jsonl', projectPath: 'E:\\Reverse', turns: 12 },
        { kind: 'changed', key: 'b', label: '设计评审记录', path: 'C:\\x\\b.jsonl', projectPath: null, turns: 3 },
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      root: 'C:\\Users\\123\\.codex\\sessions',
      found: 90,
      fresh: 7,
      changed: 1,
      known: 52,
      filtered: 30,
      importable: 8,
      errors: ['某个文件读不出来'],
      entries: [],
    },
  ],
}

const JOB = {
  jobId: 'job-1',
  status: 'running',
  dryRun: false,
  force: false,
  total: 2,
  done: 1,
  current: 'codex',
  currentProcessed: 3,
  currentTotal: 8,
  activity: '✓ [Codex] Article Write',
  created: 5,
  appended: 1,
  skipped: 2,
  failed: 1,
  rows: [
    {
      source: 'claude',
      status: 'created',
      sessionId: 'import-claude-abc',
      title: '[Claude] Fix parser bug',
      group: 'Claude · E:\\Reverse',
      turns: 12,
      events: 480,
      error: null,
      reason: null,
    },
    {
      source: 'claude',
      status: 'failed',
      sessionId: null,
      title: null,
      label: 'C:\\x\\bad.jsonl',
      group: null,
      turns: null,
      events: null,
      error: 'invalid jsonl at line 3',
      reason: null,
    },
  ],
  error: null,
  startedAt: Date.now(),
}

/* --------------------------------------------------------------- 装载 */

let loaded = null
const windowShim = {
  __ModuleLoader__: {
    load(module) {
      loaded = module
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

function instantiate(queue) {
  const React = makeReact()
  setQueue(queue)
  const require = (spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require: ${spec}`)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'fetch', SRC)
  run(windowShim, { language: 'zh-CN' }, async () => {
    throw new Error('fetch 不该在渲染阶段被调用')
  })
  if (loaded === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  if (loaded.id !== 'dsh-ai-import-ui') throw new Error(`bundle id 不对: ${loaded.id}`)
  return loaded.factory(require)
}

function fakeCtx(registrations, overrides = {}) {
  return {
    get: (name) => (name in overrides ? overrides[name] : undefined),
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    slots: {
      inject(_slot, register) {
        register()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
}

/**
 * 模仿宿主 @deepseek-ai/dsh-client-locale 的 locale 服务：
 * `bind(ns)` 返回的 (key, params) 里，params 是「具名参数对象」，`{0}` 这种位置占位
 * 只有在 `name in params` 成立时才替换；params 为假值（0、''）时直接原样返回模板。
 * 用它盯住「导入勾选的 {0} 条」这个曾经的真实 bug。
 */
function hostLocaleShim() {
  const dicts = new Map()
  return {
    register(ns, code, entries) {
      dicts.set(`${ns}:${code}`, entries)
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const entries = dicts.get(`${ns}:zh`) ?? {}
        const template = entries[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

/* ------------------------------------------------------------- 校验器 */

function walk(node, path, problems, stats) {
  if (node === null || node === undefined) return
  if (typeof node === 'string') {
    stats.strings += 1
    if (node.includes('undefined') || node.includes('NaN') || node.includes('[object Object]')) {
      problems.push(`${path}: 文本含坏值 ${JSON.stringify(node)}`)
    }
    return
  }
  if (typeof node === 'number') {
    if (Number.isNaN(node)) problems.push(`${path}: NaN`)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, problems, stats))
    return
  }
  if (typeof node !== 'object') return
  stats.elements += 1
  const props = node.props ?? {}
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue
    if (typeof value === 'string' && (value.includes('undefined') || value.includes('NaN'))) {
      problems.push(`${path}.${key}: 属性含坏值 ${JSON.stringify(value)}`)
    }
    if (typeof value === 'number' && Number.isNaN(value)) problems.push(`${path}.${key}: NaN`)
  }
  const className = props.className
  if (typeof className === 'string' && /(^|\s)(undefined|NaN)(\s|$)/.test(className)) {
    problems.push(`${path}: className 含坏值 ${JSON.stringify(className)}`)
  }
  node.children.forEach((child, index) => walk(child, `${path}/${typeof node.type === 'string' ? node.type : 'Comp'}[${index}]`, problems, stats))
}

/* --------------------------------------------------------------- 用例 */

// 替身 React 不展开子组件，所以要自己把向导组件从树里找出来再单独渲染一次。
function findComponent(node, name, path = 'root') {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const hit = findComponent(node[index], name, `${path}[${index}]`)
      if (hit) return hit
    }
    return null
  }
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findComponent(node.children ?? [], name, path)
}

function runCase(name, componentFactory, queue, expectFragments, forbidFragments = []) {
  const problems = []
  const stats = { elements: 0, strings: 0 }
  let tree
  // 队列为空表示「沿用 instantiate 时准备好的那份状态」；非空则覆盖（单独渲染子组件时用）。
  if (Array.isArray(queue) && queue.length > 0) setQueue(queue)
  try {
    tree = componentFactory()
  } catch (err) {
    console.log(`✗ ${name}: 渲染抛错 —— ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`)
    return false
  }
  walk(tree, name, problems, stats)
  const markup = JSON.stringify(tree)
  for (const fragment of expectFragments) {
    if (!markup.includes(fragment)) problems.push(`缺少预期片段: ${fragment}`)
  }
  for (const fragment of forbidFragments) {
    if (markup.includes(fragment)) problems.push(`不该出现的片段: ${fragment}`)
  }
  if (problems.length > 0) {
    console.log(`✗ ${name}: ${problems.length} 个问题`)
    for (const problem of problems.slice(0, 10)) console.log(`    ${problem}`)
    return false
  }
  console.log(`✓ ${name}: ${stats.elements} 个元素 / ${stats.strings} 段文本`)
  return true
}

let ok = true

// 1) 设置页：已扫描、无任务
{
  const registrations = []
  const module = instantiate([INDEX, false, '', null, false, false, '', null, null, ''])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  ok = runCase('设置页/已加载数据', () => section.Component({}), [], ['Claude Code', '来源', '导入选项']) && ok
}

// 2) 设置页：首屏（还没拉到数据）
{
  const registrations = []
  const module = instantiate([null, true, '', null, false, false, '', null, null, ''])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  ok = runCase('设置页/加载中', () => section.Component({}), [], ['扫描中', '来源']) && ok
}

// 3) 设置页：接口 404（宿主没注册路由）
{
  const registrations = []
  const module = instantiate([null, false, '出错：界面接口未就绪', null, false, false, '', null, null, ''])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  ok = runCase('设置页/接口未就绪', () => section.Component({}), [], ['界面接口未就绪']) && ok
}

// 4) 设置页：跑着任务 + 有结果行 + 明细展开
{
  const registrations = []
  const module = instantiate([INDEX, false, '', null, false, false, '', JOB, 'claude', '会话列表已刷新'])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  ok = runCase('设置页/导入中', () => section.Component({}), [], ['进度', 'import-claude-abc', 'Article Write', '62']) && ok
}

// 7) 向导：三栏都渲染出来（左=文件夹、中=待导入对话、右=预览占位）
{
  const registrations = []
  // createPage 的 state 顺序：data/loading/error/selected/dryRun/force/limit/job/openSource/note/picker/mode
  const module = instantiate([INDEX, false, '', null, false, false, '', null, null, '', null, 'wizard'])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  const tree = section.Component({})
  const wizard = findComponent(tree, 'AiImportWizard')
  const folders = [{ name: '论文归档', dir: 'C:\\g\\论文', sessions: 0, exists: true }]
  ok =
    (wizard !== null ||
      (() => {
        console.log('✗ 向导：树里找不到 AiImportWizard（mode 没生效？）')
        return false
      })()) &&
    runCase('向导/三栏', () => wizard.type({ data: INDEX, busy: false, startPicks() {} }), [folders, '', false, '', new Set(), {}, null, null, '', ''], [
      'aii-wiz',
      '论文归档',
      'aii-folder',
      'Fix parser bug',
    ]) &&
    ok
}

// 8) 向导：勾选两条并归入某个文件夹（中栏出现目标标签、底部按钮带数量）
{
  const registrations = []
  const module = instantiate([INDEX, false, '', null, false, false, '', null, null, '', null, 'wizard'])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  const wizard = findComponent(section.Component({}), 'AiImportWizard')
  const folders = [{ name: '论文归档', dir: 'C:\\g\\论文', sessions: 0, exists: true }]
  const targets = { a: { dir: 'C:\\g\\论文', title: '论文归档' }, b: { dir: 'C:\\g\\论文', title: '论文归档' } }
  ok =
    wizard !== null &&
    runCase(
      '向导/已勾选归入',
      () => wizard.type({ data: INDEX, busy: false, startPicks() {} }),
      [folders, '', false, '', new Set(['a', 'b']), targets, null, null, '', ''],
      ['aii-chat-tag', '论文归档', '导入勾选的 2 条'],
    ) &&
    ok
}

// 5) 悬浮层：只显示按钮
{
  const registrations = []
  const module = instantiate([false, false])
  module.apply(fakeCtx(registrations))
  const overlay = registrations.find((item) => item.options.name === 'shell.overlay')
  ok = runCase('悬浮层/按钮', () => overlay.Component({}), [], ['aii-fab', 'AI 导入']) && ok
}

// 6) 悬浮层：抽屉打开（内部再渲染一次页面）
{
  const registrations = []
  const module = instantiate([true, true, INDEX, false, '', null, false, false, '', null, null, ''])
  module.apply(fakeCtx(registrations))
  const overlay = registrations.find((item) => item.options.name === 'shell.overlay')
  ok = runCase('悬浮层/抽屉打开', () => overlay.Component({}), [], ['aii-drawer', '关闭']) && ok
}

// 9) 初次使用指引：第一次打开时展开，能翻到下一步
{
  const registrations = []
  // createPage 的 state 顺序：data/loading/error/selected/dryRun/force/limit/job/openSource/note/picker/mode/guideOpen/guideStep
  const module = instantiate([INDEX, false, '', null, false, false, '', null, null, '', null, 'simple', true, 0])
  module.apply(fakeCtx(registrations))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  ok =
    runCase('指引/第一屏', () => section.Component({}), [], [
      '第一次用？四步就能跑通',
      '① 这个面板做什么',
      '第 1 / 4 步',
      '下一步',
      '使用指引',
    ]) && ok
}

// 10) 宿主 locale 契约：位置参数必须照样替换（曾经显示成「导入勾选的 {0} 条」）
{
  const registrations = []
  const module = instantiate([INDEX, false, '', null, false, false, '', null, null, '', null, 'wizard'])
  module.apply(fakeCtx(registrations, { locale: hostLocaleShim() }))
  const section = registrations.find((item) => item.options.name === 'settings.section')
  const wizard = findComponent(section.Component({}), 'AiImportWizard')
  const folders = [{ name: '论文归档', dir: 'C:\\g\\论文', sessions: 0, exists: true }]
  ok =
    wizard !== null &&
    runCase(
      '界面文案/宿主 locale 位置参数',
      () => wizard.type({ data: INDEX, busy: false, startPicks() {} }),
      [folders, '', false, '', new Set(), {}, null, null, '', ''],
      ['导入勾选的 0 条'],
      ['{0}'],
    ) &&
    ok
}

console.log(ok ? '\nSMOKE PASS' : '\nSMOKE FAIL')
if (!ok) process.exitCode = 1