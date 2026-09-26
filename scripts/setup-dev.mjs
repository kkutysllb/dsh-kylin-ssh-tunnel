// 开发环境引导：把 package.json 声明的 peer 依赖链接进本仓 node_modules，
// 使其能在**当前引擎的物理布局**下被解析。
//
// 为什么不再整树链接共享保留区（~/.kcoder/profiles/node_modules）：
// dsh 0.1.6-alpha.2 起依赖解析默认运行时模式（PR #4471），profile 的共享
// node_modules 被划为安装保留区——不再是解析来源，引擎也不再维护它的
// 内容；旧脚本整树 symlink 到该目录，运行时升级后大量链接悬空（本仓
// 2026-09 现场：136 个悬空链接，schemastery 指向已被移除的嵌套提升路径）。
// 现在按**声明**逐个链接，并从当前引擎安装位取实体，缺谁报谁。
//
// 引擎根候选（按序探测，命中即用）：
//   1. $KCODER_RUNTIME_NODE_MODULES
//   2. ~/Library/Application Support/KCoder/kcoder-runtime/node_modules（KCoder 桌面运行时）
//   3. $DSH_HOME/profiles/<profile>/node_modules 与 $QILIN_HOME/profiles/<profile>/node_modules
// 用法：node scripts/setup-dev.mjs [--prune]（--prune 顺带清掉不再需要的旧链接）
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const peers = Object.keys(pkg.peerDependencies ?? {})

/** 引擎 node_modules 根候选（去重，存在即用）。 */
function engineRoots() {
  const roots = []
  const push = (p) => { if (p && existsSync(p)) roots.push(p) }
  push(process.env.KCODER_RUNTIME_NODE_MODULES)
  push(path.join(homedir(), 'Library', 'Application Support', 'KCoder', 'kcoder-runtime', 'node_modules'))
  for (const home of [process.env.DSH_HOME, process.env.QILIN_HOME, path.join(homedir(), '.dsh')]) {
    if (!home) continue
    const profiles = path.join(home, 'profiles')
    if (!existsSync(profiles)) continue
    for (const name of readdirSync(profiles)) push(path.join(profiles, name, 'node_modules'))
    push(path.join(profiles, 'node_modules'))
  }
  return [...new Set(roots)]
}

/** 在引擎根中定位一个包（返回实体路径或 null）。 */
function locate(roots, name) {
  for (const root of roots) {
    const candidate = path.join(root, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 建立/修复一个包链接（悬空即重建；真实目录不动）。 */
function link(linkPath, target) {
  let st = null
  try { st = lstatSync(linkPath) } catch { /* 不存在 */ }
  if (st && st.isSymbolicLink()) {
    if (existsSync(linkPath)) return 'ok'
    rmSync(linkPath)
  } else if (st) {
    return 'real-dir'
  }
  mkdirSync(path.dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, 'dir')
  return 'linked'
}

const roots = engineRoots()
if (roots.length === 0) {
  console.error('未找到引擎 node_modules：设置 KCODER_RUNTIME_NODE_MODULES 或确认 KCoder / dsh 已安装')
  process.exit(1)
}
console.log('引擎根候选：')
for (const root of roots) console.log('  - ' + root)

const missing = []
let repaired = 0
let created = 0
for (const name of peers) {
  const target = locate(roots, name)
  const linkPath = path.join(repoRoot, 'node_modules', name)
  if (target === null) {
    missing.push(name)
    continue
  }
  const result = link(linkPath, target)
  if (result === 'linked') created += 1
  if (result === 'ok' && lstatSync(linkPath).isSymbolicLink()) repaired += 1
  console.log(`  ${result.padEnd(9)} ${name}`)
}

if (process.argv.includes('--prune')) {
  const keep = new Set(peers)
  const nm = path.join(repoRoot, 'node_modules')
  let pruned = 0
  const entries = existsSync(nm) ? readdirSync(nm) : []
  for (const entry of entries) {
    const entryPath = path.join(nm, entry)
    if (!lstatSync(entryPath).isSymbolicLink()) continue
    if (entry.startsWith('@')) {
      for (const inner of readdirSync(entryPath)) {
        const innerPath = path.join(entryPath, inner)
        if (!lstatSync(innerPath).isSymbolicLink()) continue
        const full = `${entry}/${inner}`
        if (keep.has(full)) continue
        // 悬空的旧链接清掉，真实存在的保留（兼容手工安装）
        if (!existsSync(innerPath)) { rmSync(innerPath); pruned += 1 }
      }
      continue
    }
    if (!keep.has(entry) && !existsSync(entryPath)) { rmSync(entryPath); pruned += 1 }
  }
  console.log(`清理旧链接：${pruned} 个`)
}

console.log(`peer 链接：新建 ${created}，已在位 ${repaired}`)
if (missing.length > 0) {
  // 引擎不单发某些 peer（如 react 由 client runtime 内联提供）属正常：
  // 只提示，不阻断——需要它的是浏览器侧 bundle，开发态由宿主页面供给。
  console.warn('提示：以下声明 peer 在当前引擎安装位没有独立实体，按内联/宿主供给处理：' + missing.join(', '))
}
console.log('开发环境就绪（peer 依赖已按声明链接）')
