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

      // 兜底：open 且无 pos 时补测一次并触发渲染（toggle 已同步测量，此 effect 只兜异常路径）
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
        // 打开前同步测量位置（修复：effect 写 pos 无重渲染导致面板永不出现）
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
          fetch('/ssh-remote/api/hosts/' + encodeURIComponent(row.id), { method: 'DELETE' }).then(function (r) { return r.json() }).then(function (res) {
            if (res && res.ok) load()
            else { st.err = (res && res.error && res.error.message) || '删除失败'; render(function (n) { return n + 1 }) }
          }).catch(function () {
            st.err = '删除请求失败（host api unavailable）'
            render(function (n) { return n + 1 })
          })
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
          if (res && res.ok) { st.msg = '已保存（' + st.hosts.filter(function (x) { return x.source !== 'static' }).length + ' 台动态主机）'; load() }
          else st.err = (res && res.error && res.error.message) || '保存失败'
          render(function (n) { return n + 1 })
        }).catch(function () { st.saving = false; st.err = '保存请求失败（host api unavailable）'; render(function (n) { return n + 1 }) })
      }
      function doImport(preview) {
        var st = stateRef.current
        postJson('/ssh-remote/api/hosts/import', { format: st.importFormat, text: st.importText, commit: !preview }).then(function (res) {
          if (res && res.ok) {
            if (preview) st.importPreview = res.value.preview
            else { st.importPreview = null; st.importOpen = false; st.importText = ''; st.msg = '导入完成'; load() }
          } else st.err = (res && res.error && res.error.message) || '导入失败'
          render(function (n) { return n + 1 })
        }).catch(function () { st.err = '导入请求失败（host api unavailable）'; render(function (n) { return n + 1 }) })
      }
      function exportJson() {
        var blob = new Blob([JSON.stringify(stateRef.current.hosts, null, 2)], { type: 'application/json' })
        var a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'ssh-remote-hosts.json'
        a.click()
        setTimeout(function () { URL.revokeObjectURL(a.href) }, 0)
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
        h('div', { style: { overflowX: 'auto', maxWidth: '100%' } },
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
          )
        ),
        h('div', { style: Object.assign({}, S.sub, { marginTop: 8 }) }, '说明：动态主机保存后立即生效（无需重启）；静态主机来自 profile cordis.patch.yml，仅展示。')
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
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'ssh-remote', order: 116, label: 'SSH 远程主机' },
            SshRemoteSettings
          )
        })
      },
    }
  },
})
