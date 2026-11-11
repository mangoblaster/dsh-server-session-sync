"""SSH helper. Linux + Python >=3.8 + systemd; no zstd work on the server."""
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
LOG = 'session.v4.jsonl.zstd'
LEGACY = {'session.jsonl.zstd', 'session.v1.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl.zstd'}


def fail(message):
    raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def describe(root):
    if root.is_symlink():
        fail('sessions must not be a symlink')
    result = {}
    skipped = []
    residues = []
    total = 0
    if not root.exists():
        return {'tracked': result, 'files': {}, 'skipped': skipped, 'legacyResidues': residues}
    for workspace in sorted(root.iterdir()):
        if workspace.is_symlink() or not workspace.is_dir():
            fail('unexpected entry in sessions: ' + workspace.name)
        for session in sorted(workspace.iterdir()):
            if session.is_symlink() or not session.is_dir():
                fail('unexpected session entry: ' + str(session))
            for item in session.iterdir():
                if item.is_symlink():
                    fail('symlink in session: ' + str(item))
                if item.name.startswith('session.v') and item.name != LOG and item.name not in LEGACY:
                    fail('unsupported session generation: ' + item.name)
            legacy = sorted(p.name for p in session.iterdir() if p.name in LEGACY)
            detail = {'workspace': workspace.name, 'session': session.name, 'files': legacy}
            if not (session / LOG).exists():
                skipped.append(dict(detail, reason='legacy-only' if legacy else 'no-v4-log'))
            elif legacy:
                residues.append(dict(detail, reason='legacy-residue'))
            for log in session.iterdir():
                if log.name != LOG and log.name not in LEGACY:
                    continue
                if not log.is_file():
                    fail('log is not a regular file: ' + str(log))
                size = log.stat().st_size
                total += size
                if size > MAX_FILE or total > MAX_TOTAL:
                    fail('session snapshot exceeds size limit')
                result[log.relative_to(root.parent).as_posix()] = digest(log)
    return {'tracked': result, 'files': {k: v for k, v in result.items() if k.endswith('/' + LOG)},
            'skipped': skipped, 'legacyResidues': residues}


def inventory(root):
    return describe(root)['tracked']


def preserve_legacy(source, prepared):
    """Full v4 mirror must not remove remote legacy-only sessions."""
    report = describe(source)
    incoming = {p.name for w in prepared.iterdir() if w.is_dir() for p in w.iterdir() if p.is_dir()}
    for item in report['skipped']:
        if item['session'] in incoming:
            # An incoming v4 with the same id supersedes it; old bytes remain in backup.
            continue
        src = source / item['workspace'] / item['session']
        dst = prepared / item['workspace'] / item['session']
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst)


def tree_hash(items):
    return hashlib.sha256(json.dumps(items, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def service(unit, action, check=True):
    return subprocess.run(['systemctl', action, '--', unit], check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)


def safe_extract(archive, target):
    seen = set()
    total = 0
    manifest = None
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = member.name.rstrip('/')
            parts = name.split('/')
            if name in seen or any(p in ('', '.', '..') for p in parts) or '\\' in name or ':' in name:
                fail('unsafe or duplicate archive path: ' + name)
            seen.add(name)
            directory = member.isdir() and parts[0] == 'sessions' and len(parts) <= 3
            regular = member.isfile() and ((len(parts) == 4 and parts[0] == 'sessions' and parts[-1] == LOG) or name == 'manifest.json')
            if not (directory or regular):
                fail('unsupported archive entry: ' + name)
            if directory:
                (target / name).mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            total += member.size
            if member.size > MAX_FILE or total > MAX_TOTAL:
                fail('archive exceeds size limit')
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tar.extractfile(member) as src, destination.open('xb') as dst:
                shutil.copyfileobj(src, dst)
            if name == 'manifest.json':
                manifest = json.loads(destination.read_text())
    if not isinstance(manifest, dict) or manifest.get('files') != inventory(target / 'sessions'):
        fail('payload checksum manifest mismatch')
    if not manifest['files']:
        fail('empty payload refused')


def swap(home, prepared, unit, expected, keep_legacy=False):
    """Stop writers, recheck preview, rename with rollback; never prune backups."""
    if (home / 'session-sync-backups').is_symlink():
        fail('backup directory must not be a symlink')
    backup = home / 'session-sync-backups' / (str(int(time.time() * 1000)) + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, mode=0o700)
    moved = []
    installed = False
    stopped = False
    try:
        service(unit, 'stop')
        stopped = True
        if tree_hash(inventory(home / 'sessions')) != expected:
            fail('remote sessions changed after preview; create a new preview')
        if keep_legacy:
            preserve_legacy(home / 'sessions', prepared)
        for relative in ['sessions', 'storages/workspace.json', 'storages/session_projcache']:
            old = home / relative
            if old.is_symlink():
                fail('refusing symlink: ' + str(old))
            if old.exists():
                saved = backup / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                old.rename(saved)
                moved.append(relative)
        prepared.rename(home / 'sessions')
        installed = True
        service(unit, 'start')
        service(unit, 'is-active')
        return backup.name
    except BaseException as error:
        rollback_error = None
        if stopped:
            try:
                # Ensure a partially started new service cannot write during rollback.
                service(unit, 'stop')
                if installed:
                    failed = backup / 'failed-sessions'
                    (home / 'sessions').rename(failed)
                    # Caches rebuilt by the failed service belong to the failed tree.
                    for relative in ['storages/workspace.json', 'storages/session_projcache']:
                        live = home / relative
                        if live.exists():
                            live.rename(backup / ('failed-' + live.name))
                for relative in reversed(moved):
                    (backup / relative).rename(home / relative)
                service(unit, 'start')
                service(unit, 'is-active')
            except BaseException as e:
                rollback_error = str(e)
        if rollback_error:
            fail(str(error) + '; rollback also failed: ' + rollback_error + '; backup=' + str(backup))
        raise


def main(config):
    if sys.version_info < (3, 8):
        fail('Python 3.8 or newer is required')
    os.umask(0o077)
    home = Path(config['remoteHome'])
    if not home.is_absolute() or str(home) in ('/', '/root', '/home', '/tmp', '/srv', '/var'):
        fail('unsafe remoteHome')
    # Resolve no symlinks along home or storage parents.
    if home.resolve() != home or (home / 'storages').is_symlink():
        fail('remoteHome/storages must not use symlinks')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}', config['remoteService']):
        fail('invalid systemd unit')
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = home / '.session-sync.lock'
    if lock_path.is_symlink():
        fail('unsafe lock path')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        action = config['action']
        if action == 'probe':
            print(json.dumps({'ssh': True, 'workspace': Path(config['remoteCwd']).is_dir(),
                              'service': service(config['remoteService'], 'is-active', False).stdout.decode().strip(),
                              'sessions': (home / 'sessions').is_dir(), 'python': sys.version.split()[0]}))
        elif action == 'inspect':
            report = describe(home / 'sessions')
            print(json.dumps({'tree': tree_hash(report['tracked']), 'count': len(report['files']),
                              'skipped': report['skipped'], 'legacyResidues': report['legacyResidues']}))
        elif action == 'snapshot':
            report = describe(home / 'sessions')
            before = report['tracked']
            with tempfile.TemporaryDirectory(prefix='.session-sync-', dir=home) as tmp:
                archive = Path(tmp) / 'snapshot.tgz'
                manifest = dict(report, tree=tree_hash(before))
                mf = Path(tmp) / 'manifest.json'
                mf.write_text(json.dumps(manifest))
                with tarfile.open(archive, 'w:gz') as tar:
                    for name in report['files']:
                        tar.add(home / name, arcname=name, recursive=False)
                    tar.add(mf, arcname='manifest.json')
                if before != inventory(home / 'sessions'):
                    fail('remote changed while reading; pause conversation and retry')
                with archive.open('rb') as f:
                    shutil.copyfileobj(f, sys.stdout.buffer)
        elif action == 'commit':
            if not Path(config['remoteCwd']).is_dir():
                fail('remote workspace does not exist')
            with tempfile.TemporaryDirectory(prefix='.session-sync-', dir=home) as tmp:
                tmp = Path(tmp)
                archive = tmp / 'payload.tgz'
                total = 0
                with archive.open('wb') as f:
                    for chunk in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b''):
                        total += len(chunk)
                        if total > MAX_TOTAL:
                            fail('upload too large')
                        f.write(chunk)
                unpacked = tmp / 'unpacked'
                unpacked.mkdir()
                safe_extract(archive, unpacked)
                backup = swap(home, unpacked / 'sessions', config['remoteService'], config['expected'], keep_legacy=True)
                print(json.dumps({'ok': True, 'backup': backup}))
        elif action == 'backups':
            root = home / 'session-sync-backups'
            if root.is_symlink():
                fail('unsafe backup path')
            names = sorted([p.name for p in root.iterdir() if p.is_dir() and not p.is_symlink()
                            and re.fullmatch(r'\d{13}-[a-f0-9]{8}', p.name) and (p / 'sessions').is_dir()], reverse=True) if root.exists() else []
            print(json.dumps({'backups': names}))
        elif action in ('restore', 'backup-info'):
            name = config['backup']
            if not re.fullmatch(r'\d{13}-[a-f0-9]{8}', name):
                fail('invalid backup name')
            root = home / 'session-sync-backups'
            candidate = root / name
            if root.is_symlink() or candidate.is_symlink() or not (candidate / 'sessions').is_dir():
                fail('backup missing or unsafe')
            backup_inventory = inventory(candidate / 'sessions')
            if action == 'backup-info':
                print(json.dumps({'count': sum(k.endswith('/' + LOG) for k in backup_inventory), 'tree': tree_hash(backup_inventory)}))
                return
            if tree_hash(backup_inventory) != config['backupTree']:
                fail('backup changed after preview')
            with tempfile.TemporaryDirectory(prefix='.session-sync-', dir=home) as tmp:
                prepared = Path(tmp) / 'sessions'
                shutil.copytree(candidate / 'sessions', prepared)
                backup = swap(home, prepared, config['remoteService'], config['expected'])
                print(json.dumps({'ok': True, 'backup': backup}))
        else:
            fail('unsupported action')


if __name__ == '__main__':
    def deadline(_signal, _frame):
        raise TimeoutError('remote operation timed out')
    signal.signal(signal.SIGALRM, deadline)
    signal.signal(signal.SIGTERM, deadline)
    signal.signal(signal.SIGHUP, deadline)
    signal.alarm(18 * 60)
    try:
        main(json.loads(base64.b64decode(sys.argv[1])))
    except BaseException as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
