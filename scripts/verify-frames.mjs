#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inspectLog } from '../lib/zstd-frames.js'
import { scanStore } from '../lib/store.js'

const files = [], skipped = [], residues = []
async function collect(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`)
  if (info.isFile()) { files.push(path); return }
  if (!info.isDirectory()) return
  const records = await scanStore(path)
  files.push(...[...records.values()].map(r => r.file))
  skipped.push(...records.skipped)
  residues.push(...records.legacyResidues)
}
let failed = 0
for (const target of process.argv.slice(2)) {
  try { await collect(resolve(target)) } catch (e) { console.error(e.message); failed++ }
}
for (const file of files) {
  try {
    const r = inspectLog(await readFile(file))
    console.log(`✓ ${file}\n  ${r.frames.length} 帧 / ${r.lines} 行 / id=${r.header.id} / cwd=${r.header.cwd}`)
  } catch (e) { console.error(`✗ ${file}: ${e.message}`); failed++ }
}
for (const item of skipped) console.log(`↷ 跳过 ${item.path}: ${item.reason}; ${item.files.join(', ') || '没有 v4 日志'}`)
for (const item of residues) console.log(`ℹ 旧版本残留保留 ${item.path}: ${item.files.join(', ')}`)
console.log(`检查 ${files.length} 个 v4 文件，跳过 ${skipped.length} 个目录，旧版本残留 ${residues.length} 个目录，异常 ${failed} 个`)
process.exitCode = !files.length ? 2 : failed ? 1 : 0
