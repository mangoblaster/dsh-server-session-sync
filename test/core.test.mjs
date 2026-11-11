import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { constants, zstdCompressSync } from 'node:zlib'
import { Readable } from 'node:stream'
import * as tar from 'tar'
import { inspectLog, rewriteFirstLine, splitFrames } from '../lib/zstd-frames.js'
import { apply, validateConfig, shellQuote, sshArgs, remoteCommand, connectionDiagnostic } from '../lib/index.js'
import { encodeWorkspaceName, scanStore, importPull, sha } from '../lib/store.js'
import { extractSnapshot } from '../lib/archive.js'
import { run } from '../lib/process.js'
import { applyRecovery } from '../scripts/apply-recovery.mjs'

const frame = text => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const log = (id = 'session-test', text = 'hello', cwd = '/old') => Buffer.concat([
  frame(JSON.stringify({ type: 'session', version: 4, id, cwd, createdAt: 1 }) + '\n'),
  frame(JSON.stringify({ type: 'message', text }) + '\n'),
])
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function put(root, bytes, workspace = '--work--', id = 'session-test') {
  const dir = join(root, 'sessions', workspace, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), bytes)
  return join(dir, 'session.v4.jsonl.zstd')
}
function harness(home, rejection) {
  const routes = [], dispose = []
  apply({ connection: { requestRejection: () => rejection }, webServer: { register(route) { routes.push(route); return () => {} } }, effect(factory) { dispose.push(factory()) } }, { localHome: home })
  return { routes, close: () => dispose.forEach(f => f()), async call(path, method = 'GET', body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { 'content-type': 'application/json' }
    const res = { writeHead(code) { this.status = code }, end(text) { this.body = JSON.parse(text) } }
    await routes.find(r => r.path.endsWith('/' + path)).handler(req, res)
    return res
  } }
}
test('rewrite preserves content and subsequent frame bytes', () => {
  const input = log(), frames = splitFrames(input), output = rewriteFirstLine(input, '/new').buffer
  assert.equal(inspectLog(output).header.cwd, '/new')
  assert.equal(inspectLog(output).fingerprint, inspectLog(input).fingerprint)
  assert.ok(output.subarray(splitFrames(output)[0].end).equals(input.subarray(frames[0].end)))
})
test('single frame gets an isolated header and intact body', () => {
  const input = frame(inspectLog(log()).text), output = rewriteFirstLine(input, '/new').buffer
  assert.equal(splitFrames(output).length, 2)
  assert.equal(inspectLog(output).fingerprint, inspectLog(input).fingerprint)
})
test('every truncated prefix and trailing garbage is rejected', () => {
  const bytes = log(), boundary = splitFrames(bytes)[0].end
  for (let i = 0; i < bytes.length; i++) if (i !== boundary) assert.throws(() => inspectLog(bytes.subarray(0, i)), undefined, `prefix ${i}`)
  assert.throws(() => inspectLog(Buffer.concat([Buffer.from('garbage'), bytes])))
  assert.throws(() => inspectLog(Buffer.concat([bytes, Buffer.from('x')])))
})
test('checksum corruption, invalid JSON and unsupported headers are rejected', () => {
  const bytes = log(); bytes[bytes.length - 1] ^= 1
  assert.throws(() => inspectLog(bytes))
  assert.throws(() => inspectLog(Buffer.concat([frame('{"type":"session","id":"x","version":4,"cwd":"/"}\n'), frame('invalid\n')])))
  assert.throws(() => inspectLog(frame('{"id":"x"}\n')))
})
test('verify CLI reports truncated file as failure', async t => {
  const root = await sandbox(t), file = join(root, 'bad.zstd'); await writeFile(file, log().subarray(0, -3))
  assert.equal(spawnSync(process.execPath, ['scripts/verify-frames.mjs', file], { cwd: new URL('..', import.meta.url) }).status, 1)
})
test('config rejects option injection and unsafe paths; SSH uses strict known-hosts', () => {
  for (const value of [{host:'-oProxyCommand=x'}, {user:'root;id'}, {remoteService:'dsh;id'}, {remoteHome:'/'}, {remoteHome:'/tmp/../root/.dsh'}, {port:0}]) assert.throws(() => validateConfig(value))
  const opts = validateConfig({host:'example.invalid',remoteHome:"/srv/user's dsh",remoteCwd:'/srv/my work'})
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.ok(sshArgs(opts, 'true').includes('StrictHostKeyChecking=yes'))
  assert.ok(sshArgs(opts, 'true').includes('--'))
})
test('workspace encoding preserves dots, escapes UTF-16 and bounds length', () => {
  assert.equal(encodeWorkspaceName('/srv/my.work'), '--srv-my.work--')
  assert.equal(encodeWorkspaceName('/中 😀'), '--~4E2D~0020~D83D~DE00--')
  assert.ok(encodeWorkspaceName('/' + 'a'.repeat(500)).length <= 255)
})
test('all endpoints reject unauthenticated callers', async t => {
  const h = harness(await sandbox(t), 401); t.after(h.close)
  for (const route of h.routes) assert.equal((await h.call(route.path.split('/').at(-1),'POST',{host:'attacker.invalid'})).status,401)
})
test('missing authentication capability refuses activation', () => { assert.throws(() => apply({webServer:{}}, {}), /Connection/) })
test('configuration can clear host; transfer requires preview token', async t => {
  const h = harness(await sandbox(t)); t.after(h.close)
  assert.equal((await h.call('config','POST',{host:'example.invalid'})).status,200)
  assert.equal((await h.call('config','POST',{host:''})).status,200)
  assert.equal((await h.call('config')).body.config.host,'')
  assert.equal((await h.call('config','DELETE')).status,405)
  assert.equal((await h.call('push','POST',{planId:'guess'})).status,400)
})
test('duplicate remote id imports once; divergent duplicates fail', async t => {
  const root=await sandbox(t), remote=join(root,'remote'), local=join(root,'local')
  await put(remote,log(),'--a--'); await put(remote,log(),'--b--')
  const result=await importPull({localHome:local,localCwd:root},await scanStore(join(remote,'sessions')),new Map())
  assert.equal(result.imported,1)
  await put(remote,log('session-test','changed'),'--b--')
  await assert.rejects(scanStore(join(remote,'sessions')),/同 id/)
})
test('remote update stages safely; offline apply backs up original', async t => {
  const root=await sandbox(t), local=join(root,'local'), remote=join(root,'remote')
  const file=await put(local,log()), original=await readFile(file)
  await put(remote,log('session-test','continued'))
  const locals=await scanStore(join(local,'sessions'))
  const result=await importPull({localHome:local,localCwd:root},await scanStore(join(remote,'sessions')),locals,{'session-test':locals.get('session-test').fingerprint})
  assert.equal(result.pending,1); assert.equal(result.conflicts,0)
  assert.ok((await readFile(file)).equals(original))
  assert.equal((await applyRecovery(result.recovery)).applied,false)
  await assert.rejects(applyRecovery(result.recovery,{apply:true}),/退出/)
  const applied=await applyRecovery(result.recovery,{apply:true,offline:true})
  assert.equal(applied.applied,true)
  assert.ok((await readFile(join(applied.backup,'0.zstd'))).equals(original))
  assert.equal(inspectLog(await readFile(file)).fingerprint,inspectLog(log('session-test','continued')).fingerprint)
})
test('conflicts require explicit choice; changed local file blocks recovery', async t => {
  const root=await sandbox(t), local=join(root,'local'), remote=join(root,'remote')
  const file=await put(local,log()); await put(remote,log('session-test','different'))
  const result=await importPull({localHome:local,localCwd:root},await scanStore(join(remote,'sessions')),await scanStore(join(local,'sessions')))
  assert.equal(result.conflicts,1)
  await assert.rejects(applyRecovery(result.recovery,{apply:true,offline:true}),/冲突/)
  await writeFile(file,log('session-test','more local'))
  await assert.rejects(applyRecovery(result.recovery,{apply:true,offline:true,acceptConflicts:true}),/已变化/)
})
test('process runner handles missing command, failed exit, timeout and input', async () => {
  await assert.rejects(run('dsh-sync-no-such-command-123',[],{timeoutMs:1000}))
  await assert.rejects(run(process.execPath,['-e','process.exit(3)']))
  await assert.rejects(run(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:50}))
  assert.equal((await run(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:Readable.from(['hello'])})).stdout,'hello')
})
test('archive verifies manifest and rejects links before extraction', async t => {
  const root=await sandbox(t), source=join(root,'source'), out=join(root,'out'), file=await put(source,log())
  const files={'sessions/--work--/session-test/session.v4.jsonl.zstd':sha(await readFile(file))}
  await writeFile(join(source,'manifest.json'),JSON.stringify({files,tree:sha(JSON.stringify(files))}))
  const archive=join(root,'valid.tgz'); await tar.c({cwd:source,file:archive,gzip:true},['sessions','manifest.json']); await mkdir(out)
  assert.equal((await extractSnapshot(archive,out)).records.size,1)
  const header=new tar.Header({path:'sessions/link',type:'SymbolicLink',linkpath:'../../outside',size:0,mode:0o777}); header.encode()
  const evil=join(root,'evil.tar'); await writeFile(evil,Buffer.concat([header.block,Buffer.alloc(1024)]))
  const bad=join(root,'bad'); await mkdir(bad)
  await assert.rejects(extractSnapshot(evil,bad),/归档/)
  assert.deepEqual(await readdir(bad),[])
})

test('mixed library skips legacy-only and empty directories and reports residues', async t => {
  const root=await sandbox(t)
  const live=await put(root,log())
  await writeFile(join(live,'..','session.v3.jsonl.zstd'),Buffer.from('legacy residue'))
  for(const [id,name] of [['session-v0','session.jsonl.zstd'],['session-v3','session.v3.jsonl.zstd'],['session-empty',null]]) {
    const dir=join(root,'sessions','--work--',id); await mkdir(dir)
    if(name)await writeFile(join(dir,name),Buffer.from('legacy bytes stay untouched'))
  }
  const result=await scanStore(join(root,'sessions'))
  assert.equal(result.size,1)
  assert.equal(result.skipped.length,3)
  assert.deepEqual(result.skipped.map(e=>e.reason).sort(),['legacy-only','legacy-only','no-v4-log'])
  assert.equal(result.legacyResidues.length,1)
  assert.equal((await readFile(join(live,'..','session.v3.jsonl.zstd'))).toString(),'legacy residue')
})
test('legacy coexistence does not hide corrupt v4 or future generations', async t => {
  const root=await sandbox(t), file=await put(root,log().subarray(0,-1))
  await writeFile(join(file,'..','session.jsonl.zstd'),Buffer.from('old'))
  await assert.rejects(scanStore(join(root,'sessions')),/截断/)
  await writeFile(file,log())
  await writeFile(join(file,'..','session.v5.jsonl.zstd'),Buffer.from('future'))
  await assert.rejects(scanStore(join(root,'sessions')),/不支持/)
})
test('existing legacy-only id is preserved during pull rather than overwritten', async t => {
  const root=await sandbox(t), remote=join(root,'remote'), local=join(root,'local')
  await put(remote,log())
  const oldDir=join(local,'sessions','--work--','session-test');await mkdir(oldDir,{recursive:true})
  const oldFile=join(oldDir,'session.jsonl.zstd');await writeFile(oldFile,'legacy original')
  const result=await importPull({localHome:local,localCwd:root},await scanStore(join(remote,'sessions')),await scanStore(join(local,'sessions')))
  assert.equal(result.imported,0);assert.equal(result.legacyBlocked,1)
  assert.equal(await readFile(oldFile,'utf8'),'legacy original')
})
test('compressed and aggregate decompressed limits accept exact boundary and reject one byte over', () => {
  const bytes=log(), plainBytes=Buffer.byteLength(inspectLog(bytes).text)
  assert.equal(inspectLog(bytes,{maxLogBytes:bytes.length,maxPlainBytes:plainBytes}).header.id,'session-test')
  assert.throws(()=>inspectLog(bytes,{maxLogBytes:bytes.length-1}),/压缩大小/)
  assert.throws(()=>inspectLog(bytes,{maxPlainBytes:plainBytes-1}))
  const firstSize=Buffer.byteLength(inspectLog(bytes).text.split('\n')[0]+'\n')
  assert.throws(()=>inspectLog(bytes,{maxPlainBytes:firstSize}),/解压内容/)
  assert.throws(()=>inspectLog(bytes,{maxLogBytes:257*1024*1024}),/不能超过/)
  assert.throws(()=>inspectLog(bytes,{maxPlainBytes:513*1024*1024}),/不能超过/)
})
test('checksummed rewrite changes raw bytes but keeps cross-machine content fingerprint', () => {
  const bytes=zstdCompressSync(Buffer.from(inspectLog(log()).text))
  const rewritten=rewriteFirstLine(bytes,'/new').buffer
  assert.notEqual(sha(bytes),sha(rewritten))
  assert.equal(inspectLog(bytes).fingerprint,inspectLog(rewritten).fingerprint)
})
test('local identical duplicate is deliberately refused, remote duplicate can deduplicate', async t => {
  const root=await sandbox(t);await put(root,log(),'--a--');await put(root,log(),'--b--')
  assert.equal((await scanStore(join(root,'sessions'))).size,1)
  await assert.rejects(scanStore(join(root,'sessions'),{allowIdenticalDuplicates:false}),/本地同 id/)
})
test('missing Python and host key failures have actionable diagnostics', () => {
  assert.match(remoteCommand('print(1)','e30='),/command -v python3/)
  assert.match(connectionDiagnostic(new Error('ssh exit 127: DSH_SYNC_MISSING_PYTHON3')).message,/远端缺少 python3/)
  assert.match(connectionDiagnostic(new Error('Host key verification failed')).message,/核对指纹/)
})
