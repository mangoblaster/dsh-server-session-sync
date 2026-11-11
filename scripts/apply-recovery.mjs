#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { atomicJson, jsonFile, sha } from '../lib/store.js'
import { inspectLog } from '../lib/zstd-frames.js'

/** Offline only: preflight the whole batch, backup each file, rollback ordinary errors. */
export async function applyRecovery(folder, { apply = false, offline = false, acceptConflicts = false } = {}) {
  const root = await realpath(resolve(folder))
  const manifest = await jsonFile(join(root, 'recovery.json'), null)
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('无效恢复清单')
  if (manifest.appliedAt) throw new Error('此批次已恢复，请重新同步')
  const home = await realpath(manifest.localHome)
  if (dirname(root) !== join(home, 'session-sync-recovery')) throw new Error('恢复目录不在声明的 DSH_HOME 内')
  const sessions = join(home, 'sessions')
  if ((await realpath(sessions)) !== sessions) throw new Error('会话库使用了符号链接，拒绝恢复')
  const entries = []
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (typeof entry.source !== 'string' || entry.source.includes('/') || entry.source.includes('\\') || !entry.source.endsWith('.zstd')) throw new Error('非法恢复文件名')
    const rel = relative(resolve(manifest.localHome, 'sessions'), resolve(entry.target))
    const target = join(sessions, rel)
    if (!rel || isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..' || rel.split(sep).length !== 3 || seen.has(target)) throw new Error('非法恢复目标')
    seen.add(target)
    if ((await realpath(target)) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('恢复目标包含链接')
    const source = join(root, entry.source)
    if ((await realpath(source)) !== source) throw new Error('暂存文件包含链接')
    const incoming = await readFile(source)
    const old = await readFile(target)
    if (inspectLog(incoming).header.id !== entry.id || inspectLog(old).header.id !== entry.id) throw new Error('恢复 id 不一致')
    if (sha(old) !== entry.expected) throw new Error(`本地会话已变化：${entry.id}，请重新拉取`)
    if (sha(incoming) !== entry.incoming) throw new Error(`暂存文件校验失败：${entry.id}`)
    entries.push({ ...entry, target, incoming })
  }
  const summary = { files: entries.length, conflicts: entries.filter(e => e.conflict).length, applied: false }
  if (!apply) return summary
  if (!offline) throw new Error('必须先完全退出本机 DSH，再添加 --offline；本工具无法自动确认 DSH 已退出')
  if (summary.conflicts && !acceptConflicts) throw new Error('包含两端冲突；人工检查后使用 --accept-conflicts 才能应用远端版本')
  const backup = join(root, 'before-apply-' + randomUUID())
  await mkdir(backup, { mode: 0o700 })
  const replaced = []
  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (sha(await readFile(entry.target)) !== entry.expected) throw new Error('恢复期间本地会话变化，请退出 DSH')
      await copyFile(entry.target, join(backup, String(i) + '.zstd'), constants.COPYFILE_EXCL)
    }
    await atomicJson(join(backup, 'backup.json'), { entries: entries.map((e, i) => ({ id: e.id, target: e.target, file: String(i) + '.zstd' })) })
    for (const [i, entry] of entries.entries()) {
      if (sha(await readFile(entry.target)) !== entry.expected) throw new Error('恢复期间本地会话变化，请退出 DSH')
      const temp = entry.target + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, entry.incoming, { flag: 'wx', mode: 0o600 })
        await rename(temp, entry.target)
        replaced.push(i)
      } finally { await rm(temp, { force: true }) }
    }
    await atomicJson(join(root, 'recovery.json'), { ...manifest, appliedAt: new Date().toISOString(), backup })
    let warning
    if (manifest.targetKey) {
      try {
        const path = join(home, 'session-sync-state.json')
        const state = await jsonFile(path, { targets: {} })
        state.targets ??= {}
        state.targets[manifest.targetKey] ??= {}
        for (const entry of entries) state.targets[manifest.targetKey][entry.id] = inspectLog(entry.incoming).fingerprint
        await atomicJson(path, state)
      } catch (e) { warning = `会话已恢复，但同步基线保存失败：${e.message}` }
    }
    return { ...summary, applied: true, backup, warning }
  } catch (error) {
    const failures = []
    for (const i of replaced.reverse()) {
      try { await copyFile(join(backup, String(i) + '.zstd'), entries[i].target) }
      catch (e) { failures.push(e.message) }
    }
    throw new Error(error.message + (failures.length ? `；回滚失败：${failures.join('; ')}；备份：${backup}` : '；已恢复已替换的文件'))
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (!args[0] || args[0].startsWith('--')) {
    console.error('用法：node scripts/apply-recovery.mjs <恢复目录> [--apply --offline] [--accept-conflicts]')
    process.exitCode = 2
  } else {
    try { console.log(JSON.stringify(await applyRecovery(args[0], { apply: args.includes('--apply'), offline: args.includes('--offline'), acceptConflicts: args.includes('--accept-conflicts') }), null, 2)) }
    catch (e) { console.error(e.message); process.exitCode = 1 }
  }
}
