# dsh-ssh-remote 插件 v1 实施计划

> **状态（2026-09-26）：已实施完成并通过验收。** 本文件保留为设计/实施记录，下方
> 复选框是当时的推进清单，未逐项回填——以代码与测试为准：
> `npm run typecheck` + `npm test`（193 断言，T2–T14）。
> 同日完成 dsh 0.1.7-rc.2 世代对齐（v0.1.2）：peer 范围重写、`client.inject` 清理、
> HTTP handler 收敛为 `(req, res)`、工具卡片呈现、manifest 现代化（`manifestVersion`
> + 本地化标题/图标），详见 README「版本兼容」与「开发」两节。
> 当日 dev 环境实测补修：客户端两处 `useRef({})` 真值初值令默认状态永不建立，
> 设置页/胶囊浮窗首帧即抛 `undefined.map`（设置页表现为白板）；新增 T14 浏览器组件
> 渲染回归（零依赖 hook 桩渲染 + 模拟点击，回退修复可复现崩溃）。

**Goal:** 在本仓库构建 DSH 插件 `ssh-remote`：10 个 ssh_* Agent 工具（执行/读/写/编辑/搜索/推拉）+ ControlMaster 连接层 + 状态胶囊面板 + 设置页可视化配置。

**Architecture:** 双半插件（宿主 lib/ + 浏览器 client/）。宿主端组合五个纯模块：HostRegistry（静态+动态主机合并热重载）→ ConnectionManager（ControlMaster 惰性建连/探活/拆除）→ Runner（spawn 参数数组执行 + 限流/超时/错误分类）→ FsOps/Transfer（文件语义与传输）。index.js apply() 装配工具/系统提示/回环 HTTP API。全部远端操作复用同一条 master 连接。

**Tech Stack:** Node.js ESM、@deepseek-ai/cordis（插件宿主）、@deepseek-ai/dsh-tools（defineTool）、@deepseek-ai/schemastery（Config schema）、React 18（client，全行内样式）。零新增运行时依赖——远端能力全部由系统 ssh/scp/tar 二进制承担。

**设计规格:** `docs/superpowers/specs/2026-09-18-dsh-ssh-remote-design.md`

**开发环境事实（已验证）:**
- peer 依赖在 `~/.kcoder/profiles/node_modules/@deepseek-ai/` 齐全（cordis / dsh-tools / schemastery）。
- 设置页区块槽位：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id, order, label }, Component))`，组件收 `{ close }` prop。
- 会话头部槽位：`conversation.session.header.utilities`（dsh-ssh-tunnel 已验证同款用法）。
- 测试模式：fake spawn 注入（EventEmitter 假子进程，手动 emitExit/writeOut），不碰网络。

---

## 文件结构总览

| 文件 | 职责 |
|---|---|
| `package.json` / `cordis.patch.yml` | 包元数据与插件注册（id: ssh-remote） |
| `lib/hosts.js` | 主机归一化/校验（jump 成环检测）/两路合并（静态优先）/注册表热重载 |
| `lib/settings-store.js` | hostsFile 原子读写 + 导入解析（JSON/YAML 子集/ssh_config） |
| `lib/connection.js` | ControlMaster：参数组装（win32 降级）、惰性建连、`-O check` 探活、残留清理、拆除、统计 |
| `lib/exec.js` | shellQuote、良性 stderr 过滤、Runner.run/runWithStdin（限流/超时/错误分类） |
| `lib/fsops.js` | FsOps：read（复合命令+二进制嗅探+行号）、write（stdin 原子写）、edit（sha256 关键段 exit 75）、glob/grep |
| `lib/transfer.js` | Transfer：scp 单文件（-P）、tar-over-ssh 目录推/拉（双进程管道） |
| `lib/index.js` | apply()：Config、装配、生命周期、系统提示、10 工具、回环 HTTP API |
| `client/index.js` | 状态胶囊+面板；settings.section 配置区块（表格 CRUD/导入/导出） |
| `scripts/smoke-test.mjs` | 全模块 fake-spawn 冒烟（目标 ≥60 断言） |
| `scripts/live-test.mjs` | 真实主机端到端验证（env 提供主机） |
| `scripts/setup-dev.mjs` | 创建 node_modules → ~/.kcoder/profiles/node_modules 符号链接 |

任务顺序 = 依赖顺序：1 脚手架 → 2 exec → 3 hosts → 4 settings-store → 5 connection → 6/7/8 fsops → 9 transfer → 10 index 工具 → 11 index HTTP → 12/13 client → 14 README+live+验收。

---

### Task 1: 脚手架与测试基建

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `.gitignore`, `scripts/setup-dev.mjs`, `scripts/smoke-test.mjs`, `lib/hosts.js`、`lib/settings-store.js`、`lib/connection.js`、`lib/exec.js`、`lib/fsops.js`、`lib/transfer.js`、`lib/index.js`（空占位）

- [ ] **Step 1.1: 写 package.json**

```json
{
  "name": "dsh-ssh-remote",
  "version": "0.1.0",
  "description": "DSH 插件：SSH 远程运维/开发工具套件（run/read/write/edit/glob/grep/push/pull）+ ControlMaster 连接层 + 状态面板 + 设置页主机管理。",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
    "./client": "./client/index.js"
  },
  "files": ["lib/**/*.js", "client/**/*.js", "cordis.patch.yml", "README.md"],
  "scripts": {
    "typecheck": "node --check lib/index.js && node --check client/index.js && node --check lib/hosts.js && node --check lib/settings-store.js && node --check lib/connection.js && node --check lib/exec.js && node --check lib/fsops.js && node --check lib/transfer.js",
    "test": "node scripts/smoke-test.mjs",
    "setup-dev": "node scripts/setup-dev.mjs"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings-general"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh": ">=0.1.0-rc.5 <0.2.0",
    "@deepseek-ai/dsh-tools": ">=0.1.0-rc.5 <0.2.0",
    "@deepseek-ai/schemastery": ">=3.18.0 <4.0.0"
  },
  "license": "MIT"
}
```

注意：peerDependencies 声明的 `@deepseek-ai/schemastery` 与代码 import **完全一致**（dsh-ssh-tunnel 在此处犯过名不匹配的错，我们修正）。

- [ ] **Step 1.2: 写 cordis.patch.yml 与 .gitignore**

`cordis.patch.yml`：

```yaml
# dsh-ssh-remote 宿主插件：SSH 远程运维/开发工具套件。
# 主机配置示例见 README.md；动态主机由设置页写入 hostsFile（热重载）。
- insert:
    - id: ssh-remote
      name: 'dsh-ssh-remote'
```

`.gitignore`：

```
node_modules
*.log
.DS_Store
```

- [ ] **Step 1.3: 写 scripts/setup-dev.mjs（开发符号链接）**

```js
// 开发环境：node_modules -> ~/.kcoder/profiles/node_modules（peer 依赖全在那里）。
// 与 dsh-ssh-tunnel 的 Junction 方案等价，macOS 用符号链接。
import { symlinkSync, existsSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'

const target = path.join(homedir(), '.kcoder', 'profiles', 'node_modules')
const link = path.join(process.cwd(), 'node_modules')

if (!existsSync(target)) {
  console.error('缺 peer 依赖目录: ' + target)
  process.exit(1)
}
try {
  if (statSync(link).isSymbolicLink()) rmSync(link)
} catch { /* 不存在，直接建 */ }
if (!existsSync(link)) symlinkSync(target, link, 'dir')
console.log('node_modules -> ' + target)
```

- [ ] **Step 1.4: 写 7 个 lib 占位文件并跑通检查**

`lib/exec.js`、`lib/hosts.js`、`lib/settings-store.js`、`lib/connection.js`、`lib/fsops.js`、`lib/transfer.js`、`lib/index.js` 均先写一行：

```js
// placeholder — 后续任务填充
```

Run: `node scripts/setup-dev.mjs && npm run typecheck`
Expected: 输出 `node_modules -> ...` 且无语法错误（exit 0）。

- [ ] **Step 1.5: 写 smoke-test.mjs 测试骨架（fake 子进程工厂 + 断言器）**

`scripts/smoke-test.mjs`：

```js
// dsh-ssh-remote 冒烟测试：全 fake spawn，不碰网络与真实 ssh。
// 运行前先 `npm run setup-dev`（node_modules 符号链接提供 peer 依赖）。
import { EventEmitter } from 'node:events'

let passed = 0
let failed = 0
const failures = []
export function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  PASS ' + name) }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + detail : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** fake 子进程：手动 emitExit / emitClose / writeOut / writeErr */
export function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.emitExit = (code, signal) => child.emit('exit', code, signal || null)
  child.emitClose = (code) => child.emit('close', code)
  child.writeOut = (s) => child.stdout.emit('data', Buffer.from(s, 'utf8'))
  child.writeErr = (s) => child.stderr.emit('data', Buffer.from(s, 'utf8'))
  return child
}

/** 记录型 spawnFn */
export function recordingSpawn(log) {
  return (cmd, args, opts) => {
    const child = fakeChild(9000 + log.length)
    log.push({ cmd, args, opts, child })
    return child
  }
}

export { sleep, EventEmitter }
export function summary() {
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  if (failed > 0) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1 }
}
export function counts() { return { passed, failed } }
```

（后续任务在文件末尾追加各测试组 + main；本任务先保证 `node --check scripts/smoke-test.mjs` 通过。）

Run: `node --check scripts/smoke-test.mjs`
Expected: 无输出（exit 0）。

- [ ] **Step 1.6: Commit**

```bash
git add package.json cordis.patch.yml .gitignore scripts/ lib/
git commit -m "chore: dsh-ssh-remote 脚手架与 fake-spawn 测试基建"
```

---

### Task 2: exec.js — shellQuote / stderr 过滤 / Runner

**Files:**
- Modify: `lib/exec.js`（替换占位）
- Modify: `scripts/smoke-test.mjs`（追加 T2 组）

- [ ] **Step 2.1: 追加失败测试（T2 组）到 smoke-test.mjs 末尾**

```js
// ================= T2 exec.js =================
import { shellQuote, cleanSshStderr, classifyError, Runner } from '../lib/exec.js'

async function t2() {
  console.log('== T2 exec.js ==')
  check('T2.1 shellQuote 单引号转义', shellQuote("a'b") === "'a'\\''b'", shellQuote("a'b"))
  check('T2.2 shellQuote 普通串', shellQuote('/srv/app') === "'/srv/app'")
  check('T2.3 cleanSshStderr 过滤良性噪音', cleanSshStderr('warn: post-quantum stuff\nreal error').includes('real error') && !cleanSshStderr('warn: post-quantum stuff\nreal error').includes('post-quantum'))
  check('T2.4 classify unreachable', classifyError('ssh: connect to host x port 22: Connection timed out', -1) === 'unreachable')
  check('T2.5 classify auth', classifyError('user@h: Permission denied (publickey).', 255) === 'auth')
  check('T2.6 classify stale-edit', classifyError('', 75) === 'stale-edit')

  const log = []
  const runner = new Runner({
    muxArgs: () => ['-o', 'ControlPath=/tmp/x.sock'],
    target: () => 'root@1.2.3.4',
    spawnFn: recordingSpawn(log),
    defaults: { commandTimeoutMs: 5000, maxStdout: 1024, maxStderr: 256 },
  })
  const host = { id: 'h1', user: 'root', host: '1.2.3.4', port: 22, identityFile: '/k', defaultCwd: '/srv' }

  // 正常执行 + defaultCwd 前缀
  const p1 = runner.run(host, 'hostname', {})
  setTimeout(() => { log[0].child.writeOut('srv1\n'); log[0].child.emitClose(0) }, 5)
  const r1 = await p1
  check('T2.7 run 返回 exitCode/stdout', r1.exitCode === 0 && r1.stdout === 'srv1\n', JSON.stringify(r1))
  check('T2.8 defaultCwd 变 cd 前缀', log[0].args.includes("cd '/srv' && hostname") || log[0].args.some(a => a === "cd '/srv' && hostname"), log[0].args.join(' '))
  check('T2.9 命令为最后一个参数', log[0].args[log[0].args.length - 1] === "cd '/srv' && hostname")
  check('T2.10 复用 mux 参数', log[0].args.includes('ControlPath=/tmp/x.sock'))

  // cwd 参数覆盖 + 引号
  const p2 = runner.run(host, 'ls', { cwd: "a'b" })
  setTimeout(() => log[1].child.emitClose(0), 5)
  await p2
  check('T2.11 cwd 覆盖并转义', log[1].args.some(a => a === "cd 'a'\\''b' && ls"), log[1].args.join(' '))

  // 超时
  const r3 = await runner.run(host, 'sleep 999', { timeoutMs: 60 })
  check('T2.12 超时 kill 并标记', r3.timedOut === true && r3.exitCode === -1 && log[2].child.killed === true, JSON.stringify(r3))

  // 错误分类透传
  const p4 = runner.run(host, 'x', {})
  setTimeout(() => { log[3].child.writeErr('Permission denied (publickey)'); log[3].child.emitClose(255) }, 5)
  const r4 = await p4
  check('T2.13 auth 分类', r4.errorKind === 'auth', JSON.stringify(r4))

  // runWithStdin：stdin 透传给远端
  const p5 = runner.runWithStdin(host, 'cat > /tmp/f', { stdin: 'hello' })
  setTimeout(() => { log[4].child.emitClose(0) }, 5)
  const r5 = await p5
  check('T2.14 stdin 写入', r5.exitCode === 0 && log[4].child.__stdin === 'hello', JSON.stringify(r5))
  check('T2.15 spawn 参数数组无 shell', log[0].cmd === 'ssh')
}
```

并在 main 里调用（main 结构见 Step 2.4）。

注意 fake 子进程没有 stdin 流；Runner 通过 `child.stdin?.write` 写入——测试里在 fakeChild 上挂 `child.stdin = { write: (s) => { child.__stdin = (child.__stdin || '') + s; child.end?.() }, end() {} }`（在 recordingSpawn 里统一挂）。

- [ ] **Step 2.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`SyntaxError: The requested module '../lib/exec.js' does not provide an export named 'shellQuote'`（占位文件无导出）。

- [ ] **Step 2.3: 实现 lib/exec.js**

```js
// dsh-ssh-remote — 远程执行核心：spawn 参数数组直调 ssh（不经任何本地 shell）。
import * as cp from 'node:child_process'

/** 远端 shell 单引号安全引用。 */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 过滤 OpenSSH 良性 stderr 噪音（post-quantum 提示等）。 */
export function cleanSshStderr(text) {
  if (!text) return text
  return text.split(/\r?\n/)
    .filter(line => !/post-quantum|store now, decrypt later|server may need to be upgraded/i.test(line))
    .join('\n')
}

/** 失败分类：Agent 可反应的结构化错误前缀。 */
export function classifyError(stderr, exitCode) {
  if (exitCode === 75) return 'stale-edit'
  const s = stderr || ''
  if (/connection timed out|connection refused|no route to host|network is unreachable|could not resolve hostname|control socket/i.test(s)) return 'unreachable'
  if (/permission denied/i.test(s)) return 'auth'
  if (/no such file or directory/i.test(s)) return 'not-found'
  return null
}

function cap(buf, limit) {
  return buf.length > limit ? buf.slice(buf.length - limit) : buf
}

export class Runner {
  /**
   * @param opts {muxArgs(host): string[], target(host): string, spawnFn?,
   *              defaults {commandTimeoutMs, maxStdout, maxStderr}}
   */
  constructor(opts = {}) {
    this.opts = opts
    this.spawnFn = opts.spawnFn || ((cmd, args, o) => cp.spawn(cmd, args, o))
    this.defaults = Object.assign({ commandTimeoutMs: 60000, maxStdout: 262144, maxStderr: 65536 }, opts.defaults)
  }

  /** 组装完整 ssh argv：mux 参数 + user@host + 远端命令（单参数）。 */
  argv(host, remote) {
    return [...this.opts.muxArgs(host), this.opts.target(host), remote]
  }

  /** 执行远程命令；cwd 归 host.defaultCwd（可被参数覆盖）。 */
  async run(host, command, o = {}) {
    const cwd = o.cwd !== undefined ? o.cwd : host.defaultCwd
    const remote = (cwd ? 'cd ' + shellQuote(cwd) + ' && ' : '') + String(command)
    return this.execArgv(host, this.argv(host, remote), { stdin: null, timeoutMs: o.timeoutMs })
  }

  /** 远端脚本 + stdin 载荷（write/edit 用）。 */
  async runWithStdin(host, remoteScript, o = {}) {
    return this.execArgv(host, this.argv(host, remoteScript), { stdin: o.stdin || '', timeoutMs: o.timeoutMs })
  }

  execArgv(host, args, { stdin, timeoutMs }) {
    return new Promise((resolve) => {
      const started = Date.now()
      let child
      try {
        child = this.spawnFn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ exitCode: -1, stdout: '', stderr: 'spawn ssh 失败: ' + (err && err.message), durationMs: 0, timedOut: false, errorKind: 'spawn-error' })
        return
      }
      let stdout = ''
      let stderr = ''
      if (child.stdout) child.stdout.on('data', d => { stdout = cap(stdout + d.toString('utf8'), this.defaults.maxStdout) })
      if (child.stderr) child.stderr.on('data', d => { stderr = cap(stderr + d.toString('utf8'), this.defaults.maxStderr) })
      if (stdin !== null && child.stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
      const limit = Math.max(1000, Number(timeoutMs) || this.defaults.commandTimeoutMs)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        resolve({ exitCode: -1, stdout, stderr: cleanSshStderr(stderr) + '\n[已超时 ' + limit + 'ms，本地进程被终止]', durationMs: Date.now() - started, timedOut: true, errorKind: 'timed-out' })
      }, limit)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ exitCode: -1, stdout, stderr: 'spawn ssh 失败: ' + (err && err.message), durationMs: Date.now() - started, timedOut: false, errorKind: 'spawn-error' })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const cleaned = cleanSshStderr(stderr)
        resolve({ exitCode: code, stdout, stderr: cleaned, durationMs: Date.now() - started, timedOut: false, errorKind: classifyError(cleaned, code) })
      })
    })
  }
}
```

- [ ] **Step 2.4: 在 smoke-test.mjs 组装 main 并跑通**

在文件末尾追加（后续任务只往 main 里加组调用）：

```js
const keepAlive = setInterval(() => {}, 1000)
async function main() {
  await t2()
  clearInterval(keepAlive)
  summary()
}
main().catch(err => { console.error(err); process.exit(1) })
```

同时给 `fakeChild` 的 stdin 打桩（在 fakeChild 内加）：

```js
child.stdin = {
  write: (s) => { child.__stdin = (child.__stdin || '') + s },
  end: () => {},
}
```

Run: `node scripts/smoke-test.mjs`
Expected: `== T2 exec.js ==` 下 15 项全 PASS，`结果: 15 通过, 0 失败`。

- [ ] **Step 2.5: Commit**

```bash
git add lib/exec.js scripts/smoke-test.mjs
git commit -m "feat(exec): Runner 远程执行核心（转义/限流/超时/错误分类）+ 15 项冒烟"
```

---

### Task 3: hosts.js — 归一化/校验/合并/注册表

**Files:**
- Modify: `lib/hosts.js`, `scripts/smoke-test.mjs`（追加 T3 组）

- [ ] **Step 3.1: 追加失败测试（T3 组）**

```js
// ================= T3 hosts.js =================
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { normalizeHost, validateHosts, mergeHosts, HostRegistry } from '../lib/hosts.js'

async function t3() {
  console.log('== T3 hosts.js ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-test-'))
  const hostsFile = path.join(tmpDir, 'hosts.json')

  const h = normalizeHost({ id: 'Prod_1', host: '1.2.3.4', identityFile: '~/k' })
  check('T3.1 id 非法字符报错', h === null)
  const h2 = normalizeHost({ id: 'prod-1', name: '生产', host: '1.2.3.4', identityFile: '~/k', port: 2222, jump: 'bastion' })
  check('T3.2 归一化默认值', h2.user === 'root' && h2.port === 2222 && h2.connectTimeoutSec === 15 && h2.controlPersistSec === 600 && h2.jump === 'bastion')
  check('T3.3 ~ 展开', h2.identityFile === path.join(os.homedir(), 'k'), h2.identityFile)

  const errs = validateHosts([
    { id: 'a', host: 'h', identityFile: 'k', jump: 'b' },
    { id: 'b', host: 'h', identityFile: 'k', jump: 'a' },
    { id: 'a', host: 'h', identityFile: 'k' },
    { id: 'bad id', host: 'h', identityFile: 'k' },
  ])
  check('T3.4 环检测', errs.some(e => e.includes('jump 成环')), errs.join(';'))
  check('T3.5 id 重复检测', errs.some(e => e.includes('重复')), errs.join(';'))
  check('T3.6 id 格式检测', errs.some(e => e.includes('id')), errs.join(';'))

  const merged = mergeHosts(
    [{ id: 'a', host: 'h', identityFile: 'k', at: 'static' }],
    [{ id: 'a', host: 'h2', identityFile: 'k2' }, { id: 'c', host: 'h3', identityFile: 'k3' }]
  )
  check('T3.7 静态优先去重', merged.length === 2 && merged[0].host === 'h' && merged[1].id === 'c')

  // 注册表：动态文件读写 + pick + 热重载
  fs.writeFileSync(hostsFile, JSON.stringify([{ id: 'dyn-1', host: '5.6.7.8', identityFile: '/k' }]), 'utf8')
  const reg = new HostRegistry({ staticHosts: [{ id: 'st-1', host: 'h', identityFile: 'k' }], hostsFile })
  check('T3.8 合并读取', reg.list().length === 2 && reg.list()[0].id === 'st-1')
  check('T3.9 pick 缺省第一条', reg.pick().id === 'st-1')
  check('T3.10 pick 按 id', reg.pick('dyn-1').id === 'dyn-1')
  let pickErr = null
  try { reg.pick('nope') } catch (e) { pickErr = e }
  check('T3.11 未知 id 报错并列出可用', String(pickErr.message).includes('st-1') && String(pickErr.message).includes('dyn-1'))
  let reloaded = false
  reg.startWatch(() => { reloaded = true })
  await sleep(50)
  fs.writeFileSync(hostsFile + '.tmp-x', JSON.stringify([{ id: 'dyn-2', host: '9.9.9.9', identityFile: '/k' }]), 'utf8')
  fs.renameSync(hostsFile + '.tmp-x', hostsFile)
  await sleep(400)
  check('T3.12 热重载生效', reg.list().length === 2 && reg.list().some(x => x.id === 'dyn-2') && reg.list().every(x => x.id !== 'dyn-1'))
  check('T3.13 热重载回调触发', reloaded === true)
  reg.stopWatch()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`does not provide an export named 'normalizeHost'`。

- [ ] **Step 3.3: 实现 lib/hosts.js**

```js
// dsh-ssh-remote — 主机注册表：静态（cordis.patch.yml）+ 动态（hostsFile）两路合并。
// 静态优先：设置页不可覆盖静态主机。hostsFile 变更热重载。
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

const ID_RE = /^[a-z0-9_-]+$/
const DEFAULTS = { user: 'root', port: 22, jump: '', defaultCwd: '', connectTimeoutSec: 15, controlPersistSec: 600 }

function expandTilde(p) {
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

/** 归一化单台主机；非法返回 null。 */
export function normalizeHost(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '')
  if (!ID_RE.test(id)) return null
  if (!raw.host) return null
  const out = {
    id,
    name: String(raw.name || id),
    host: String(raw.host),
    user: String(raw.user || DEFAULTS.user),
    port: Number(raw.port) || DEFAULTS.port,
    identityFile: expandTilde(String(raw.identityFile || '')),
    jump: raw.jump ? String(raw.jump) : '',
    defaultCwd: raw.defaultCwd ? String(raw.defaultCwd) : '',
    connectTimeoutSec: Number(raw.connectTimeoutSec) || DEFAULTS.connectTimeoutSec,
    controlPersistSec: Number(raw.controlPersistSec) || DEFAULTS.controlPersistSec,
    source: raw.source || 'static',
  }
  if (out.port < 1 || out.port > 65535) return null
  return out
}

/** 批量校验：id 重复/格式、jump 引用存在、jump 成环。返回错误字符串数组。 */
export function validateHosts(hosts) {
  const errors = []
  const ids = new Set(hosts.map(h => h.id))
  const seen = new Set()
  for (const h of hosts) {
    if (seen.has(h.id)) errors.push('id 重复: ' + h.id)
    seen.add(h.id)
  }
  for (const h of hosts) {
    if (h.jump) {
      if (!ids.has(h.jump)) errors.push('[' + h.id + '] jump 引用不存在: ' + h.jump)
      else {
        const chain = new Set()
        let cur = h
        while (cur && cur.jump) {
          if (chain.has(cur.id)) { errors.push('[' + h.id + '] jump 成环'); break }
          chain.add(cur.id)
          cur = hosts.find(x => x.id === cur.jump)
        }
      }
    }
  }
  return errors
}

/** 静态优先合并（按 id 去重）。 */
export function mergeHosts(staticHosts, dynamicHosts) {
  const out = [...staticHosts]
  const ids = new Set(staticHosts.map(h => h.id))
  for (const d of dynamicHosts) {
    if (!ids.has(d.id)) { out.push(d); ids.add(d.id) }
  }
  return out
}

export class HostRegistry {
  constructor({ staticHosts = [], hostsFile, logger } = {}) {
    this.staticHosts = staticHosts.map(h => normalizeHost({ ...h, source: 'static' })).filter(Boolean)
    this.hostsFile = hostsFile || path.join(homedir(), '.dsh', 'ssh-remote', 'hosts.json')
    this.logger = logger
    this.dynamicHosts = []
    this.watcher = null
    this.watchTimer = null
    this.reload()
  }

  /** 读动态文件并合并；watch 回调外的手动调用也安全。 */
  reload() {
    try {
      const raw = fs.readFileSync(this.hostsFile, 'utf8')
      const arr = JSON.parse(raw)
      this.dynamicHosts = (Array.isArray(arr) ? arr : []).map(h => normalizeHost({ ...h, source: 'dynamic' })).filter(Boolean)
    } catch { /* 文件不存在或损坏 → 空动态表 */ }
    this.hosts = mergeHosts(this.staticHosts, this.dynamicHosts)
    this.errors = validateHosts(this.hosts)
    if (this.errors.length && this.logger?.warn) this.logger.warn('[ssh-remote] 主机校验问题: ' + this.errors.join('; '))
  }

  list() { return this.hosts }
  validationErrors() { return this.errors }
  source(id) { const h = this.hosts.find(x => x.id === id); return h ? h.source : null }

  pick(id) {
    if (id !== undefined && id !== null && String(id) !== '') {
      const t = this.hosts.find(x => x.id === String(id))
      if (!t) throw new Error('主机 [' + id + '] 不存在（可用: ' + this.hosts.map(x => x.id).join(', ') + '）')
      return t
    }
    if (this.hosts.length === 0) throw new Error('未配置任何主机（设置页或 cordis.patch.yml 的 ssh-remote.config）')
    return this.hosts[0]
  }

  /** 监听 hostsFile 所在目录（tmp+rename 原子写对目录监听可靠）。 */
  startWatch(onChange) {
    const dir = path.dirname(this.hostsFile)
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    this.stopWatch()
    this.watcher = fs.watch(dir, (event, filename) => {
      if (filename && !String(filename).startsWith(path.basename(this.hostsFile))) return
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null
        this.reload()
        if (onChange) onChange()
      }, 200)
    })
  }

  stopWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null }
  }
}
```

- [ ] **Step 3.4: main 中调用 t3 并跑通**

`main()` 里 `await t2()` 后加 `await t3()`。

Run: `node scripts/smoke-test.mjs`
Expected: T3 组 13 项全 PASS，累计 `结果: 28 通过, 0 失败`。

- [ ] **Step 3.5: Commit**

```bash
git add lib/hosts.js scripts/smoke-test.mjs
git commit -m "feat(hosts): 主机注册表（归一化/jump 环检测/静态优先合并/热重载）+ 13 项冒烟"
```

---

### Task 4: settings-store.js — 原子写 + 导入解析

**Files:**
- Modify: `lib/settings-store.js`, `scripts/smoke-test.mjs`（追加 T4 组）

- [ ] **Step 4.1: 追加失败测试（T4 组）**

```js
// ================= T4 settings-store.js =================
import { atomicWriteJson, readHostsFile, parseImport } from '../lib/settings-store.js'

async function t4() {
  console.log('== T4 settings-store.js ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t4-'))
  const f = path.join(tmpDir, 'sub', 'hosts.json')
  atomicWriteJson(f, [{ id: 'x', host: '1.1.1.1', identityFile: '/k' }])
  check('T4.1 原子写建目录+落盘', JSON.parse(fs.readFileSync(f, 'utf8'))[0].id === 'x')
  check('T4.2 readHostsFile', readHostsFile(f).length === 1)
  check('T4.3 readHostsFile 缺文件容忍', readHostsFile(path.join(tmpDir, 'none.json')).length === 0)

  // JSON 导入
  const j = parseImport('[{"id":"j1","host":"1.2.3.4","identityFile":"/k","port":2222}]', 'json')
  check('T4.4 json 导入', j.hosts.length === 1 && j.hosts[0].port === 2222 && j.errors.length === 0)
  const j2 = parseImport('{"hosts":[{"id":"j2","host":"h","identityFile":"/k"}]}', 'json')
  check('T4.5 json 对象包裹形态', j2.hosts.length === 1)

  // YAML 子集导入
  const y = parseImport([
    '# 注释',
    "- id: y1",
    "  name: '生产 1'",
    "  host: 1.2.3.4",
    "  identityFile: ~/.ssh/id_ed25519",
    "  port: 22",
  ].join('\n'), 'yaml')
  check('T4.6 yaml 导入', y.hosts.length === 1 && y.hosts[0].name === '生产 1' && y.hosts[0].port === 22 && y.errors.length === 0, JSON.stringify(y))

  // ssh_config 导入
  const sc = parseImport([
    'Host bastion',
    '  HostName 203.0.113.7',
    '  User ops',
    '  Port 2222',
    '  IdentityFile ~/.ssh/bastion_key',
    '',
    'Host web-01',
    '  HostName 10.0.0.5',
    '  IdentityFile ~/.ssh/web_key',
    '  ProxyJump bastion',
    '',
    'Host *',
    '  ServerAliveInterval 60',
  ].join('\n'), 'sshconfig')
  check('T4.7 sshconfig 解析两条', sc.hosts.length === 2, JSON.stringify(sc))
  const bas = sc.hosts.find(h => h.id === 'bastion')
  const web = sc.hosts.find(h => h.id === 'web-01')
  check('T4.8 字段映射', bas.host === '203.0.113.7' && bas.user === 'ops' && bas.port === 2222)
  check('T4.9 ProxyJump 转 jump 引用', web.jump === 'bastion')
  check('T4.10 缺省 user/root', web.user === 'root')
  check('T4.11 通配 Host 跳过', !sc.hosts.some(h => h.id === '*'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
```

- [ ] **Step 4.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`does not provide an export named 'atomicWriteJson'`。

- [ ] **Step 4.3: 实现 lib/settings-store.js**

```js
// dsh-ssh-remote — 动态主机存储：原子写 + 导入解析（JSON / YAML 子集 / ssh_config）。
import * as path from 'node:path'
import * as fs from 'node:fs'
import { normalizeHost } from './hosts.js'

/** tmp+rename 原子写（对目录 watcher 友好）。 */
export function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 读动态主机文件；缺失/损坏返回 []。 */
export function readHostsFile(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function stripQuotes(v) {
  const t = v.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1)
  return t
}

/** 极简 YAML 子集：仅支持「- key: value 顶层列表 + 一层缩进键值」。够 hosts 粘贴用。 */
function parseYamlSubset(text) {
  const items = []
  let cur = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line || /^\s*#/.test(line)) continue
    if (/^-\s+\S/.test(line)) {
      cur = {}
      items.push(cur)
      const kv = line.replace(/^-\s+/, '')
      const idx = kv.indexOf(':')
      if (idx > 0) cur[kv.slice(0, idx).trim()] = stripQuotes(kv.slice(idx + 1))
      continue
    }
    if (/^\s+\S/.test(line) && cur) {
      const t = line.trim()
      const idx = t.indexOf(':')
      if (idx > 0) cur[t.slice(0, idx).trim()] = stripQuotes(t.slice(idx + 1))
    }
  }
  return items
}

/** ssh_config 解析：Host 块 → 主机条目；跳过通配；ProxyJump 别名转 jump 引用。 */
function parseSshConfig(text) {
  const blocks = []
  let cur = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(Host|HostName|User|Port|IdentityFile|ProxyJump)\s+(.+)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'host') {
      cur = { alias: val }
      blocks.push(cur)
    } else if (cur) {
      cur[key] = val
    }
  }
  const hosts = []
  const errors = []
  const aliases = new Set(blocks.filter(b => !/[*?]/.test(b.alias)).map(b => b.alias))
  for (const b of blocks) {
    if (/[*?]/.test(b.alias)) continue
    const id = b.alias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const entry = {
      id,
      name: b.alias,
      host: b.hostname || b.alias,
      user: b.user || 'root',
      port: Number(b.port) || 22,
      identityFile: b.identityfile || '',
      jump: '',
    }
    if (b.proxyjump) {
      const jumpAlias = b.proxyjump.split('@').pop().split(':').shift()
      if (aliases.has(jumpAlias)) entry.jump = jumpAlias.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      else errors.push('[' + id + '] ProxyJump ' + jumpAlias + ' 未在导入内容中，已忽略')
    }
    if (!entry.identityFile) errors.push('[' + id + '] 缺 IdentityFile，导入后需补密钥路径')
    hosts.push(entry)
  }
  return { raw: hosts, errors }
}

/**
 * 导入解析统一入口。
 * @returns {{hosts: object[], errors: string[]}} hosts 为「可入库的原始字段」（未 normalize，由保存时校验）。
 */
export function parseImport(text, format) {
  const errors = []
  let rawList = []
  try {
    if (format === 'json') {
      const data = JSON.parse(text)
      rawList = Array.isArray(data) ? data : (Array.isArray(data && data.hosts) ? data.hosts : [])
    } else if (format === 'yaml') {
      rawList = parseYamlSubset(text)
    } else if (format === 'sshconfig') {
      const r = parseSshConfig(text)
      rawList = r.raw
      errors.push(...r.errors)
    } else {
      return { hosts: [], errors: ['未知格式: ' + format] }
    }
  } catch (err) {
    return { hosts: [], errors: ['解析失败: ' + (err && err.message)] }
  }
  const hosts = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const n = normalizeHost({ ...raw })
    if (n) hosts.push({ ...n, source: undefined })
    else errors.push('条目非法（id/host/identityFile 缺失或 id 非 [a-z0-9_-]）: ' + JSON.stringify(raw).slice(0, 120))
  }
  return { hosts, errors }
}
```

- [ ] **Step 4.4: main 中调用 t4 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T4 组 11 项全 PASS，累计 `结果: 39 通过, 0 失败`。

- [ ] **Step 4.5: Commit**

```bash
git add lib/settings-store.js scripts/smoke-test.mjs
git commit -m "feat(settings): hostsFile 原子写 + JSON/YAML/ssh_config 导入解析 + 11 项冒烟"
```

---

### Task 5: connection.js — ControlMaster 管理器

**Files:**
- Modify: `lib/connection.js`, `scripts/smoke-test.mjs`（追加 T5 组）

- [ ] **Step 5.1: 追加失败测试（T5 组）**

```js
// ================= T5 connection.js =================
import { ConnectionManager } from '../lib/connection.js'

function connOpts(log, over = {}) {
  return Object.assign({
    platform: 'darwin',
    cmDir: '/tmp/cm-test',
    spawnFn: recordingSpawn(log),
    sleepMs: 0.02,
    probeIntervalMs: 30,
    connectFloorMs: 400,
  }, over)
}

async function t5() {
  console.log('== T5 connection.js ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/key', jump: '', connectTimeoutSec: 2, controlPersistSec: 600 }

  // 参数组装
  {
    const c = new ConnectionManager(connOpts([]))
    const base = c.baseArgs(H)
    check('T5.1 基础参数 BatchMode/accept-new/ConnectTimeout', base.includes('-o') && base.join(' ').includes('BatchMode=yes') && base.join(' ').includes('StrictHostKeyChecking=accept-new') && base.join(' ').includes('ConnectTimeout=2'))
    check('T5.2 22 端口不加 -p', !base.includes('-p'))
    const mux = c.muxArgs(H)
    check('T5.3 mux 参数含 Control 三件套', mux.join(' ').includes('ControlMaster=auto') && mux.join(' ').includes('ControlPath=/tmp/cm-test/h1.sock') && mux.join(' ').includes('ControlPersist=600'))
    check('T5.4 target', c.target(H) === 'root@1.2.3.4')

    const H2 = { ...H, port: 2222, jump: 'bastion', _jumpHost: { user: 'ops', host: '10.0.0.9', port: 2222 } }
    check('T5.5 非 22 加 -p', c.muxArgs(H2).includes('-p') && c.muxArgs(H2).includes('2222'))
    check('T5.6 jump 转 -J（_jumpHost 由 resolveJump 注入，单测直接预置）', c.muxArgs(H2).includes('-J') && c.muxArgs(H2).includes('ops@10.0.0.9:2222'))

    const cw = new ConnectionManager(connOpts([], { platform: 'win32' }))
    check('T5.7 win32 降级无 Control 参数', !cw.muxArgs(H).join(' ').includes('ControlMaster'))
    check('T5.8 win32 降级标志', cw.degraded === true)
  }

  // ensureMaster：check 失败 → 清 socket → spawn master → poll check 成功
  {
    const log = []
    let checkCalls = 0
    const opts = connOpts(log, {
      spawnFn: (cmd, args, o) => {
        const child = fakeChild(7000 + log.length)
        log.push({ cmd, args, opts: o, child, isCheck: args.includes('-O') && args.includes('check') })
        if (args.includes('-O') && args.includes('check')) {
          checkCalls += 1
          setTimeout(() => child.emitClose(checkCalls >= 2 ? 0 : 255), 10) // 第一次无 master，建后成功
        } else if (args.includes('-N')) {
          // master 进程：保持存活（不发 exit）
        }
        return child
      },
    })
    const c = new ConnectionManager(opts)
    const r = await c.ensureMaster(H)
    check('T5.9 建连成功', r.ok === true)
    const masterEntry = log.find(e => e.args.includes('-N'))
    check('T5.10 spawn 了 -N master', !!masterEntry)
    check('T5.11 master 带 ServerAlive', masterEntry.args.join(' ').includes('ServerAliveInterval=30'))
    check('T5.12 master detached', masterEntry.opts.detached === true)
    // 再 ensure：check 直接过，不重复 spawn master
    const before = log.length
    const r2 = await c.ensureMaster(H)
    check('T5.13 复用不重建', r2.ok === true && log.filter(e => e.args.includes('-N')).length === 1)
    check('T5.14 stats 记录', c.view()[0].id === 'h1' && c.view()[0].commands === 0)
  }

  // master 建连失败（超时窗口内 check 一直 255）
  {
    const log = []
    const opts = connOpts(log, {
      spawnFn: (cmd, args, o) => {
        const child = fakeChild(7100 + log.length)
        log.push({ cmd, args, opts: o, child })
        if (args.includes('check')) setTimeout(() => child.emitClose(255), 5)
        if (args.includes('-N')) setTimeout(() => child.emitExit(255), 30) // master 秒死（如 auth 失败）
        return child
      },
    })
    const c = new ConnectionManager(opts)
    const r = await c.ensureMaster(H)
    check('T5.15 建连失败上报', r.ok === false && typeof r.error === 'string')
  }

  // 拆除：-O exit
  {
    const log = []
    const opts = connOpts(log, {
      spawnFn: (cmd, args, o) => {
        const child = fakeChild(7200 + log.length)
        log.push({ cmd, args, opts: o, child })
        setTimeout(() => child.emitClose(0), 5)
        return child
      },
    })
    const c = new ConnectionManager(opts)
    await c.ensureMaster(H)
    await c.teardown(H)
    check('T5.16 teardown 发 -O exit', log.some(e => e.args.includes('exit') && e.cmd === 'ssh'))
  }
}
```

- [ ] **Step 5.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`does not provide an export named 'ConnectionManager'`。

- [ ] **Step 5.3: 实现 lib/connection.js**

```js
// dsh-ssh-remote — ControlMaster 连接管理：惰性建连、-O check 探活、残留清理、拆除、统计。
// Windows 宿主不支持 ControlMaster → 降级为逐次直连（degraded 模式）。
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'

export class ConnectionManager {
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform
    this.degraded = this.platform === 'win32'
    this.cmDir = opts.cmDir || path.join(homedir(), '.dsh', 'ssh-remote', 'cm')
    this.spawnFn = opts.spawnFn || ((cmd, args, o) => cp.spawn(cmd, args, o))
    this.sleepMs = typeof opts.sleepMs === 'number' ? opts.sleepMs : 1
    this.probeIntervalMs = opts.probeIntervalMs || 250
    this.connectFloorMs = typeof opts.connectFloorMs === 'number' ? opts.connectFloorMs : 6000
    this.stats = new Map()   // id → { latencyMs, establishedAt, commands, lastError, master: 'up'|'down'|'degraded' }
    this.pending = new Map() // id → Promise（并发去重）
  }

  sockPath(host) { return path.join(this.cmDir, host.id + '.sock') }

  /** 基础参数（不含 Control 三件套；scp 也能复用 -o 项）。 */
  baseArgs(host) {
    const args = ['-i', host.identityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + (host.connectTimeoutSec || 15), '-o', 'StrictHostKeyChecking=accept-new']
    if (host.port && host.port !== 22) args.push('-p', String(host.port))
    if (host.jump) {
      const j = host._jumpHost // 已由 resolveJump 注入 {user,host,port}
      if (j) args.push('-J', j.user + '@' + j.host + (j.port && j.port !== 22 ? ':' + j.port : ''))
    }
    return args
  }

  /** ssh 用的完整参数（master 复用）。 */
  muxArgs(host) {
    const args = this.baseArgs(host)
    if (!this.degraded) {
      args.push('-o', 'ControlMaster=auto', '-o', 'ControlPath=' + this.sockPath(host), '-o', 'ControlPersist=' + (host.controlPersistSec || 600))
    }
    return args
  }

  /** scp 用：同 mux 但端口参数换成 -P（外层 transfer 处理，这里给 -o 部分）。 */
  scpArgs(host) {
    const args = ['-i', host.identityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + (host.connectTimeoutSec || 15), '-o', 'StrictHostKeyChecking=accept-new']
    if (!this.degraded) {
      args.push('-o', 'ControlMaster=auto', '-o', 'ControlPath=' + this.sockPath(host), '-o', 'ControlPersist=' + (host.controlPersistSec || 600))
    }
    return args
  }

  target(host) { return host.user + '@' + host.host }

  /** 宿主把 jump 主机解析进 host._jumpHost（注册表查引用）。 */
  resolveJump(host, registry) {
    if (!host.jump) return
    const j = registry && registry.list().find(x => x.id === host.jump)
    if (j) host._jumpHost = { user: j.user, host: j.host, port: j.port }
  }

  stat(id) {
    if (!this.stats.has(id)) this.stats.set(id, { latencyMs: null, establishedAt: null, commands: 0, lastError: null, master: 'down' })
    return this.stats.get(id)
  }

  _spawnSsh(args, opts) { return this.spawnFn('ssh', args, opts) }

  /** 一次 ssh 子进程跑完并收 exit code（-O check/exit 用）。 */
  _sshOnce(args) {
    return new Promise((resolve) => {
      let child
      try {
        child = this._spawnSsh(args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (err) { resolve({ code: -1, err: String(err && err.message) }); return }
      let out = ''
      if (child.stdout) child.stdout.on('data', d => { out += d.toString('utf8') })
      const timer = setTimeout(() => { try { child.kill() } catch { /* */ } resolve({ code: -1, err: 'timeout' }) }, 10000)
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, err: String(err && err.message) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
    })
  }

  checkArgs(host) {
    const args = ['-i', host.identityFile]
    if (host.port && host.port !== 22) args.push('-p', String(host.port))
    if (!this.degraded) args.push('-o', 'ControlPath=' + this.sockPath(host))
    args.push('-O', 'check', this.target(host))
    return args
  }

  /**
   * 惰性建 master：check → 失败则清残留 socket → spawn -N master → poll check。
   * degraded（win32）直接 ok。并发调用共享同一 Promise。
   */
  ensureMaster(host) {
    if (this.degraded) {
      const s = this.stat(host.id)
      s.master = 'degraded'
      return Promise.resolve({ ok: true, degraded: true })
    }
    if (this.pending.has(host.id)) return this.pending.get(host.id)
    const p = this._ensureMasterInner(host).finally(() => this.pending.delete(host.id))
    this.pending.set(host.id, p)
    return p
  }

  async _ensureMasterInner(host) {
    const s = this.stat(host.id)
    const started = Date.now()
    const r0 = await this._sshOnce(this.checkArgs(host))
    if (r0.code === 0) {
      s.master = 'up'
      s.latencyMs = Date.now() - started
      s.establishedAt = s.establishedAt || Date.now()
      return { ok: true, reused: true }
    }
    // 清残留 socket
    try { fs.rmSync(this.sockPath(host), { force: true }) } catch { /* */ }
    try { fs.mkdirSync(this.cmDir, { recursive: true }) } catch { /* */ }
    const masterArgs = [...this.muxArgs(host), '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-N', this.target(host)]
    let child
    try {
      child = this._spawnSsh(masterArgs, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      s.lastError = 'spawn ssh 失败: ' + (err && err.message)
      return { ok: false, error: s.lastError }
    }
    let stderrBuf = ''
    if (child.stderr) child.stderr.on('data', d => { stderrBuf = (stderrBuf + d.toString('utf8')).slice(-2048) })
    child.on('exit', () => { if (this.stat(host.id).establishedAt === null) s.lastError = stderrBuf.trim().split(/\r?\n/).slice(-2).join(' | ') })
    const deadline = Date.now() + Math.max(this.connectFloorMs, (host.connectTimeoutSec || 15) * 2000 + 2000)
    for (;;) {
      await this._sleep(Math.max(10, this.probeIntervalMs * this.sleepMs))
      const c = await this._sshOnce(this.checkArgs(host))
      if (c.code === 0) {
        s.master = 'up'
        s.latencyMs = Date.now() - started
        s.establishedAt = Date.now()
        s.lastError = null
        return { ok: true }
      }
      if (Date.now() > deadline) {
        try { child.kill() } catch { /* */ }
        s.master = 'down'
        s.lastError = s.lastError || ('master 在 ' + (host.connectTimeoutSec || 15) * 2 + 's 内未就绪')
        return { ok: false, error: s.lastError }
      }
    }
  }

  /** 操作前调用：master 失效则重建一次；degraded 直通。 */
  async beforeOp(host) {
    const r = await this.ensureMaster(host)
    if (r.ok && !r.degraded) this.stat(host.id).commands += 1
    return r
  }

  async teardown(host) {
    if (this.degraded) return
    const r = await this._sshOnce([...this.checkArgs(host).slice(0, -3), '-O', 'exit', this.target(host)])
    const s = this.stat(host.id)
    s.master = 'down'
    s.establishedAt = null
    void r
  }

  async teardownAll(hosts) {
    for (const h of hosts) await this.teardown(h)
  }

  view() {
    return [...this.stats.entries()].map(([id, s]) => ({ id, ...s }))
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const h = setTimeout(resolve, Math.max(1, ms))
      if (h.unref) h.unref()
    })
  }
}
```

- [ ] **Step 5.4: main 中调用 t5 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T5 组 16 项全 PASS，累计 `结果: 55 通过, 0 失败`。

- [ ] **Step 5.5: Commit**

```bash
git add lib/connection.js scripts/smoke-test.mjs
git commit -m "feat(connection): ControlMaster 惰性建连/check/拆除/win32 降级 + 16 项冒烟"
```

---

### Task 6: fsops.js — read / write

**Files:**
- Modify: `lib/fsops.js`, `scripts/smoke-test.mjs`（追加 T6 组）

- [ ] **Step 6.1: 追加失败测试（T6 组）**

```js
// ================= T6 fsops read/write =================
import { FsOps } from '../lib/fsops.js'

async function t6() {
  console.log('== T6 fsops read/write ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/k', defaultCwd: '' }

  // read：复合命令 + 行号 + 二进制嗅探
  {
    const calls = []
    const fx = new FsOps({
      runner: {
        run: async (h, command, o) => {
          calls.push({ kind: 'run', command, o })
          return { exitCode: 0, stdout: '__SR__ abcdef0123 8000 8000\nline1\nline2\n', stderr: '', timedOut: false }
        },
        runWithStdin: async (h, script, o) => {
          calls.push({ kind: 'stdin', script, o })
          return { exitCode: 0, stdout: 'newhash', stderr: '', timedOut: false }
        },
      },
    })
    const r = await fx.read(H, '/etc/app.conf', { offset: 1, limit: 2 })
    check('T6.1 read 解析 META/行号', r.lines === 2 && r.content === '1\tline1\n2\tline2\n', JSON.stringify(r))
    check('T6.2 read sha 透传', r.sha256 === 'abcdef0123')
    check('T6.3 read 文本判定（8000=8000）', r.binary === false)
    check('T6.4 复合命令含 sed 窗口', calls[0].command.includes("sed -n '1,2p'") && calls[0].command.includes('sha256sum'))
    check('T6.5 路径单引号包裹', calls[0].command.includes("'/etc/app.conf'"))

    // 文本文件
    const fx2 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '__SR__ h1 100 100\nbeta\ngamma\n', stderr: '', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false }),
      },
    })
    const r2 = await fx2.read(H, '/a.txt', { offset: 2, limit: 2 })
    check('T6.6 offset 窗口行号', r2.content === '2\tbeta\n3\tgamma\n', JSON.stringify(r2))
    check('T6.7 文件非二进制', r2.binary === false)

    // 二进制拒绝
    const fxB = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '__SR__ abcdef0123 8192 8000\n\x00\x01bin\n', stderr: '', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let binErr = null
    try { await fxB.read(H, '/b.bin', {}) } catch (e) { binErr = e }
    check('T6.3b 二进制拒绝读取', binErr && binErr.kind === 'binary-rejected', String(binErr))

    // not-found 分类
    const fx3 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 1, stdout: '', stderr: 'cat: /nope: No such file or directory', errorKind: 'not-found', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let err = null
    try { await fx3.read(H, '/nope', {}) } catch (e) { err = e }
    check('T6.8 not-found 抛错', err && err.kind === 'not-found', String(err))
  }

  // write：stdin → tmp → mv 原子替换 + mkdirs
  {
    const calls = []
    const fx = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        runWithStdin: async (h, script, o) => { calls.push({ script, stdin: o.stdin }); return { exitCode: 0, stdout: 'deadbeef'.repeat(8), stderr: '', timedOut: false } },
      },
    })
    const r = await fx.write(H, '/srv/app/conf.yml', 'key: 1\n', { mkdirs: true })
    check('T6.9 write 返回新 sha', r.sha256 === 'deadbeef'.repeat(8))
    check('T6.10 write 脚本 mkdir+tmp+mv', calls[0].script.includes('mkdir -p') && calls[0].script.includes('__tmp__') && calls[0].script.includes('mv '), calls[0].script)
    check('T6.11 write stdin 是内容', calls[0].stdin === 'key: 1\n')
    // 不带 mkdirs
    calls.length = 0
    await fx.write(H, '/srv/x', 'v', {})
    check('T6.12 无 mkdirs 不建目录', !calls[0].script.includes('mkdir -p'))
  }
}
```

- [ ] **Step 6.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`does not provide an export named 'FsOps'`。

- [ ] **Step 6.3: 实现 lib/fsops.js（本任务先实现 read/write，下两个任务补 edit/glob/grep）**

```js
// dsh-ssh-remote — 远程文件语义：read（行号+二进制嗅探+sha）/ write（stdin 原子写）/
// edit（sha256 关键段）/ glob / grep。全部经 Runner（单参数直传远端 shell）。
import { randomBytes } from 'node:crypto'
import { shellQuote as q } from './exec.js'

export class FsOpsError extends Error {
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

function toFsError(result, fallback) {
  const kind = result.errorKind || fallback || 'remote-error'
  const msg = (result.stderr || result.stdout || ('exit ' + result.exitCode)).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
  return new FsOpsError(msg, kind)
}

export class FsOps {
  constructor({ runner }) {
    this.runner = runner
  }

  /**
   * 读文件窗口。远端单条复合命令：
   *   h=$(sha256sum f); a=$(head -c 8192 f|wc -c); b=$(同去 NUL|wc -c); echo __SR__ h a b; sed -n 'o,ep' f
   * a!==b ⇒ 前 8KB 有 NUL ⇒ 二进制。返回 {content 行号文本, lines, sha256, binary}。
   */
  async read(host, filePath, { offset = 1, limit = 2000 } = {}) {
    const f = q(filePath)
    const o = Math.max(1, Math.floor(offset))
    const e = o + Math.max(1, Math.floor(limit)) - 1
    const cmd = 'h=$(sha256sum ' + f + " 2>/dev/null | cut -d' ' -f1); a=$(head -c 8192 " + f + ' 2>/dev/null | wc -c); b=$(head -c 8192 ' + f + " 2>/dev/null | tr -d '\\0' | wc -c); echo \"__SR__ $h $a $b\"; sed -n '" + o + ',' + e + "p' " + f
    const r = await this.runner.run(host, cmd, {})
    if (r.exitCode !== 0) throw toFsError(r, 'not-found')
    const lines = r.stdout.split('\n')
    const meta = (lines.shift() || '').split(' ')
    if (meta[0] !== '__SR__') throw new FsOpsError('远端返回缺少 __SR__ 元信息头', 'parse-error')
    const sha256 = meta[1] && meta[1] !== '' ? meta[1] : null
    const a = Number(meta[2]) || 0
    const b = Number(meta[3]) || 0
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const binary = a > 0 && a !== b
    if (binary) throw new FsOpsError('二进制文件（前 8KB 含 NUL），拒绝读取: ' + filePath, 'binary-rejected')
    const content = lines.map((l, i) => (o + i) + '\t' + l).join('\n') + (lines.length ? '\n' : '')
    return { path: filePath, lines: lines.length, windowStart: o, content, sha256, binary: false }
  }

  /** 全量读（edit 用，1MB 上限）。 */
  async readWhole(host, filePath) {
    const f = q(filePath)
    const cmd = 'h=$(sha256sum ' + f + " 2>/dev/null | cut -d' ' -f1); s=$(wc -c < " + f + ' 2>/dev/null); echo "__SR__ $h $s"; cat ' + f
    const r = await this.runner.run(host, cmd, {})
    if (r.exitCode !== 0) throw toFsError(r, 'not-found')
    const lines = r.stdout.split('\n')
    const meta = (lines.shift() || '').split(' ')
    if (meta[0] !== '__SR__') throw new FsOpsError('远端返回缺少 __SR__ 元信息头', 'parse-error')
    const size = Number(meta[2]) || 0
    if (size > 1048576) throw new FsOpsError('文件超过 1MB，不支持编辑: ' + filePath, 'file-too-large')
    if (r.stdout.includes('\0')) throw new FsOpsError('二进制文件，拒绝编辑: ' + filePath, 'binary-rejected')
    // join('\n') 恰好保留结尾换行的有无（往返保真，edit 需要精确原文）
    const body = lines.join('\n')
    return { sha256: meta[1] || null, content: body }
  }

  /** 全量覆写：stdin → 同目录 tmp → mv 原子替换；mkdirs 可选建父目录。 */
  async write(host, filePath, content, { mkdirs = false } = {}) {
    const f = q(filePath)
    const rand = randomBytes(6).toString('hex')
    const pre = mkdirs ? 'd=$(dirname ' + f + '); mkdir -p "$d" || exit 71; ' : ''
    const script = pre
      + 't=' + f + '.__tmp__' + rand + '; '
      + 'cat > "$t" || { rm -f "$t"; exit 70; }; '
      + 'mv "$t" ' + f + ' || { rm -f "$t"; exit 70; }; '
      + 'sha256sum ' + f + " | cut -d' ' -f1"
    const r = await this.runner.runWithStdin(host, script, { stdin: content })
    if (r.exitCode !== 0) throw toFsError(r, 'write-failed')
    const sha = (r.stdout || '').trim().split(/\s+/).pop()
    return { path: filePath, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null }
  }
}
```

- [ ] **Step 6.4: main 中调用 t6 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T6 组 12 项全 PASS，累计 `结果: 67 通过, 0 失败`。

- [ ] **Step 6.5: Commit**

```bash
git add lib/fsops.js scripts/smoke-test.mjs
git commit -m "feat(fsops): read 复合命令(行号/二进制嗅探/sha) + write 原子覆写 + 12 项冒烟"
```

---

### Task 7: fsops.js — edit 防冲突关键段

**Files:**
- Modify: `lib/fsops.js`（追加 edit 方法）, `scripts/smoke-test.mjs`（追加 T7 组）

- [ ] **Step 7.1: 追加失败测试（T7 组）**

```js
// ================= T7 fsops edit =================
function editHarness(wholeStdout, stdinResult) {
  const calls = []
  const fx = new FsOps({
    runner: {
      run: async (h, command, o) => { calls.push({ kind: 'run', command }); return { exitCode: 0, stdout: wholeStdout, stderr: '', timedOut: false } },
      runWithStdin: async (h, script, o) => { calls.push({ kind: 'stdin', script, stdin: o.stdin }); return stdinResult },
    },
  })
  return { fx, calls }
}

async function t7() {
  console.log('== T7 fsops edit ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/k', defaultCwd: '' }
  const SHA_A = 'a'.repeat(64)
  const SHA_B = 'b'.repeat(64)
  const whole = '__SR__ ' + SHA_A + ' 100\nhello world\nfoo = 1\n'

  // 正常编辑
  {
    const { fx, calls } = editHarness(whole, { exitCode: 0, stdout: SHA_B, stderr: '', timedOut: false })
    const r = await fx.edit(H, '/a.conf', 'foo = 1', 'foo = 2', {})
    check('T7.1 edit 成功返回替换数与 sha', r.replaced === 1 && r.sha256 === SHA_B)
    check('T7.2 关键段含期望 sha 校验', calls[1].script.includes(SHA_A) && calls[1].script.includes('sha256sum'), calls[1].script)
    check('T7.3 关键段 stale 退出码 75', calls[1].script.includes('exit 75'))
    check('T7.4 新内容走 stdin', calls[1].stdin === 'hello world\nfoo = 2\n', JSON.stringify(calls[1].stdin))

    // oldString 不存在
    let e1 = null
    try { await fx.edit(H, '/a.conf', 'nope', 'x', {}) } catch (e) { e1 = e }
    check('T7.5 未匹配报错', e1 && e1.kind === 'not-found', String(e1))

    // 多处匹配未开 replaceAll
    const whole2 = '__SR__ ' + SHA_A + ' 100\naa\naa\n'
    const h2res = { exitCode: 0, stdout: SHA_B, stderr: '', timedOut: false }
    const fx2 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: whole2, stderr: '', timedOut: false }),
        runWithStdin: async (h, s, o) => { calls.push({ kind: 'stdin2', script: s, stdin: o.stdin }); return h2res },
      },
    })
    let e2 = null
    try { await fx2.edit(H, '/b', 'aa', 'bb', {}) } catch (e) { e2 = e }
    check('T7.6 非唯一报错', e2 && e2.kind === 'not-unique', String(e2))

    // replaceAll
    const r3 = await fx2.edit(H, '/b', 'aa', 'bb', { replaceAll: true })
    check('T7.7 replaceAll 全替换', r3.replaced === 2 && calls.some(c => c.stdin === 'bb\nbb\n'))
  }

  // stale：远端文件在读取后被改 → exit 75 → stale-edit
  {
    const { fx } = editHarness(whole, { exitCode: 75, stdout: '', stderr: '', timedOut: false })
    let e = null
    try { await fx.edit(H, '/a.conf', 'foo = 1', 'foo = 2', {}) } catch (err) { e = err }
    check('T7.8 exit 75 → stale-edit', e && e.kind === 'stale-edit', String(e))
  }
}
```

- [ ] **Step 7.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`fx.edit is not a function`。

- [ ] **Step 7.3: 在 FsOps 类中追加 edit 方法**

```js
  /**
   * 字面量替换编辑（乐观并发）：
   *  1) readWhole 拿全文 + sha256；
   *  2) 本地字面量替换（默认必须唯一命中）；
   *  3) 远端关键段：stdin 先落 tmp → 校验原文件 sha 未变 → 原子 mv；变了 exit 75。
   */
  async edit(host, filePath, oldString, newString, { replaceAll = false } = {}) {
    if (!oldString) throw new FsOpsError('oldString 不能为空', 'bad-args')
    const whole = await this.readWhole(host, filePath)
    const count = whole.content.split(oldString).length - 1
    if (count === 0) throw new FsOpsError('oldString 在 ' + filePath + ' 中未找到', 'not-found')
    if (count > 1 && !replaceAll) throw new FsOpsError('oldString 命中 ' + count + ' 处（需唯一或 replaceAll）', 'not-unique')
    const next = replaceAll
      ? whole.content.split(oldString).join(newString)
      : whole.content.replace(oldString, newString)
    const f = q(filePath)
    const rand = randomBytes(6).toString('hex')
    const script = 't=' + f + '.__tmp__' + rand + '; '
      + 'cat > "$t" || { rm -f "$t"; exit 70; }; '
      + 'if [ "$(sha256sum ' + f + " | cut -d' ' -f1)\" = '" + (whole.sha256 || '') + "' ]; then mv \"$t\" " + f + '; else rm -f "$t"; exit 75; fi; '
      + 'sha256sum ' + f + " | cut -d' ' -f1"
    const r = await this.runner.runWithStdin(host, script, { stdin: next })
    if (r.exitCode === 75) throw new FsOpsError(filePath + ' 在读取后已被修改（远端 sha256 不符），请重新 read 后再编辑', 'stale-edit')
    if (r.exitCode !== 0) throw toFsError(r, 'edit-failed')
    const sha = (r.stdout || '').trim().split(/\s+/).pop()
    return { path: filePath, replaced: replaceAll ? count : 1, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null }
  }
```

- [ ] **Step 7.4: main 中调用 t7 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T7 组 8 项全 PASS，累计 `结果: 75 通过, 0 失败`。

- [ ] **Step 7.5: Commit**

```bash
git add lib/fsops.js scripts/smoke-test.mjs
git commit -m "feat(fsops): edit sha256 防冲突关键段（exit 75 stale）+ 8 项冒烟"
```

---

### Task 8: fsops.js — glob / grep

**Files:**
- Modify: `lib/fsops.js`（追加 glob/grep）, `scripts/smoke-test.mjs`（追加 T8 组）

- [ ] **Step 8.1: 追加失败测试（T8 组）**

```js
// ================= T8 fsops glob/grep =================
async function t8() {
  console.log('== T8 fsops glob/grep ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/k', defaultCwd: '' }
  const calls = []
  const mk = (stdout) => new FsOps({
    runner: {
      run: async (h, command) => { calls.push(command); return { exitCode: 0, stdout, stderr: '', timedOut: false } },
      runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    },
  })

  calls.length = 0
  const g = await mk('/a.js\n/b.js\n/c.js\n').glob(H, '*.js', { path: '/srv', maxDepth: 3 })
  check('T8.1 glob 返回文件数组', g.files.length === 3 && g.files[0] === '/a.js')
  check('T8.2 glob 命令 find/-maxdepth/-name', calls[0].includes('find') && calls[0].includes('-maxdepth 3') && calls[0].includes("'*.js'") && calls[0].includes("'/srv'"))
  check('T8.3 glob 上限截断标记', (await mk(Array.from({ length: 205 }, (_, i) => '/f' + i).join('\n') + '\n').glob(H, '*', { path: '/', maxDepth: 1 })).truncated === true)

  calls.length = 0
  const gr = await mk('/a.js:3:foo()\n/a.js:9:bar\n').grep(H, 'foo\\(', { path: '/srv', include: '*.js' })
  check('T8.4 grep 返回行数组', gr.matches.length === 2)
  check('T8.5 grep 命令 -rnE/--include/--exclude-dir', calls[0].includes('grep -rnE') && calls[0].includes("--include='*.js'") && calls[0].includes('--exclude-dir=.git'))
  calls.length = 0
  await mk('x\n').grep(H, 'y', { path: '/srv', ignoreCase: true })
  check('T8.6 ignoreCase 加 -i', calls[0].includes('-i'))
  check('T8.7 grep 上限 250', (await mk(Array.from({ length: 255 }, () => 'm').join('\n') + '\n').grep(H, 'm', { path: '/' })).truncated === true)
}
```

- [ ] **Step 8.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`fx.glob is not a function`。

- [ ] **Step 8.3: 在 FsOps 追加 glob/grep 方法**

```js
  /** 远端 find：文件路径数组（上限 200，超出标 truncated）。 */
  async glob(host, pattern, { path: root = '.', maxDepth = 3 } = {}) {
    const n = Math.max(1, Math.min(10, Math.floor(maxDepth)))
    const cmd = 'find ' + q(root) + ' -maxdepth ' + n + ' -name ' + q(pattern) + ' -type f 2>/dev/null | sort | head -201'
    const r = await this.runner.run(host, cmd, {})
    if (r.exitCode !== 0) throw toFsError(r, 'glob-failed')
    const files = r.stdout.split('\n').filter(Boolean)
    const truncated = files.length > 200
    return { files: truncated ? files.slice(0, 200) : files, truncated }
  }

  /** 远端 grep -rnE（POSIX ERE）；上限 250 行，超出标 truncated。 */
  async grep(host, pattern, { path: root = '.', include = '', ignoreCase = false } = {}) {
    const parts = ['grep -rnE']
    if (ignoreCase) parts.push('-i')
    parts.push('--', q(pattern), q(root))
    if (include) parts.push('--include=' + q(include))
    parts.push('--exclude-dir=.git')
    const cmd = parts.join(' ') + ' 2>/dev/null | head -251'
    const r = await this.runner.run(host, cmd, {})
    if (r.exitCode !== 0 && r.exitCode !== 1) throw toFsError(r, 'grep-failed')
    const matches = r.stdout.split('\n').filter(Boolean)
    const truncated = matches.length > 250
    return { matches: truncated ? matches.slice(0, 250) : matches, truncated }
  }
```

- [ ] **Step 8.4: main 中调用 t8 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T8 组 7 项全 PASS，累计 `结果: 82 通过, 0 失败`。

- [ ] **Step 8.5: Commit**

```bash
git add lib/fsops.js scripts/smoke-test.mjs
git commit -m "feat(fsops): glob/grep 远端搜索（上限截断标记）+ 7 项冒烟"
```

---

### Task 9: transfer.js — scp 单文件 / tar 目录推拉

**Files:**
- Modify: `lib/transfer.js`, `scripts/smoke-test.mjs`（追加 T9 组）

- [ ] **Step 9.1: 追加失败测试（T9 组）**

```js
// ================= T9 transfer =================
import { Transfer } from '../lib/transfer.js'

async function t9() {
  console.log('== T9 transfer ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 2222, identityFile: '/k', defaultCwd: '' }
  const conn = {
    scpArgs: () => ['-i', '/k', '-o', 'ControlPath=/tmp/x.sock'],
    target: () => 'root@1.2.3.4',
  }
  const runCalls = []
  const runner = { run: async (h, c) => { runCalls.push(c); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } }

  // 单文件推：scp -P 2222
  {
    const log = []
    const tr = new Transfer({ conn, runner, spawnFn: recordingSpawn(log), sleepMs: 1 })
    const p = tr.push(H, '/local/a.js', '/srv/a.js', {})
    setTimeout(() => log[0].child.emitClose(0), 5)
    const r = await p
    check('T9.1 scp 推成功', r.exitCode === 0)
    check('T9.2 scp 用 -P 大写端口', log[0].cmd === 'scp' && log[0].args.includes('-P') && log[0].args.includes('2222'))
    check('T9.3 scp 目标 user@host:remote', log[0].args.includes('root@1.2.3.4:/srv/a.js'))
    check('T9.4 scp 复用 ControlPath', log[0].args.includes('ControlPath=/tmp/x.sock'))
  }

  // 目录推：mkdir -p + tar|ssh 管道
  {
    const log = []
    const tr = new Transfer({ conn, runner, spawnFn: recordingSpawn(log), sleepMs: 1 })
    const p = tr.push(H, '/local/dir', '/srv/dir', { recursive: true })
    setTimeout(() => { log.find(e => e.cmd === 'tar').child.emitClose(0); log.find(e => e.cmd === 'ssh').child.emitClose(0) }, 10)
    const r = await p
    check('T9.5 目录推成功', r.exitCode === 0)
    check('T9.6 先 mkdir -p 远端目录', runCalls.some(c => c.includes('mkdir -p') && c.includes("'/srv/dir'")))
    const tar = log.find(e => e.cmd === 'tar')
    const ssh = log.find(e => e.cmd === 'ssh' && e.args.some(a => String(a).includes('tar -C')))
    check('T9.7 本地 tar -C -cf -', tar && tar.args.join(' ').includes('-C /local/dir') && tar.args.includes('-cf') && tar.args.includes('-'))
    check('T9.8 远端 tar -C 解包', ssh && ssh.args.join(' ').includes("tar -C '/srv/dir' -xf -"))
  }

  // 单文件拉
  {
    const log = []
    const tr = new Transfer({ conn, runner, spawnFn: recordingSpawn(log), sleepMs: 1 })
    const p = tr.pull(H, '/srv/a.js', '/local/a.js', {})
    setTimeout(() => log[0].child.emitClose(0), 5)
    const r = await p
    check('T9.9 scp 拉成功', r.exitCode === 0 && log[0].args.includes('root@1.2.3.4:/srv/a.js') && log[0].args.includes('/local/a.js'))
  }

  // 超时双杀
  {
    const log = []
    const tr = new Transfer({ conn, runner, spawnFn: recordingSpawn(log), sleepMs: 1 })
    const r = await tr.push(H, '/local/dir', '/srv/dir', { recursive: true, timeoutMs: 80 })
    check('T9.10 超时标记且双杀', r.timedOut === true && log.every(e => e.child.killed), JSON.stringify(r))
  }
}
```

- [ ] **Step 9.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`does not provide an export named 'Transfer'`。

- [ ] **Step 9.3: 实现 lib/transfer.js**

```js
// dsh-ssh-remote — 文件传输：单文件 scp（端口 -P 大写）；目录 tar-over-ssh 双进程管道。
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { shellQuote as q } from './exec.js'

export class Transfer {
  constructor({ conn, runner, spawnFn, sleepMs = 1 }) {
    this.conn = conn
    this.runner = runner
    this.spawnFn = spawnFn || ((cmd, args, o) => cp.spawn(cmd, args, o))
    this.sleepMs = sleepMs
  }

  /** push/pull 统一入口。 */
  push(host, localPath, remotePath, { recursive = false, timeoutMs } = {}) {
    return recursive ? this.pushDir(host, localPath, remotePath, timeoutMs) : this.pushFile(host, localPath, remotePath, timeoutMs)
  }
  pull(host, remotePath, localPath, { recursive = false, timeoutMs } = {}) {
    return recursive ? this.pullDir(host, remotePath, localPath, timeoutMs) : this.pullFile(host, remotePath, localPath, timeoutMs)
  }

  async pushFile(host, localPath, remotePath, timeoutMs) {
    const args = [...this.conn.scpArgs(host)]
    if (host.port && host.port !== 22) args.push('-P', String(host.port))
    args.push(String(localPath), this.conn.target(host) + ':' + String(remotePath))
    return this._runScp(args, timeoutMs)
  }

  async pullFile(host, remotePath, localPath, timeoutMs) {
    const args = [...this.conn.scpArgs(host)]
    if (host.port && host.port !== 22) args.push('-P', String(host.port))
    args.push(this.conn.target(host) + ':' + String(remotePath), String(localPath))
    return this._runScp(args, timeoutMs)
  }

  /** 目录推：mkdir -p 远端 → 本地 tar 打包 stdout 接 ssh stdin。 */
  async pushDir(host, localDir, remoteDir, timeoutMs) {
    const mk = await this.runner.run(host, 'mkdir -p ' + q(remoteDir), {})
    if (mk.exitCode !== 0) return { exitCode: mk.exitCode, stderr: mk.stderr, durationMs: mk.durationMs, timedOut: false, errorKind: mk.errorKind }
    const remote = 'tar -C ' + q(remoteDir) + ' -xf -'
    return this._tarPipe(host,
      ['tar', '-C', String(localDir), '-cf', '-', '.'],
      remote, timeoutMs)
  }

  /** 目录拉：ssh tar 打包 stdout 接本地 tar stdin。 */
  async pullDir(host, remoteDir, localDir, timeoutMs) {
    try { fs.mkdirSync(String(localDir), { recursive: true }) } catch { /* */ }
    const remote = 'tar -C ' + q(remoteDir) + ' -cf - .'
    return this._tarPipe(host,
      ['tar', '-C', String(localDir), '-xf', '-'],
      remote, timeoutMs, { producer: 'ssh', consumer: 'tar' })
  }

  /** producer(本地 tar) → consumer(ssh)；pull 时反向。 */
  _tarPipe(host, tarArgs, remote, timeoutMs, { producer = 'tar', consumer = 'ssh' } = {}) {
    return new Promise((resolve) => {
      const started = Date.now()
      // 组装：ssh [opts] target 'remote-script'
      const sshArgv = [...this.conn.scpArgs(host), this.conn.target(host), remote]
      let producerChild, consumerChild
      try {
        const tarSpawnOpts = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        if (producer === 'tar') {
          producerChild = this.spawnFn('tar', tarArgs, tarSpawnOpts)
          consumerChild = this.spawnFn('ssh', sshArgv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
          producerChild.stdout.pipe(consumerChild.stdin)
        } else {
          producerChild = this.spawnFn('ssh', sshArgv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
          consumerChild = this.spawnFn('tar', tarArgs, tarSpawnOpts)
          producerChild.stdout.pipe(consumerChild.stdin)
        }
      } catch (err) {
        resolve({ exitCode: -1, stderr: 'spawn 失败: ' + (err && err.message), durationMs: 0, timedOut: false, errorKind: 'spawn-error' })
        return
      }
      let stderr = ''
      const cap = (d) => { stderr = (stderr + d.toString('utf8')).slice(-8192) }
      if (producerChild.stderr) producerChild.stderr.on('data', cap)
      if (consumerChild.stderr) consumerChild.stderr.on('data', cap)
      const finish = (tag, code, extra) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ exitCode: code, stderr: (extra || '') + stderr, durationMs: Date.now() - started, timedOut: false })
      }
      let done = false
      const limit = Math.max(10000, Number(timeoutMs) || 180000)
      const timer = setTimeout(() => {
        done = true
        try { producerChild.kill() } catch { /* */ }
        try { consumerChild.kill() } catch { /* */ }
        resolve({ exitCode: -1, stderr: stderr + '\n[已超时 ' + limit + 'ms，双进程被终止]', durationMs: Date.now() - started, timedOut: true, errorKind: 'timed-out' })
      }, limit)
      consumerChild.on('close', (code) => finish('consumer', code))
      producerChild.on('close', (code) => { if (code !== 0) finish('producer', code) })
      producerChild.on('error', (e) => finish('producer', -1, String(e && e.message)))
      consumerChild.on('error', (e) => finish('consumer', -1, String(e && e.message)))
    })
  }

  _runScp(args, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now()
      let child
      try {
        child = this.spawnFn('scp', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ exitCode: -1, stderr: 'spawn scp 失败: ' + (err && err.message), durationMs: 0, timedOut: false, errorKind: 'spawn-error' })
        return
      }
      let stderr = ''
      if (child.stderr) child.stderr.on('data', d => { stderr = (stderr + d.toString('utf8')).slice(-8192) })
      const limit = Math.max(10000, Number(timeoutMs) || 180000)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* */ }
        resolve({ exitCode: -1, stderr: stderr + '\n[已超时 ' + limit + 'ms]', durationMs: Date.now() - started, timedOut: true, errorKind: 'timed-out' })
      }, limit)
      child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: -1, stderr: 'spawn scp 失败: ' + (err && err.message), durationMs: Date.now() - started, timedOut: false, errorKind: 'spawn-error' }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stderr, durationMs: Date.now() - started, timedOut: false }) })
    })
  }
}
```


- [ ] **Step 9.4: main 中调用 t9 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T9 组 10 项全 PASS，累计 `结果: 92 通过, 0 失败`。

- [ ] **Step 9.5: Commit**

```bash
git add lib/transfer.js scripts/smoke-test.mjs
git commit -m "feat(transfer): scp -P 单文件 + tar-over-ssh 目录推拉（超时双杀）+ 10 项冒烟"
```

---

### Task 10: index.js — Config / 装配 / 系统提示 / 10 工具

**Files:**
- Modify: `lib/index.js`, `scripts/smoke-test.mjs`（追加 T10 组）

- [ ] **Step 10.1: 追加失败测试（T10 组）**

```js
// ================= T10 index.js 工具装配 =================
import { apply } from '../lib/index.js'

function fakeCtx() {
  const registeredTools = []
  const sections = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { effects.push(fn); const d = fn(); return () => { if (typeof d === 'function') d() } },
    tools: { register(def) { registeredTools.push(def) } },
    systemPrompt: { section(s) { sections.push(s) } },
    inject(names, fn) { ctx._injects.push([names, fn]) },
    _injects: [],
    _registeredTools: registeredTools,
    _sections: sections,
    _effects: effects,
  }
  return ctx
}

async function t10() {
  console.log('== T10 index.js 工具装配 ==')
  const ctx = fakeCtx()
  apply(ctx, { hosts: [{ id: 't1', host: '1.2.3.4', identityFile: '/k' }], commandTimeoutMs: 1000, hostsFile: path.join(os.tmpdir(), 'ssh-remote-t10-' + Date.now() + '.json') })
  const names = ctx._registeredTools.map(t => t.name)
  const want = ['ssh_hosts', 'ssh_status', 'ssh_run', 'ssh_read', 'ssh_write', 'ssh_edit', 'ssh_glob', 'ssh_grep', 'ssh_push', 'ssh_pull']
  check('T10.1 十个工具注册', want.every(n => names.includes(n)), names.join(','))
  check('T10.2 系统提示注册', ctx._sections.length === 1 && ctx._sections[0].name === 'ssh-remote' && ctx._sections[0].text.includes('ssh_hosts'))
  check('T10.3 生命周期 effect', ctx._effects.length >= 1)

  // ssh_hosts / ssh_status 可执行
  const hostsTool = ctx._registeredTools.find(t => t.name === 'ssh_hosts')
  const hv = await hostsTool.execute({})
  check('T10.4 ssh_hosts 返回主机', hv.hosts.length === 1 && hv.hosts[0].id === 't1')

  // ssh_run：经 fake spawn（真实 Runner）——unreachable 分类路径
  // （HTTP 与 probe 的 fake webServer 由 T11 覆盖；此处验证 pickHost 错误）
  const runTool = ctx._registeredTools.find(t => t.name === 'ssh_run')
  let e1 = null
  try { await runTool.execute({ hostId: 'nope', command: 'x' }) } catch (e) { e1 = e }
  check('T10.5 未知 hostId 报错', e1 && String(e1.message).includes('t1'))
  let e2 = null
  try { await runTool.execute({ command: '' }) } catch (e) { e2 = e }
  check('T10.6 空 command 报错', e2 !== null)
}
```

- [ ] **Step 10.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——占位 index.js 无 `apply` 导出（import 报错）。

- [ ] **Step 10.3: 实现 lib/index.js（本任务实现 Config/装配/工具；HTTP API 下一任务）**

```js
// dsh-ssh-remote — 宿主端入口：Config、装配、生命周期、系统提示、10 个 Agent 工具、回环 HTTP API。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { HostRegistry } from './hosts.js'
import { ConnectionManager } from './connection.js'
import { Runner } from './exec.js'
import { FsOps, FsOpsError } from './fsops.js'
import { Transfer } from './transfer.js'

export const name = 'ssh-remote'
export const inject = ['tools', 'webServer', 'systemPrompt']

export const Config = z.object({
  hosts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    host: z.string(),
    user: z.string().default('root'),
    port: z.number().default(22),
    identityFile: z.string(),
    jump: z.string().default(''),
    defaultCwd: z.string().default(''),
    connectTimeoutSec: z.number().default(15),
    controlPersistSec: z.number().default(600),
  })).default([]),
  commandTimeoutMs: z.number().default(60000),
  hostsFile: z.string().default(path.join(homedir(), '.dsh', 'ssh-remote', 'hosts.json')),
})

const SYSTEM_PROMPT = [
  '<ssh_remote_guide>',
  '本机装有 SSH 远程工具插件（dsh-ssh-remote）：可在配置的远程 Linux 主机上执行命令、读写编辑文件、搜索、传输。',
  '工作流：',
  '1. 远程任务开始时先调 ssh_hosts 查看可用主机（id/名称/地址）。',
  '2. 远程命令用 ssh_run(hostId=..., command=...)（远端 bash 解释，带超时）；不要手工拼 ssh 命令行。',
  '3. 远程文件：ssh_read（带行号）/ ssh_write（全量覆写）/ ssh_edit（字面量替换，防冲突）。',
  '4. 远程定位：ssh_glob（find）/ ssh_grep（POSIX ERE 正则）。',
  '5. 传输：ssh_push / ssh_pull（recursive=true 走目录）。本地文件仍用本地工具。',
  '</ssh_remote_guide>',
].join('\n')

function fmtErr(err) {
  return { ok: false, error: { kind: err && err.kind ? err.kind : 'error', message: String((err && err.message) || err) } }
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const registry = new HostRegistry({ staticHosts: cfg.hosts || [], hostsFile: cfg.hostsFile, logger: ctx.logger })
  const conn = new ConnectionManager({})
  const runner = new Runner({
    muxArgs: (h) => conn.muxArgs(h),
    target: (h) => conn.target(h),
    defaults: { commandTimeoutMs: cfg.commandTimeoutMs },
  })
  const fsops = new FsOps({ runner })
  const transfer = new Transfer({ conn, runner })

  const pick = (id) => {
    const h = registry.pick(id)
    conn.resolveJump(h, registry)
    return h
  }
  /** 先保证 master（best-effort），再执行；FsOpsError 结构化返回。 */
  const withHost = async (id, fn) => {
    const h = pick(id)
    const ready = await conn.beforeOp(h)
    if (!ready.ok && !ready.degraded) return fmtErr(new Error(ready.error || '连接失败'))
    try {
      return await fn(h)
    } catch (err) {
      return fmtErr(err instanceof FsOpsError ? err : err)
    }
  }

  ctx.effect(() => {
    registry.startWatch()
    return () => { registry.stopWatch(); conn.teardownAll(registry.list()) }
  }, 'ssh-remote: lifecycle')

  try {
    ctx.systemPrompt.section({ name: 'ssh-remote', order: 121, text: SYSTEM_PROMPT })
  } catch (err) { ctx.logger?.warn?.('[ssh-remote] 系统提示注册失败: ' + (err && err.message)) }

  const jsonOut = { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] }
  const textOut = (pick2) => ({ schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: pick2(v) }] })

  try {
    ctx.tools.register(defineTool({
      name: 'ssh_hosts',
      description: '列出可用 SSH 远程主机（id/名称/地址/来源 static|dynamic/是否默认跳板引用），远程任务开始时先调用本工具。',
      parameters: {},
      output: jsonOut,
      async execute() {
        return { hosts: registry.list().map(h => ({ id: h.id, name: h.name, host: h.host, user: h.user, port: h.port, jump: h.jump || null, defaultCwd: h.defaultCwd || null, source: h.source })), validationErrors: registry.validationErrors() }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_status',
      description: 'SSH 连接池状态：每主机 ControlMaster 状态（up/down/degraded）、延迟、命令数、最后错误。',
      parameters: {},
      output: jsonOut,
      async execute() { return { connections: conn.view(), degraded: conn.degraded } },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_run',
      description: '在远程主机执行命令（远端 bash 解释，单参数直传不经本地 shell）。返回 {exitCode, stdout, stderr, durationMs, timedOut}。cwd 可选（缺省用主机 defaultCwd）。',
      parameters: {
        hostId: { type: 'string', description: '主机 id（来自 ssh_hosts）；缺省第一条。' },
        command: { type: 'string', required: true, description: '远程命令（bash 语法）。' },
        cwd: { type: 'string', description: '工作目录（可选）。' },
        timeoutMs: { type: 'number', description: '超时毫秒（缺省插件配置）。' },
      },
      output: textOut(v => (v && v.ok === false) ? JSON.stringify(v) : ((v && v.stdout) || '') + (v && v.stderr ? '\n[stderr] ' + v.stderr : '') + '\n[exit ' + (v && v.exitCode) + ']'),
      async execute(args) {
        const a = args || {}
        if (!a.command) throw new Error('command 必填')
        return withHost(a.hostId, h => runner.run(h, String(a.command), { cwd: a.cwd, timeoutMs: a.timeoutMs }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_read',
      description: '读远程文本文件窗口（带行号，tab 分隔，格式同本地 read）。参数 offset（起始行，1 起）/ limit（行数，默认 2000）。二进制文件会被拒绝。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        path: { type: 'string', required: true, description: '远程文件绝对路径。' },
        offset: { type: 'number', description: '起始行（1 起）。' },
        limit: { type: 'number', description: '行数（默认 2000）。' },
      },
      output: textOut(v => (v && v.ok === false) ? JSON.stringify(v) : (v.content || '') + '\n[' + (v.lines || 0) + ' 行，sha256 ' + String(v.sha256 || '').slice(0, 12) + ']'),
      async execute(args) {
        const a = args || {}
        if (!a.path) throw new Error('path 必填')
        return withHost(a.hostId, h => fsops.read(h, String(a.path), { offset: a.offset, limit: a.limit }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_write',
      description: '全量覆写远程文件（stdin→临时文件→原子替换）。返回新 sha256。mkdirs=true 自动建父目录。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        path: { type: 'string', required: true, description: '远程文件绝对路径。' },
        content: { type: 'string', required: true, description: '完整新内容。' },
        mkdirs: { type: 'boolean', description: '自动创建父目录（默认 false）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.path || a.content === undefined) throw new Error('path 与 content 必填')
        return withHost(a.hostId, h => fsops.write(h, String(a.path), String(a.content), { mkdirs: Boolean(a.mkdirs) }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_edit',
      description: '远程文件字面量替换编辑（同本地 edit 语义）：oldString 默认需唯一命中；远端文件在读取后被改动会报 stale-edit，需重读重试。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        path: { type: 'string', required: true, description: '远程文件绝对路径。' },
        oldString: { type: 'string', required: true, description: '被替换文本（须与文件内容精确匹配）。' },
        newString: { type: 'string', description: '替换文本（空串=删除）。' },
        replaceAll: { type: 'boolean', description: '替换全部命中（默认 false）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.path || a.oldString === undefined) throw new Error('path 与 oldString 必填')
        return withHost(a.hostId, h => fsops.edit(h, String(a.path), String(a.oldString), String(a.newString || ''), { replaceAll: Boolean(a.replaceAll) }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_glob',
      description: '远程文件名匹配（远端 find -name）：返回匹配文件路径数组（上限 200，超出标 truncated）。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        pattern: { type: 'string', required: true, description: "glob 模式（如 '*.js'）。" },
        path: { type: 'string', description: '搜索根目录（缺省主机 defaultCwd 或 .）。' },
        maxDepth: { type: 'number', description: '最大深度（默认 3，上限 10）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.pattern) throw new Error('pattern 必填')
        return withHost(a.hostId, h => fsops.glob(h, String(a.pattern), { path: a.path, maxDepth: a.maxDepth }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_grep',
      description: '远程内容搜索（POSIX ERE 正则；grep -rnE）：返回 file:line:text 行数组（上限 250，超出标 truncated）。默认排除 .git。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        pattern: { type: 'string', required: true, description: 'POSIX ERE 正则。' },
        path: { type: 'string', description: '搜索根目录。' },
        include: { type: 'string', description: "文件名过滤 glob（如 '*.py'）。" },
        ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.pattern) throw new Error('pattern 必填')
        return withHost(a.hostId, h => fsops.grep(h, String(a.pattern), { path: a.path, include: a.include, ignoreCase: Boolean(a.ignoreCase) }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_push',
      description: '上传本地文件/目录到远程主机（单文件 scp；recursive=true 目录 tar-over-ssh）。返回 {exitCode, stderr, durationMs}。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        localPath: { type: 'string', required: true, description: '本地文件/目录绝对路径。' },
        remotePath: { type: 'string', required: true, description: '远程目标路径。' },
        recursive: { type: 'boolean', description: '目录递归（默认 false）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.localPath || !a.remotePath) throw new Error('localPath 与 remotePath 必填')
        return withHost(a.hostId, h => transfer.push(h, String(a.localPath), String(a.remotePath), { recursive: Boolean(a.recursive) }))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'ssh_pull',
      description: '从远程主机下载文件/目录到本地（单文件 scp；recursive=true 目录 tar-over-ssh，自动建本地父目录）。',
      parameters: {
        hostId: { type: 'string', description: '主机 id；缺省第一条。' },
        remotePath: { type: 'string', required: true, description: '远程文件/目录路径。' },
        localPath: { type: 'string', required: true, description: '本地目标路径。' },
        recursive: { type: 'boolean', description: '目录递归（默认 false）。' },
      },
      output: jsonOut,
      async execute(args) {
        const a = args || {}
        if (!a.remotePath || !a.localPath) throw new Error('remotePath 与 localPath 必填')
        return withHost(a.hostId, h => transfer.pull(h, String(a.remotePath), String(a.localPath), { recursive: Boolean(a.recursive) }))
      },
    }))
  } catch (err) {
    ctx.logger?.error?.('[ssh-remote] 工具注册失败: ' + (err && err.message))
    throw err
  }

  return { registry, conn, runner, fsops, transfer }
}
```

- [ ] **Step 10.4: main 中调用 t10 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T10 组 6 项全 PASS，累计 `结果: 98 通过, 0 失败`。

（注意：`apply` 会在 `ctx.inject(['webServer'], ...)` 尚未实现前不注册 HTTP——本任务先不写 HTTP 部分，fakeCtx 的 `_injects` 空数组即无操作；Task 11 补上。）

- [ ] **Step 10.5: Commit**

```bash
git add lib/index.js scripts/smoke-test.mjs
git commit -m "feat(index): Config/装配/生命周期/系统提示/10 工具 + 6 项冒烟"
```

---

### Task 11: index.js — 回环 HTTP API（status/hosts CRUD/import/probe）

**Files:**
- Modify: `lib/index.js`（追加 HTTP 注册与 settings-store 集成）, `scripts/smoke-test.mjs`（追加 T11 组）

- [ ] **Step 11.1: 追加失败测试（T11 组）**

```js
// ================= T11 HTTP API =================
async function t11() {
  console.log('== T11 HTTP API ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t11-'))
  const hostsFile = path.join(tmpDir, 'hosts.json')

  const ctx = fakeCtx()
  apply(ctx, { hosts: [], hostsFile })
  // 模拟 webServer inject
  const routes = []
  ctx._injects.forEach(([names, fn]) => {
    if (names.includes('webServer')) {
      fn({
        effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
        webServer: { register(entry) { routes.push(entry) } },
      })
    }
  })
  check('T11.1 路由注册', routes.length === 1 && routes[0].path === '/ssh-remote/api', JSON.stringify(routes.map(r => r.path)))
  const handler = routes[0].handler

  const mkRes = () => { const r = { headersSent: false }; r.writeHead = (s) => { r.status = s }; r.end = (b) => { r.body = b }; return r }

  // 回环守卫
  const res403 = mkRes()
  handler({ method: 'GET', url: '/ssh-remote/api/status', headers: { host: 'evil.com' } }, res403)
  check('T11.2 非回环 403', res403.status === 403)

  // hosts CRUD
  const resC = mkRes()
  handler({ method: 'POST', url: '/ssh-remote/api/hosts', headers: { host: '127.0.0.1:1' } }, resC, JSON.stringify({ id: 'd1', name: '动态机', host: '1.1.1.1', identityFile: '/k' }))
  // （handler 内部异步：等一拍）
  await sleep(30)
  check('T11.3 新增动态主机 200', resC.status === 200 && JSON.parse(resC.body).ok === true, resC.body)
  check('T11.4 落盘 hostsFile', readHostsFile(hostsFile).some(h => h.id === 'd1'))

  // bulk 替换
  const resB = mkRes()
  handler({ method: 'POST', url: '/ssh-remote/api/hosts/bulk', headers: { host: 'localhost' } }, resB, JSON.stringify({ hosts: [{ id: 'd2', host: '2.2.2.2', identityFile: '/k' }] }))
  await sleep(30)
  check('T11.5 bulk 替换动态集', readHostsFile(hostsFile).length === 1 && readHostsFile(hostsFile)[0].id === 'd2')

  // import 预览 + 提交
  const resI = mkRes()
  handler({ method: 'POST', url: '/ssh-remote/api/hosts/import', headers: { host: '127.0.0.1:1' } }, resI, JSON.stringify({ format: 'sshconfig', text: 'Host web\n  HostName 3.3.3.3\n  IdentityFile /k\n' }))
  await sleep(30)
  const pv = JSON.parse(resI.body)
  check('T11.6 import 预览不落盘', pv.ok === true && pv.value.preview.hosts.length === 1 && readHostsFile(hostsFile).length === 1, resI.body)
  const resI2 = mkRes()
  handler({ method: 'POST', url: '/ssh-remote/api/hosts/import', headers: { host: '127.0.0.1:1' } }, resI2, JSON.stringify({ format: 'sshconfig', text: 'Host web\n  HostName 3.3.3.3\n  IdentityFile /k\n', commit: true }))
  await sleep(30)
  check('T11.7 import 提交落盘', readHostsFile(hostsFile).some(h => h.id === 'web'))

  // DELETE
  const resD = mkRes()
  handler({ method: 'DELETE', url: '/ssh-remote/api/hosts/web', headers: { host: '127.0.0.1:1' } }, resD)
  await sleep(30)
  check('T11.8 删除动态主机', !readHostsFile(hostsFile).some(h => h.id === 'web'))

  // status 视图
  const resS = mkRes()
  handler({ method: 'GET', url: '/ssh-remote/api/status', headers: { host: '127.0.0.1:1' } }, resS)
  check('T11.9 status 200 带视图', resS.status === 200 && JSON.parse(resS.body).value.hosts !== undefined)

  // 静态保护
  const ctx2 = fakeCtx()
  apply(ctx2, { hosts: [{ id: 'st', host: 'h', identityFile: 'k' }], hostsFile: path.join(tmpDir, 'h2.json') })
  const routes2 = []
  ctx2._injects.forEach(([names, fn]) => names.includes('webServer') && fn({ effect(cb) { cb(); return () => {} }, webServer: { register: (e) => routes2.push(e) } }))
  const resDel2 = mkRes()
  routes2[0].handler({ method: 'DELETE', url: '/ssh-remote/api/hosts/st', headers: { host: '127.0.0.1:1' } }, resDel2)
  await sleep(30)
  check('T11.10 静态主机删除被拒', resDel2.status === 409, String(resDel2.status))

  fs.rmSync(tmpDir, { recursive: true, force: true })
}
```

- [ ] **Step 11.2: 跑测试确认失败**

Run: `node scripts/smoke-test.mjs`
Expected: FAIL——`T11.1 路由注册`（routes.length === 0，apply 尚无 HTTP 注册）。

- [ ] **Step 11.3: 在 apply() 末尾（return 之前）追加 HTTP API**

```js
  // ---- 回环 HTTP API ----
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/ssh-remote/api',
        handler: (req, res, body) => {
          const host = String(req.headers.host ?? '')
          const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
          if (!loopback) { respond(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } }); return }
          const url = new URL(req.url || '/', 'http://' + host)
          const p = url.pathname.replace(/\/+$/, '')
          const m = req.method
          // 说明：body 第三参仅测试注入路径；真实 HTTP 层走 req 流。

          if (m === 'GET' && p === '/ssh-remote/api/status') {
            respond(res, 200, { ok: true, value: { hosts: registry.list(), connections: conn.view(), validationErrors: registry.validationErrors(), degraded: conn.degraded } })
            return
          }
          if (m === 'GET' && p === '/ssh-remote/api/hosts') {
            respond(res, 200, { ok: true, value: registry.list() })
            return
          }
          if (m === 'POST' && p === '/ssh-remote/api/hosts') {
            readJson(req, body).then(body => {
              const r = addDynamicHost(body)
              respond(res, r.status, r.payload)
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (m === 'POST' && p === '/ssh-remote/api/hosts/bulk') {
            readJson(req, body).then(body => {
              const arr = Array.isArray(body && body.hosts) ? body.hosts : []
              const errs = []
              const cleaned = []
              for (const raw of arr) {
                const n = normalizeHost({ ...raw, source: 'dynamic' })
                if (n) cleaned.push(n)
                else errs.push('条目非法: ' + JSON.stringify(raw).slice(0, 80))
              }
              const conflicts = cleaned.filter(h => registry.source(h.id) === 'static').map(h => h.id)
              if (conflicts.length) {
                respond(res, 409, { ok: false, error: { code: 'static-conflict', message: '不可覆盖静态主机: ' + conflicts.join(', ') } })
                return
              }
              atomicWriteJson(registry.hostsFile, cleaned)
              registry.reload()
              respond(res, 200, { ok: true, value: registry.list() })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (m === 'POST' && p === '/ssh-remote/api/hosts/import') {
            readJson(req, body).then(async body => {
              const r = parseImport(String((body && body.text) || ''), String((body && body.format) || 'json'))
              if (body && body.commit) {
                const existing = readHostsFile(registry.hostsFile)
                const ids = new Set(existing.map(h => h.id))
                const stat = new Set(registry.list().filter(h => h.source === 'static').map(h => h.id))
                const add = r.hosts.filter(h => !ids.has(h.id) && !stat.has(h.id))
                atomicWriteJson(registry.hostsFile, [...existing, ...add.map(h => ({ ...h, source: undefined }))])
                registry.reload()
                respond(res, 200, { ok: true, value: { added: add.map(h => h.id), skipped: r.hosts.length - add.length, errors: r.errors, hosts: registry.list() } })
              } else {
                respond(res, 200, { ok: true, value: { preview: r } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          const delM = p.match(/^\/ssh-remote\/api\/hosts\/([a-z0-9_-]+)$/)
          if (m === 'DELETE' && delM) {
            const id = delM[1]
            if (registry.source(id) === 'static') { respond(res, 409, { ok: false, error: { code: 'static-conflict', message: '静态主机不可删除' } }); return }
            const remaining = readHostsFile(registry.hostsFile).filter(h => h.id !== id)
            atomicWriteJson(registry.hostsFile, remaining)
            registry.reload()
            respond(res, 200, { ok: true, value: registry.list() })
            return
          }
          if (m === 'POST' && p === '/ssh-remote/api/probe') {
            readJson(req, body).then(async body => {
              try {
                const h = pick(body && body.hostId)
                const started = Date.now()
                const r = await conn.ensureMaster(h)
                respond(res, 200, { ok: true, value: { hostId: h.id, ok: r.ok, degraded: !!r.degraded, latencyMs: Date.now() - started, error: r.error || null } })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: String((err && err.message) || err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
        },
      }), 'ssh-remote: http api')
    })
  } catch (err) { ctx.logger?.warn?.('[ssh-remote] HTTP API 注册失败: ' + (err && err.message)) }
```

并在文件顶部补 import、在 apply 内加辅助函数与依赖引入：

```js
import { normalizeHost } from './hosts.js'
import { atomicWriteJson, readHostsFile, parseImport } from './settings-store.js'
```

apply 内（HTTP 注册之前）加：

```js
  /** 新增单台动态主机（id 与静态/已有冲突则 409）。 */
  function addDynamicHost(body) {
    const n = body && typeof body === 'object' ? normalizeHost({ ...body, source: 'dynamic' }) : null
    if (!n) return { status: 400, payload: { ok: false, error: { code: 'bad-host', message: '主机字段非法（id [a-z0-9_-] / host / identityFile 必填）' } } }
    if (registry.list().some(h => h.id === n.id)) return { status: 409, payload: { ok: false, error: { code: 'conflict', message: 'id 已存在: ' + n.id } } }
    atomicWriteJson(registry.hostsFile, [...readHostsFile(registry.hostsFile), { ...body }])
    registry.reload()
    return { status: 200, payload: { ok: true, value: registry.list() } }
  }
```

文件底部追加 respond/readJson 辅助（dsh-ssh-tunnel 同款 + body 直接传第三参的测试兼容）：

```js
function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJson(req, bodyOverride) {
  if (bodyOverride !== undefined) return Promise.resolve(typeof bodyOverride === 'string' ? JSON.parse(bodyOverride) : (bodyOverride || {}))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}
```

测试 fakeRes 需要把第三参透传：T11 测试里 handler 调用时传了第三参（body 字符串）——真实 HTTP 层不会传；readJson 的 bodyOverride 分支仅测试使用（生产不受影响）。

- [ ] **Step 11.4: main 中调用 t11 并跑通**

Run: `node scripts/smoke-test.mjs`
Expected: T11 组 10 项全 PASS，累计 `结果: 108 通过, 0 失败`。

- [ ] **Step 11.5: Commit**

```bash
git add lib/index.js scripts/smoke-test.mjs
git commit -m "feat(api): 回环 HTTP API（status/hosts CRUD/bulk/import/probe，静态保护）+ 10 项冒烟"
```

---

### Task 12: client — 状态胶囊 + 面板

**Files:**
- Create: `client/index.js`
- Modify: `package.json`（files 已含 client/**/*.js，无需改）

本任务无 fake 浏览器测试；验证 = `node --check` + 安装后人工冒烟（Task 14 收尾登记）。

- [ ] **Step 12.1: 写 client/index.js（胶囊 + 面板）**

```js
// dsh-ssh-remote — browser half（全行内样式，零全局副作用）。
// 会话头部「SSH」胶囊：绿=全部主机可达 / 红=有不可达 / 灰=无主机。
// 浮窗：每主机状态行（连通性探测/打开设置）+ 刷新。
window.__ModuleLoader__.load({
  id: 'dsh-ssh-remote',
  factory: function (require) {
    var React = require('react')
    var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useCallback = React.useCallback

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    var S = {
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 999, background: 'transparent', color: 'var(--dsw-alias-label-secondary,#999)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: 1.8, whiteSpace: 'nowrap', position: 'relative' },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      panel: { position: 'fixed', zIndex: 2000, maxWidth: '92vw', maxHeight: '70vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,#1f1f1f)', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,.4)', padding: '10px 12px', font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)', textAlign: 'left' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l1,#88888866)' },
      ttl: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary,inherit)' },
      close: { font: 'inherit', fontSize: 14, lineHeight: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 6, margin: '1px 0', borderBottom: '1px solid var(--dsw-alias-border-l1,#88888866)' },
      nm: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-primary,inherit)', fontWeight: 600 },
      sub: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#888)', marginTop: 2, wordBreak: 'break-all' },
      badge: { fontSize: 10, padding: '1px 5px', borderRadius: 999, flex: '0 0 auto' },
      btn: { flex: '0 0 auto', font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer', marginLeft: 4 },
      actions: { display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 2px' },
      err: { color: '#e5484d', fontSize: 11, marginTop: 4, wordBreak: 'break-all' },
      empty: { color: 'var(--dsw-alias-label-tertiary,#888)', padding: '8px 4px', fontSize: 11 },
    }

    function postJson(url, body) {
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json() })
    }

    function SshRemoteUtility() {
      var wrapRef = useRef(null)
      var stateRef = useRef({})
      var render = useState(0)[1]
      stateRef.current = stateRef.current || { data: null, error: null, open: false, pos: null, probing: {} }

      var refresh = useCallback(function () {
        fetch('/ssh-remote/api/status').then(function (r) { return r.json() }).then(function (res) {
          stateRef.current.error = res && res.ok ? null : 'status failed'
          stateRef.current.data = res && res.ok ? res.value : stateRef.current.data
          render(function (n) { return n + 1 })
        }).catch(function () {
          stateRef.current.error = 'host api unavailable'
          render(function (n) { return n + 1 })
        })
      }, [])

      useEffect(function () { refresh() }, [refresh])

      useEffect(function () {
        var st = stateRef.current
        if (!st.open || st.pos) return
        var chip = wrapRef.current
        if (!chip) return
        var r = chip.getBoundingClientRect()
        st.pos = { top: r.bottom + 6, left: Math.max(8, r.right - 460), width: 460 }
        render(function (n) { return n + 1 })
      })

      function probe(id) {
        stateRef.current.probing[id] = true
        render(function (n) { return n + 1 })
        postJson('/ssh-remote/api/probe', { hostId: id }).then(function (res) {
          stateRef.current.probing[id] = false
          if (res && res.ok === false && res.error) stateRef.current.error = res.error.message
          refresh()
        }).catch(function () {
          stateRef.current.probing[id] = false
          stateRef.current.error = 'probe 请求失败（host api unavailable）'
          render(function (n) { return n + 1 })
        })
      }

      var st = stateRef.current
      var data = st.data
      var hosts = data && Array.isArray(data.hosts) ? data.hosts : []
      var conns = {}
      if (data && Array.isArray(data.connections)) data.connections.forEach(function (c) { conns[c.id] = c })
      var anyDown = hosts.length > 0 && hosts.some(function (x) { var c = conns[x.id]; return c && c.master === 'down' })
      var dotColor = hosts.length === 0 ? '#888' : (anyDown ? '#e5484d' : '#30a46c')

      return h('div', { ref: wrapRef, style: S.chip, onClick: function () {
        if (!st.open && wrapRef.current) {
          var r = wrapRef.current.getBoundingClientRect()
          st.pos = { top: r.bottom + 6, left: Math.max(8, r.right - 460), width: 460 }
        }
        st.open = !st.open
        render(function (n) { return n + 1 })
      }, title: 'SSH 远程主机：点击展开' },
        h('span', { style: Object.assign({ background: dotColor }, S.dot) }),
        h('span', null, 'SSH'),
        st.open && st.pos && h('div', { style: Object.assign({ top: st.pos.top, left: st.pos.left, width: st.pos.width }, S.panel), onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.head },
            h('span', { style: S.ttl }, 'SSH 远程主机'),
            h('button', { style: S.close, onClick: function () { st.open = false; render(function (n) { return n + 1 }) } }, '✕')
          ),
          hosts.length === 0 && h('div', { style: S.empty }, '未配置主机（设置页或 cordis.patch.yml 的 ssh-remote.config.hosts）'),
          hosts.map(function (x) {
            var c = conns[x.id] || {}
            var up = c.master === 'up' || c.master === 'degraded'
            var color = c.master === 'up' ? '#30a46c' : (c.master === 'degraded' ? '#f5a623' : '#e5484d')
            var extra = []
            if (c.latencyMs !== null && c.latencyMs !== undefined) extra.push('延迟 ' + c.latencyMs + 'ms')
            if (c.commands) extra.push('命令 ' + c.commands + ' 次')
            if (x.source) extra.push(x.source === 'static' ? '静态' : '动态')
            return h('div', { key: x.id, style: S.row },
              h('span', { style: Object.assign({ background: color }, S.dot) }),
              h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: S.nm }, h('span', null, x.name),
                  h('span', { style: Object.assign({}, S.badge, { background: up ? 'var(--dsw-alias-state-success-primary,#16a34a)' : 'var(--dsw-alias-state-danger-primary,#e5484d)', color: '#fff' }) }, c.master === 'degraded' ? '直连' : (up ? 'UP' : 'DOWN'))),
                h('div', { style: S.sub }, x.user + '@' + x.host + (x.port !== 22 ? ':' + x.port : '') + (x.jump ? ' · 经 ' + x.jump : '')),
                extra.length > 0 && h('div', { style: S.sub }, extra.join(' · ')),
                c.lastError && h('div', { style: S.err, title: c.lastError }, '最后错误：' + String(c.lastError).slice(0, 160))
              ),
              h('button', { style: S.btn, disabled: st.probing[x.id], onClick: function () { probe(x.id) } }, st.probing[x.id] ? '探测中…' : '连通性')
            )
          }),
          st.error && h('div', { style: S.err }, st.error),
          h('div', { style: S.actions }, h('button', { style: S.btn, onClick: refresh }, '刷新'))
        )
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'ssh-remote', order: 116, label: 'SSH' },
            SshRemoteUtility
          )
        })
      },
    }
  },
})
```

- [ ] **Step 12.2: 语法检查**

Run: `node --check client/index.js`
Expected: 无输出（exit 0）。

- [ ] **Step 12.3: Commit**

```bash
git add client/index.js
git commit -m "feat(client): SSH 状态胶囊+面板（连通性探测/静态动态标识）"
```

---

### Task 13: client — settings.section 配置区块

**Files:**
- Modify: `client/index.js`（追加 SettingsSection 组件并注册 settings.section）

- [ ] **Step 13.1: 在 client/index.js 的 factory 内追加配置区块组件**

在 `SshRemoteUtility` 定义之后追加（同文件、同一 factory 作用域）：

```js
    var FIELDS = [
      { key: 'id', label: 'id', w: 90 },
      { key: 'name', label: '名称', w: 110 },
      { key: 'host', label: '主机', w: 130 },
      { key: 'user', label: '用户', w: 80 },
      { key: 'port', label: '端口', w: 55 },
      { key: 'identityFile', label: '私钥路径', w: 170 },
      { key: 'jump', label: '跳板', w: 80 },
      { key: 'defaultCwd', label: '默认目录', w: 110 },
    ]

    function inputStyle(w) {
      return { font: 'inherit', fontSize: 11, width: w, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'var(--dsw-alias-bg-layer-2,#2a2a2a)', color: 'var(--dsw-alias-label-primary,inherit)' }
    }

    function SshRemoteSettings(props) {
      var stateRef = useRef({})
      var render = useState(0)[1]
      stateRef.current = stateRef.current || { hosts: [], dirty: false, msg: null, err: null, importOpen: false, importFormat: 'sshconfig', importText: '', importPreview: null, saving: false }

      var load = useCallback(function () {
        fetch('/ssh-remote/api/hosts').then(function (r) { return r.json() }).then(function (res) {
          if (res && res.ok) {
            stateRef.current.hosts = res.value.map(function (x) { return Object.assign({}, x) })
            stateRef.current.dirty = false
          } else stateRef.current.err = '加载失败'
          render(function (n) { return n + 1 })
        }).catch(function () { stateRef.current.err = 'host api unavailable'; render(function (n) { return n + 1 }) })
      }, [])
      useEffect(function () { load() }, [load])

      function setCell(i, key, v) {
        var st = stateRef.current
        st.hosts[i][key] = v
        st.dirty = true
        render(function (n) { return n + 1 })
      }
      function addRow() {
        var st = stateRef.current
        st.hosts.push({ id: '', name: '', host: '', user: 'root', port: 22, identityFile: '', jump: '', defaultCwd: '', source: 'dynamic' })
        st.dirty = true
        render(function (n) { return n + 1 })
      }
      function delRow(i) {
        var st = stateRef.current
        var row = st.hosts[i]
        if (row.source === 'static') { st.err = '静态主机不可在此删除（cordis.patch.yml）'; render(function (n) { return n + 1 }); return }
        if (row.id) {
          fetch('/ssh-remote/api/hosts/' + encodeURIComponent(row.id), { method: 'DELETE' }).then(function (r) { return r.json() }).then(function () { load() })
        } else {
          st.hosts.splice(i, 1); st.dirty = true; render(function (n) { return n + 1 })
        }
      }
      function save() {
        var st = stateRef.current
        st.saving = true; st.err = null; st.msg = null
        render(function (n) { return n + 1 })
        postJson('/ssh-remote/api/hosts/bulk', { hosts: st.hosts.filter(function (x) { return x.source !== 'static' }) }).then(function (res) {
          st.saving = false
          if (res && res.ok) { st.msg = '已保存（' + res.value.length + ' 台）'; load() }
          else st.err = (res && res.error && res.error.message) || '保存失败'
          render(function (n) { return n + 1 })
        })
      }
      function doImport(preview) {
        var st = stateRef.current
        postJson('/ssh-remote/api/hosts/import', { format: st.importFormat, text: st.importText, commit: !preview }).then(function (res) {
          if (res && res.ok) {
            if (preview) st.importPreview = res.value.preview
            else { st.importPreview = null; st.importOpen = false; st.importText = ''; st.msg = '导入完成'; load() }
          } else st.err = (res && res.error && res.error.message) || '导入失败'
          render(function (n) { return n + 1 })
        })
      }
      function exportJson() {
        var blob = new Blob([JSON.stringify(stateRef.current.hosts, null, 2)], { type: 'application/json' })
        var a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'ssh-remote-hosts.json'
        a.click()
        URL.revokeObjectURL(a.href)
      }

      var st = stateRef.current
      var th = { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#888)', textAlign: 'left', padding: '2px 6px' }
      var canSave = st.dirty && !st.saving
      return h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' } },
          h('button', { style: S.btn, onClick: addRow }, '+ 新增主机'),
          h('button', { style: S.btn, onClick: function () { st.importOpen = !st.importOpen; st.importPreview = null; render(function (n) { return n + 1 }) } }, st.importOpen ? '收起导入' : '批量导入'),
          h('button', { style: S.btn, onClick: exportJson }, '导出 JSON'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: Object.assign({}, S.btn, canSave ? {} : { opacity: 0.4 }), disabled: !canSave, onClick: save }, st.saving ? '保存中…' : '保存动态主机')
        ),
        st.msg && h('div', { style: { color: '#30a46c', fontSize: 11, margin: '4px 0' } }, st.msg),
        st.err && h('div', { style: S.err }, st.err),
        st.importOpen && h('div', { style: { border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 8, padding: 8, margin: '8px 0' } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
            h('select', { style: inputStyle(110), value: st.importFormat, onChange: function (e) { st.importFormat = e.target.value; render(function (n) { return n + 1 }) } },
              h('option', { value: 'sshconfig' }, '~/.ssh/config'),
              h('option', { value: 'json' }, 'JSON'),
              h('option', { value: 'yaml' }, 'YAML')
            ),
            h('button', { style: S.btn, onClick: function () { doImport(true) } }, '预览'),
            h('button', { style: S.btn, disabled: !st.importPreview, onClick: function () { doImport(false) } }, '确认导入')
          ),
          h('textarea', { style: Object.assign(inputStyle('100%'), { height: 120, resize: 'vertical' }), value: st.importText, placeholder: '粘贴配置文本…', onChange: function (e) { st.importText = e.target.value; render(function (n) { return n + 1 }) } }),
          st.importPreview && h('div', { style: { marginTop: 6 } },
            h('div', { style: S.sub }, '解析到 ' + st.importPreview.hosts.length + ' 台；问题 ' + st.importPreview.errors.length + ' 条'),
            st.importPreview.errors.map(function (e, i) { return h('div', { key: i, style: S.err }, e) }),
            st.importPreview.hosts.map(function (x, i) { return h('div', { key: i, style: S.sub }, x.id + ' → ' + x.host + (x.jump ? '（经 ' + x.jump + '）' : '')) })
          )
        ),
        h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          h('thead', null, h('tr', null, FIELDS.map(function (f) { return h('th', { key: f.key, style: th }, f.label) }).concat([h('th', { key: 'op', style: th }, '操作')]))),
          h('tbody', null, st.hosts.map(function (row, i) {
            return h('tr', { key: i, style: { opacity: row.source === 'static' ? 0.75 : 1 } },
              FIELDS.map(function (f) {
                var editable = row.source !== 'static' && f.key !== 'id'
                return h('td', { key: f.key, style: { padding: '2px 4px' } },
                  h('input', { style: inputStyle(f.w), value: row[f.key] || '', disabled: !editable, title: editable ? '' : '静态主机不可编辑', onChange: function (e) { setCell(i, f.key, e.target.value) } })
                )
              }).concat([
                h('td', { key: 'op', style: { padding: '2px 4px' } },
                  row.source === 'static'
                    ? h('span', { style: S.sub }, '静态')
                    : h('button', { style: S.btn, onClick: function () { delRow(i) } }, '删除')
                )
              ])
            )
          }))
        ),
        h('div', { style: Object.assign({}, S.sub, { marginTop: 8 }) }, '说明：动态主机保存后立即生效（无需重启）；静态主机来自 profile cordis.patch.yml，仅展示。')
      )
    }
```

- [ ] **Step 13.2: 在返回对象中注册 settings.section**

把 factory 末尾的 `return { inject: ['slots'], apply: ... }` 改为：

```js
    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'ssh-remote', order: 116, label: 'SSH' },
            SshRemoteUtility
          )
        })
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'ssh-remote', order: 116, label: 'SSH 远程主机' },
            SshRemoteSettings
          )
        })
      },
    }
```

（settings.section 组件由设置页以 `{ close }` 渲染；本组件暂未用到 close，签名留空即可。）

- [ ] **Step 13.3: 语法检查 + Commit**

Run: `node --check client/index.js`
Expected: exit 0。

```bash
git add client/index.js
git commit -m "feat(client): settings.section 主机配置区块（表格 CRUD/批量导入预览/导出）"
```

---

### Task 14: README + live-test + 真机验收

**Files:**
- Create: `README.md`, `scripts/live-test.mjs`
- Modify: `package.json`（scripts.live）

- [ ] **Step 14.1: 写 scripts/live-test.mjs**

```js
// dsh-ssh-remote 真机验证：不装 profile，直接用插件模块连真实主机。
// 主机来源（环境变量）：SSH_REMOTE_HOST / SSH_REMOTE_USER / SSH_REMOTE_PORT / SSH_REMOTE_KEY
// 未设置则跳过（exit 0）。
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HostRegistry } from '../lib/hosts.js'
import { ConnectionManager } from '../lib/connection.js'
import { Runner } from '../lib/exec.js'
import { FsOps, FsOpsError } from '../lib/fsops.js'
import { Transfer } from '../lib/transfer.js'

const HOST = process.env.SSH_REMOTE_HOST
const KEY = process.env.SSH_REMOTE_KEY
if (!HOST || !KEY) {
  console.log('跳过 live-test：未设置 SSH_REMOTE_HOST / SSH_REMOTE_KEY')
  process.exit(0)
}

let passed = 0, failed = 0
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + detail : '')) }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-live-'))
const hostsFile = path.join(tmpDir, 'hosts.json')
fs.writeFileSync(hostsFile, JSON.stringify([{
  id: 'live', name: 'Live', host: HOST,
  user: process.env.SSH_REMOTE_USER || 'root',
  port: Number(process.env.SSH_REMOTE_PORT) || 22,
  identityFile: KEY,
}]), 'utf8')

const registry = new HostRegistry({ staticHosts: [], hostsFile })
const conn = new ConnectionManager({ cmDir: path.join(tmpDir, 'cm') })
const runner = new Runner({ muxArgs: (h) => conn.muxArgs(h), target: (h) => conn.target(h) })
const fsops = new FsOps({ runner })
const transfer = new Transfer({ conn, runner })
const H = registry.pick('live')
conn.resolveJump(H, registry)

const keepAlive = setInterval(() => {}, 1000)

async function main() {
  console.log('== L1 建连（ControlMaster） ==')
  const t0 = Date.now()
  const r1 = await conn.ensureMaster(H)
  check('L1.1 master 建立', r1.ok === true, JSON.stringify(r1))
  console.log('  建连耗时 ' + (Date.now() - t0) + 'ms')

  console.log('== L2 ssh_run + 复用延迟 ==')
  const r2 = await runner.run(H, 'echo LIVE_OK && uname -s', {})
  check('L2.1 执行成功', r2.exitCode === 0 && r2.stdout.includes('LIVE_OK'), JSON.stringify(r2))
  const t2 = Date.now()
  const r2b = await runner.run(H, 'true', {})
  const reuseMs = Date.now() - t2
  check('L2.2 复用连接（应 <500ms）', r2b.exitCode === 0 && reuseMs < 500, reuseMs + 'ms')

  console.log('== L3 read/edit/write ==')
  const remote = '/tmp/ssh-remote-live-' + Date.now() + '.conf'
  const w = await fsops.write(H, remote, 'alpha=1\nbeta=2\n')
  check('L3.1 write', (w.sha256 || '').length === 64)
  const rd = await fsops.read(H, remote, {})
  check('L3.2 read 行号', rd.content.includes('1\talpha=1'), JSON.stringify(rd.content))
  const ed = await fsops.edit(H, remote, 'beta=2', 'beta=22', {})
  check('L3.3 edit', ed.replaced === 1)
  // stale 模拟：直接 write 改文件后再 edit 旧内容
  await fsops.write(H, remote, 'alpha=9\nbeta=2\n')
  let staleErr = null
  try { await fsops.edit(H, remote, 'beta=2', 'beta=x', {}) } catch (e) { staleErr = e }
  check('L3.4 stale-edit 防冲突', staleErr instanceof FsOpsError && staleErr.kind === 'stale-edit', String(staleErr && staleErr.kind))
  await runner.run(H, 'rm -f ' + JSON.stringify(remote), {})

  console.log('== L4 push/pull 往返 ==')
  const localFile = path.join(tmpDir, 'up.txt')
  fs.writeFileSync(localFile, 'payload ' + Date.now() + '\n')
  const p1 = await transfer.push(H, localFile, '/tmp/ssh-remote-live-up.txt')
  check('L4.1 push 文件', p1.exitCode === 0, JSON.stringify(p1))
  const pulled = path.join(tmpDir, 'down.txt')
  const p2 = await transfer.pull(H, '/tmp/ssh-remote-live-up.txt', pulled)
  check('L4.2 pull 文件', p2.exitCode === 0 && fs.readFileSync(pulled, 'utf8') === fs.readFileSync(localFile, 'utf8'))
  await runner.run(H, 'rm -f /tmp/ssh-remote-live-up.txt', {})

  console.log('== L5 glob/grep ==')
  const g = await fsops.glob(H, '*.conf', { path: '/etc', maxDepth: 1 })
  check('L5.1 glob', Array.isArray(g.files) && g.files.length >= 0)
  const gr = await fsops.grep(H, 'root', { path: '/etc/passwd' })
  check('L5.2 grep', gr.matches.length > 0)

  console.log('== L6 teardown ==')
  await conn.teardown(H)
  check('L6.1 teardown 完成', true)

  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearInterval(keepAlive)
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch(err => { console.error('live test 异常:', err); process.exit(1) })
```

- [ ] **Step 14.2: 写 README.md**

````markdown
# dsh-ssh-remote

DSH（DeepSeek Harness）插件：**SSH 远程运维/开发工具套件**——Agent 通过 10 个 `ssh_*` 工具在远程 Linux 主机上执行命令、读/写/编辑文件、搜索、双向传输（对标 VS Code Remote SSH 的核心工作流）。

- 系统ssh 二进制 + **ControlMaster 连接复用**：首连后每次操作毫秒级；宿主重启自动重建；
- **远程文件编辑带防冲突**：读取记 sha256，提交前远端校验，文件被并发修改报 `stale-edit`；
- 所有命令/路径**参数数组直传**远端 shell，不经本地 shell——无引号地狱；
- 会话头部**状态胶囊**+面板；设置页**可视化主机管理**（表格 CRUD / 批量导入 / 导出，动态主机保存即生效）；
- 回环 HTTP API（非回环 403）。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/<you>/dsh-kkutysllb-ssh-tunnel.git
```

静态主机（可选，重启生效）——profile `cordis.patch.yml`：

```yaml
- id: ssh-remote
  config:
    hosts:
      - id: prod-1
        name: 生产机 1
        host: 203.0.113.10
        user: root            # 默认 root
        port: 22              # 默认 22
        identityFile: ~/.ssh/id_ed25519
        jump: bastion         # 可选：跳板（引用另一主机 id → ssh -J）
        defaultCwd: /srv/app  # 可选
    commandTimeoutMs: 60000
```

动态主机：设置页「SSH 远程主机」区块添加/导入，写入 `~/.dsh/ssh-remote/hosts.json`，**热生效**。

## Agent 工具

| 工具 | 作用 |
|------|------|
| `ssh_hosts` | 列出主机（id/名称/来源/跳板）——远程任务先调它 |
| `ssh_status` | 连接池状态（master/延迟/命令数/最后错误） |
| `ssh_run` | 远程命令（bash 解释，cwd 可选，带超时）→ `{exitCode, stdout, stderr, durationMs}` |
| `ssh_read` | 读远程文件窗口（带行号，offset/limit；二进制拒绝） |
| `ssh_write` | 全量覆写（stdin→tmp→原子 mv；mkdirs 可选） |
| `ssh_edit` | 字面量替换（唯一命中或 replaceAll；**stale-edit 防冲突**） |
| `ssh_glob` | 远程 find -name（上限 200） |
| `ssh_grep` | 远程 grep -rnE（POSIX ERE；上限 250；默认排除 .git） |
| `ssh_push` / `ssh_pull` | 上传/下载（单文件 scp；目录 tar-over-ssh，recursive=true） |

## 设计要点

- **ControlMaster**：`~/.dsh/ssh-remote/cm/<id>.sock`，`ControlPersist` 默认 600s；操作前 `-O check`，失效自动重建；插件停止 `-O exit`。Windows 宿主自动降级逐次直连（功能完整，速度较慢）。
- **edit 防冲突**：读全文记 sha256 → 本地替换 → 远端「内容落 tmp → 原文件 sha 校验 → 原子 mv」，变了 exit 75 → `stale-edit`。
- **安全**：仅密钥认证（BatchMode）；`StrictHostKeyChecking=accept-new`（首连自动接受 host key，信任权衡自行评估）；HTTP API 仅回环。
- **已知限制**：`ssh_run` 超时只终止本地 ssh，远端命令可能继续（可自行包 `timeout N cmd`）；`ssh_grep` 为 POSIX ERE，与 ripgrep 语法有差异；编辑限 1MB 内文本。

## 开发

```bash
npm run setup-dev   # node_modules → ~/.kcoder/profiles/node_modules 符号链接
npm run typecheck
npm test            # 全量冒烟（fake spawn，不碰网络）
# 真机验证（可选）：
SSH_REMOTE_HOST=1.2.3.4 SSH_REMOTE_KEY=~/.ssh/id_ed25519 npm run live
```

## License

MIT
````

- [ ] **Step 14.3: package.json scripts 加 live 并跑全量验证**

`package.json` 的 scripts 追加：`"live": "node scripts/live-test.mjs"`。

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0；冒烟 `结果: 108 通过, 0 失败`。

- [ ] **Step 14.4: 真机验收（用户提供一台 Linux 主机）**

Run: `SSH_REMOTE_HOST=<ip> SSH_REMOTE_USER=root SSH_REMOTE_KEY=~/.ssh/id_ed25519 npm run live`
Expected: L1–L6 全 PASS。

随后安装进本地 profile 人工验收两场景：
1. **运维排障**：让 Agent `ssh_grep` 找日志报错关键字 → `ssh_read` 看配置 → `ssh_edit` 修复 → `ssh_run` 重启服务并验证；
2. **开发迭代**：`ssh_pull` 拉远端代码 → 本地 edit → `ssh_push` → `ssh_run` 跑测试。

- [ ] **Step 14.5: Commit**

```bash
git add README.md scripts/live-test.mjs package.json
git commit -m "docs+test: README 与真机 live-test（验收两场景说明）"
```

---

## 验收清单（对照设计规格）

| 规格条目 | 任务 |
|---|---|
| §4.1 主机两路合并/热重载/校验 | Task 3、4 |
| §4.2 ControlMaster/win32 降级/残留清理/拆除 | Task 5 |
| §4.3 run/read/write/edit/glob/grep/push/pull 语义 | Task 2、6、7、8、9 |
| §4.4 十工具 + hostId 缺省 + 系统提示 | Task 10 |
| §4.5 回环 HTTP API（CRUD/import/probe） | Task 11 |
| §4.6 胶囊面板 + 设置页区块 | Task 12、13 |
| §4.7 错误分类（7 类） | Task 2、6、7 |
| §5 冒烟 ≥50 / live-test / 两验收场景 | 各任务 + Task 14（最终 108 项） |
| §6 范围外 | 未实现（按规格排除） |
