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
  // Transfer._tarPipe 用 producer.stdout.pipe(consumer.stdin)；fake 下给最小桩（不影响其他组）
  child.stdout.pipe = (dst) => { child.__pipedTo = dst; return dst }
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.emitExit = (code, signal) => child.emit('exit', code, signal || null)
  child.emitClose = (code) => child.emit('close', code)
  child.writeOut = (s) => child.stdout.emit('data', Buffer.from(s, 'utf8'))
  child.writeErr = (s) => child.stderr.emit('data', Buffer.from(s, 'utf8'))
  child.stdin = {
    write: (s) => { child.__stdin = (child.__stdin || '') + s },
    end: () => {},
    on: () => {}, // 对齐真实 Writable 的 EventEmitter 接口（EPIPE 监听用）
  }
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

  // 错误分类透传（I1 收紧后须为 ssh 官方格式 user@host: 前缀）
  const p4 = runner.run(host, 'x', {})
  setTimeout(() => { log[3].child.writeErr('root@1.2.3.4: Permission denied (publickey).'); log[3].child.emitClose(255) }, 5)
  const r4 = await p4
  check('T2.13 auth 分类', r4.errorKind === 'auth', JSON.stringify(r4))

  // runWithStdin：stdin 透传给远端
  const p5 = runner.runWithStdin(host, 'cat > /tmp/f', { stdin: 'hello' })
  setTimeout(() => { log[4].child.emitClose(0) }, 5)
  const r5 = await p5
  check('T2.14 stdin 写入', r5.exitCode === 0 && log[4].child.__stdin === 'hello', JSON.stringify(r5))
  check('T2.15 spawn 参数数组无 shell', log[0].cmd === 'ssh')

  // EPIPE 回归：子进程秒退 + 在途 stdin 大载荷不崩（真实 spawn /usr/bin/true）
  {
    const { spawn: realSpawn } = await import('node:child_process')
    const epRunner = new Runner({
      muxArgs: () => [], target: () => 't@h',
      spawnFn: (cmd, args, o) => realSpawn('true', [], o),
      defaults: { commandTimeoutMs: 2000, maxStdout: 1024, maxStderr: 256 },
    })
    const rE = await epRunner.runWithStdin(host, 'noop', { stdin: 'x'.repeat(1024 * 1024) })
    check('T2.16 stdin EPIPE 不崩（秒退子进程+1MB 载荷）', rE.exitCode === 0, JSON.stringify(rE))
    check('T2.17 spawn 无 shell 选项', log[0].opts.shell === undefined)
  }

  // 截断标志回归
  {
    const logB = []
    const r2 = new Runner({
      muxArgs: () => [], target: () => 't@h',
      spawnFn: recordingSpawn(logB),
      defaults: { commandTimeoutMs: 2000, maxStdout: 64, maxStderr: 256 },
    })
    const pT = r2.run(host, 'cat big', {})
    setTimeout(() => { for (let i = 0; i < 20; i++) logB[0].child.writeOut('x'.repeat(16) + '\n'); logB[0].child.emitClose(0) }, 5)
    const rT = await pT
    check('T2.18 stdout 截断置标志', rT.stdoutTruncated === true && rT.stdout.length <= 64, JSON.stringify({ len: rT.stdout.length, t: rT.stdoutTruncated }))
  }
}

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
  check('T3.6 id 含空格被拒（normalizeHost）', normalizeHost({ id: 'bad id', host: 'h', identityFile: 'k' }) === null)

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
  // I-1 回归：文件删除/损坏后动态表清空
  fs.rmSync(hostsFile, { force: true })
  reg.reload()
  check('T3.14 文件删除后动态表清空', reg.list().length === 1 && reg.list()[0].id === 'st-1')
  fs.writeFileSync(hostsFile, '{corrupted', 'utf8')
  reg.reload()
  check('T3.15 损坏 JSON 后动态表清空', reg.list().length === 1)
  fs.writeFileSync(hostsFile, '[]', 'utf8')
  reg.stopWatch()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

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

  // 回归：= 分隔 / 多别名 / 注释 / 大小写 / 异常分支
  const eq = parseImport('Host=x\nHostName=1.2.3.4\nIdentityFile=/k\n', 'sshconfig')
  check('T4.12 = 分隔语法解析', eq.hosts.length === 1 && eq.hosts[0].host === '1.2.3.4', JSON.stringify(eq))
  const eq2 = parseImport('Host = y\n HostName = 2.2.2.2\n IdentityFile = /k\n', 'sshconfig')
  check('T4.13 「Host = y」形态干净', eq2.hosts.length === 1 && eq2.hosts[0].id === 'y' && eq2.hosts[0].host === '2.2.2.2', JSON.stringify(eq2))
  const multi = parseImport('Host web-01 www\n  HostName 10.0.0.5\n  IdentityFile /k\n', 'sshconfig')
  check('T4.14 多别名各成主机', multi.hosts.length === 2 && multi.hosts.every(h => h.host === '10.0.0.5'), JSON.stringify(multi))
  const y2 = parseImport("- id: c1\n  host: 1.1.1.1\n  identityFile: /k\n  port: 22 # 备注\n", 'yaml')
  check('T4.15 YAML 行内注释剥离', y2.hosts.length === 1 && y2.hosts[0].port === 22, JSON.stringify(y2))
  const crlf = parseImport("- id: c2\r\n  host: 1.1.1.1\r\n  identityFile: /k\r\n", 'yaml')
  check('T4.16 CRLF 容忍', crlf.hosts.length === 1, JSON.stringify(crlf))
  const bad = parseImport('{invalid json', 'json')
  check('T4.17 JSON 解析失败报错', bad.hosts.length === 0 && bad.errors.length === 1 && bad.errors[0].includes('解析失败'))
  const ci = parseImport('Host Bastion\n  HostName 203.0.113.7\n  IdentityFile /k\n\nHost web-02\n  HostName 10.0.0.9\n  IdentityFile /k\n  ProxyJump bastion\n', 'sshconfig')
  check('T4.18 ProxyJump 大小写不敏感', ci.hosts.find(h => h.id === 'web-02').jump === 'bastion', JSON.stringify(ci))
  const perr = parseImport('Host p1\n  HostName 1.1.1.1\n  IdentityFile /k\n  Port abc\n', 'sshconfig')
  check('T4.19 Port 非数字记错误', perr.errors.some(e => e.includes('Port 非数字')), JSON.stringify(perr))
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

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
        if (args.includes('-N')) setTimeout(() => { child.writeErr('Permission denied (publickey)'); child.emitExit(255) }, 30) // master 秒死（如 auth 失败）
        return child
      },
    })
    const c = new ConnectionManager(opts)
    const r = await c.ensureMaster(H)
    check('T5.15 建连失败上报', r.ok === false && typeof r.error === 'string' && r.error.includes('Permission denied'))
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

  // 回归：状态卫生
  {
    // I1：jump 引用被删后 -J 不残留
    const c1 = new ConnectionManager(connOpts([]))
    const H3 = { ...H, jump: 'bastion', _jumpHost: { user: 'ops', host: '10.0.0.9', port: 2222 } }
    c1.resolveJump(H3, { list: () => [] })
    check('T5.17 jump 失配清除 _jumpHost', !c1.muxArgs(H3).includes('-J'), c1.muxArgs(H3).join(' '))
    const H4 = { ...H, jump: 'bastion' }
    c1.resolveJump(H4, { list: () => [{ id: 'bastion', user: 'ops', host: '10.0.0.9', port: 2222 }] })
    check('T5.17b jump 命中注入 _jumpHost', c1.muxArgs(H4).includes('-J') && c1.muxArgs(H4).includes('ops@10.0.0.9:2222'))
  }
  {
    // I2：复用成功清 lastError
    const log2 = []
    let okNow = false
    const c2 = new ConnectionManager(connOpts(log2, {
      spawnFn: (cmd, args, o) => {
        const child = fakeChild(7700 + log2.length)
        log2.push({ cmd, args, opts: o, child })
        if (args.includes('check')) setTimeout(() => child.emitClose(okNow ? 0 : 255), 5)
        else if (args.includes('-N')) { /* master 存活 */ }
        else setTimeout(() => child.emitClose(0), 5)
        return child
      },
    }))
    const rFail = await c2.ensureMaster(H)
    const st = c2.stat(H.id)
    okNow = true
    // 模拟 master 后来建好：直接构造复用成功路径
    st.master = 'up'
    const rOk = await c2.ensureMaster(H)
    check('T5.18 复用成功清 lastError', rFail.ok === false && rOk.ok === true && c2.stat(H.id).lastError === null, JSON.stringify(c2.stat(H.id)))
  }
  {
    // N1：teardown 后迟到 exit 不写 lastError
    // （先走真实建连拿挂好 exit 处理器的 master：check#1 255 → spawn -N → check#2 0 → up；再 teardown → 迟到 exit）
    const log3 = []
    let checkCalls = 0
    let masterChild = null
    const c3 = new ConnectionManager(connOpts(log3, {
      spawnFn: (cmd, args, o) => {
        const child = fakeChild(7800 + log3.length)
        log3.push({ cmd, args, opts: o, child })
        if (args.includes('check')) { checkCalls += 1; setTimeout(() => child.emitClose(checkCalls >= 2 ? 0 : 255), 5) }
        else if (args.includes('-N')) masterChild = child
        else setTimeout(() => child.emitClose(0), 5)
        return child
      },
    }))
    const rUp = await c3.ensureMaster(H)
    check('T5.19 前置：master 已 up 且捕获到 master 子进程', rUp.ok === true && masterChild !== null, JSON.stringify(rUp))
    await c3.teardown(H)
    masterChild.stderr.emit('data', Buffer.from('late exit noise', 'utf8'))
    masterChild.emitExit(255)
    check('T5.19 teardown 后迟到 exit 不写 lastError', c3.stat(H.id).lastError === null && c3.stat(H.id).master === 'down', JSON.stringify(c3.stat(H.id)))
  }
}

// ================= T6 fsops read/write =================
import { FsOps, FsOpsError } from '../lib/fsops.js'

async function t6() {
  console.log('== T6 fsops read/write ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/k', defaultCwd: '' }

  // read：复合命令 + 行号 + 嗅探
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

    // offset 窗口（fixture 模拟 sed -n '2,3p' 只回窗口行）
    const fx2 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '__SR__ h1 100 100\nbeta\ngamma\n', stderr: '', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false }),
      },
    })
    const r2 = await fx2.read(H, '/a.txt', { offset: 2, limit: 2 })
    check('T6.6 offset 窗口行号', r2.content === '2\tbeta\n3\tgamma\n', JSON.stringify(r2))
    check('T6.7 文件非二进制', r2.binary === false)

    // 二进制拒绝（a≠b → throw binary-rejected）
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
    const SHA = 'deadbeef'.repeat(8) // 64 位 hex，过 write 的 sha 校验
    const calls = []
    const fx = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        runWithStdin: async (h, script, o) => { calls.push({ script, stdin: o.stdin }); return { exitCode: 0, stdout: SHA, stderr: '', timedOut: false } },
      },
    })
    const r = await fx.write(H, '/srv/app/conf.yml', 'key: 1\n', { mkdirs: true })
    check('T6.9 write 返回新 sha', r.sha256 === SHA)
    check('T6.10 write 脚本 mkdir+tmp+mv', calls[0].script.includes('mkdir -p') && calls[0].script.includes('__tmp__') && calls[0].script.includes('mv '), calls[0].script)
    check('T6.11 write stdin 是内容', calls[0].stdin === 'key: 1\n')
    // 不带 mkdirs
    calls.length = 0
    await fx.write(H, '/srv/x', 'v', {})
    check('T6.12 无 mkdirs 不建目录', !calls[0].script.includes('mkdir -p'))
  }

  // 回归：截断/NaN/相对路径/退化 meta
  {
    const fxT = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: 'just-content-no-meta', stderr: '', timedOut: false, stdoutTruncated: true }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let e1 = null
    try { await fxT.read(H, '/big.log', {}) } catch (e) { e1 = e }
    check('T6.13 截断报 result-truncated', e1 && e1.kind === 'result-truncated', String(e1))
    let e2 = null
    try { await fxT.read(H, '/a', { offset: 'x' }) } catch (e) { e2 = e }
    check('T6.14 非数字 offset 报 bad-args', e2 && e2.kind === 'bad-args', String(e2))
    let e3 = null
    try { await fxT.read(H, 'relative.txt', {}) } catch (e) { e3 = e }
    check('T6.15 相对路径报 bad-args', e3 && e3.kind === 'bad-args', String(e3))
    const fxW = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '__SR__   ' + 'a'.repeat(64) + '     100\nhello\n', stderr: '', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false }),
      },
    })
    const rw = await fxW.readWhole(H, '/a.txt')
    check('T6.16 BSD 前导空格 meta 容忍', rw.sha256 === 'a'.repeat(64) && rw.content === 'hello\n', JSON.stringify(rw))
    const fxW2 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 0, stdout: '__SR__ short 100\nhello\n', stderr: '', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let e4 = null
    try { await fxW2.readWhole(H, '/a.txt') } catch (e) { e4 = e }
    check('T6.17 readWhole sha 强校验', e4 && e4.kind === 'parse-error', String(e4))
  }
}

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

  // 集成回归：关键段脚本在真实 /bin/sh 下执行（不碰网络）
  {
    const { spawn: shSpawn } = await import('node:child_process')
    const { createHash } = await import('node:crypto')
    const shaOf = (s) => createHash('sha256').update(s).digest('hex')
    const runSh = (script, stdin) => new Promise((resolve) => {
      const c = shSpawn('/bin/sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let errS = ''
      c.stdout.on('data', d => { out += d })
      c.stderr.on('data', d => { errS += d })
      c.stdin.write(stdin)
      c.stdin.end()
      c.on('close', (code) => resolve({ code, out, errS }))
    })
    // 与 lib/fsops.js edit 关键段同构（生产侧 readlink/mv 守卫/stale 语义在此真机验证）
    const mkScript = (filePath, sha) => 'f=$(readlink -f -- ' + JSON.stringify(filePath) + ') || exit 76; '
      + 't="$f.__tmp__t79"; cat > "$t" || { rm -f "$t"; exit 70; }; '
      + 'if [ "$(sha256sum "$f" | cut -d\' \' -f1)" = \'' + sha + '\' ]; then mv "$t" "$f" || { rm -f "$t"; exit 70; }; else rm -f "$t"; exit 75; fi; '
      + 'sha256sum "$f" | cut -d\' \' -f1'

    // 成功路径
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't7-int-'))
    const f1 = path.join(tmpDir, 'a.conf')
    fs.writeFileSync(f1, 'hello\nfoo = 1\n')
    const r1s = await runSh(mkScript(f1, shaOf('hello\nfoo = 1\n')), 'hello\nfoo = 2\n')
    check('T7.9 关键段真机成功（exit 0 + 新 sha）', r1s.code === 0 && r1s.out.trim() === shaOf('hello\nfoo = 2\n'), JSON.stringify(r1s))
    // stale 路径：sha 不符 → exit 75，原文保留
    fs.writeFileSync(f1, 'hello\nfoo = 1\n')
    const r2s = await runSh(mkScript(f1, 'deadbeef'), 'hello\nfoo = 9\n')
    check('T7.10 关键段真机 stale（exit 75 + 原文保留）', r2s.code === 75 && fs.readFileSync(f1, 'utf8') === 'hello\nfoo = 1\n', JSON.stringify(r2s))
    // 单替换 $ 字面量（fake runner，只验 node 侧替换语义）
    const fxD = editHarness('__SR__ ' + SHA_A + ' 9\nvXv\n', { exitCode: 0, stdout: SHA_B, stderr: '', timedOut: false })
    await fxD.fx.edit(H, '/d.txt', 'X', '100$&', {})
    check('T7.11 单替换 $& 字面量不展开', fxD.calls.some(c => c.kind === 'stdin' && c.stdin === 'v100$&v\n'), JSON.stringify(fxD.calls.filter(c => c.kind === 'stdin').map(c => c.stdin)))
    // symlink 实体化：编辑 link 实际写 target，link 关系保持
    const realF = path.join(tmpDir, 'real.conf')
    const linkF = path.join(tmpDir, 'link.conf')
    fs.writeFileSync(realF, 'v1\n')
    fs.symlinkSync(realF, linkF)
    const r3s = await runSh(mkScript(linkF, shaOf('v1\n')), 'v2\n')
    check('T7.12 symlink 编辑实体（link 保持 + 目标更新）', r3s.code === 0 && fs.readFileSync(realF, 'utf8') === 'v2\n' && fs.realpathSync(linkF) === fs.realpathSync(realF), JSON.stringify(r3s))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ================= T8 fsops glob/grep =================
async function t8() {
  console.log('== T8 fsops glob/grep ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 22, identityFile: '/k', defaultCwd: '' }
  const calls = []
  const mk = (stdout, extra = {}) => new FsOps({
    runner: {
      run: async (h, command) => { calls.push(command); return { exitCode: 0, stdout, stderr: '', timedOut: false, ...extra } },
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
  check('T8.5 grep 命令 -rnE/-I/--include/--exclude-dir', calls[0].includes('grep') && calls[0].includes('-rnE') && calls[0].includes('-I') && calls[0].includes("--include='*.js'") && calls[0].includes('--exclude-dir=.git'))
  calls.length = 0
  await mk('x\n').grep(H, 'y', { path: '/srv', ignoreCase: true })
  check('T8.6 ignoreCase 加 -i', calls[0].includes('-i'))
  check('T8.7 grep 上限 250', (await mk(Array.from({ length: 255 }, () => 'm').join('\n') + '\n').grep(H, 'm', { path: '/' })).truncated === true)
  // 截断传播：远端 stdout 截断 → truncated 标志
  const gt = await mk('/a\n/b\n', { stdoutTruncated: true }).glob(H, '*', { path: '/' })
  check('T8.8 stdout 截断传播 truncated', gt.truncated === true)

  // 错误分支回归
  {
    const fxErr = new FsOps({
      runner: {
        run: async () => ({ exitCode: 2, stdout: '', stderr: 'find: /nope: No such file or directory', timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let eg = null
    try { await fxErr.glob(H, '*', { path: '/nope' }) } catch (e) { eg = e }
    check('T8.9 glob 出错抛 glob-failed', eg && eg.kind === 'glob-failed' && String(eg.message).includes('No such file'), String(eg))
    const fxErr2 = new FsOps({
      runner: {
        run: async () => ({ exitCode: 2, stdout: '', stderr: "grep: Unmatched ( or \\(", timedOut: false }),
        runWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      },
    })
    let er = null
    try { await fxErr2.grep(H, '(', {}) } catch (e) { er = e }
    check('T8.10 grep 非法正则抛 grep-failed', er && er.kind === 'grep-failed', String(er))
    let ed = null
    try { await fxErr.glob(H, '*', { path: '/', maxDepth: 'abc' }) } catch (e) { ed = e }
    check('T8.11 maxDepth 非数字 bad-args', ed && ed.kind === 'bad-args', String(ed))
  }
}

// ================= T9 transfer =================
import { Transfer } from '../lib/transfer.js'

async function t9() {
  console.log('== T9 transfer ==')
  const H = { id: 'h1', host: '1.2.3.4', user: 'root', port: 2222, identityFile: '/k', defaultCwd: '' }
  const conn = {
    scpArgs: () => ['-i', '/k', '-o', 'ControlPath=/tmp/x.sock'],
    muxArgs: () => ['-i', '/k', '-o', 'ControlPath=/tmp/x.sock', '-p', '2222'],
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
    check('T9.7 本地 tar argv 精确', tar && JSON.stringify(tar.args) === JSON.stringify(['-C', '/local/dir', '-cf', '-', '.']), JSON.stringify(tar && tar.args))
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

  // 本地集成：真实 tar → sh(tar) 管道目录推（不碰网络）
  {
    const { spawn: realSpawn } = await import('node:child_process')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't9-int-'))
    const srcDir = path.join(tmpDir, 'src')
    const dstDir = path.join(tmpDir, 'dst')
    fs.mkdirSync(srcDir)
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'payload-A')
    fs.mkdirSync(path.join(srcDir, 'sub'))
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'payload-B')
    const trInt = new Transfer({
      conn: { scpArgs: () => [], muxArgs: () => [], target: () => 'localhost' },
      // runner shim 真实执行远端脚本（mkdir -p）：dstDir 由生产路径创建，整条链路保真
      runner: {
        run: async (h, command) => await new Promise((resolve) => {
          const c = realSpawn('sh', ['-c', command], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
          let err = ''
          if (c.stderr) c.stderr.on('data', d => { err += d.toString('utf8') })
          c.on('close', (code) => resolve({ exitCode: code, stdout: '', stderr: err, timedOut: false }))
          c.on('error', () => resolve({ exitCode: -1, stdout: '', stderr: 'runner spawn 失败', timedOut: false }))
        }),
      },
      spawnFn: (cmd, args, opts) => {
        if (cmd === 'tar') return realSpawn('tar', args, opts)
        if (cmd === 'ssh') return realSpawn('sh', ['-c', 'exec ' + args[args.length - 1]], opts)
        if (cmd === 'scp') return realSpawn('false', [], opts)
        return realSpawn(cmd, args, opts)
      },
      sleepMs: 1,
    })
    const rInt = await trInt.push({ id: 'h1', host: 'x', user: 'u', port: 22, identityFile: '/k', defaultCwd: '' }, srcDir, dstDir, { recursive: true, timeoutMs: 15000 })
    const okFiles = fs.existsSync(path.join(dstDir, 'a.txt')) && fs.existsSync(path.join(dstDir, 'sub', 'b.txt'))
      && fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8') === 'payload-A'
      && fs.readFileSync(path.join(dstDir, 'sub', 'b.txt'), 'utf8') === 'payload-B'
    check('T9.11 本地 tar→sh(tar) 目录推集成', rInt.exitCode === 0 && okFiles, JSON.stringify(rInt))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // H1 回归：tar 管道 ssh 用 muxArgs（含 -p）
  {
    const log = []
    const connP = {
      scpArgs: () => ['-i', '/k'],
      muxArgs: (h) => ['-i', '/k', '-p', String(h.port)],
      target: () => 'root@1.2.3.4',
    }
    const runnerP = { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) }
    const trP = new Transfer({ conn: connP, runner: runnerP, spawnFn: recordingSpawn(log), sleepMs: 1 })
    const pPush = trP.push(H, '/local/dir', '/srv/dir', { recursive: true })
    setTimeout(() => { log.find(e => e.cmd === 'tar').child.emitClose(0); log.filter(e => e.cmd === 'ssh').forEach(e => e.child.emitClose(0)) }, 10)
    const rPush = await pPush
    const sshPush = log.find(e => e.cmd === 'ssh')
    check('T9.12 目录推 ssh 含 -p 端口', rPush.exitCode === 0 && sshPush.args.includes('-p') && sshPush.args.includes('2222'), JSON.stringify(sshPush && sshPush.args))
    const log2 = []
    const trP2 = new Transfer({ conn: connP, runner: runnerP, spawnFn: recordingSpawn(log2), sleepMs: 1 })
    // pullDir 会对本地目录 mkdirSync——用 tmpdir 隔离，避免污染工作区
    const pullLocal = path.join(os.tmpdir(), 't9-pull-' + Date.now())
    const pPull = trP2.pull(H, '/srv/dir', pullLocal, { recursive: true })
    setTimeout(() => { log2.find(e => e.cmd === 'tar').child.emitClose(0); log2.filter(e => e.cmd === 'ssh').forEach(e => e.child.emitClose(0)) }, 10)
    const rPull = await pPull
    const sshPull = log2.find(e => e.cmd === 'ssh')
    check('T9.13 目录拉 ssh 含 -p 端口', rPull.exitCode === 0 && sshPull.args.includes('-p') && sshPull.args.includes('2222'), JSON.stringify(sshPull && sshPull.args))
    fs.rmSync(pullLocal, { recursive: true, force: true })
  }
}

// ================= T10 index.js 工具装配 =================
import { apply } from '../lib/index.js'

function fakeCtx() {
  const registeredTools = []
  const sections = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn(); disposers.push(typeof d === 'function' ? d : () => {}); return disposers[disposers.length - 1] },
    tools: { register(def) { registeredTools.push(def) } },
    systemPrompt: { section(s) { sections.push(s) } },
    inject(names, fn) { ctx._injects.push([names, fn]) },
    _injects: [],
    _registeredTools: registeredTools,
    _sections: sections,
    _disposers: disposers,
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
  check('T10.3 生命周期 effect', ctx._disposers.length === 1)

  const hostsTool = ctx._registeredTools.find(t => t.name === 'ssh_hosts')
  const hv = await hostsTool.execute({})
  check('T10.4 ssh_hosts 返回主机', hv.hosts.length === 1 && hv.hosts[0].id === 't1')

  const runTool = ctx._registeredTools.find(t => t.name === 'ssh_run')
  let e1 = null
  try { await runTool.execute({ hostId: 'nope', command: 'x' }) } catch (e) { e1 = e }
  check('T10.5 未知 hostId 报错', e1 && String(e1.message).includes('t1'))
  let e2 = null
  try { await runTool.execute({ command: '' }) } catch (e) { e2 = e }
  check('T10.6 空 command 报错', e2 !== null)

  // 门卫通道：gate 失败 kind=unreachable / FsOpsError kind 透传
  {
    const ctx2 = fakeCtx()
    const inst = apply(ctx2, { hosts: [{ id: 't1', host: '1.2.3.4', identityFile: '/k' }], hostsFile: path.join(os.tmpdir(), 'ssh-remote-t10b-' + Date.now() + '.json') })
    const runTool2 = ctx2._registeredTools.find(t => t.name === 'ssh_run')
    inst.conn.beforeOp = async () => ({ ok: false, error: 'ssh: connect to host 1.2.3.4 port 22: Connection timed out' })
    const rg = await runTool2.execute({ command: 'x' })
    check('T10.7 gate 失败 kind=unreachable', rg.ok === false && rg.error.kind === 'unreachable' && rg.error.message.includes('timed out'), JSON.stringify(rg))
    const readTool2 = ctx2._registeredTools.find(t => t.name === 'ssh_read')
    inst.conn.beforeOp = async () => ({ ok: true, degraded: false })
    inst.fsops.read = async () => { const e = new FsOpsError('文件在读取后已被修改', 'stale-edit'); throw e }
    const rr = await readTool2.execute({ path: '/a' })
    check('T10.8 FsOpsError kind 透传', rr.ok === false && rr.error.kind === 'stale-edit', JSON.stringify(rr))
    ctx2._disposers.forEach(d => d())
  }
  // 清理（防 watcher 吊住进程）
  ctx._disposers.forEach(d => d())
}

// ================= T11 HTTP API =================
async function t11() {
  console.log('== T11 HTTP API ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t11-'))
  const hostsFile = path.join(tmpDir, 'hosts.json')

  const ctx = fakeCtx()
  const inst = apply(ctx, { hosts: [], hostsFile })
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
  // dsh 0.1.7 WebRoute 契约：注册的 handler 严格 (req, res) 两参
  check('T11.1b WebRoute handler 严格两参', typeof handler === 'function' && handler.length === 2, String(handler.length))
  // 路由体（含测试用 body 注入第三参）挂在 apply 返回实例上，供测试/调试使用
  const api = inst.handleApi
  check('T11.1c 内部路由体暴露且可注入 body', typeof api === 'function' && api.length === 3, String(api && api.length))

  const mkRes = () => { const r = {}; r.writeHead = (s) => { r.status = s }; r.end = (b) => { r.body = b }; return r }

  // 回环守卫
  const res403 = mkRes()
  handler({ method: 'GET', url: '/ssh-remote/api/status', headers: { host: 'evil.com' } }, res403)
  check('T11.2 非回环 403', res403.status === 403)
  const res403b = mkRes()
  handler({ method: 'GET', url: '/ssh-remote/api/status', headers: { host: '127.0x0.1:8080' } }, res403b)
  check('T11.2b 未转义通配形态 403', res403b.status === 403, String(res403b.status))

  // hosts CRUD
  const resC = mkRes()
  api({ method: 'POST', url: '/ssh-remote/api/hosts', headers: { host: '127.0.0.1:1' } }, resC, JSON.stringify({ id: 'd1', name: '动态机', host: '1.1.1.1', identityFile: '/k' }))
  await sleep(30)
  check('T11.3 新增动态主机 200', resC.status === 200 && JSON.parse(resC.body).ok === true, resC.body)
  check('T11.4 落盘 hostsFile', readHostsFile(hostsFile).some(h => h.id === 'd1'))

  // bulk 替换
  const resB = mkRes()
  api({ method: 'POST', url: '/ssh-remote/api/hosts/bulk', headers: { host: 'localhost' } }, resB, JSON.stringify({ hosts: [{ id: 'd2', host: '2.2.2.2', identityFile: '/k' }] }))
  await sleep(30)
  check('T11.5 bulk 替换动态集', readHostsFile(hostsFile).length === 1 && readHostsFile(hostsFile)[0].id === 'd2')

  // import 预览 + 提交
  const resI = mkRes()
  api({ method: 'POST', url: '/ssh-remote/api/hosts/import', headers: { host: '127.0.0.1:1' } }, resI, JSON.stringify({ format: 'sshconfig', text: 'Host web\n  HostName 3.3.3.3\n  IdentityFile /k\n' }))
  await sleep(30)
  const pv = JSON.parse(resI.body)
  check('T11.6 import 预览不落盘', pv.ok === true && pv.value.preview.hosts.length === 1 && readHostsFile(hostsFile).length === 1, resI.body)
  const resI2 = mkRes()
  api({ method: 'POST', url: '/ssh-remote/api/hosts/import', headers: { host: '127.0.0.1:1' } }, resI2, JSON.stringify({ format: 'sshconfig', text: 'Host web\n  HostName 3.3.3.3\n  IdentityFile /k\n', commit: true }))
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
  const inst2 = apply(ctx2, { hosts: [{ id: 'st', host: 'h', identityFile: 'k' }], hostsFile: path.join(tmpDir, 'h2.json') })
  const routes2 = []
  ctx2._injects.forEach(([names, fn]) => names.includes('webServer') && fn({ effect(cb) { cb(); return () => {} }, webServer: { register: (e) => routes2.push(e) } }))
  const api2 = inst2.handleApi
  const resDel2 = mkRes()
  routes2[0].handler({ method: 'DELETE', url: '/ssh-remote/api/hosts/st', headers: { host: '127.0.0.1:1' } }, resDel2)
  await sleep(30)
  check('T11.10 静态主机删除被拒', resDel2.status === 409, String(resDel2.status))

  // bulk 静态冲突 / POST 静态 id / 坏 JSON / 流式 body 生产路径
  const resBC = mkRes()
  api2({ method: 'POST', url: '/ssh-remote/api/hosts/bulk', headers: { host: '127.0.0.1:1' } }, resBC, JSON.stringify({ hosts: [{ id: 'st', host: 'h2', identityFile: 'k' }] }))
  await sleep(30)
  check('T11.11 bulk 静态冲突 409', resBC.status === 409, String(resBC.status))
  const resPC = mkRes()
  api2({ method: 'POST', url: '/ssh-remote/api/hosts', headers: { host: '127.0.0.1:1' } }, resPC, JSON.stringify({ id: 'st', host: 'h2', identityFile: 'k' }))
  await sleep(30)
  check('T11.12 POST 静态 id 409', resPC.status === 409, String(resPC.status))
  const resBJ = mkRes()
  api2({ method: 'POST', url: '/ssh-remote/api/hosts', headers: { host: '127.0.0.1:1' } }, resBJ, '{bad json')
  await sleep(30)
  check('T11.13 坏 JSON 400', resBJ.status === 400, String(resBJ.status))
  // 流式 body 生产路径（req 事件流，不经第三参）
  const mkStreamReq = (obj) => {
    const chunks = Buffer.from(JSON.stringify(obj))
    const listeners = {}
    return {
      method: 'POST', url: '/ssh-remote/api/hosts', headers: { host: '127.0.0.1:1' },
      on(evt, cb) { listeners[evt] = cb; if (evt === 'end') { setTimeout(() => { listeners.data && listeners.data(chunks); listeners.end() }, 5) } return this },
    }
  }
  const resStream = mkRes()
  routes2[0].handler(mkStreamReq({ id: 'dyn-s', host: '4.4.4.4', identityFile: '/k' }), resStream)
  await sleep(60)
  check('T11.14 流式 body 生产路径 200', resStream.status === 200 && readHostsFile(path.join(tmpDir, 'h2.json')).some(h => h.id === 'dyn-s'), resStream.body)

  ctx._disposers.forEach(d => d())
  ctx2._disposers.forEach(d => d())
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ================= T12 工具呈现（presentCall/presentResult） =================
async function t12() {
  console.log('== T12 工具呈现 ==')
  const ctx = fakeCtx()
  apply(ctx, { hosts: [{ id: 'r1', host: '1.2.3.4', identityFile: '/k' }], hostsFile: path.join(os.tmpdir(), 'ssh-remote-t12-' + Date.now() + '.json') })
  const tool = (n) => ctx._registeredTools.find(t => t.name === n)
  const names = ctx._registeredTools.map(t => t.name)

  check('T12.1 十个工具都声明了 presentCall/presentResult',
    names.length === 10 && ctx._registeredTools.every(t => typeof t.presentCall === 'function' && typeof t.presentResult === 'function'),
    names.filter(n => { const t = tool(n); return typeof t.presentCall !== 'function' || typeof t.presentResult !== 'function' }).join(','))

  // ssh_run：terminal 卡（命令为题、主机为描述）
  const runCall = tool('ssh_run').presentCall({ hostId: 'r1', command: 'systemctl status nginx', cwd: '/srv' })
  check('T12.2 ssh_run presentCall 为 terminal 卡', runCall.card === 'terminal' && runCall.title === 'systemctl status nginx' && runCall.description.includes('r1') && runCall.description.includes('/srv'), JSON.stringify(runCall))
  const runOk = tool('ssh_run').presentResult({ command: 'x' }, { content: [], isError: false, meta: { output: 'ok\n', exitCode: 0 } })
  check('T12.3 ssh_run presentResult 带 output/exitCode', runOk.card === 'terminal' && runOk.output === 'ok\n' && runOk.exitCode === 0, JSON.stringify(runOk))
  const runErr = tool('ssh_run').presentResult({ command: 'x' }, { content: [], isError: true, meta: { error: 'ssh: connect timeout' } })
  check('T12.4 ssh_run 失败回落通用错误卡', runErr.card === 'generic' && String(runErr.title).includes('connect timeout'), JSON.stringify(runErr))

  // ssh_write / ssh_edit：diff 卡（写入无前像；编辑是字面量替换）
  const wCall = tool('ssh_write').presentCall({ path: '/tmp/a.txt', content: 'hello\n' })
  check('T12.5 ssh_write presentCall 为 diff 卡且 oldText=null', wCall.card === 'diff' && wCall.diffs[0].path === '/tmp/a.txt' && wCall.diffs[0].oldText === null && wCall.diffs[0].newText === 'hello\n', JSON.stringify(wCall))
  const eCall = tool('ssh_edit').presentCall({ path: '/tmp/a.txt', oldString: 'a', newString: 'b' })
  check('T12.6 ssh_edit presentCall 为 diff 卡', eCall.card === 'diff' && eCall.diffs[0].oldText === 'a' && eCall.diffs[0].newText === 'b', JSON.stringify(eCall))
  const eRes = tool('ssh_edit').presentResult({ path: '/tmp/a.txt', oldString: 'a', newString: 'b' }, { content: [], isError: false, meta: {} })
  check('T12.7 ssh_edit presentResult 保持 diff（不回落原文）', eRes.card === 'diff' && eRes.diffs[0].newText === 'b', JSON.stringify(eRes))
  const eErr = tool('ssh_edit').presentResult({ path: '/tmp/a.txt', oldString: 'a' }, { content: [], isError: true, meta: { error: 'stale-edit: 文件已被修改' } })
  check('T12.8 ssh_edit 失败回落错误卡', eErr.card === 'generic' && String(eErr.title).includes('stale-edit'), JSON.stringify(eErr))
  // 框架层回放保护：必填参数缺失时 present* 被短路为 undefined（不抛、不猜）
  check('T12.8b 参数校验失败时 presentCall 短路为 undefined', tool('ssh_edit').presentCall({ path: '/tmp/a.txt' }) === undefined)

  // ssh_grep：presentationMeta 投影 → search/matches 分组
  const grepTool = tool('ssh_grep')
  const grepMeta = grepTool.output.presentationMeta({ pattern: 'foo' }, { matches: ['a.js:3:foo', 'a.js:7:bar', 'b.js:1:baz'], truncated: true, total: 9 })
  check('T12.9 ssh_grep presentationMeta 分组', grepMeta.files.length === 2 && grepMeta.files[0].path === 'a.js' && grepMeta.files[0].matches.length === 2 && grepMeta.files[0].matches[0].lineNumber === 3 && grepMeta.total === 9, JSON.stringify(grepMeta))
  const grepRes = grepTool.presentResult({ pattern: 'foo' }, { content: [], isError: false, meta: grepMeta })
  check('T12.10 ssh_grep presentResult 为 search 卡', grepRes.card === 'search' && grepRes.shape === 'matches' && grepRes.truncated === true && grepRes.total === 9, JSON.stringify(grepRes))

  // ssh_glob：presentationMeta 投影 → search/paths
  const globTool = tool('ssh_glob')
  const globMeta = globTool.output.presentationMeta({ pattern: '*.js' }, { files: ['a.js', 'b.js'], truncated: false, total: 2 })
  const globRes = globTool.presentResult({ pattern: '*.js' }, { content: [], isError: false, meta: globMeta })
  check('T12.11 ssh_glob presentResult 为 paths 搜索卡', globRes.card === 'search' && globRes.shape === 'paths' && globRes.paths.length === 2 && globRes.truncated === false, JSON.stringify(globRes))

  // ssh_read：read 意图 + 行号跟随
  const rCall = tool('ssh_read').presentCall({ path: '/etc/nginx.conf', offset: 40 })
  check('T12.12 ssh_read presentCall kind=read 带 locations', rCall.card === 'generic' && rCall.kind === 'read' && rCall.locations[0].path === '/etc/nginx.conf' && rCall.locations[0].line === 40, JSON.stringify(rCall))

  // ssh_push/pull：generic + 主机摘要
  check('T12.13 ssh_push/pull presentCall 摘要', tool('ssh_push').presentCall({ localPath: '/a', remotePath: '/b' }).title.includes('/a → /b')
    && tool('ssh_pull').presentCall({ remotePath: '/b', localPath: '/a' }).kind === 'fetch', JSON.stringify(tool('ssh_pull').presentCall({ remotePath: '/b', localPath: '/a' })))

  // 呈现层纪律：空参数/缺 meta/异常载荷都不得抛，且必须给出卡片或 undefined
  // 注意：引擎只对 schema 合法的参数调用 present*（非法参数短路为 undefined），
  // 因此这里直接裸调，验证「即使被绕过包装也不抛」。
  let threw = null
  const views = []
  const metas = []
  try {
    for (const t of ctx._registeredTools) {
      views.push(t.presentCall({}), t.presentCall(undefined), t.presentCall(null))
      views.push(t.presentResult({}, { content: [], isError: false }))
      views.push(t.presentResult(undefined, { content: [], isError: true, meta: { error: 'e' } }))
      if (typeof t.output.presentationMeta === 'function') {
        metas.push(t.output.presentationMeta({}, {}), t.output.presentationMeta(undefined, undefined))
      }
    }
  } catch (e) { threw = e }
  check('T12.14 呈现层裸调 replay-safe 永不抛', threw === null, threw && String(threw.message))
  check('T12.15 呈现结果都是卡片或 undefined', views.every(c => c === undefined || (c && typeof c.card === 'string')), JSON.stringify(views.filter(c => c !== undefined && !(c && typeof c.card === 'string'))))
  check('T12.16 presentationMeta 只返回纯数据', metas.every(m => m && typeof m === 'object' && typeof m.card === 'undefined'), JSON.stringify(metas.filter(m => !m || typeof m !== 'object')))

  ctx._disposers.forEach(d => d())
}

// ================= T13 插件清单（0.1.7 对齐） =================
async function t13() {
  console.log('== T13 插件清单 ==')
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

  check('T13.1 dsh/qilin 都是 manifestVersion 1', pkg.dsh.manifestVersion === 1 && pkg.qilin.manifestVersion === 1, JSON.stringify({ dsh: pkg.dsh.manifestVersion, qilin: pkg.qilin.manifestVersion }))
  check('T13.2 bundle.patch 指向 cordis.patch.yml', pkg.dsh.bundle.patch === './cordis.patch.yml' && pkg.qilin.bundle.patch === './cordis.patch.yml')
  check('T13.3 client.inject 不再引用已删除的 dsh-client-runtime', pkg.dsh.client.inject.every(n => n !== '@deepseek-ai/dsh-client-runtime'), pkg.dsh.client.inject.join(','))
  check('T13.4 client.inject 覆盖两个槽位声明方',
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation') && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'),
    pkg.dsh.client.inject.join(','))
  check('T13.5 platform=web 且 dsh/qilin 客户端声明一致', pkg.dsh.client.platform === 'web' && JSON.stringify(pkg.dsh.client) === JSON.stringify(pkg.qilin.client))

  // 兼容性检查只看 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 的 peer：
  // 范围必须同时覆盖 0.1.x 预发布代（含 0.1.7-rc.2）且不越到 0.2
  check('T13.6 dsh peer 覆盖 0.1.x 预发布且不越代', pkg.peerDependencies['@deepseek-ai/dsh'] === '>=0.1.0-rc.5 <0.2.0', String(pkg.peerDependencies['@deepseek-ai/dsh']))
  check('T13.7 dsh-tools peer 覆盖 0.1.x 预发布且不越代', pkg.peerDependencies['@deepseek-ai/dsh-tools'] === '>=0.1.0-rc.5 <0.2.0', String(pkg.peerDependencies['@deepseek-ai/dsh-tools']))
  check('T13.8 schemastery peer 钉在大版本 3', pkg.peerDependencies['@deepseek-ai/schemastery'] === '>=3.18.0 <4.0.0', String(pkg.peerDependencies['@deepseek-ai/schemastery']))
  check('T13.9 engines.dsh 与 peer 同口径', pkg.engines && pkg.engines.dsh === '>=0.1.0-rc.5 <0.2.0', JSON.stringify(pkg.engines))

  // 展示元数据：icon + 本地化 title/description（引擎经 exports 读取，必须导出）
  check('T13.10 exports 导出 package.json 与 locale', pkg.exports['./package.json'] === './package.json' && Boolean(pkg.exports['./locale/*.json']), JSON.stringify(pkg.exports))
  check('T13.11 files 含 locale 与 icon', pkg.files.includes('locale/**/*.json') && pkg.files.includes('icon.svg'), pkg.files.join(','))
  const iconPath = path.join(root, pkg.icon)
  const iconStat = fs.statSync(iconPath)
  check('T13.12 icon 为 SVG 且不超 256KiB', pkg.icon === 'icon.svg' && iconStat.size < 256 * 1024, pkg.icon + ' ' + iconStat.size)
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locale/en.json'), 'utf8'))
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'locale/zh.json'), 'utf8'))
  check('T13.13 本地化标题/描述齐备（en+zh）',
    typeof en.meta.title === 'string' && en.meta.title.length > 0 && typeof en.meta.description === 'string' && en.meta.description.length > 0
    && typeof zh.meta.title === 'string' && zh.meta.title.length > 0 && typeof zh.meta.description === 'string' && zh.meta.description.length > 0,
    JSON.stringify({ en: en.meta.title, zh: zh.meta.title }))
}

// ================= T14 浏览器组件渲染（回归：useRef({}) 初值为真 → 默认状态永不建立 → 首帧崩溃） =================
// 客户端组件此前从未被渲染测试过：settings.section 首帧就读 st.hosts.map，而 useRef({}) 让
// `stateRef.current || { hosts: [] ... }` 永不生效 → React 子树整体抛错 → 设置页白板；
// 头部胶囊展开浮窗读 st.probing 也是同一个雷。这里用零依赖 hook 桩渲染组件树并模拟点击。
function t14Hooks() {
  const refs = []
  let idx = 0
  return {
    refs,
    useState: (init) => [init, () => {}],
    useRef: (init) => { const i = idx++; if (!(i in refs)) refs[i] = { current: init }; return refs[i] },
    useCallback: (fn) => fn,
    useEffect: (fn) => { fn() },
    reset: () => { idx = 0 },
  }
}

function t14React(hooks) {
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: Object.assign({}, props || {}, { children }) }
    },
    useState: hooks.useState,
    useRef: hooks.useRef,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
  }
}

function t14Walk(node, visit) {
  if (Array.isArray(node)) { node.forEach(k => t14Walk(k, visit)); return } // h('tbody', null, rows) 会包成嵌套数组
  if (!node || typeof node !== 'object') return
  visit(node)
  const kids = node.props && node.props.children
  if (kids !== undefined) t14Walk(kids, visit)
}

function t14Strings(node, out = []) {
  if (Array.isArray(node)) { node.forEach(k => t14Strings(k, out)); return out }
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  const kids = node.props && node.props.children
  if (kids !== undefined) t14Strings(kids, out)
  return out
}

/** 收集某个 prop 的取值（主机名/地址等在表格里是 input 的 value，不是文本节点）。 */
function t14PropValues(node, prop, out = []) {
  t14Walk(node, (n) => { if (n.props && n.props[prop] !== undefined) out.push(n.props[prop]) })
  return out
}

function t14Count(node, type) {
  let n = 0
  t14Walk(node, (x) => { if (x.type === type) n += 1 })
  return n
}

function t14Button(node, label) {
  let found
  t14Walk(node, (n) => {
    if (found === undefined && n.type === 'button' && t14Strings(n).includes(label)) found = n
  })
  return found
}

/** 渲染一次组件：hook 索引归零，ref 对象跨渲染保持（与 React 的组件实例语义一致）。 */
function t14Render(hooks, Comp, props) {
  hooks.reset()
  return Comp(props)
}

/** 在受控沙箱里执行客户端源码，取出 factory 注册出来的组件。 */
function t14LoadClient(source, hooks, fetchImpl) {
  const captured = { mod: null }
  const injected = [] // 记录 <style> 注入，锁「去重注入」契约
  const fn = new Function('window', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'Blob', 'URL', 'document', source)
  fn(
    { __ModuleLoader__: { load: (m) => { captured.mod = m } } },
    fetchImpl, console, setTimeout, clearTimeout,
    class {}, { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    { head: { appendChild: (el) => injected.push(el) }, getElementById: (id) => injected.find(el => el.id === id) || null, createElement: () => ({ click() {} }) },
  )
  const mod = captured.mod.factory((name) => {
    if (name === 'react') return t14React(hooks)
    throw new Error('未预期的 require: ' + name)
  })
  const comps = {}
  const keys = []
  mod.apply({ slots: { inject: (key, cb) => { keys.push(key); cb() }, register: (opts, Comp) => { comps[opts.name] = Comp; return () => {} } } })
  return { comps, keys, id: captured.mod.id, injected }
}

async function t14() {
  console.log('== T14 浏览器组件渲染 ==')
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
  const source = fs.readFileSync(path.join(root, 'client/index.js'), 'utf8')
  const hostsBody = { ok: true, value: [{ id: 'm1', name: '主机一', host: '10.0.0.1', user: 'root', port: 22, source: 'dynamic' }] }
  const okFetch = (url) => Promise.resolve({
    json: () => Promise.resolve(String(url).includes('/status')
      ? { ok: true, value: { hosts: [{ id: 'm1', name: '主机一' }], connections: [] } }
      : String(url).includes('/probe')
        ? { ok: true, value: { hostId: 'm1', ok: true, degraded: false, latencyMs: 12 } }
        : hostsBody),
  })
  const badFetch = () => Promise.reject(new Error('offline'))

  const CHIP = 'conversation.session.header.utilities'
  const SECTION = 'settings.section'

  const chipHooks = t14Hooks()
  const chip = t14LoadClient(source, chipHooks, okFetch)
  const setHooks = t14Hooks()
  const settings = t14LoadClient(source, setHooks, okFetch)
  const badHooks = t14Hooks()
  const bad = t14LoadClient(source, badHooks, badFetch)

  check('T14.1 客户端以 dsh-ssh-remote 注册并注入两个槽位',
    chip.id === 'dsh-ssh-remote' && chip.keys.length === 2 && chip.keys.includes(CHIP) && chip.keys.includes(SECTION),
    chip.id + ' [' + chip.keys.join(', ') + ']')

  // --- 会话头部胶囊 ---
  let chipTree, chipErr
  try { chipTree = t14Render(chipHooks, chip.comps[CHIP], {}) } catch (e) { chipErr = e }
  check('T14.2 头部胶囊首帧渲染不抛错', chipErr === undefined && t14Strings(chipTree).includes('SSH'), chipErr && chipErr.message)

  let openErr, openTree
  try {
    await sleep(5)
    chipTree = t14Render(chipHooks, chip.comps[CHIP], {})
    chipHooks.refs[0].current = { getBoundingClientRect: () => ({ bottom: 40, right: 500 }) } // wrapRef：让浮窗拿到定位
    chipTree.props.onClick()
    openTree = t14Render(chipHooks, chip.comps[CHIP], {})
  } catch (e) { openErr = e }
  check('T14.3 展开胶囊浮窗（读 st.probing）不抛错且渲染出主机行',
    openErr === undefined && t14Strings(openTree).join('|').includes('连通性'), openErr && openErr.message)

  // --- 设置页 ---
  let setTree, setErr
  try { setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} }) } catch (e) { setErr = e }
  check('T14.4 设置页首帧渲染不抛错（useRef 初值回归）', setErr === undefined, setErr && setErr.message)

  const bar = t14Strings(setTree).join('|')
  check('T14.5 设置页渲染出工具栏', bar.includes('+ 新增主机') && bar.includes('批量导入') && bar.includes('导出 JSON'), bar.slice(0, 70))
  check('T14.6 初始空状态：无主机卡片且有引导文案',
    t14PropValues(setTree, 'data-ssh-host').length === 0 && bar.includes('暂无主机'),
    'cards=' + t14PropValues(setTree, 'data-ssh-host').length)

  let addErr
  try { t14Button(setTree, '+ 新增主机').props.onClick(); setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} }) } catch (e) { addErr = e }
  check('T14.7 点「+ 新增主机」后出现一张主机卡片（st.hosts 可用）',
    addErr === undefined && t14PropValues(setTree, 'data-ssh-host').length === 1, addErr && addErr.message)

  let impErr
  try { t14Button(setTree, '批量导入').props.onClick(); setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} }) } catch (e) { impErr = e }
  check('T14.8 展开批量导入区不抛错', impErr === undefined && t14Count(setTree, 'textarea') === 1, impErr && impErr.message)

  await sleep(5)
  setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  const cells = t14PropValues(setTree, 'value').map(String)
  check('T14.9 宿主数据回填后渲染出该主机卡片', t14PropValues(setTree, 'data-ssh-host').length === 1 && cells.includes('主机一') && cells.includes('10.0.0.1'),
    'cards=' + t14PropValues(setTree, 'data-ssh-host').length + ' cells=' + JSON.stringify(cells.slice(0, 4)))

  let badErr, badTree
  try { badTree = t14Render(badHooks, bad.comps[SECTION], { close() {} }); await sleep(5); badTree = t14Render(badHooks, bad.comps[SECTION], { close() {} }) } catch (e) { badErr = e }
  check('T14.10 宿主 API 不可达时降级提示而不崩', badErr === undefined && t14Strings(badTree).join('|').includes('host api unavailable'), badErr && badErr.message)

  const code = source.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  check('T14.11 客户端不再出现 useRef({}) 真值初值', !/useRef\(\{\}\)/.test(code))

  // 样式看齐（dsh-coding-sidebar「侧边卡片」配方）：DSH 原生令牌 + 760px 内容列 + hover/focus 样式表
  let tokenHit = false
  t14Walk(setTree, (n) => { if (n.props && n.props.style && JSON.stringify(n.props.style).includes('--dsw-alias-')) tokenHit = true })
  check('T14.12 设置页走 DSH 原生令牌（与侧边卡片设置页同配方）', tokenHit)
  const css = settings.injected.map(el => String(el.textContent)).join('\n')
  check('T14.13 :hover/:focus 样式表去重注入', settings.injected.length === 1
    && css.includes('.dsshr-btn-primary:hover') && css.includes(':focus-visible') && css.includes('prefers-reduced-motion'),
    'injected=' + settings.injected.length)

  // ── 登录方式与密码 UI：密码只进加密库，永不回显/落 DOM 值 ──
  setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  t14Button(setTree, '+ 新增主机').props.onClick()
  setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  const authText = t14Strings(setTree).join('|')
  check('T14.14 新增行渲染「登录方式」与私钥路径', authText.includes('登录方式') && authText.includes('私钥路径'), authText.slice(0, 120))

  let selErr
  try {
    let hostInput
    t14Walk(setTree, (n) => { if (hostInput === undefined && n.type === 'input' && n.props.placeholder === 'IP 或域名') hostInput = n })
    hostInput.props.onChange({ target: { value: '10.1.2.3' } })
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
    let sel
    t14Walk(setTree, (n) => { if (sel === undefined && n.type === 'select') sel = n })
    sel.props.onChange({ target: { value: 'password' } })
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  } catch (e) { selErr = e }
  const pwText = t14Strings(setTree).join('|')
  const modeVals = t14PropValues(setTree, 'value').map(String)
  check('T14.15 切到密码模式显示密码控件', selErr === undefined && pwText.includes('登录密码') && pwText.includes('设置密码') && modeVals.includes('password'), pwText.slice(0, 120))
  let pwCell
  t14Walk(setTree, (n) => { if (pwCell === undefined && n.props && n.props.style && n.props.style.gridColumn === 'span 2') pwCell = n })
  check('T14.15b 密码格跨 2 列（避免保存按钮溢出到下一格被压住）', pwCell !== undefined)

  let pwErr
  try {
    t14Button(setTree, '设置密码').props.onClick()
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
    let pwInput
    t14Walk(setTree, (n) => { if (pwInput === undefined && n.type === 'input' && n.props.type === 'password') pwInput = n })
    pwInput.props.onChange({ target: { value: 'pw-机密-123' } })
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
    t14Button(setTree, '保存').props.onClick()
    await sleep(5)
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  } catch (e) { pwErr = e }
  const afterPw = t14Strings(setTree).join('|')
  const afterVals = t14PropValues(setTree, 'value').map(String)
  check('T14.16 密码输入为 password 型且保存后清空', pwErr === undefined && !afterVals.includes('pw-机密-123'), JSON.stringify(afterVals.slice(0, 4)))
  check('T14.17 保存后给出加密库提示且未回显密码', afterPw.includes('加密凭据库') && afterPw.includes('root@10.1.2.3') && !afterPw.includes('pw-机密-123'), afterPw.slice(0, 140))

  // ── 测试连接入口（此前只在会话头部胶囊浮窗里，设置页缺失）──
  setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  const testBtn = t14Button(setTree, '测试连接')
  check('T14.18 卡片提供「测试连接」入口', testBtn !== undefined && testBtn.props.disabled === false, testBtn === undefined ? '无按钮' : String(testBtn.props.disabled))
  let probeErr
  try {
    testBtn.props.onClick()
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
    await sleep(5)
    setTree = t14Render(setHooks, settings.comps[SECTION], { close() {} })
  } catch (e) { probeErr = e }
  const probeText = t14Strings(setTree).join('|')
  check('T14.19 测试结果就地展示（连通/延迟）', probeErr === undefined && probeText.includes('✓ 连通') && probeText.includes('12ms'), probeText.slice(0, 140))
}


// ================= T15 加密凭据库（credentials.js） =================
import * as crypto from 'node:crypto'
import { CredentialStore, identityOf } from '../lib/credentials.js'

async function t15() {
  console.log('== T15 加密凭据库 ==')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t15-'))
  const file = path.join(tmp, 'credentials.enc')
  const keyFile = path.join(tmp, 'credentials.key')
  const store = new CredentialStore({ file, keyFile })

  check('T15.1 identityOf 形态（供 askpass 反查）', identityOf('root', '10.0.0.1') === 'root@10.0.0.1', identityOf('root', '10.0.0.1'))
  check('T15.2 未存时 has/get 均为空', store.has('root@10.0.0.1') === false && store.get('root@10.0.0.1') === null)

  store.set('root@10.0.0.1', 's3cret-密码')
  check('T15.3 写入后可取回（含非 ASCII）', store.get('root@10.0.0.1') === 's3cret-密码')
  check('T15.4 has 判定', store.has('root@10.0.0.1') === true)

  const raw = fs.readFileSync(file, 'utf8')
  check('T15.5 密文文件不含明文', !raw.includes('s3cret') && !raw.includes('密码'), raw.slice(0, 90))
  check('T15.6 密钥文件已生成且 0600', fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o777) === 0o600, (fs.statSync(keyFile).mode & 0o777).toString(8))
  check('T15.7 密文文件 0600', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8))

  store.set('u2@h2', 'second')
  check('T15.8 多条并存', store.get('u2@h2') === 'second' && store.get('root@10.0.0.1') === 's3cret-密码')
  store.remove('root@10.0.0.1')
  check('T15.9 删除单条不影响其它', store.has('root@10.0.0.1') === false && store.get('u2@h2') === 'second')
  check('T15.10 list 只有身份不含密码', JSON.stringify(store.list()) === JSON.stringify(['u2@h2']), JSON.stringify(store.list()))

  fs.writeFileSync(keyFile, crypto.randomBytes(32))
  check('T15.11 自管密钥被换后解不开（返回 null 不抛错）', store.get('u2@h2') === null)
}

// ================= T16 登录方式参数（connection.js） =================
async function t16() {
  console.log('== T16 登录方式参数 ==')
  const conn = new ConnectionManager({})
  const key = { id: 'k', user: 'root', host: 'a', identityFile: '/k/id', auth: 'key', connectTimeoutSec: 15 }
  const agent = { id: 'g', user: 'root', host: 'b', identityFile: '', auth: 'agent', connectTimeoutSec: 15 }
  const pw = { id: 'p', user: 'root', host: 'c', identityFile: '', auth: 'password', connectTimeoutSec: 15 }

  const keyArgs = conn.baseArgs(key)
  check('T16.1 key：带 -i 与 BatchMode', keyArgs.includes('-i') && keyArgs.includes('/k/id') && keyArgs.includes('BatchMode=yes'), keyArgs.join(' '))
  const agentArgs = conn.baseArgs(agent)
  check('T16.2 agent：不传 -i（走 agent/config/默认密钥），保留 BatchMode', !agentArgs.includes('-i') && agentArgs.includes('BatchMode=yes'), agentArgs.join(' '))
  const pwArgs = conn.baseArgs(pw)
  check('T16.3 password：强制密码/键盘交互、禁公钥', pwArgs.includes('PreferredAuthentications=password,keyboard-interactive') && pwArgs.includes('PubkeyAuthentication=no'), pwArgs.join(' '))
  check('T16.4 password：不设 BatchMode（BatchMode 会连 SSH_ASKPASS 一起禁掉）', !pwArgs.includes('BatchMode=yes'))
  check('T16.5 scp 同口径', conn.scpArgs(pw).includes('PubkeyAuthentication=no') && !conn.scpArgs(agent).includes('-i'))
  check('T16.6 check/exit 同口径', conn.checkArgs(pw).includes('PubkeyAuthentication=no') && conn.checkArgs(key).includes('/k/id'))
}

// ================= T17 凭据 API（HTTP） =================
async function t17() {
  console.log('== T17 凭据 API ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t17-'))
  const hostsFile = path.join(tmpDir, 'hosts.json')
  const ctx = fakeCtx()
  const inst = apply(ctx, { hosts: [{ id: 'h1', name: '密码机', host: '9.9.9.9', user: 'root', auth: 'password' }], hostsFile })
  const mkRes = () => { const r = {}; r.writeHead = (s) => { r.status = s }; r.end = (b) => { r.body = b }; return r }
  const api = inst.handleApi
  const H = { host: '127.0.0.1:1' }

  check('T17.1 askpass 包装脚本生成在数据目录', fs.existsSync(path.join(tmpDir, 'askpass.sh')), tmpDir)
  const sh = fs.readFileSync(path.join(tmpDir, 'askpass.sh'), 'utf8')
  check('T17.2 包装脚本带凭据库与密钥路径', sh.includes('askpass.js') && sh.includes('credentials.enc') && sh.includes('credentials.key'), sh.trim())

  const resPut = mkRes()
  api({ method: 'PUT', url: '/ssh-remote/api/credentials', headers: H }, resPut, JSON.stringify({ user: 'root', host: '9.9.9.9', password: 'pw1' }))
  await sleep(20)
  const putBody = JSON.parse(resPut.body)
  check('T17.3 PUT 写入凭据', resPut.status === 200 && putBody.value.hasPassword === true && putBody.value.identity === 'root@9.9.9.9', resPut.body)

  const resList = mkRes()
  api({ method: 'GET', url: '/ssh-remote/api/hosts', headers: H }, resList)
  await sleep(20)
  const list = JSON.parse(resList.body).value
  check('T17.4 主机列表标注 hasPassword 与 auth', list.length === 1 && list[0].hasPassword === true && list[0].auth === 'password', resList.body.slice(0, 140))
  check('T17.5 列表响应不含密码明文', !resList.body.includes('pw1'), resList.body.slice(0, 140))

  const resDel = mkRes()
  api({ method: 'DELETE', url: '/ssh-remote/api/credentials/' + encodeURIComponent('root@9.9.9.9'), headers: H }, resDel)
  await sleep(20)
  check('T17.6 DELETE 清除凭据', resDel.status === 200 && JSON.parse(resDel.body).value.removed === true, resDel.body)

  const resBad = mkRes()
  api({ method: 'PUT', url: '/ssh-remote/api/credentials', headers: H }, resBad, JSON.stringify({ user: 'root', host: 'x' }))
  await sleep(20)
  check('T17.7 缺密码 400', resBad.status === 400, String(resBad.status))
}


// ================= T18 保存兜底：缺 id 自动补全（回归"保存后计数 0"） =================
async function t18() {
  console.log('== T18 保存兜底：缺 id 自动补全 ==')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-remote-t18-'))
  const hostsFile = path.join(tmpDir, 'hosts.json')
  const ctx = fakeCtx()
  const inst = apply(ctx, { hosts: [], hostsFile })
  const api = inst.handleApi
  const H = { host: '127.0.0.1:1' }
  const mkRes = () => { const r = {}; r.writeHead = (s) => { r.status = s }; r.end = (b) => { r.body = b }; return r }
  const call = async (method, url, bodyObj) => {
    const res = mkRes()
    api({ method, url, headers: H }, res, bodyObj === undefined ? undefined : JSON.stringify(bodyObj))
    await sleep(20)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const r1 = await call('POST', '/ssh-remote/api/hosts/bulk', { hosts: [{ name: '生产机', host: '10.0.0.1', user: 'root' }] })
  check('T18.1 缺 id 的条目被自动补全并保存', r1.status === 200 && r1.body.value.length === 1 && /^[a-z0-9_-]+$/.test(r1.body.value[0].id), JSON.stringify(r1.body.value).slice(0, 120))
  check('T18.2 补 id 后无 warnings', (r1.body.warnings || []).length === 0, JSON.stringify(r1.body.warnings))

  const r2 = await call('POST', '/ssh-remote/api/hosts/bulk', { hosts: [{ name: '同名', host: '10.0.0.5' }, { name: '同名', host: '10.0.0.5' }] })
  const ids = (r2.body.value || []).map(h => h.id)
  check('T18.3 同 slug 条目 id 去重', r2.status === 200 && r2.body.value.length === 2 && new Set(ids).size === 2, JSON.stringify(ids))

  const r3 = await call('GET', '/ssh-remote/api/hosts')
  check('T18.4 保存后重新拉取列表非空（回归：保存后计数 0）', r3.body.value.length === 2, JSON.stringify(r3.body.value.map(h => h.id)))

  const r4 = await call('POST', '/ssh-remote/api/hosts/bulk', { hosts: [{ name: '缺主机地址' }] })
  check('T18.5 真非法条目进 warnings 而非静默', r4.status === 200 && (r4.body.warnings || []).length === 1, JSON.stringify(r4.body.warnings))

  const r5 = await call('POST', '/ssh-remote/api/hosts', { name: '单条', host: '10.0.0.9' })
  check('T18.6 单条创建缺 id 同样自动补全', r5.status === 200 && (r5.body.value || []).some(h => h.host === '10.0.0.9' && /^[a-z0-9_-]+$/.test(h.id)), JSON.stringify(r5.body.value).slice(0, 120))
}


// ================= T19 建连失败快返回（回归"一直测试中"） =================
async function t19() {
  console.log('== T19 建连失败快返回 ==')
  const H19 = { id: 'h19', host: '9.9.9.9', user: 'root', port: 22, identityFile: '', auth: 'password', connectTimeoutSec: 2, controlPersistSec: 600 }
  const log = []
  const t0 = Date.now()
  const c = new ConnectionManager(connOpts(log, {
    spawnFn: (cmd, args, o) => {
      const child = fakeChild(8800 + log.length)
      log.push({ cmd, args, opts: o, child })
      if (args.includes('check')) setTimeout(() => child.emitClose(255), 5)
      else if (args.includes('-N')) setTimeout(() => { child.writeErr('Permission denied (publickey,password).'); child.emitExit(255); child.emitClose(255) }, 20) // 真实子进程 exit+close 都会发
      else setTimeout(() => child.emitClose(0), 5)
      return child
    },
  }))
  const r = await c.ensureMaster(H19)
  const elapsed = Date.now() - t0
  check('T19.1 master 退出即失败返回（不等满 deadline，此前要干等约 32s）', r.ok === false && elapsed < 3000, 'elapsed=' + elapsed + 'ms')
  check('T19.2 错误透出 ssh 原文', /Permission denied/.test(String(r.error)), String(r.error))
  check('T19.3 状态 down 且 lastError 有记录', c.stat(H19.id).master === 'down' && /Permission denied/.test(String(c.stat(H19.id).lastError)), JSON.stringify(c.stat(H19.id)))

  // 空 stderr 时不能只报"master 进程已退出"（用户实测遇到，信息不足无从定位）
  const log2 = []
  const c2 = new ConnectionManager(connOpts(log2, {
    spawnFn: (cmd, args, o) => {
      const child = fakeChild(8900 + log2.length)
      log2.push({ cmd, args, opts: o, child })
      if (args.includes('check')) setTimeout(() => child.emitClose(255), 5)
      else if (args.includes('-N')) setTimeout(() => { child.emitExit(255); child.emitClose(255) }, 20) // 无 stderr
      else setTimeout(() => child.emitClose(0), 5)
      return child
    },
  }))
  const r2 = await c2.ensureMaster(H19)
  check('T19.4 空 stderr 时给出退出码而非含糊文案', r2.ok === false && /exit 255/.test(String(r2.error)), String(r2.error))

  // ControlPersist 语义：master daemon 化后前台进程以 0 退出 —— 这是成功不是失败
  const log3 = []
  let checks = 0
  const c3 = new ConnectionManager(connOpts(log3, {
    spawnFn: (cmd, args, o) => {
      const child = fakeChild(9000 + log3.length)
      log3.push({ cmd, args, opts: o, child })
      if (args.includes('check')) setTimeout(() => child.emitClose(checks++ === 0 ? 255 : 0), 5)
      else if (args.includes('-N')) setTimeout(() => { child.emitExit(0); child.emitClose(0) }, 10) // daemon 化
      else setTimeout(() => child.emitClose(0), 5)
      return child
    },
  }))
  const r3 = await c3.ensureMaster(H19)
  check('T19.5 master exit 0（daemon 化）不得判失败', r3.ok === true, JSON.stringify(r3))
}

const keepAlive = setInterval(() => {}, 1000)
async function main() {
  await t2()
  await t3()
  await t4()
  await t5()
  await t6()
  await t7()
  await t8()
  await t9()
  await t10()
  await t11()
  await t12()
  await t13()
  await t14()
  await t15()
  await t16()
  await t17()
  await t18()
  await t19()
  clearInterval(keepAlive)
  summary()
  // fs.watch（HostRegistry.startWatch）会吊住事件循环，主动收尾退出
  process.exit(failed > 0 ? 1 : 0)
}
main().catch(err => { console.error(err); process.exit(1) })
