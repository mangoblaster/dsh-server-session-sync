"""Transaction tests with fake systemctl: never contacts a server."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from contextlib import redirect_stdout
import base64
import subprocess

if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(flock=lambda *args: None, LOCK_EX=1, LOCK_NB=4)
spec = importlib.util.spec_from_file_location('remote', Path(__file__).parents[1] / 'lib' / 'remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class Transactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home'
        self.home.mkdir()
        self.log = self.home / 'sessions' / '--work--' / 'session-test' / remote.LOG
        self.log.parent.mkdir(parents=True)
        self.log.write_bytes(b'old bytes')
        self.prepared = Path(self.temp.name) / 'prepared'
        self.prepared.mkdir()
        (self.prepared / 'new').write_text('new bytes')
        self.calls = []
        self.original_service = remote.service
        self.addCleanup(setattr, remote, 'service', self.original_service)
        remote.service = lambda unit, action, check=True: self.calls.append(action)

    def test_success_keeps_backup(self):
        backup = remote.swap(self.home, self.prepared, 'fake', remote.tree_hash(remote.inventory(self.home / 'sessions')))
        self.assertEqual((self.home / 'sessions' / 'new').read_text(), 'new bytes')
        self.assertEqual((self.home / 'session-sync-backups' / backup / 'sessions' / '--work--' / 'session-test' / remote.LOG).read_bytes(), b'old bytes')
        self.assertEqual(self.calls, ['stop', 'start', 'is-active'])

    def test_restart_failure_rolls_back_logs_and_indexes(self):
        registry = self.home / 'storages' / 'workspace.json'
        registry.parent.mkdir()
        registry.write_text('old index')
        count = 0
        def service(unit, action, check=True):
            nonlocal count
            self.calls.append(action)
            if action == 'start':
                count += 1
                if count == 1:
                    registry.write_text('new failed index')
                    raise RuntimeError('injected start failure')
        remote.service = service
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            remote.swap(self.home, self.prepared, 'fake', remote.tree_hash(remote.inventory(self.home / 'sessions')))
        self.assertEqual(self.log.read_bytes(), b'old bytes')
        self.assertEqual(registry.read_text(), 'old index')
        self.assertEqual(self.calls, ['stop', 'start', 'stop', 'start', 'is-active'])

    def test_stale_preview_preserves_store(self):
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            remote.swap(self.home, self.prepared, 'fake', 'stale')
        self.assertEqual(self.log.read_bytes(), b'old bytes')

    def test_bad_upload_does_not_stop_service(self):
        archive = Path(self.temp.name) / 'bad.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            data = json.dumps({'files': {}}).encode()
            member = tarfile.TarInfo('manifest.json'); member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        out = Path(self.temp.name) / 'out'; out.mkdir()
        with self.assertRaises(RuntimeError):
            remote.safe_extract(archive, out)
        self.assertEqual(self.log.read_bytes(), b'old bytes')
        self.assertEqual(self.calls, [])

    def test_traversal_and_links_rejected(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('sessions/link', tarfile.SYMTYPE)]:
            archive = Path(self.temp.name) / 'evil.tgz'
            with tarfile.open(archive, 'w:gz') as tar:
                member = tarfile.TarInfo(name); member.type = kind; member.linkname = '/outside'; tar.addfile(member)
            with self.assertRaises(RuntimeError):
                remote.safe_extract(archive, Path(self.temp.name) / 'out')

    def test_unknown_generation_refused(self):
        (self.log.parent / 'session.v5.jsonl.zstd').write_bytes(b'future')
        with self.assertRaisesRegex(RuntimeError, 'unsupported'):
            remote.inventory(self.home / 'sessions')

    def configuration(self, **options):
        return dict(remoteHome=str(self.home.resolve()), remoteCwd=str(Path(self.temp.name).resolve()), remoteService='fake', **options)

    def prepare_valid_tree(self):
        (self.prepared / 'new').unlink()
        log = self.prepared / '--work--' / 'session-test' / remote.LOG
        log.parent.mkdir(parents=True)
        log.write_bytes(b'new bytes')

    def test_legacy_only_and_residue_are_reported_and_tracked(self):
        old = self.home / 'sessions' / '--work--' / 'session-old' / 'session.jsonl.zstd'
        old.parent.mkdir(); old.write_bytes(b'legacy')
        (self.log.parent / 'session.v3.jsonl.zstd').write_bytes(b'residue')
        report = remote.describe(self.home / 'sessions')
        self.assertEqual(len(report['files']), 1)
        self.assertEqual(len(report['tracked']), 3)
        self.assertEqual(len(report['skipped']), 1)
        self.assertEqual(len(report['legacyResidues']), 1)

    def test_push_preserves_remote_legacy_only_directory(self):
        old = self.home / 'sessions' / '--work--' / 'session-old' / 'session.jsonl.zstd'
        old.parent.mkdir(); old.write_bytes(b'legacy')
        self.prepare_valid_tree()
        backup = remote.swap(self.home, self.prepared, 'fake', remote.tree_hash(remote.inventory(self.home / 'sessions')), keep_legacy=True)
        self.assertEqual(old.read_bytes(), b'legacy')
        self.assertEqual(self.log.read_bytes(), b'new bytes')
        self.assertEqual((self.home / 'session-sync-backups' / backup / 'sessions' / '--work--' / 'session-old' / old.name).read_bytes(), b'legacy')

    def test_legacy_change_invalidates_preview(self):
        old = self.log.parent / 'session.jsonl.zstd'; old.write_bytes(b'legacy')
        expected = remote.tree_hash(remote.inventory(self.home / 'sessions'))
        old.write_bytes(b'changed legacy')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            remote.swap(self.home, self.prepared, 'fake', expected, keep_legacy=True)
        self.assertEqual(self.log.read_bytes(), b'old bytes')

    def test_full_restore_action_preserves_selected_backup(self):
        self.prepare_valid_tree()
        old_tree = remote.tree_hash(remote.inventory(self.home / 'sessions'))
        selected = remote.swap(self.home, self.prepared, 'fake', old_tree)
        current_tree = remote.tree_hash(remote.inventory(self.home / 'sessions'))
        output = io.StringIO()
        with redirect_stdout(output):
            remote.main(self.configuration(action='restore', backup=selected, backupTree=old_tree, expected=current_tree))
        result = json.loads(output.getvalue())
        self.assertTrue(result['ok'])
        self.assertEqual(self.log.read_bytes(), b'old bytes')
        backup_root = self.home / 'session-sync-backups'
        self.assertEqual((backup_root / selected / 'sessions' / '--work--' / 'session-test' / remote.LOG).read_bytes(), b'old bytes')
        self.assertEqual((backup_root / result['backup'] / 'sessions' / '--work--' / 'session-test' / remote.LOG).read_bytes(), b'new bytes')

    def test_restore_refuses_changed_backup_before_stopping_service(self):
        self.prepare_valid_tree()
        old_tree = remote.tree_hash(remote.inventory(self.home / 'sessions'))
        selected = remote.swap(self.home, self.prepared, 'fake', old_tree)
        (self.home / 'session-sync-backups' / selected / 'sessions' / '--work--' / 'session-test' / remote.LOG).write_bytes(b'tampered')
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'backup changed'):
            remote.main(self.configuration(action='restore', backup=selected, backupTree=old_tree, expected=remote.tree_hash(remote.inventory(self.home / 'sessions'))))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.log.read_bytes(), b'new bytes')

    def test_python_snapshot_is_accepted_by_node_with_legacy_tracking(self):
        # Real zstd bytes produced locally; Python never decompresses or recompresses.
        code = "const z=require('node:zlib');console.log(z.zstdCompressSync(Buffer.from(JSON.stringify({type:'session',version:4,id:'session-test',cwd:'/work'})+'\\n')).toString('base64'))"
        self.log.write_bytes(base64.b64decode(subprocess.check_output(['node', '-e', code], text=True).strip()))
        old = self.home / 'sessions' / '--work--' / 'session-old' / 'session.jsonl.zstd'
        old.parent.mkdir(); old.write_bytes(b'legacy bytes')
        stream = io.BytesIO()
        previous = sys.stdout
        try:
            sys.stdout = types.SimpleNamespace(buffer=stream)
            remote.main(self.configuration(action='snapshot'))
        finally:
            sys.stdout = previous
        archive = Path(self.temp.name) / 'snapshot.tgz'; archive.write_bytes(stream.getvalue())
        out = Path(self.temp.name) / 'node-out'; out.mkdir()
        module = (Path(__file__).parents[1] / 'lib' / 'archive.js').resolve().as_uri()
        script = 'import {extractSnapshot} from ' + json.dumps(module) + '; const r=await extractSnapshot(process.argv[1],process.argv[2]); console.log(JSON.stringify({v4:r.records.size,skipped:r.records.skipped.length}));'
        result = subprocess.check_output(['node', '--input-type=module', '-e', script, str(archive), str(out)], text=True)
        self.assertEqual(json.loads(result), {'v4': 1, 'skipped': 1})
        self.assertEqual(old.read_bytes(), b'legacy bytes')

    def test_restore_inspection_needs_no_download_and_does_not_stop_service(self):
        old = self.home / 'sessions' / '--work--' / 'session-old' / 'session.jsonl.zstd'
        old.parent.mkdir(); old.write_bytes(b'legacy')
        output = io.StringIO()
        with redirect_stdout(output):
            remote.main(self.configuration(action='inspect'))
        result = json.loads(output.getvalue())
        self.assertEqual(result['count'], 1)
        self.assertEqual(len(result['skipped']), 1)
        self.assertEqual(result['tree'], remote.tree_hash(remote.inventory(self.home / 'sessions')))
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
