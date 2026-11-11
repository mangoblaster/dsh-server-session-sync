import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
for (const dir of ['lib', 'scripts', 'test']) {
  for (const name of await readdir(new URL('../' + dir + '/', import.meta.url))) {
    if (!/\.(m?js)$/.test(name)) continue
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../' + dir + '/' + name, import.meta.url))], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
