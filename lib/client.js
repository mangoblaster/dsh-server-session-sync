/**
 * dsh-server-session-sync — browser half.
 *
 * Seats one first-level settings section (设置 → 会话同步) that owns the whole
 * feature: the remote target form, a connectivity probe, and the two transfer
 * buttons. Everything talks to this plugin's own host routes.
 *
 * The section is a real slot registration (`settings.section`), so the shell
 * renders it inside the settings panel and owns its lifecycle — the plugin
 * draws no page-level DOM and cannot disturb the shell's reconciliation.
 *
 * @module dsh-server-session-sync/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-server-session-sync',
  factory: (require) => {
    const exports = {}
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    /** Settings-section order: after the plugin-family sections. */
    const SECTION_ORDER = 156

    /** Host route root, document-relative because the GUI is served with `<base href="./">`. */
    const API = 'api/dsh-server-session-sync/'

    /** Field definitions, in display order: key, label, hint, placeholder. */
    const FIELDS = [
      { key: 'host', label: '服务器地址', hint: '远端 DSH 所在主机的 IP 或域名', wide: true },
      { key: 'port', label: 'SSH 端口', hint: '通常 22' },
      { key: 'user', label: 'SSH 用户名', hint: '例如 root' },
      { key: 'keyPath', label: '私钥路径', hint: '免密登录用的私钥，例如 ~/.ssh/id_ed25519', wide: true },
      { key: 'remoteCwd', label: '远端工作区目录', hint: '会话在远端归属的目录，必须已存在', wide: true },
      { key: 'remoteHome', label: '远端 DSH 目录', hint: '远端的 DSH_HOME' },
      { key: 'remoteService', label: '远端服务名', hint: 'systemd 单元名' },
      { key: 'localCwd', label: '拉取到的工作区', hint: '留空则使用最近使用的工作区', wide: true },
    ]

    /** Shared text styles. */
    const T = {
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      hint: { fontSize: 12, opacity: 0.6, lineHeight: 1.5, margin: '2px 0 0' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      label: { fontSize: 12, opacity: 0.75, marginBottom: 4, display: 'block' },
    }

    /** One JSON call against this plugin's host routes. */
    async function call(path, init) {
      const response = await fetch(API + path, {
        ...init,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...init?.headers },
        body: init?.method === 'POST' ? init.body ?? '{}' : undefined,
        signal: AbortSignal.timeout(20 * 60 * 1000),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { ok: response.ok, status: response.status, body }
    }

    /** A bordered block used by every card in the section. */
    function Card(props) {
      return h(
        'div',
        {
          style: {
            border: '1px solid rgba(127,127,127,0.22)',
            borderRadius: 10,
            padding: '14px 16px',
            background: 'rgba(127,127,127,0.05)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            ...props.style,
          },
        },
        props.children,
      )
    }

    /** A labelled text input bound to the form state. */
    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gridColumn: props.wide ? '1 / -1' : 'auto' } },
        h('span', { style: T.label }, props.label),
        h('input', {
          type: 'text',
          value: props.value ?? '',
          placeholder: props.hint,
          spellCheck: false,
          disabled: props.disabled,
          onChange: (event) => props.onChange(event.currentTarget.value),
          style: {
            padding: '7px 10px',
            borderRadius: 8,
            border: '1px solid rgba(127,127,127,0.3)',
            background: 'rgba(127,127,127,0.06)',
            color: 'inherit',
            fontSize: 13,
            fontFamily: 'inherit',
            width: '100%',
            boxSizing: 'border-box',
          },
        }),
      )
    }

    /** A button with the shared compact look. */
    function Button(props) {
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          disabled,
          title: props.title,
          onClick: props.onClick,
          style: {
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid rgba(127,127,127,0.3)',
            background: props.primary ? 'rgba(59,130,246,0.14)' : 'rgba(127,127,127,0.1)',
            color: 'inherit',
            fontSize: 13,
            fontWeight: props.primary ? 500 : 400,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            whiteSpace: 'nowrap',
            flex: props.grow ? '1 1 0' : 'auto',
            minWidth: 0,
          },
        },
        props.label,
      )
    }

    /** One-line result strip (colour-coded by `state`). */
    function Note(props) {
      const color =
        props.state === 'ok' ? 'rgba(34,197,94,0.9)' : props.state === 'error' ? 'rgba(239,68,68,0.9)' : 'inherit'
      return h(
        'div',
        { style: { color, fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
        props.children,
      )
    }

    /**
     * The section body.
     * @param props - slot props (`close` is supplied by the shell).
     */
    function SessionSyncSection() {
      const [config, setConfig] = useState(null)
      const [configPath, setConfigPath] = useState('')
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saveNote, setSaveNote] = useState(null)
      const [testing, setTesting] = useState(false)
      const [probe, setProbe] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [messageState, setMessageState] = useState(null)
      const [status, setStatus] = useState(null)
      const [previewPlan, setPreviewPlan] = useState(null)
      const [backups, setBackups] = useState([])
      const [backup, setBackup] = useState('')

      // Load the effective config (file over profile patch) plus the last result.
      useEffect(() => {
        let alive = true
        call('config').then((res) => {
          if (!alive || !res.ok || !res.body) return
          setConfig(res.body.config ?? {})
          setConfigPath(res.body.configPath ?? '')
        }, () => {})
        call('status').then((res) => {
          if (!alive || !res.ok || !res.body) return
          setStatus(res.body)
          const last = res.body.last
          if (last && typeof last.message === 'string' && last.message !== '尚未同步') {
            setMessage(last.message)
            setMessageState(last.ok ? 'ok' : 'error')
          }
        }, () => {})
        const polling = setInterval(() => {
          call('status').then(res => { if (alive && res.ok) setStatus(res.body) }, () => {})
        }, 2000)
        return () => {
          alive = false
          clearInterval(polling)
        }
      }, [])

      /** Update one field in local state. */
      const edit = (key) => (value) => {
        setConfig((prev) => ({ ...(prev ?? {}), [key]: value }))
        setDirty(true)
        setSaveNote(null)
        setPreviewPlan(null)
      }

      /** Persist the whole form to the host's config file. */
      const save = async () => {
        if (config === null) return
        setSaving(true)
        setSaveNote(null)
        try {
          const res = await call('config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
          })
          if (res.ok && res.body && res.body.ok) {
            setConfig(res.body.config ?? config)
            setDirty(false)
            setSaveNote({ state: 'ok', text: `配置已保存到 ${res.body.configPath ?? ''}` })
          } else {
            setSaveNote({ state: 'error', text: '保存失败：' + String((res.body && res.body.error) || res.status) })
          }
        } catch (error) {
          setSaveNote({ state: 'error', text: '保存失败：' + String(error && error.message ? error.message : error) })
        } finally {
          setSaving(false)
        }
      }

      /** Probe the remote with the current (saved) settings. */
      const test = async () => {
        setTesting(true)
        setProbe(null)
        try {
          const res = await call('test', { method: 'POST' })
          if (!res.body?.report) throw new Error(res.body?.error || '测试连接没有返回检查结果')
          setProbe(res.body ?? { ok: false, report: { ssh: false, error: '无响应' } })
        } catch (error) {
          setProbe({ ok: false, report: { ssh: false, error: String(error && error.message ? error.message : error) } })
        } finally {
          setTesting(false)
        }
      }

      /** Run one transfer direction. */
      const run = async (direction, planId) => {
        if (busy) return
        setBusy(true)
        setMessageState(null)
        setMessage(direction === 'push' ? '正在上传到服务器…' : direction === 'restore' ? '正在恢复远端备份…' : '正在从服务器拉取…')
        try {
          const res = await call(direction, { method: 'POST', body: JSON.stringify({ planId }) })
          const body = res.body ?? {}
          setMessageState(body.ok ? 'ok' : 'error')
          setMessage(String(body.message || body.error || '结果未知（HTTP ' + res.status + '）'))
        } catch (error) {
          setMessageState('error')
          setMessage('失败：' + String(error && error.message ? error.message : error))
        } finally {
          setBusy(false)
          setPreviewPlan(null)
        }
      }

      const preview = async (direction) => {
        setBusy(true)
        setPreviewPlan(null)
        setMessageState(null)
        setMessage('正在读取两端快照并生成预览…')
        try {
          const res = await call('preview', { method: 'POST', body: JSON.stringify({ direction, backup }) })
          if (!res.ok || !res.body?.ok) throw new Error(res.body?.error || '预览失败')
          setPreviewPlan(res.body.plan)
          setMessage('预览已生成，确认范围后执行；10 分钟后过期。')
        } catch (error) { setMessageState('error'); setMessage(error.message) }
        finally { setBusy(false) }
      }
      const loadBackups = async () => {
        setBusy(true)
        try {
          const res = await call('backups')
          if (!res.ok || !res.body?.ok) throw new Error(res.body?.error || '读取备份失败')
          setBackups(res.body.backups ?? [])
          setBackup(res.body.backups?.[0] ?? '')
          setMessage(res.body.backups?.length ? '已读取远端备份' : '远端暂无备份')
        } catch (error) { setMessageState('error'); setMessage(error.message) }
        finally { setBusy(false) }
      }

      const configured = config !== null && typeof config.host === 'string' && config.host.trim() !== ''
      const locked = busy || saving || testing || status?.busy === true

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', fontSize: 13 } },

        h(
          'div',
          null,
          h('div', { style: T.title }, '会话同步'),
          h(
            'p',
            { style: T.hint },
            '把本机的 DSH 会话库推送到服务器，或从服务器拉取到本机。',
          ),
        ),

        // ---- remote target form -------------------------------------------------
        h(
          Card,
          null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, '远端目标'),
            configPath !== ''
              ? h('span', { style: { ...T.hint, fontFamily: T.mono.fontFamily } }, configPath)
              : null,
          ),
          config === null
            ? h(Note, null, '读取配置中…')
            : h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
                FIELDS.map((field) =>
                  h(Field, {
                    key: field.key,
                    label: field.label,
                    hint: field.hint,
                    wide: field.wide === true,
                    value: config[field.key] ?? '',
                    disabled: locked,
                    onChange: edit(field.key),
                  }),
                ),
              ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(Button, { label: saving ? '保存中…' : dirty ? '保存配置 *' : '保存配置', primary: true, disabled: locked || config === null, onClick: save }),
            h(Button, { label: testing ? '测试中…' : '测试连接', disabled: locked || dirty || !configured, onClick: test }),
            saveNote !== null ? h(Note, { state: saveNote.state }, saveNote.text) : null,
          ),
          probe !== null
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 2 } },
                h(Note, { state: probe.ok ? 'ok' : 'error' }, probe.ok ? '连接正常，可以开始同步' : '连接不可用'),
                probe.report && probe.report.ssh === true
                  ? h(Note, null, `SSH 可达 · Python ${probe.report.python ?? '未知'} · 工作区目录 ${probe.report.workspace ? '存在' : '不存在'} · 服务 ${probe.report.service ?? '未知'} · 会话库 ${probe.report.sessions ? '已存在' : '尚未创建'}`)
                  : h(Note, { state: 'error' }, String((probe.report && probe.report.error) || 'ssh 无法连接，检查地址、端口和私钥')),
              )
            : null,
        ),

        // ---- transfers ----------------------------------------------------------
        h(
          Card,
          null,
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, '同步操作'),
          h(
            'div',
            { style: { display: 'flex', gap: 10 } },
            h(Button, {
              label: '↑ 预览上传',
              title: '把本机会话库覆盖到服务器，并重启服务器上的 DSH',
              primary: true,
              grow: true,
              disabled: locked || dirty || !configured,
              onClick: () => preview('push'),
            }),
            h(Button, {
              label: '↓ 预览拉取',
              title: '导入新会话，将已有会话的远端更新暂存供离线恢复',
              grow: true,
              disabled: locked || dirty || !configured,
              onClick: () => preview('pull'),
            }),
          ),
          h(
            'div',
            { style: { minHeight: 20, display: 'flex', alignItems: 'center' } },
            h(Note, { state: messageState }, busy ? status?.busy ? status.progress : message : message || '尚未同步'),
          ),
          configured ? null : h(Note, { state: 'error' }, '先填写并保存「服务器地址」，两个按钮才会启用。'),
          dirty ? h(Note, { state: 'error' }, '配置有修改，请先保存，再测试或同步。') : null,
          previewPlan ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(Note, null, `跳过旧格式或无 v4 日志目录：本地 ${previewPlan.skipped?.local?.length ?? 0}，远端 ${previewPlan.skipped?.remote?.length ?? 0}。旧文件保留，不自动迁移。`),
            h('details', null, h('summary', null, '查看跳过目录和旧版本残留'),
              h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 12 } },
                JSON.stringify({ skipped: previewPlan.skipped, legacyResidues: previewPlan.legacyResidues }, null, 2))),
            h(Note, null, previewPlan.direction === 'restore'
              ? `将恢复备份 ${previewPlan.backup} 中的 ${previewPlan.backupCount} 个会话，替换当前远端 ${previewPlan.remoteCount} 个会话。替换前会另存一份备份。`
              : `新增 ${previewPlan.summary.added.length} · ${previewPlan.direction === 'pull' ? '更新暂存' : '覆盖'} ${previewPlan.summary.changed.length} · 未变化 ${previewPlan.summary.unchanged.length} · ${previewPlan.direction === 'pull' ? '本地保留' : '远端移除'} ${previewPlan.summary.removed.length}`),
            previewPlan.direction !== 'restore' ? h('details', null, h('summary', null, '查看会话明细'),
              h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 12 } }, JSON.stringify(previewPlan.summary, null, 2))) : null,
            h(Note, { state: 'error' }, previewPlan.direction === 'pull'
              ? '已有会话不会直接覆盖。更新将放到恢复目录，请退出 DSH 后运行恢复命令。'
              : '将替换远端会话库并重启服务。请先暂停两端对话；远端独有会话会从当前库移到备份。'),
            h(Button, { label: previewPlan.direction === 'pull' ? '确认导入并暂存更新' : previewPlan.direction === 'restore' ? '确认恢复备份' : '确认替换远端会话库',
              primary: true, disabled: locked || dirty || Date.now() > previewPlan.expires,
              onClick: () => run(previewPlan.direction, previewPlan.id) }),
            h(Button, { label: '取消', disabled: locked, onClick: () => setPreviewPlan(null) }),
          ) : null,
        ),

        h(Card, null,
          h('span', { style: { fontWeight: 600 } }, '远端备份恢复'),
          h(Button, { label: '读取备份列表', disabled: locked || dirty || !configured, onClick: loadBackups }),
          backups.length ? h('select', { value: backup, disabled: locked,
            onChange: e => { setBackup(e.target.value); setPreviewPlan(null) } },
            backups.map(name => h('option', { key: name, value: name }, name))) : null,
          backups.length ? h(Button, { label: '预览恢复', disabled: locked || dirty || !backup, onClick: () => preview('restore') }) : null,
        ),

        // ---- caveats ------------------------------------------------------------
        h('p', { style: T.hint }, '↑ 推送会先备份，再替换服务器上的会话库，并重启远端 DSH。'),
        h('p', { style: T.hint }, '↓ 拉取会导入新会话；已有会话的更新会暂存，退出 DSH 后再应用。'),
        h('p', { style: T.hint }, '请勿在两端同时编辑同一会话，以免产生冲突。'),
      )
    }

    /**
     * Client body: register the settings section.
     * @param ctx - client context (slots registry).
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-server-session-sync',
              order: SECTION_ORDER,
              label: () => '会话同步',
            },
            SessionSyncSection,
          )
          return () => {
            unregister()
          }
        } catch {
          return () => {}
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})
