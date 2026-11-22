"""Stdlib readback of owned /qa installs/cache; never import or run SDK code."""
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import marshal
import os
from pathlib import Path
import platform
import stat
import sys
import sysconfig
import time
import types


STATE = Path('/qa/s')
TOOL = STATE / 'uv/tools/omnigent'
COMMON = 'lib/python3.12/site-packages/omnigent/native/native_bridge_common.py'
BEFORE = '2a80d492f6f844a8da0e7dbb3e8aaec396a2bbd525f6d042ddc3cf2eed6bccc6'
AFTER = '68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962'
SNAPSHOT_MAX_TICKS = 100000
SNAPSHOT_TIMEOUT_SECONDS = 180


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid,
            info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def plain(path, limit=256 * 1024):
    for parent in path.parents:
        require(stat.S_ISDIR(parent.lstat().st_mode), 'redirected-parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, 'file-bound-or-type')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
                == identity(path.lstat()), 'changed-during-read')
        return raw, before
    finally:
        os.close(fd)


def pyc_readback(raw, source, filename, optimization):
    require(len(raw) > 16 and raw[:4] == importlib.util.MAGIC_NUMBER
            and int.from_bytes(raw[4:8], 'little') == 3
            and raw[8:16] == importlib.util.source_hash(source), 'pyc-header')
    stream = io.BytesIO(raw[16:])
    code = marshal.load(stream)
    require(isinstance(code, types.CodeType) and stream.read() == b''
            and code == compile(source, filename, 'exec', dont_inherit=True, optimize=optimization), 'pyc-code')
    def filenames(node):
        require(node.co_filename == filename, 'pyc-filename')
        for value in node.co_consts:
            if isinstance(value, types.CodeType):
                filenames(value)
    filenames(code)
    return {'optimization': optimization, 'sha256': digest(raw), 'flags': 3,
            'magic': raw[:4].hex(), 'sourceHash': raw[8:16].hex(), 'marshalMatchesSource': True}


def sandbox():
    require(os.geteuid() == os.getegid() == 1000, 'uid-gid')
    require(os.listdir('/sys/class/net') == ['lo'], 'network-not-none')
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        fields = left.split()
        mounts[fields[4]] = (set(fields[5].split(',')), right.split()[0])
    require('ro' in mounts['/'][0] and 'rw' in mounts['/qa'][0]
            and mounts['/tmp'][1] == 'tmpfs'
            and {'rw', 'noexec', 'nosuid', 'nodev'} <= mounts['/tmp'][0], 'mount-sandbox')
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    require(int(status['CapEff'].strip(), 16) == 0 and status['NoNewPrivs'].strip() == '1', 'process-sandbox')


def readback(expected_platform):
    sandbox()
    machine = {'linux/amd64': 'x86_64', 'linux/arm64': 'aarch64'}.get(expected_platform)
    require(sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12)
            and platform.machine() == machine, 'python-or-platform')
    require(sys.prefix == str(TOOL) and sys.executable == str(TOOL / 'bin/python'), 'selected-python')
    require(sysconfig.get_path('purelib') == str(TOOL / 'lib/python3.12/site-packages'), 'selected-purelib')
    require(importlib.metadata.version('omnigent') == '0.16.0'
            and str(importlib.metadata.distribution('omnigent').locate_file('')) == sysconfig.get_path('purelib'), 'metadata')
    target = TOOL / COMMON
    source, info = plain(target)
    require(digest(source) == AFTER and len(source) == 13872, 'source-pin')
    def installed_mode(info):
        require(info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o644
                and info.st_uid == info.st_gid == 1000, 'installed-file-identity')
    installed_mode(info)
    expected = {Path(importlib.util.cache_from_source(str(target), optimization=o)) for o in ('', 1, 2)}
    require(set((target.parent / '__pycache__').glob('native_bridge_common.*.pyc')) == expected, 'pyc-set')
    pycs = []
    for optimization in (0, 1, 2):
        path = Path(importlib.util.cache_from_source(str(target), optimization='' if optimization == 0 else optimization))
        raw, compiled_info = plain(path)
        installed_mode(compiled_info)
        pycs.append(dict(pyc_readback(raw, source, str(target), optimization), bytes=len(raw), mode='0644', uid=1000, gid=1000))
    require(not any(name == 'omnigent' or name.startswith('omnigent.') or name == 'claude_agent_sdk'
                    or name.startswith('claude_agent_sdk.') for name in sys.modules), 'sdk-imported')
    return {'python': platform.python_version(), 'machine': platform.machine(), 'uid': 1000, 'gid': 1000,
            'sourceSha256': AFTER, 'sourceBytes': len(source), 'sourceNlink': info.st_nlink,
            'sourceMode': '0644', 'metadataVersion': '0.16.0', 'pycs': pycs,
            'sdkImported': False, 'network': 'none', 'readOnlyRoot': True}


def snapshot(roots=None):
    """Hash all entries/content/identity in the owned cache and other install.

    Atime is excluded; no symlink target is opened. One deadline/count/byte
    budget applies to both roots. CLI callers cannot choose narrower roots.
    """
    roots = roots if roots is not None else [('cache', STATE / 'uv-cache'), ('other', Path('/qa/warm/tools/omnigent'))]
    deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
    count = total = 0
    result = hashlib.sha256()
    cached_sources = []
    def tick(size=0):
        nonlocal count, total
        count += 1
        total += size
        require(time.monotonic() <= deadline and count <= SNAPSHOT_MAX_TICKS and total <= 8 * 1024**3, 'inventory-budget')
    def visit(scope, path, relative, parent_fd=None):
        tick()
        name = path if parent_fd is None else path.name
        def current():
            return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        before = current()
        record = [scope, digest(os.fsencode(relative)), identity(before)]
        if stat.S_ISDIR(before.st_mode):
            result.update((json.dumps(record, separators=(',', ':')) + '\n').encode())
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            try:
                require(identity(os.fstat(fd)) == identity(before), 'inventory-changed')
                names = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        tick()  # Bound each name before storing or sorting it.
                        names.append(entry.name)
                require(time.monotonic() <= deadline, 'inventory-budget')
                names.sort()
                require(time.monotonic() <= deadline, 'inventory-budget')
                require(identity(os.fstat(fd)) == identity(before), 'inventory-changed')
                for child in names:
                    visit(scope, path / child, relative + '/' + child, fd)
                require(identity(os.fstat(fd)) == identity(before), 'inventory-changed')
            finally:
                os.close(fd)
        elif stat.S_ISLNK(before.st_mode):
            record.append(digest(os.fsencode(os.readlink(name, dir_fd=parent_fd))))
            result.update((json.dumps(record, separators=(',', ':')) + '\n').encode())
        else:
            require(stat.S_ISREG(before.st_mode) and before.st_size <= 512 * 1024**2, 'inventory-file-type-or-bound')
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            hashed = hashlib.sha256()
            size = 0
            try:
                require(identity(os.fstat(fd)) == identity(before), 'inventory-changed')
                while True:
                    data = os.read(fd, 1024 * 1024)
                    if not data:
                        break
                    size += len(data)
                    tick(len(data))
                    hashed.update(data)
                require(size == before.st_size and identity(os.fstat(fd)) == identity(before), 'inventory-changed')
            finally:
                os.close(fd)
            record.append(hashed.hexdigest())
            if scope == 'cache' and path.name == 'native_bridge_common.py':
                cached_sources.append(hashed.hexdigest())
            result.update((json.dumps(record, separators=(',', ':')) + '\n').encode())
        require(identity(current()) == identity(before), 'inventory-changed')
    for scope, root in roots:
        require(root.is_absolute() and stat.S_ISDIR(root.lstat().st_mode), 'inventory-root')
        for parent in root.parents:
            require(stat.S_ISDIR(parent.lstat().st_mode), 'inventory-root-link')
        visit(scope, root, '')
    if roots == [('cache', STATE / 'uv-cache'), ('other', Path('/qa/warm/tools/omnigent'))]:
        require(1 <= len(cached_sources) <= 16 and set(cached_sources) == {BEFORE}, 'cache-common-source')
        require(digest(plain(Path('/qa/warm/tools/omnigent') / COMMON)[0]) == BEFORE, 'other-install-source')
    return {'sha256': result.hexdigest(), 'entriesAndReadChunks': count, 'bytesHashed': total,
            'cachedOriginalCommonFiles': len(cached_sources), 'atimeExcluded': True}


if __name__ == '__main__':
    if sys.argv[1:] == ['snapshot']:
        sandbox()
        value = snapshot()
    else:
        require(len(sys.argv) == 3 and sys.argv[1] == 'readback', 'arguments')
        value = readback(sys.argv[2])
    print(json.dumps(value, sort_keys=True))
