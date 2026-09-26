// dsh-ssh-remote — 宿主端入口：Config、装配、生命周期、系统提示、10 个 Agent 工具、回环 HTTP API。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { harnessHome } from './home.js'
import { HostRegistry, normalizeHost } from './hosts.js'
import { ConnectionManager } from './connection.js'
import { Runner } from './exec.js'
import { FsOps } from './fsops.js'
import { Transfer } from './transfer.js'
import { atomicWriteJson, readHostsFile, parseImport } from './settings-store.js'

export const name = 'ssh-remote'
// inject 声明的服务须全部可用插件才加载（cordis 语义）；webServer 由下方 HTTP API 段使用，目标宿主为 web profile。
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
  hostsFile: z.string().default(path.join(harnessHome(), 'ssh-remote', 'hosts.json')),
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
    if (!ready.ok && !ready.degraded) {
      const err = new Error(ready.error || '连接失败')
      err.kind = 'unreachable'
      return fmtErr(err)
    }
    try {
      return await fn(h)
    } catch (err) {
      return fmtErr(err)
    }
  }

  ctx.effect(() => {
    registry.startWatch()
    return () => { registry.stopWatch() }
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
      description: '远程内容搜索（POSIX ERE 正则；grep -rnE）：返回 file:line:text 行数组（跳过二进制文件）（上限 250，超出标 truncated）。默认排除 .git。',
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

  // ---- 回环 HTTP API ----

  /** 新增单台动态主机（id 与静态/已有冲突则 409）。 */
  function addDynamicHost(body) {
    const n = body && typeof body === 'object' ? normalizeHost({ ...body, source: 'dynamic' }) : null
    if (!n) return { status: 400, payload: { ok: false, error: { code: 'bad-host', message: '主机字段非法（id [a-z0-9_-] / host / identityFile 必填）' } } }
    if (registry.list().some(h => h.id === n.id)) return { status: 409, payload: { ok: false, error: { code: 'conflict', message: 'id 已存在: ' + n.id } } }
    atomicWriteJson(registry.hostsFile, [...readHostsFile(registry.hostsFile), n])
    registry.reload()
    return { status: 200, payload: { ok: true, value: registry.list() } }
  }

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
              respond(res, 200, { ok: true, value: registry.list(), warnings: errs })
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
                const msg = String((err && err.message) || err)
                const notFound = msg.includes('不存在') || msg.includes('未配置')
                respond(res, notFound ? 404 : 409, { ok: false, error: { code: notFound ? 'not-found' : 'conflict', message: msg } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
        },
      }), 'ssh-remote: http api')
    })
  } catch (err) { ctx.logger?.warn?.('[ssh-remote] HTTP API 注册失败: ' + (err && err.message)) }

  // cordis 4.0.x：apply 只能返回函数（收为插件 disposer）或 undefined；
  // 返回普通对象会 TypeError('Invalid effect') 使 fiber 直接 FAILED，
  // 运行时启停/卸载（HMR）的状态机随之异常。disposer 语义：
  // 1) conn.dispose 置 disposed——在途/后续操作不再重建 master；
  // 2) 返回 teardownAll 的 promise——unload 会 await 它，全部
  //    `ssh -O exit`（每主机上限约 10s）完成后管理器才继续 pnpm remove。
  // 内件（conn/fsops 等）作为属性挂在 disposer 上：cordis 只调用函数本身，
  // 属性不影响生命周期，同时保留既有测试/调试面（inst.conn 桩替换）。
  const dispose = () => {
    conn.dispose(registry.list())
    return conn.teardownAll(registry.list())
  }
  return Object.assign(dispose, { registry, conn, runner, fsops, transfer })
}

function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJson(req, bodyOverride) {
  if (bodyOverride !== undefined) {
    // 解析失败转 rejected promise（与流式路径一致，路由 .catch → 400）
    if (typeof bodyOverride !== 'string') return Promise.resolve(bodyOverride || {})
    return new Promise((resolve, reject) => {
      try { resolve(JSON.parse(bodyOverride)) } catch (e) { reject(e) }
    })
  }
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
