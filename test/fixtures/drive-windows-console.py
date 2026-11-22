"""Drive the real Windows CLI in a native pseudoconsole."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import queue
import subprocess
import sys
import threading
import time
import msvcrt

kernel = c.WinDLL("kernel32", use_last_error=True)

def bind(name, result, *args):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = args
    return function

class Coord(c.Structure):
    _fields_ = [("x", c.c_short), ("y", c.c_short)]

class Startup(c.Structure):
    _fields_ = [
        ("cb", w.DWORD), *[(name, w.LPWSTR) for name in ("reserved", "desktop", "title")],
        *[(name, w.DWORD) for name in ("x", "y", "width", "height", "columns", "rows", "fill", "flags")],
        ("show", w.WORD), ("reserved_size", w.WORD), ("reserved_bytes", c.c_void_p),
        ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE),
    ]

class StartupEx(c.Structure):
    _fields_ = [("startup", Startup), ("attributes", c.c_void_p)]

class Process(c.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]

pipe = bind("CreatePipe", w.BOOL, c.POINTER(w.HANDLE), c.POINTER(w.HANDLE), c.c_void_p, w.DWORD)
pseudo = bind("CreatePseudoConsole", c.c_long, Coord, w.HANDLE, w.HANDLE, w.DWORD, c.POINTER(w.HANDLE))
close_pseudo = bind("ClosePseudoConsole", None, w.HANDLE)
close = bind("CloseHandle", w.BOOL, w.HANDLE)
init = bind("InitializeProcThreadAttributeList", w.BOOL, c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t))
update = bind("UpdateProcThreadAttribute", w.BOOL, c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p)
delete = bind("DeleteProcThreadAttributeList", None, c.c_void_p)
create = bind("CreateProcessW", w.BOOL, w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD,
              c.c_void_p, w.LPCWSTR, c.POINTER(StartupEx), c.POINTER(Process))
wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
status = bind("GetExitCodeProcess", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))
terminate = bind("TerminateProcess", w.BOOL, w.HANDLE, w.UINT)

def checked(ok):
    if not ok:
        raise c.WinError(c.get_last_error())

def make_pipe():
    reader, writer = w.HANDLE(), w.HANDLE()
    checked(pipe(c.byref(reader), c.byref(writer), None, 0))
    return reader, writer

def run(config):
    input_read, input_write = make_pipe()
    output_read, output_write = make_pipe()
    console = w.HANDLE()
    result = pseudo(Coord(180, 50), input_read, output_write, 0, c.byref(console))
    if result != 0:
        raise OSError(f"CreatePseudoConsole failed ({result:#x})")
    size = c.c_size_t()
    init(None, 1, 0, c.byref(size))
    buffer = c.create_string_buffer(size.value)
    checked(init(buffer, 1, 0, c.byref(size)))
    process = Process()
    input_fd = msvcrt.open_osfhandle(input_write.value, os.O_WRONLY | os.O_BINARY)
    output_fd = msvcrt.open_osfhandle(output_read.value, os.O_RDONLY | os.O_BINARY)
    chunks = queue.Queue()

    def drain():
        try:
            while data := os.read(output_fd, 4096):
                chunks.put(data)
        except OSError as error:
            chunks.put(error)
        finally:
            chunks.put(None)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        start = StartupEx()
        start.startup.cb = c.sizeof(start)
        # Null handles with STARTF_USESTDHANDLES let the pseudoconsole replace
        # the redirected standard handles of this CI runner.
        start.startup.flags = 0x100
        start.attributes = c.cast(buffer, c.c_void_p)
        checked(update(buffer, 0, 0x00020016, console, c.sizeof(console), None, None))
        cmdline = c.create_unicode_buffer(subprocess.list2cmdline(config["command"]))
        checked(create(config["command"][0], cmdline, None, None, False, 0x00080000, None,
                       config["cwd"], c.byref(start), c.byref(process)))
        close(input_read)
        close(output_write)
        input_read = output_write = None
        output = bytearray()
        cursor = 0
        for action in config["actions"]:
            if "send" in action:
                os.write(input_fd, action["send"].encode())
                continue
            expected = action["wait"].encode()
            deadline = time.monotonic() + 18
            while (found := output.find(expected, cursor)) < 0:
                if time.monotonic() >= deadline:
                    raise TimeoutError((action, output.decode(errors="replace")))
                try:
                    data = chunks.get(timeout=0.1)
                except queue.Empty:
                    continue
                if data is None:
                    exit_code = w.DWORD()
                    checked(status(process.process, c.byref(exit_code)))
                    raise RuntimeError((action, f"host status {exit_code.value:#x}", output[-1200:].decode(errors="replace")))
                if isinstance(data, OSError):
                    exit_code = w.DWORD()
                    checked(status(process.process, c.byref(exit_code)))
                    raise RuntimeError((action, str(data), f"host status {exit_code.value:#x}", output[-1200:].decode(errors="replace")))
                output.extend(data)
            cursor = found + len(expected)
        if wait(process.process, 15_000) != 0:
            raise TimeoutError(output.decode(errors="replace"))
        exit_code = w.DWORD()
        checked(status(process.process, c.byref(exit_code)))
        return exit_code.value
    finally:
        if input_read:
            close(input_read)
        if output_write:
            close(output_write)
        if process.process:
            if wait(process.process, 0) != 0:
                terminate(process.process, 1)
                wait(process.process, 5000)
            close(process.thread)
            close(process.process)
        delete(buffer)
        os.close(input_fd)
        close_pseudo(console)
        reader.join(3)
        os.close(output_fd)

if __name__ == "__main__":
    sys.exit(run(json.load(sys.stdin)))
