import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export const MAX_LOG_BYTES = 256 * 1024 * 1024
export const MAX_PLAIN_BYTES = 512 * 1024 * 1024
function budget(value, maximum) {
  const limit = value ?? maximum
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) throw new Error('大小限制必须为正整数，且不能超过默认上限')
  return limit
}

/** Strict container scan: no ignored tail or automatic repair. */
export function splitFrames(buffer, limits = {}) {
  const maxLogBytes = budget(limits.maxLogBytes, MAX_LOG_BYTES)
  if (!buffer.length || buffer.length > maxLogBytes) throw new Error(`会话文件为空或超过压缩大小上限 ${maxLogBytes} 字节`)
  const frames = []
  let pos = 0
  const need = size => { if (pos + size > buffer.length) throw new Error(`zstd 帧截断（字节 ${pos}）`) }
  while (pos < buffer.length) {
    const start = pos
    need(5)
    if (buffer.readUInt32LE(pos) !== 0xfd2fb528) throw new Error(`无效 zstd magic（字节 ${pos}）`)
    pos += 4
    const d = buffer[pos++]
    if (d & 0x18) throw new Error('zstd 保留标志位非零')
    const remaining = ((d & 32) ? 0 : 1) + [0, 1, 2, 4][d & 3] + [d & 32 ? 1 : 0, 2, 4, 8][d >> 6]
    need(remaining)
    pos += remaining
    for (;;) {
      need(3)
      const block = buffer.readUIntLE(pos, 3)
      pos += 3
      const type = (block >> 1) & 3
      const length = block >>> 3
      if (type === 3 || length > 128 * 1024) throw new Error('无效 zstd block')
      const payload = type === 1 ? 1 : length
      need(payload)
      pos += payload
      if (block & 1) break
    }
    if (d & 4) { need(4); pos += 4 }
    frames.push({ start, end: pos })
  }
  return frames
}

export function decompressAll(buffer, frames = splitFrames(buffer), limits = {}) {
  const maxPlainBytes = budget(limits.maxPlainBytes, MAX_PLAIN_BYTES)
  const chunks = []
  let total = 0
  for (const frame of frames) {
    const remaining = maxPlainBytes - total
    if (remaining <= 0) throw new Error('解压内容超过大小上限')
    const chunk = zstdDecompressSync(buffer.subarray(frame.start, frame.end), { maxOutputLength: remaining })
    total += chunk.length
    if (total > maxPlainBytes) throw new Error('解压内容超过大小上限')
    chunks.push(chunk)
  }
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), failed: 0 }
}

export function inspectLog(buffer, limits = {}) {
  const frames = splitFrames(buffer, limits)
  const { text } = decompressAll(buffer, frames, limits)
  if (!text.endsWith('\n')) throw new Error('会话末行不完整，拒绝同步')
  const lines = text.slice(0, -1).split('\n')
  const header = JSON.parse(lines[0])
  if (!header || header.type !== 'session' || header.version !== 4 ||
      typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') throw new Error('仅支持带有 id/cwd 的 v4 session header')
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) throw new Error(`第 ${i + 1} 行为空`)
    JSON.parse(lines[i])
  }
  const normalized = { ...header }
  delete normalized.cwd
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).update('\n')
    .update(lines.slice(1).join('\n')).digest('hex')
  return { frames, text, header, fingerprint, lines: lines.length }
}

export function rewriteFirstLine(buffer, cwd) {
  const report = inspectLog(buffer)
  const first = new TextDecoder('utf-8', { fatal: true }).decode(
    zstdDecompressSync(buffer.subarray(0, report.frames[0].end), { maxOutputLength: MAX_PLAIN_BYTES }))
  const newline = first.indexOf('\n')
  if (newline < 0) throw new Error('首帧不包含完整 header')
  const compress = text => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const chunks = [compress(JSON.stringify({ ...report.header, cwd }) + '\n')]
  if (first.length > newline + 1) chunks.push(compress(first.slice(newline + 1)))
  chunks.push(buffer.subarray(report.frames[0].end))
  const result = Buffer.concat(chunks)
  const after = inspectLog(result)
  if (after.fingerprint !== report.fingerprint) throw new Error('重写后内容校验失败')
  return { buffer: result, frames: after.frames.length, before: report.header.cwd, reframed: true }
}
