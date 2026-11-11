import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

/** Checked exit, bounded diagnostics, timeout, and shared abort for stream I/O. */
export async function run(command, args, { input, output, timeoutMs = 20 * 60_000, signal } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error(`${command} 超时`)), timeoutMs)
  let child
  let stdout = '', stderr = ''
  try {
    child = spawn(command, args, { windowsHide: true, signal: controller.signal, killSignal: 'SIGKILL' })
    const closed = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, sig) => code === 0 ? resolve() : reject(new Error(`${command} 失败 (${code ?? sig}): ${stderr.slice(-2000)}`)))
    })
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-16_384) })
    const io = []
    if (input) io.push(pipeline(input, child.stdin, { signal: controller.signal }))
    else child.stdin.end()
    if (output) io.push(pipeline(child.stdout, output, { signal: controller.signal }))
    else child.stdout.on('data', c => { stdout = (stdout + c).slice(-64_000) })
    await Promise.all([closed, ...io])
    return { stdout, stderr }
  } catch (e) {
    controller.abort()
    child?.kill('SIGKILL')
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
