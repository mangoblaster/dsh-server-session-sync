import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isIP } from 'node:net'
import { isAbsolute, join, resolve, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { run } from './process.js'
import { atomicJson, changes, directory, importPull, jsonFile, preparePayload, scanStore, sha, storeSignature, targetIdentity } from './store.js'
import { createPayload, extractSnapshot, MAX_ARCHIVE } from './archive.js'

export { encodeWorkspaceName } from './store.js'
export const name = 'dsh-server-session-sync'
export const inject = ['webServer', 'connection']
export const EDITABLE_FIELDS = ['host', 'port', 'user', 'keyPath', 'remoteHome', 'remoteService', 'remoteCwd', 'localCwd']
const DEFAULTS = {
  host: '', port: 22, user: 'root', keyPath: join(homedir(), '.ssh', 'id_ed25519'),
  remoteHome: '/root/.dsh', remoteService: 'dsh-web', remoteCwd: '/srv/dsh/work', localCwd: '',
}
const PLAN_TTL = 10 * 60_000
const helper = readFile(new URL('./remote.py', import.meta.url), 'utf8')
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
export function remoteCommand(script, config) {
  return "command -v python3 >/dev/null 2>&1 || { printf '%s\\n' DSH_SYNC_MISSING_PYTHON3 >&2; exit 127; }; exec python3 -c " + shellQuote(script) + ' ' + shellQuote(config)
}
export function connectionDiagnostic(error) {
  if (error.message.includes('DSH_SYNC_MISSING_PYTHON3')) return new Error('远端缺少 python3：请安装 Python 3.8+ 后重试')
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(error.message)) return new Error('SSH 主机指纹验证失败：请先在终端手动 SSH，核对指纹和 known_hosts；不要跳过指纹校验')
  return error
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象')
  const config = { ...DEFAULTS }
  for (const field of EDITABLE_FIELDS) {
    if (input[field] === undefined) continue
    if (field === 'port') {
      const port = Number(input.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数')
      config.port = port
    } else {
      if (typeof input[field] !== 'string' || input[field].length > 4096 || /[\x00-\x1f\x7f]/.test(input[field])) throw new Error(`无效字段：${field}`)
      config[field] = input[field].trim()
    }
  }
  if (config.host && !isIP(config.host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(config.host)) throw new Error('服务器地址格式无效')
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(config.user)) throw new Error('SSH 用户名格式无效')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(config.remoteService)) throw new Error('systemd 服务名格式无效')
  for (const field of ['remoteHome', 'remoteCwd']) {
    if (!posix.isAbsolute(config[field]) || posix.normalize(config[field]) !== config[field] || config[field].includes('\\')) throw new Error(`${field} 必须是规范的 Linux 绝对路径`)
  }
  if (['/', '/root', '/home', '/tmp', '/srv', '/var', '/etc', '/usr'].includes(config.remoteHome)) throw new Error('远端 DSH 目录过于宽泛')
  if (config.keyPath.startsWith('~/') || config.keyPath.startsWith('~\\')) config.keyPath = join(homedir(), config.keyPath.slice(2))
  if (!isAbsolute(config.keyPath)) throw new Error('私钥必须使用绝对路径或 ~/ 路径')
  if (config.localCwd && !isAbsolute(config.localCwd)) throw new Error('本地工作区必须是绝对路径')
  return config
}

export function sshArgs(opts, command) {
  const host = isIP(opts.host) === 6 ? `[${opts.host}]` : opts.host
  return ['-i', opts.keyPath, '-p', String(opts.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15', '--', `${opts.user}@${host}`, command]
}

async function remote(opts, action, { input, output, expected, backup, backupTree } = {}) {
  if (!opts.host) throw new Error('先填写并保存服务器地址')
  const config = Buffer.from(JSON.stringify({ action, remoteHome: opts.remoteHome, remoteCwd: opts.remoteCwd,
    remoteService: opts.remoteService, expected, backup, backupTree })).toString('base64')
  const command = remoteCommand(await helper, config)
  let result
  try { result = await run('ssh', sshArgs(opts, command), { input, output, timeoutMs: action === 'probe' ? 20_000 : undefined }) }
  catch (error) { throw connectionDiagnostic(error) }
  return output ? null : JSON.parse(result.stdout)
}

async function snapshot(opts, staging, onProgress = () => {}) {
  const archive = join(staging, 'remote.tgz')
  let received = 0
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length
    onProgress(`下载远端快照：已接收 ${(received / 1024 ** 2).toFixed(1)} MiB`)
    callback(received > MAX_ARCHIVE ? new Error('下载超过 2 GiB 限制') : null, chunk)
  } })
  const destination = createWriteStream(archive, { flags: 'wx', mode: 0o600 })
  // pipeline errors must reach the child runner and terminate SSH too.
  const { pipeline } = await import('node:stream/promises')
  const saving = pipeline(limit, destination)
  try { await Promise.all([saving, remote(opts, 'snapshot', { output: limit })]) }
  catch (e) { limit.destroy(e); await saving.catch(() => {}); throw e }
  const unpacked = join(staging, 'remote')
  await mkdir(unpacked, { mode: 0o700 })
  return extractSnapshot(archive, unpacked)
}

async function localWorkspace(opts) {
  if (opts.localCwd) return directory(opts.localCwd)
  const registry = await jsonFile(join(opts.localHome, 'storages', 'workspace.json'))
  for (const id of registry?.global?.workspaceIds ?? []) {
    const path = registry?.tables?.workspaces?.[id]?.path
    if (typeof path === 'string') { try { return await directory(path) } catch {} }
  }
  throw new Error('找不到有效的最近工作区，请填写「拉取到的工作区」')
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('请求必须使用 application/json')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体超过 64 KiB')
    chunks.push(Buffer.from(chunk))
  }
  const result = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('请求必须是 JSON 对象')
  return result
}

export function apply(ctx, config = {}) {
  if (typeof ctx.connection?.requestRejection !== 'function') throw new Error('当前 DSH 缺少 Connection.requestRejection；请升级 DSH 后使用此修订版')
  const home = resolve(config.localHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const configPath = join(home, 'session-sync.json')
  const baselinePath = join(home, 'session-sync-state.json')
  let busy = false, progress = '空闲', plan = null
  let last = { ok: null, message: '尚未同步', at: null }
  const effective = async () => ({ ...validateConfig({ ...DEFAULTS, ...config, ...await jsonFile(configPath) }), localHome: home })
  const setProgress = message => { progress = message }
  async function clearPlan() {
    const old = plan
    plan = null
    if (old) await rm(old.staging, { recursive: true, force: true })
  }
  const cleanup = setInterval(() => { if (!busy && plan && Date.now() > plan.expires) clearPlan().catch(() => {}) }, 60_000)
  cleanup.unref()
  const routes = []
  function route(path, method, action, exclusive = false) {
    routes.push({ kind: 'exact', path: '/api/dsh-server-session-sync/' + path, handler: async (req, res) => {
      try {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) { send(res, rejection, { ok: false, error: '请在 DSH 中登录后操作，且请求必须来自受信任来源' }); return }
        if (req.method !== method) { send(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (exclusive && busy) { send(res, 409, { ok: false, error: '已有操作正在进行' }); return }
        if (exclusive) busy = true
        try {
          const body = method === 'POST' ? await readJson(req) : {}
          const result = await action(body)
          send(res, 200, { ok: true, ...result })
        } finally { if (exclusive) { busy = false; progress = '空闲' } }
      } catch (error) {
        last = { ok: false, message: error.message, at: new Date().toISOString() }
        send(res, 400, { ok: false, error: error.message, message: error.message })
      }
    } })
  }
  route('config', 'GET', async () => ({ config: await effective(), configPath }))
  // Same pathname can only be registered once in WebServer.
  const getConfig = routes.pop()
  route('config', 'POST', async body => {
    const next = validateConfig(body)
    await mkdir(home, { recursive: true, mode: 0o700 })
    await clearPlan()
    await atomicJson(configPath, next)
    return { config: await effective(), configPath }
  }, true)
  const postConfig = routes.pop()
  routes.push({ ...getConfig, handler: (req, res) => req.method === 'GET' ? getConfig.handler(req, res) : postConfig.handler(req, res) })
  route('status', 'GET', async () => ({ busy, progress, last, configPath }))
  route('test', 'POST', async () => {
    setProgress('检查远端环境')
    const report = await remote(await effective(), 'probe')
    return { ok: report.ssh && report.workspace && report.service === 'active', report }
  }, true)
  route('preview', 'POST', async body => {
    if (!['push', 'pull', 'restore'].includes(body.direction)) throw new Error('无效同步方向')
    await clearPlan()
    const opts = await effective()
    if (!opts.host) throw new Error('先填写并保存服务器地址')
    if (body.direction === 'pull') opts.localCwd = await localWorkspace(opts)
    if (body.direction === 'restore' && !/^\d{13}-[a-f0-9]{8}$/.test(body.backup ?? '')) throw new Error('备份编号无效')
    const staging = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
    try {
      setProgress('读取并校验本机会话')
      const local = body.direction === 'restore' ? Object.assign(new Map(), { skipped: [], legacyResidues: [] })
        : await scanStore(join(home, 'sessions'), { allowIdenticalDuplicates: false })
      setProgress('下载远端快照并校验')
      let snapshotResult
      if (body.direction === 'restore') {
        const info = await remote(opts, 'inspect')
        snapshotResult = { ...info, records: Object.assign(new Map(), { skipped: info.skipped, legacyResidues: info.legacyResidues }) }
      } else snapshotResult = await snapshot(opts, staging, setProgress)
      const remoteRecords = snapshotResult.records
      const backupInfo = body.direction === 'restore' ? await remote(opts, 'backup-info', { backup: body.backup }) : null
      const summary = body.direction === 'pull' ? changes(remoteRecords, local) : changes(local, remoteRecords)
      if (body.direction === 'push' && !local.size) throw new Error('本地没有会话，拒绝用空库覆盖远端')
      if (body.direction === 'push') {
        setProgress('重写并打包上传内容')
        const payload = join(staging, 'payload')
        await mkdir(payload, { mode: 0o700 })
        await preparePayload(local, payload, opts.remoteCwd)
        await createPayload(join(staging, 'payload.tgz'), payload)
      }
      plan = { id: randomUUID(), direction: body.direction, backup: body.backup, staging, opts,
        backupTree: backupInfo?.tree,
        configHash: sha(JSON.stringify(await effective())), localSignature: storeSignature(local),
        remote: remoteRecords, tree: snapshotResult.tree, summary, expires: Date.now() + PLAN_TTL }
      return { plan: { id: plan.id, direction: plan.direction, backup: plan.backup, summary,
        skipped: { local: local.skipped, remote: remoteRecords.skipped },
        legacyResidues: { local: local.legacyResidues, remote: remoteRecords.legacyResidues },
        expires: plan.expires, remoteCount: snapshotResult.count ?? remoteRecords.size, localCount: local.size, backupCount: backupInfo?.count } }
    } catch (e) { await rm(staging, { recursive: true, force: true }); throw e }
  }, true)
  for (const direction of ['push', 'pull', 'restore']) route(direction, 'POST', async body => {
    const current = plan
    if (!current || body.planId !== current.id || current.direction !== direction || Date.now() > current.expires) throw new Error('预览已过期或不匹配，请重新预览')
    try {
      if (sha(JSON.stringify(await effective())) !== current.configHash) throw new Error('配置已改变，请重新预览')
      const local = direction === 'restore' ? new Map() : await scanStore(join(home, 'sessions'), { allowIdenticalDuplicates: false })
      if (direction !== 'restore' && storeSignature(local) !== current.localSignature) throw new Error('本地会话在预览后发生变化，请暂停对话并重新预览')
      let result
      if (direction === 'pull') {
        setProgress('导入新会话并暂存更新')
        const state = await jsonFile(baselinePath, { targets: {} })
        const target = targetIdentity(current.opts)
        const baseline = state.targets?.[target] ?? {}
        result = await importPull(current.opts, current.remote, local, baseline)
        state.targets ??= {}
        state.targets[target] = { ...baseline }
        for (const [id, r] of current.remote) if (!local.has(id) || local.get(id).fingerprint === r.fingerprint) state.targets[target][id] = r.fingerprint
        await mkdir(home, { recursive: true, mode: 0o700 })
        result.message = `已导入 ${result.imported} 个新会话，${result.unchanged} 个未变化；${result.pending} 个更新已暂存（其中 ${result.conflicts} 个冲突）` + (result.recovery ? `。恢复目录：${result.recovery}` : '')
        if (result.legacyBlocked) result.message += `。${result.legacyBlocked} 个会话与本地旧格式 id 相同，已保留原文件并跳过导入`
        try { await atomicJson(baselinePath, state) }
        catch (e) { result.message += `。会话操作已完成，但同步基线保存失败：${e.message}` }
      } else {
        setProgress(direction === 'push' ? '上传、校验并切换远端会话库' : '恢复远端备份')
        result = await remote(current.opts, direction === 'push' ? 'commit' : 'restore', {
          expected: current.tree, backup: current.backup, backupTree: current.backupTree,
          input: direction === 'push' ? createReadStream(join(current.staging, 'payload.tgz')) : undefined,
        })
        result.message = `远端${direction === 'push' ? '上传' : '恢复'}成功，服务已启动；替换前备份：${result.backup}`
        if (direction === 'push') {
          try {
          const state = await jsonFile(baselinePath, { targets: {} })
          const target = targetIdentity(current.opts)
          state.targets ??= {}
          state.targets[target] = Object.fromEntries([...local].map(([id, r]) => [id, r.fingerprint]))
          await mkdir(home, { recursive: true, mode: 0o700 })
          await atomicJson(baselinePath, state)
          } catch (e) { result.message += `。远端操作已完成，但本机同步基线保存失败：${e.message}` }
        }
      }
      last = { ok: true, message: result.message, at: new Date().toISOString(), direction }
      return result
    } finally { await clearPlan() }
  }, true)
  route('backups', 'GET', async () => remote(await effective(), 'backups'), true)
  const disposers = routes.map(r => ctx.webServer.register(r))
  ctx.effect(() => () => {
    clearInterval(cleanup)
    for (const dispose of disposers) dispose()
    clearPlan().catch(() => {})
  }, 'dsh-server-session-sync: routes')
}
