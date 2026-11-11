import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readdir, readFile, writeFile, rename, rm, rmdir, realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { inspectLog, rewriteFirstLine, MAX_LOG_BYTES } from './zstd-frames.js'

export const SESSION_FILE = 'session.v4.jsonl.zstd'
export const LEGACY_FILES = ['session.jsonl.zstd', 'session.v1.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl.zstd']
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const targetIdentity = opts => sha(JSON.stringify([opts.host, opts.port, opts.user, opts.remoteHome]))
export const encodeSegment = raw => {
  if (!raw) throw new Error('空 id')
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    out += /^[A-Za-z0-9._-]$/.test(ch) && raw !== '.' && raw !== '..'
      ? ch : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
export function encodeWorkspaceName(cwd) {
  if (!cwd) throw new Error('空工作区路径')
  let readable = '', separator = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]
    if ('/\\:'.includes(ch)) { if (!separator) readable += '-'; separator = true }
    else { readable += /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'); separator = false }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}

export async function atomicJson(path, data) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
export async function jsonFile(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}
export async function directory(path) {
  if (!isAbsolute(path)) throw new Error('工作区必须是绝对路径')
  const canonical = await realpath(path)
  if (!(await lstat(canonical)).isDirectory()) throw new Error('工作区不是目录')
  return canonical
}

export async function scanStore(root, { allowIdenticalDuplicates = true } = {}) {
  const records = new Map()
  records.skipped = []
  records.legacyResidues = []
  let workspaces
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('会话库不能是符号链接')
    workspaces = await readdir(root, { withFileTypes: true })
  } catch (e) { if (e.code === 'ENOENT') return records; throw e }
  let total = 0
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) throw new Error(`会话库包含异常条目：${workspace.name}`)
    const parent = join(root, workspace.name)
    for (const session of await readdir(parent, { withFileTypes: true })) {
      if (!session.isDirectory() || session.isSymbolicLink()) throw new Error(`异常会话目录：${session.name}`)
      const dir = join(parent, session.name)
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`拒绝会话中的符号链接：${entry.name}`)
        if (LEGACY_FILES.includes(entry.name) && !entry.isFile()) throw new Error(`旧日志不是普通文件：${entry.name}`)
        if (entry.name.startsWith('session.v') && entry.name !== SESSION_FILE && !LEGACY_FILES.includes(entry.name)) throw new Error(`不支持的会话版本：${entry.name}`)
      }
      const legacy = entries.filter(e => LEGACY_FILES.includes(e.name)).map(e => e.name)
      const detail = { workspace: workspace.name, session: session.name, files: legacy, path: dir }
      if (!entries.some(e => e.name === SESSION_FILE)) {
        records.skipped.push({ ...detail, reason: legacy.length ? 'legacy-only' : 'no-v4-log' })
        continue
      }
      if (legacy.length) records.legacyResidues.push({ ...detail, reason: 'legacy-residue' })
      const file = join(dir, SESSION_FILE)
      const before = await lstat(file)
      total += before.size
      if (!before.isFile() || before.size > MAX_LOG_BYTES || total > 2 * 1024 ** 3) throw new Error('会话库超出大小限制或包含非普通文件')
      const bytes = await readFile(file)
      const after = await lstat(file)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('读取时会话仍在变化，请暂停对话后重试')
      let report
      try { report = inspectLog(bytes) }
      catch (error) { throw new Error(`${file}: ${error.message}`) }
      if (encodeSegment(report.header.id) !== session.name) throw new Error(`目录和 header id 不一致：${session.name}`)
      const record = { id: report.header.id, file, workspace: workspace.name, bytes, hash: sha(bytes), fingerprint: report.fingerprint }
      const existing = records.get(record.id)
      if (existing && !allowIdenticalDuplicates) throw new Error(`本地同 id 在多个目录中存在，请先处理：${record.id}`)
      if (existing && existing.fingerprint !== record.fingerprint) throw new Error(`同 id 存在不同内容，须先处理：${record.id}`)
      if (!existing) records.set(record.id, record)
    }
  }
  return records
}

export function storeSignature(records) {
  return sha(JSON.stringify([...records.values()].map(r => [r.id, r.file, r.hash]).sort((a, b) => a[0].localeCompare(b[0]))))
}
export function changes(local, remote) {
  const result = { added: [], changed: [], unchanged: [], removed: [] }
  for (const [id, record] of local) {
    const other = remote.get(id)
    result[!other ? 'added' : other.fingerprint === record.fingerprint ? 'unchanged' : 'changed'].push(id)
  }
  for (const id of remote.keys()) if (!local.has(id)) result.removed.push(id)
  return result
}

export async function preparePayload(records, staging, cwd) {
  const files = {}
  for (const r of records.values()) {
    const relative = ['sessions', encodeWorkspaceName(cwd), encodeSegment(r.id), SESSION_FILE].join('/')
    const file = join(staging, ...relative.split('/'))
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
    const rewritten = rewriteFirstLine(r.bytes, cwd).buffer
    await writeFile(file, rewritten, { flag: 'wx', mode: 0o600 })
    files[relative] = sha(rewritten)
  }
  await atomicJson(join(staging, 'manifest.json'), { files })
}

/** Only new ids go live. Existing ids become offline recovery candidates. */
export async function importPull(opts, remote, local, baseline = {}) {
  const result = { imported: 0, unchanged: 0, pending: 0, conflicts: 0, legacyBlocked: 0, details: [], recovery: null }
  const batch = randomUUID()
  const recovery = join(opts.localHome, 'session-sync-recovery', batch)
  const entries = []
  for (const r of remote.values()) {
    const old = local.get(r.id)
    if (!old && local.skipped?.some(item => item.session === encodeSegment(r.id))) {
      result.legacyBlocked++
      result.details.push({ id: r.id, action: 'legacy-id-preserved' })
      continue
    }
    if (old?.fingerprint === r.fingerprint) { result.unchanged++; continue }
    // Updates retain their existing local workspace, even when new imports use another one.
    const rewritten = rewriteFirstLine(r.bytes, old ? inspectLog(old.bytes).header.cwd : opts.localCwd).buffer
    if (old) {
      await mkdir(recovery, { recursive: true, mode: 0o700 })
      const name = encodeSegment(r.id) + '.zstd'
      const conflict = !baseline[r.id] || baseline[r.id] !== old.fingerprint
      await writeFile(join(recovery, name), rewritten, { flag: 'wx', mode: 0o600 })
      entries.push({ id: r.id, source: name, target: old.file, expected: old.hash, incoming: sha(rewritten), conflict })
      await atomicJson(join(recovery, 'recovery.json'), { version: 1, localHome: opts.localHome,
        targetKey: opts.host ? targetIdentity(opts) : null, entries })
      result.pending++
      if (conflict) result.conflicts++
      result.details.push({ id: r.id, action: conflict ? 'conflict' : 'remote-update' })
    } else {
      // Publish a complete directory with an exclusive final mkdir. Never overwrite.
      const parent = join(opts.localHome, 'sessions', encodeWorkspaceName(opts.localCwd))
      await mkdir(parent, { recursive: true, mode: 0o700 })
      const target = join(parent, encodeSegment(r.id))
      const temp = join(parent, '.incoming-' + randomUUID())
      await mkdir(temp, { mode: 0o700 })
      let reserved = false
      try {
        await writeFile(join(temp, SESSION_FILE), rewritten, { flag: 'wx', mode: 0o600 })
        // A concurrent import cannot be replaced, even by POSIX rename.
        await mkdir(target, { mode: 0o700 })
        reserved = true
        await rename(join(temp, SESSION_FILE), join(target, SESSION_FILE))
      } catch (error) {
        // Remove only an empty directory reserved by us; never remove another writer's data.
        if (reserved) await rmdir(target).catch(() => {})
        throw error
      } finally { await rm(temp, { recursive: true, force: true }) }
      local.set(r.id, { ...r, file: join(target, SESSION_FILE), hash: sha(rewritten) })
      result.imported++
      result.details.push({ id: r.id, action: 'imported' })
    }
  }
  if (entries.length) {
    result.recovery = recovery
  }
  return result
}
