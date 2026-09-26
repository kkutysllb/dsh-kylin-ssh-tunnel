// dsh-ssh-remote — 主机注册表：静态（cordis.patch.yml）+ 动态（hostsFile）两路合并。
// 静态优先：设置页不可覆盖静态主机。hostsFile 变更热重载。
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { harnessHome } from './home.js'

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
  if (typeof raw.host !== 'string' || !raw.host.trim()) return null
  if (typeof raw.identityFile !== 'string' || !raw.identityFile.trim()) return null
  const portIn = raw.port
  let port = DEFAULTS.port
  if (portIn !== undefined && portIn !== null && portIn !== '') {
    const n = Number(portIn)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null
    port = n
  }
  const out = {
    id,
    name: String(raw.name || id),
    host: String(raw.host),
    user: String(raw.user || DEFAULTS.user),
    port,
    identityFile: expandTilde(String(raw.identityFile || '')),
    jump: raw.jump ? String(raw.jump) : '',
    defaultCwd: raw.defaultCwd ? String(raw.defaultCwd) : '',
    connectTimeoutSec: Number(raw.connectTimeoutSec) || DEFAULTS.connectTimeoutSec,
    controlPersistSec: Number(raw.controlPersistSec) || DEFAULTS.controlPersistSec,
    source: raw.source || 'static',
  }
  return out
}

/** 批量校验：id 重复、jump 引用存在、jump 成环。返回错误字符串数组。 */
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
  return [...new Set(errors)]
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
    this.hostsFile = hostsFile || path.join(harnessHome(), 'ssh-remote', 'hosts.json')
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
    } catch { this.dynamicHosts = [] /* 文件不存在或损坏 → 空动态表（不保留僵尸） */ }
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
    this._onChange = onChange
    this.watcher = fs.watch(dir, (event, filename) => {
      if (filename && !String(filename).startsWith(path.basename(this.hostsFile))) return
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null
        this.reload()
        if (onChange) onChange()
      }, 200)
    })
    this.watcher.on('error', (err) => {
      if (this.logger?.warn) this.logger.warn('[ssh-remote] hostsFile 目录监听异常: ' + (err && err.message))
      this.stopWatch()
      try { this.startWatch(this._onChange) } catch { /* 目录可能已不存在，放弃重挂 */ }
    })
  }

  stopWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null }
  }
}
