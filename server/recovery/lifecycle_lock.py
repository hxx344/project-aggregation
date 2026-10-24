"""Local OS lifecycle lock. A lock alone does not prove a service cgroup is empty."""

from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import signal
import stat
import sys
import threading
import time


# The runtime holds its lock exclusively; API processes share theirs; the
# recovery tools take both exclusively (design doc 5.7).
LOCK_FILES = {"runtime": ".runtime.lock", "api": ".api.lock"}
LOCK_MODES = ("exclusive", "shared")


class LifecycleLockError(RuntimeError):
    def __init__(self, code):
        super().__init__(f"Runtime lifecycle control: {code}")
        self.code = code


def _fail(code):
    raise LifecycleLockError(code)


def _windows_security(target, require_protected=False):
    """Reject foreign ownership and ACL grants that let another user replace the lock."""
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p
    advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.GetAce.argtypes = [pointer, wintypes.DWORD, ctypes.POINTER(pointer)]
    advapi.GetSecurityDescriptorControl.argtypes = [pointer, ctypes.POINTER(wintypes.USHORT), ctypes.POINTER(wintypes.DWORD)]
    advapi.GetSecurityDescriptorControl.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.LocalFree.argtypes = [pointer]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def sid_string(sid):
        output = wintypes.LPWSTR()
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(output)):
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        try:
            return output.value
        finally:
            kernel.LocalFree(ctypes.cast(output, pointer))

    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        _fail("UNSAFE_RUNTIME_LOCK_PATH")
    try:
        required = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))
        buffer = ctypes.create_string_buffer(required.value)
        if not advapi.GetTokenInformation(token, 1, buffer, required, ctypes.byref(required)):
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        current_sid = sid_string(ctypes.cast(buffer, ctypes.POINTER(pointer))[0])
    finally:
        kernel.CloseHandle(token)
    owner, dacl, descriptor = pointer(), pointer(), pointer()
    result = advapi.GetNamedSecurityInfoW(str(target), 1, 0x00000005, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if result:
        _fail("UNSAFE_RUNTIME_LOCK_PATH")
    try:
        if require_protected:
            control, revision = wintypes.USHORT(), wintypes.DWORD()
            if not advapi.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)) or not control.value & 0x1000:
                # Directory handles prevent rename, while SE_DACL_PROTECTED
                # prevents a foreign ancestor WRITE_DAC from propagating grants.
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
        trusted = {current_sid, "S-1-5-18", "S-1-5-32-544"}
        if sid_string(owner) not in trusted or not dacl:
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        # ACL header: revision, reserved, size, ace count, reserved.
        count = ctypes.c_ushort.from_address(dacl.value + 4).value
        for index in range(count):
            ace = pointer()
            if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
            ace_type = ctypes.c_ubyte.from_address(ace.value).value
            ace_flags = ctypes.c_ubyte.from_address(ace.value + 1).value
            if ace_flags & 0x08:  # INHERIT_ONLY_ACE does not grant rights on this object.
                continue
            if ace_type in (1, 6):  # Deny ACEs cannot grant mutation rights.
                continue
            mask = ctypes.c_uint32.from_address(ace.value + 4).value
            if not mask & 0x500D0156:  # generic write/all, delete/owner/DACL, file/dir writes.
                continue
            if ace_type != 0 or sid_string(pointer(ace.value + 8)) not in trusted | {"S-1-3-0", "S-1-3-4"}:
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
    finally:
        kernel.LocalFree(descriptor)


def _check_path(data_dir, owner_uid):
    if not isinstance(data_dir, str) or not data_dir or "\0" in data_dir or not os.path.isabs(data_dir) or data_dir.startswith(("\\\\", "//", "\\??\\")):
        _fail("UNSAFE_RUNTIME_LOCK_PATH")
    if os.name == "nt" and ":" in data_dir[2:]:
        _fail("UNSAFE_RUNTIME_LOCK_PATH")
    target = Path(os.path.abspath(data_dir))
    for component in [*reversed(target.parents), target]:
        info = component.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        if os.name != "nt":
            if info.st_uid not in (0, owner_uid) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
    directory = target.stat()
    if os.name == "nt":
        _windows_security(target, require_protected=True)
    elif directory.st_uid != owner_uid or directory.st_mode & 0o077:
        _fail("UNSAFE_RUNTIME_LOCK_PATH")
    return target, (directory.st_dev, directory.st_ino)


class RuntimeLock:
    def __init__(self, data_dir, timeout_ms=5000, expected_owner_uid=None, name="runtime", mode="exclusive"):
        self.descriptor = None
        self.handle = None
        self._directory_handles = []
        self._overlapped = None
        self.closed = False
        try:
            # Only API processes share their lock: a shared runtime lock would let two runtimes run.
            if type(timeout_ms) is not int or not 0 <= timeout_ms <= 60000 or name not in LOCK_FILES or mode not in LOCK_MODES or (name == "runtime" and mode != "exclusive"):
                _fail("INVALID_RUNTIME_LOCK_OPTIONS")
            self.shared = mode == "shared"
            if os.name == "nt":
                if expected_owner_uid is not None:
                    _fail("INVALID_RUNTIME_LOCK_OPTIONS")
                self.owner_uid = None
            else:
                self.owner_uid = os.getuid() if expected_owner_uid is None else expected_owner_uid
                if type(self.owner_uid) is not int or self.owner_uid < 0 or (self.owner_uid != os.getuid() and os.getuid() != 0):
                    _fail("INVALID_RUNTIME_LOCK_OPTIONS")
            self.data_dir, self.directory_identity = _check_path(data_dir, self.owner_uid)
            self.path = self.data_dir / LOCK_FILES[name]
            if os.name == "nt":
                self._open_windows()
            else:
                flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                try:
                    self.descriptor = os.open(str(self.path), flags | os.O_CREAT | os.O_EXCL, 0o600)
                    if os.getuid() == 0 and self.owner_uid != 0:
                        os.fchown(self.descriptor, self.owner_uid, -1)
                except FileExistsError:
                    self.descriptor = os.open(str(self.path), flags)
            self.identity = self._identity()
            self.assert_held(check_locked=False)
            deadline = time.monotonic() + timeout_ms / 1000
            while not self._try_lock():
                if time.monotonic() >= deadline:
                    _fail("RUNTIME_LOCK_BUSY")
                time.sleep(min(0.025, max(0, deadline - time.monotonic())))
            self.assert_held()
        except Exception as error:
            self.close()
            if isinstance(error, LifecycleLockError):
                raise
            _fail("RUNTIME_LOCK_UNAVAILABLE")

    def _open_windows(self):
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self._kernel = kernel
        class FileInformation(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME), ("accessed", wintypes.FILETIME), ("written", wintypes.FILETIME), ("volume", wintypes.DWORD), ("sizeHigh", wintypes.DWORD), ("sizeLow", wintypes.DWORD), ("links", wintypes.DWORD), ("indexHigh", wintypes.DWORD), ("indexLow", wintypes.DWORD)]
        kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInformation)]
        kernel.GetFileInformationByHandle.restype = wintypes.BOOL
        # Ancestors may be shared (for example Windows TEMP). Pin every directory
        # without FILE_SHARE_DELETE so neither it nor DATA_DIR can be renamed out
        # from under the lock, even if a parent ACL grants DELETE_CHILD.
        for directory in [*reversed(self.data_dir.parents), self.data_dir]:
            if directory.parent == directory:
                continue
            held = kernel.CreateFileW(str(directory), 0x00000080, 0x00000003, None, 3, 0x02200000, None)
            if held == wintypes.HANDLE(-1).value:
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
            self._directory_handles.append(held)
            info = FileInformation()
            path_info = directory.lstat()
            if not kernel.GetFileInformationByHandle(held, ctypes.byref(info)) or not info.attributes & 0x10 or info.attributes & 0x400 or ((info.indexHigh << 32) | info.indexLow) != path_info.st_ino:
                _fail("UNSAFE_RUNTIME_LOCK_PATH")
        # Omit FILE_SHARE_DELETE so a held file cannot be replaced or unlinked.
        handle = kernel.CreateFileW(str(self.path), 0xC0000000, 0x00000003, None, 4, 0x00200000, None)
        if handle == wintypes.HANDLE(-1).value:
            _fail("RUNTIME_LOCK_UNAVAILABLE")
        self.handle = handle
        try:
            self.descriptor = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        except Exception:
            kernel.CloseHandle(wintypes.HANDLE(handle))
            self.handle = None
            raise
        class Overlapped(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t), ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
        self._overlapped = Overlapped()
        kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
        kernel.LockFileEx.restype = wintypes.BOOL

    def _try_lock(self):
        if os.name == "nt":
            # LOCKFILE_FAIL_IMMEDIATELY, plus LOCKFILE_EXCLUSIVE_LOCK unless shared.
            if self._kernel.LockFileEx(self.handle, 0x00000001 if self.shared else 0x00000003, 0, 1, 0, ctypes.byref(self._overlapped)):
                return True
            if ctypes.get_last_error() in (33, 158):
                return False
            _fail("RUNTIME_LOCK_UNAVAILABLE")
        import fcntl
        try:
            fcntl.flock(self.descriptor, (fcntl.LOCK_SH if self.shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False

    def _identity(self):
        info = os.fstat(self.descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        if os.name != "nt" and (info.st_uid != self.owner_uid or info.st_mode & 0o077):
            _fail("UNSAFE_RUNTIME_LOCK_PATH")
        return info.st_dev, info.st_ino

    def assert_held(self, check_locked=True):
        if self.closed or self.descriptor is None:
            _fail("RUNTIME_LOCK_LOST")
        directory = self.data_dir.lstat()
        info = self.path.lstat()
        if not stat.S_ISDIR(directory.st_mode) or stat.S_ISLNK(directory.st_mode) or (directory.st_dev, directory.st_ino) != self.directory_identity or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1 or getattr(info, "st_file_attributes", 0) & 0x400 or (info.st_dev, info.st_ino) != self.identity or self._identity() != self.identity:
            _fail("RUNTIME_LOCK_LOST")
        if os.name == "nt":
            _windows_security(self.data_dir, require_protected=True)
            _windows_security(self.path)
        elif directory.st_uid != self.owner_uid or directory.st_mode & 0o077:
            _fail("RUNTIME_LOCK_LOST")
        return True

    def close(self):
        if not self.closed:
            self.closed = True
            if self.descriptor is not None:
                os.close(self.descriptor)  # Closing releases flock / LockFileEx, never unlink.
                self.descriptor = None
            if os.name == "nt":
                for handle in reversed(self._directory_handles):
                    self._kernel.CloseHandle(handle)
                self._directory_handles.clear()


def main():
    lock = None
    # A service stop or Ctrl+C reaches the whole process group: the lock stays
    # until the parent closes stdin (or dies), so it is never freed before the
    # parent has closed its databases.
    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_IGN)
    try:
        # DATA_DIR TIMEOUT_MS [OWNER_UID] [--name=runtime|api] [--mode=exclusive|shared]
        positional = [value for value in sys.argv[1:] if not value.startswith("--")]
        options = {}
        for value in sys.argv[1:]:
            if value.startswith("--"):
                key, separator, choice = value[2:].partition("=")
                if key not in ("name", "mode") or not separator or key in options:
                    _fail("INVALID_RUNTIME_LOCK_OPTIONS")
                options[key] = choice
        if len(positional) not in (2, 3):
            _fail("INVALID_RUNTIME_LOCK_OPTIONS")
        lock = RuntimeLock(positional[0], int(positional[1]), int(positional[2]) if len(positional) == 3 else None, **options)
        print(json.dumps({"ready": True, "schemaVersion": 1}), flush=True)
        ended = threading.Event()

        def read_parent():
            try:
                while sys.stdin.buffer.read(1):
                    pass
            finally:
                ended.set()

        threading.Thread(target=read_parent, daemon=True).start()
        while not ended.wait(0.1):
            lock.assert_held()
        return 0
    except Exception as error:
        code = error.code if isinstance(error, LifecycleLockError) else "RUNTIME_LOCK_UNAVAILABLE"
        print(json.dumps({"code": code}), flush=True)
        return 1
    finally:
        if lock is not None:
            lock.close()


if __name__ == "__main__":
    sys.exit(main())
