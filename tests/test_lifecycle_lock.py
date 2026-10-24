import ctypes
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "recovery"))
from lifecycle_lock import RuntimeLock, LifecycleLockError, _windows_security


def secure_directory(target, unsafe=False):
    if os.name != "nt":
        os.chmod(target, 0o777 if unsafe else 0o700)
        return
    acl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)"
    if unsafe:
        acl += "(A;OICI;FA;;;WD)"
    windows_acl(target, acl)


def windows_acl(target, acl, propagate=False):
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    descriptor = ctypes.c_void_p()
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    advapi.SetNamedSecurityInfoW.restype = wintypes.DWORD
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(acl, 1, ctypes.byref(descriptor), None):
        raise OSError("fixture ACL conversion failed")
    try:
        if propagate:
            present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
            if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present:
                raise OSError("fixture ACL extraction failed")
            if advapi.SetNamedSecurityInfoW(str(target), 1, 0x80000004, None, None, dacl, None):
                raise OSError("fixture inheritable ACL setting failed")
        elif not advapi.SetFileSecurityW(str(target), 0x80000004, descriptor):
            raise OSError("fixture ACL setting failed")
    finally:
        kernel.LocalFree(descriptor)


class RuntimeLockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="runtime-lock-py-")
        self.path = Path(self.directory.name)
        secure_directory(self.path)
        self.locks = []

    def tearDown(self):
        for lock in self.locks:
            lock.close()
        self.directory.cleanup()

    def lock(self, timeout_ms=25, **options):
        lock = RuntimeLock(str(self.path), timeout_ms, **options)
        self.locks.append(lock)
        return lock

    def error(self, expected, action):
        with self.assertRaises(LifecycleLockError) as context:
            action()
        self.assertEqual(context.exception.code, expected)

    def test_exclusive_os_lock_and_reuse_without_unlink(self):
        first = self.lock()
        self.assertTrue(first.assert_held())
        info = (self.path / ".runtime.lock").stat()
        self.error("RUNTIME_LOCK_BUSY", self.lock)
        first.close()
        second = self.lock()
        self.assertEqual(second.identity, (info.st_dev, info.st_ino))
        self.error("RUNTIME_LOCK_LOST", first.assert_held)

    def test_api_lock_is_shared_and_separate_from_the_runtime_lock(self):
        runtime = self.lock()
        first = self.lock(name="api", mode="shared")
        second = self.lock(name="api", mode="shared")
        self.assertTrue(first.assert_held() and second.assert_held())
        self.assertNotEqual(first.identity, runtime.identity)
        self.assertEqual(first.identity, second.identity)
        # Recovery takes the API lock exclusively: any live API refuses it.
        self.error("RUNTIME_LOCK_BUSY", lambda: self.lock(name="api"))
        first.close()
        self.error("RUNTIME_LOCK_BUSY", lambda: self.lock(name="api"))
        second.close()
        exclusive = self.lock(name="api")
        self.error("RUNTIME_LOCK_BUSY", lambda: self.lock(name="api", mode="shared"))
        exclusive.close()
        self.assertTrue(self.lock(name="api", mode="shared").assert_held())

    def test_lock_name_and_mode_are_closed_sets(self):
        for options in ({"name": "../hub"}, {"name": "instance"}, {"mode": "read"}, {"mode": "shared"}, {"name": "runtime", "mode": "shared"}):
            self.error("INVALID_RUNTIME_LOCK_OPTIONS", lambda: self.lock(**options))
        helper = Path(__file__).resolve().parents[1] / "server" / "recovery" / "lifecycle_lock.py"
        for extra in (["--name=other"], ["--mode"], ["--name=api", "--name=api"], ["--path=x"], ["--mode=shared"], ["--name=runtime", "--mode=shared"]):
            result = subprocess.run([sys.executable, "-I", str(helper), str(self.path), "25", *extra], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("INVALID_RUNTIME_LOCK_OPTIONS", result.stdout)

    def test_cross_process_lock_releases_after_parent_pipe_eof(self):
        helper = Path(__file__).resolve().parents[1] / "server" / "recovery" / "lifecycle_lock.py"
        child = subprocess.Popen([sys.executable, "-I", str(helper), str(self.path), "100"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn('"ready": true', child.stdout.readline())
            self.error("RUNTIME_LOCK_BUSY", self.lock)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=3), 0)
            self.assertTrue(self.lock().assert_held())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()

    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_helper_keeps_the_lock_through_a_service_stop_signal(self):
        helper = Path(__file__).resolve().parents[1] / "server" / "recovery" / "lifecycle_lock.py"
        child = subprocess.Popen([sys.executable, "-I", str(helper), str(self.path), "100"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn('"ready": true', child.stdout.readline())
            for signal_number in (signal.SIGTERM, signal.SIGINT):
                child.send_signal(signal_number)
            time.sleep(0.3)
            self.assertIsNone(child.poll())
            self.error("RUNTIME_LOCK_BUSY", self.lock)
            child.stdin.close()
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()

    def test_untrusted_permissions_and_hardlinked_lock_reject(self):
        secure_directory(self.path, unsafe=True)
        self.error("UNSAFE_RUNTIME_LOCK_PATH", self.lock)
        secure_directory(self.path)
        original = self.path / "original"
        original.touch(mode=0o600)
        os.link(original, self.path / ".runtime.lock")
        self.error("UNSAFE_RUNTIME_LOCK_PATH", self.lock)

    @unittest.skipUnless(os.name == "nt", "Windows ancestor handles use native directory sharing semantics")
    def test_writable_ancestor_cannot_replace_any_pinned_directory_or_lock(self):
        parent = self.path / "public-parent"
        parent.mkdir()
        secure_directory(parent, unsafe=True)
        child = parent / "protected-data"
        child.mkdir()
        secure_directory(child)
        lock = RuntimeLock(str(child), 100)
        self.locks.append(lock)
        for source in (parent, child, child / ".runtime.lock"):
            with self.assertRaises(PermissionError):
                source.rename(source.with_name(source.name + "-replaced"))
            self.assertTrue(lock.assert_held())
        lock.close()
        moved = parent.with_name(parent.name + "-released")
        parent.rename(moved)
        moved.rename(parent)

    @unittest.skipUnless(os.name == "nt", "Windows DACL protection and ACL inheritance use native APIs")
    def test_unprotected_data_dir_rejects_before_parent_acl_can_propagate(self):
        parent = self.path / "foreign-acl-parent"
        parent.mkdir()
        trusted = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)"
        windows_acl(parent, trusted + "(A;;FA;;;WD)")
        unprotected = parent / "inherited-safe-data"
        unprotected.mkdir()
        _windows_security(unprotected)  # Its current effective ACL is safe.
        self.error("UNSAFE_RUNTIME_LOCK_PATH", lambda: RuntimeLock(str(unprotected), 100))
        self.assertFalse((unprotected / ".runtime.lock").exists())
        protected = parent / "protected-data"
        protected.mkdir()
        secure_directory(protected)
        lock = RuntimeLock(str(protected), 100)
        self.locks.append(lock)
        windows_acl(parent, trusted + "(A;OICI;FA;;;WD)", propagate=True)
        self.error("UNSAFE_RUNTIME_LOCK_PATH", lambda: _windows_security(unprotected))
        self.assertTrue(lock.assert_held())

    def test_special_file_and_symlink_reject(self):
        (self.path / ".runtime.lock").mkdir()
        self.error("RUNTIME_LOCK_UNAVAILABLE", self.lock)
        (self.path / ".runtime.lock").rmdir()
        target = self.path / "other"
        target.touch(mode=0o600)
        try:
            (self.path / ".runtime.lock").symlink_to(target)
        except OSError:
            self.skipTest("Native Windows symlink creation privilege unavailable")
        self.error("UNSAFE_RUNTIME_LOCK_PATH" if os.name == "nt" else "RUNTIME_LOCK_UNAVAILABLE", self.lock)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("--secure-dir", "--unsafe-dir"):
        secure_directory(sys.argv[2], unsafe=sys.argv[1] == "--unsafe-dir")
    else:
        unittest.main()
