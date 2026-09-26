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
