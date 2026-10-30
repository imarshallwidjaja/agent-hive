/**
 * Crash-released exclusive locks for Hive state.
 *
 * Ownership is an operating-system lock held on one open file description
 * (`flock` on POSIX) or one file handle (`LockFileEx` on Windows). The kernel
 * releases it when the owning process exits, however it exits, so a crashed
 * host never leaves a lock behind. The anchor file that carries the lock is a
 * stable coordination file: it is never unlinked or replaced, and the pid and
 * timestamp written into it are diagnostics, never proof of ownership.
 *
 * This module owns resource canonicalization, anchor-path derivation, the
 * native backend, and waiting. Callers above it decide what a legacy
 * exclusive-create lock file means for their operation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';

/** Bundles that ship Koffi at an artifact-relative path define this specifier at build time. */
declare const __HIVE_KOFFI_MODULE__: string | undefined;

const NATIVE_LOCK_PROTOCOL = 'hive-native-lock/v1';
const HIVE_DIRECTORY_NAME = '.hive';
const LOCK_ANCHOR_DIRECTORY = '.locks';
const LOCK_ANCHOR_SUFFIX = '.lock';
/** Anchor suffix for resources outside any `.hive` directory; distinct from the legacy `.lock` sibling. */
const SIBLING_ANCHOR_SUFFIX = '.hive-lock';

/** Raised when no native lock backend can run in this process; Hive never falls back to an unsafe lock. */
export class NativeLockUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeLockUnavailableError';
  }
}

export interface LockAnchor {
  /** Canonical absolute path of the locked resource. */
  resourcePath: string;
  /** Stable coordination file that carries the native lock. */
  anchorPath: string;
  /** Path of the exclusive-create lock file that hosts before native locking used. */
  legacyLockPath: string;
}

/**
 * Canonical identity of a lock resource: the real path of its parent directory
 * joined with its own unchanged name. The final component is never followed,
 * because Hive writes a locked file by renaming over that name; a leaf symlink
 * is then replaced by a regular file, and an identity taken from the link's
 * target would change under a live owner.
 */
function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalDirectory(parent), path.basename(absolute));
}

/** Real path of a directory, keeping any missing trailing components as written. */
function canonicalDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...pending.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Derive the one lock anchor for a resource. Resources inside a `.hive`
 * directory anchor under its `.locks` directory, so deleting a task or feature
 * directory never deletes a lock another process may hold. Other resources
 * (such as the global configuration file) anchor beside themselves.
 */
export function resolveLockAnchor(resourcePath: string): LockAnchor {
  const canonical = canonicalPath(resourcePath);
  const segments = canonical.split(path.sep);
  const hiveIndex = segments.lastIndexOf(HIVE_DIRECTORY_NAME, segments.length - 2);
  const legacyLockPath = `${path.resolve(resourcePath)}${LOCK_ANCHOR_SUFFIX}`;
  if (hiveIndex <= 0) {
    return { resourcePath: canonical, anchorPath: `${canonical}${SIBLING_ANCHOR_SUFFIX}`, legacyLockPath };
  }
  const hiveDirectory = segments.slice(0, hiveIndex + 1).join(path.sep) || path.sep;
  const name = createHash('sha256').update(canonical).digest('hex');
  return {
    resourcePath: canonical,
    anchorPath: path.join(hiveDirectory, LOCK_ANCHOR_DIRECTORY, `${name}${LOCK_ANCHOR_SUFFIX}`),
    legacyLockPath,
  };
}

/** The directory that holds lock anchors for one `.hive` directory. */
export function getLockAnchorDirectory(hiveDir: string): string {
  return path.join(hiveDir, LOCK_ANCHOR_DIRECTORY);
}

/** One acquired native lock. `release` is idempotent and throws when the operating system reports a failure. */
export interface NativeLockOwnership {
  readonly anchor: LockAnchor;
  release(): void;
}

interface BackendHandle {
  unlock(): void;
}

interface NativeLockBackend {
  /** Open the anchor and try the exclusive lock once; null while another owner holds it. */
  tryLock(anchorPath: string): BackendHandle | null;
  /** Report whether an existing anchor is locked, without creating it or writing to it. */
  isLocked(anchorPath: string): boolean;
}

type Koffi = typeof import('koffi');

function loadKoffi(): Koffi {
  const specifier = typeof __HIVE_KOFFI_MODULE__ === 'string' ? __HIVE_KOFFI_MODULE__ : 'koffi';
  try {
    return createRequire(import.meta.url)(specifier) as Koffi;
  } catch (error) {
    throw new NativeLockUnavailableError(
      `Hive state locking needs the bundled Koffi native module (${specifier}) for ${process.platform}-${process.arch}, and it could not be loaded: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function posixBackend(koffi: Koffi): NativeLockBackend {
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const LOCK_UN = 8;
  const F_SETFD = 2;
  const FD_CLOEXEC = 1;
  // RTLD_DEFAULT: the C library the runtime already uses, on glibc, musl, macOS and the BSDs alike.
  const libc = koffi.load(null);
  const flock = libc.func('int flock(int fd, int operation)');
  const fcntl = libc.func('int fcntl(int fd, int cmd, ...)');
  const { EWOULDBLOCK, EAGAIN, EINTR } = koffi.os.errno;
  const busy = new Set([EWOULDBLOCK, EAGAIN]);

  const callChecked = (label: string, call: () => number): number => {
    for (;;) {
      const result = call();
      if (result !== -1) return result;
      const errno = koffi.errno();
      if (errno === EINTR) continue;
      const error = new Error(`${label} failed with errno ${errno}`) as NodeJS.ErrnoException;
      error.errno = errno;
      throw error;
    }
  };

  // flock needs no write access, so a probe opens read-only and works on a read-only checkout.
  const openAnchor = (anchorPath: string, create: boolean): number | null => {
    const flags = (create ? fs.constants.O_RDWR | fs.constants.O_CREAT : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0);
    let fd: number;
    try {
      fd = fs.openSync(anchorPath, flags, 0o644);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      callChecked('fcntl(F_SETFD, FD_CLOEXEC)', () => fcntl(fd, F_SETFD, 'int', FD_CLOEXEC));
      if (!fs.fstatSync(fd).isFile()) throw new Error(`Lock anchor ${anchorPath} is not a regular file`);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };

  /** Try once; returns true when locked, false when another description holds it. */
  const tryFlock = (fd: number, anchorPath: string): boolean => {
    for (;;) {
      const result = flock(fd, LOCK_EX | LOCK_NB);
      if (result === 0) return true;
      const errno = koffi.errno();
      if (errno === EINTR) continue;
      if (busy.has(errno)) return false;
      throw new Error(`flock(${anchorPath}) failed with errno ${errno}`);
    }
  };

  return {
    tryLock(anchorPath) {
      const fd = openAnchor(anchorPath, true)!;
      let locked = false;
      try {
        locked = tryFlock(fd, anchorPath);
        if (!locked) {
          fs.closeSync(fd);
          return null;
        }
        // The anchor is never replaced by Hive; a replaced path means this description no longer guards the resource.
        const held = fs.fstatSync(fd);
        const current = fs.lstatSync(anchorPath, { throwIfNoEntry: false });
        if (!current || current.ino !== held.ino || current.dev !== held.dev) {
          throw new Error(`Lock anchor ${anchorPath} was replaced while it was being locked`);
        }
      } catch (error) {
        try {
          if (locked) callChecked(`flock(${anchorPath}, LOCK_UN)`, () => flock(fd, LOCK_UN));
        } finally {
          fs.closeSync(fd);
        }
        throw error;
      }
      return {
        unlock() {
          try {
            callChecked(`flock(${anchorPath}, LOCK_UN)`, () => flock(fd, LOCK_UN));
          } finally {
            fs.closeSync(fd);
          }
        },
      };
    },
    isLocked(anchorPath) {
      const fd = openAnchor(anchorPath, false);
      if (fd === null) return false;
      try {
        if (!tryFlock(fd, anchorPath)) return true;
        callChecked(`flock(${anchorPath}, LOCK_UN)`, () => flock(fd, LOCK_UN));
        return false;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** Exported for tests, which drive it through a stand-in for Koffi; the runtime selects it by platform. */
export function windowsBackend(koffi: Koffi): NativeLockBackend {
  const GENERIC_READ = 0x80000000;
  const GENERIC_WRITE = 0x40000000;
  // Read and write sharing without delete sharing: the anchor cannot be deleted or renamed while any handle is open.
  const FILE_SHARE_READ_WRITE = 0x1 | 0x2;
  const OPEN_EXISTING = 3;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  const FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
  const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
  const ERROR_FILE_NOT_FOUND = 2;
  // A missing parent directory (no `.hive/.locks` yet) reports this instead of ERROR_FILE_NOT_FOUND.
  const ERROR_PATH_NOT_FOUND = 3;
  const ERROR_LOCK_VIOLATION = 33;
  const INVALID_HANDLE_VALUE = -1;
  // Lock one byte far beyond the diagnostic record so other handles can still read and write it.
  const LOCK_OFFSET_HIGH = 0x7fffffff;

  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('HIVE_LOCK_OVERLAPPED', {
    Internal: 'uintptr_t',
    InternalHigh: 'uintptr_t',
    Offset: 'uint32_t',
    OffsetHigh: 'uint32_t',
    hEvent: 'intptr_t',
  });
  koffi.struct('HIVE_LOCK_FILE_INFORMATION', {
    dwFileAttributes: 'uint32_t',
    ftCreationTimeLow: 'uint32_t',
    ftCreationTimeHigh: 'uint32_t',
    ftLastAccessTimeLow: 'uint32_t',
    ftLastAccessTimeHigh: 'uint32_t',
    ftLastWriteTimeLow: 'uint32_t',
    ftLastWriteTimeHigh: 'uint32_t',
    dwVolumeSerialNumber: 'uint32_t',
    nFileSizeHigh: 'uint32_t',
    nFileSizeLow: 'uint32_t',
    nNumberOfLinks: 'uint32_t',
    nFileIndexHigh: 'uint32_t',
    nFileIndexLow: 'uint32_t',
  });
  // A HANDLE is pointer-sized; intptr keeps it a plain number and maps INVALID_HANDLE_VALUE to -1.
  const CreateFileW = kernel32.func('intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t templateFile)');
  const LockFileEx = kernel32.func('bool __stdcall LockFileEx(intptr_t file, uint32_t flags, uint32_t reserved, uint32_t lengthLow, uint32_t lengthHigh, _Inout_ HIVE_LOCK_OVERLAPPED *overlapped)');
  const UnlockFileEx = kernel32.func('bool __stdcall UnlockFileEx(intptr_t file, uint32_t reserved, uint32_t lengthLow, uint32_t lengthHigh, _Inout_ HIVE_LOCK_OVERLAPPED *overlapped)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t handle)');
  const GetFileInformationByHandle = kernel32.func('bool __stdcall GetFileInformationByHandle(intptr_t file, _Out_ HIVE_LOCK_FILE_INFORMATION *information)');
  // Koffi saves the thread's last error after every call and restores it before the next one.
  const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

  const overlapped = () => ({ Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: LOCK_OFFSET_HIGH, hEvent: 0 });
  const fail = (label: string): never => {
    throw new Error(`${label} failed with Windows error ${GetLastError()}`);
  };
  const close = (handle: number, anchorPath: string): void => {
    if (!CloseHandle(handle)) fail(`CloseHandle(${anchorPath})`);
  };

  const openAnchor = (anchorPath: string, create: boolean): number | null => {
    const handle = CreateFileW(
      path.toNamespacedPath(anchorPath),
      create ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ,
      FILE_SHARE_READ_WRITE,
      null,
      create ? OPEN_ALWAYS : OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      0,
    ) as number;
    if (handle === INVALID_HANDLE_VALUE) {
      const error = GetLastError();
      if (!create && (error === ERROR_FILE_NOT_FOUND || error === ERROR_PATH_NOT_FOUND)) return null;
      throw new Error(`CreateFileW(${anchorPath}) failed with Windows error ${error}`);
    }
    try {
      const information: Record<string, number> = {};
      if (!GetFileInformationByHandle(handle, information)) fail(`GetFileInformationByHandle(${anchorPath})`);
      if (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) {
        throw new Error(`Lock anchor ${anchorPath} is not a regular file`);
      }
      return handle;
    } catch (error) {
      close(handle, anchorPath);
      throw error;
    }
  };

  const tryLockHandle = (handle: number, anchorPath: string): boolean => {
    if (LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped())) return true;
    const error = GetLastError();
    if (error === ERROR_LOCK_VIOLATION) return false;
    throw new Error(`LockFileEx(${anchorPath}) failed with Windows error ${error}`);
  };
  const unlockHandle = (handle: number, anchorPath: string): void => {
    try {
      if (!UnlockFileEx(handle, 0, 1, 0, overlapped())) fail(`UnlockFileEx(${anchorPath})`);
    } finally {
      close(handle, anchorPath);
    }
  };

  return {
    tryLock(anchorPath) {
      const handle = openAnchor(anchorPath, true)!;
      let locked: boolean;
      try {
        locked = tryLockHandle(handle, anchorPath);
      } catch (error) {
        close(handle, anchorPath);
        throw error;
      }
      if (!locked) {
        close(handle, anchorPath);
        return null;
      }
      return { unlock: () => unlockHandle(handle, anchorPath) };
    },
    isLocked(anchorPath) {
      const handle = openAnchor(anchorPath, false);
      if (handle === null) return false;
      let locked: boolean;
      try {
        locked = tryLockHandle(handle, anchorPath);
      } catch (error) {
        close(handle, anchorPath);
        throw error;
      }
      if (!locked) {
        close(handle, anchorPath);
        return true;
      }
      unlockHandle(handle, anchorPath);
      return false;
    },
  };
}

let backend: NativeLockBackend | NativeLockUnavailableError | undefined;

function nativeBackend(): NativeLockBackend {
  if (backend === undefined) {
    try {
      const koffi = loadKoffi();
      backend = process.platform === 'win32' ? windowsBackend(koffi) : posixBackend(koffi);
    } catch (error) {
      backend = error instanceof NativeLockUnavailableError
        ? error
        : new NativeLockUnavailableError(`Hive state locking could not initialize its native backend on ${process.platform}-${process.arch}: ${(error as Error).message}`, { cause: error });
    }
  }
  if (backend instanceof NativeLockUnavailableError) throw backend;
  return backend;
}

/**
 * Try the native lock once. A new open file description or handle is used for
 * every attempt, so two acquisitions in one process exclude each other.
 */
export function tryAcquireNativeLock(anchor: LockAnchor): NativeLockOwnership | null {
  const lockBackend = nativeBackend();
  fs.mkdirSync(path.dirname(anchor.anchorPath), { recursive: true });
  const handle = lockBackend.tryLock(anchor.anchorPath);
  if (!handle) return null;
  let released = false;
  return {
    anchor,
    release() {
      if (released) return;
      released = true;
      handle.unlock();
    },
  };
}

/** True when a live process holds the resource's native lock. Creates and writes nothing. */
export function isNativeLockHeld(anchor: LockAnchor): boolean {
  return nativeBackend().isLocked(anchor.anchorPath);
}

interface NativeLockDiagnostic {
  protocol: typeof NATIVE_LOCK_PROTOCOL;
  pid: number;
  acquiredAt: string;
  resource: string;
}

/**
 * Record the current owner in the anchor for diagnostics. The record never
 * proves ownership; once a process holds the native lock, any earlier record
 * is historical.
 */
export function writeNativeLockDiagnostic(ownership: NativeLockOwnership): void {
  const record: NativeLockDiagnostic = {
    protocol: NATIVE_LOCK_PROTOCOL,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    resource: ownership.anchor.resourcePath,
  };
  // A separate descriptor: closing it does not release a flock or LockFileEx lock held by another one.
  const fd = fs.openSync(ownership.anchor.anchorPath, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(record), 0);
  } finally {
    fs.closeSync(fd);
  }
}

export function describeNativeLockHolder(anchor: LockAnchor): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(anchor.anchorPath, 'utf8')) as Partial<NativeLockDiagnostic>;
    const details = [];
    if (typeof parsed.pid === 'number') details.push(`recorded holder pid ${parsed.pid}`);
    if (typeof parsed.acquiredAt === 'string') details.push(`acquired ${parsed.acquiredAt}`);
    return details.length > 0 ? `; ${details.join(', ')}` : '';
  } catch {
    return '';
  }
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Block the calling thread without spinning. */
export function sleepSync(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(waitCell, 0, 0, milliseconds);
}
