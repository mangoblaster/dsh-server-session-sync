import * as tar from 'tar'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { scanStore, sha } from './store.js'

export const MAX_ARCHIVE = 2 * 1024 ** 3

export async function extractSnapshot(file, cwd) {
  let total = 0
  const seen = new Set()
  let parser
  const filter = (name, entry) => {
    try {
    const path = name.replace(/\/$/, '')
    const parts = path.split('/')
    if (seen.has(path) || parts.some(p => !p || p === '.' || p === '..') || /[\\:]/.test(path)) throw new Error(`非法归档路径：${name}`)
    seen.add(path)
    const directory = entry.type === 'Directory' && parts[0] === 'sessions' && parts.length <= 3
    const regular = entry.type === 'File' && ((parts.length === 4 && parts[0] === 'sessions' && parts[3] === 'session.v4.jsonl.zstd') || path === 'manifest.json')
    if (!directory && !regular) throw new Error(`归档含链接或不支持的条目：${name}`)
    total += entry.size
    if (entry.size > 256 * 1024 ** 2 || total > MAX_ARCHIVE) throw new Error('归档超出大小限制')
    return true
    } catch (error) {
      parser.abort(error)
      return false
    }
  }
  // Validate the entire table before any extraction. The file is in a private staging dir.
  parser = tar.t({ strict: true, filter })
  await pipeline(createReadStream(file), parser)
  await tar.x({ file, cwd, strict: true, noChmod: true, noMtime: true, filter: (_name, entry) => entry.type === 'File' || entry.type === 'Directory' })
  const manifest = JSON.parse(await readFile(join(cwd, 'manifest.json'), 'utf8'))
  if (!manifest || !manifest.files || typeof manifest.tree !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.tree)) throw new Error('远端校验清单无效')
  const records = await scanStore(join(cwd, 'sessions'))
  // Include identical duplicates in the checksum check, not only the deduplicated records.
  const listed = [...seen].filter(p => p.endsWith('/session.v4.jsonl.zstd')).sort()
  if (JSON.stringify(listed) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('归档文件清单不一致')
  for (const name of listed) if (sha(await readFile(join(cwd, ...name.split('/')))) !== manifest.files[name]) throw new Error(`校验和不一致：${name}`)
  const tracked = manifest.tracked ?? manifest.files
  if (!tracked || typeof tracked !== 'object' || Array.isArray(tracked)) throw new Error('远端追踪清单无效')
  for (const name of listed) if (tracked[name] !== manifest.files[name]) throw new Error('追踪清单和传输清单不一致')
  const sorted = Object.fromEntries(Object.keys(tracked).sort().map(k => [k, tracked[k]]))
  // Paths are normally ASCII; Python uses ensure_ascii for unicode paths.
  const encoded = JSON.stringify(sorted).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  if (sha(Buffer.from(encoded)) !== manifest.tree) throw new Error('远端树摘要不一致')
  records.skipped = manifest.skipped ?? []
  records.legacyResidues = manifest.legacyResidues ?? []
  return { records, tree: manifest.tree }
}

export async function createPayload(file, cwd) {
  await tar.c({ file, cwd, gzip: true, portable: true, noMtime: true }, ['sessions', 'manifest.json'])
}
