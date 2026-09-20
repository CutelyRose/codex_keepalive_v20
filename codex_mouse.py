"""Mouse input for native Windows consoles and POSIX SGR terminals."""
from __future__ import annotations

from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
import os
import re
import sys
import time


@dataclass(frozen=True)
class Mouse:
    x: int
    y: int
    kind: str = "left"
    clicks: int = 1


_sgr_press = None


def sgr(sequence: str):
    global _sgr_press
    match = re.fullmatch(r"\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])", sequence)
    if not match:
        return "unknown"
    button, x, y = map(int, match.group(1, 2, 3))
    if not 1 <= x <= 65535 or not 1 <= y <= 65535:
        return None
    if button & 4:
        _sgr_press = None
        return None
    if button & 32:
        if _sgr_press and _sgr_press != (x, y):
            _sgr_press = None
        return None
    if button & 64:
        return Mouse(x - 1, y - 1, "wheel-down" if button & 1 else "wheel-up")
    if button & 3 == 0:
        if match[4] == "M":
            _sgr_press = (x, y)
            return Mouse(x - 1, y - 1, "press")
        else:
            pressed, _sgr_press = _sgr_press, None
            if pressed == (x, y):
                return Mouse(x - 1, y - 1)
    return None


class WindowsInput:
    def __init__(self):
        import ctypes
        import msvcrt
        from ctypes import wintypes as w
        self.ctypes, self.w = ctypes, w

        class Coord(ctypes.Structure):
            _fields_ = [("X", w.SHORT), ("Y", w.SHORT)]

        class Key(ctypes.Structure):
            _fields_ = [("down", w.BOOL), ("repeat", w.WORD), ("vk", w.WORD),
                        ("scan", w.WORD), ("char", w.WCHAR), ("control", w.DWORD)]

        class Pointer(ctypes.Structure):
            _fields_ = [("position", Coord), ("buttons", w.DWORD), ("control", w.DWORD),
                        ("flags", w.DWORD)]

        class Event(ctypes.Union):
            _fields_ = [("key", Key), ("mouse", Pointer), ("size", Coord),
                        ("padding", ctypes.c_byte * 16)]

        class Record(ctypes.Structure):
            _fields_ = [("kind", w.WORD), ("event", Event)]

        class Rect(ctypes.Structure):
            _fields_ = [("left", w.SHORT), ("top", w.SHORT), ("right", w.SHORT), ("bottom", w.SHORT)]

        class Buffer(ctypes.Structure):
            _fields_ = [("size", Coord), ("cursor", Coord), ("attributes", w.WORD),
                        ("window", Rect), ("maximum", Coord)]

        self.Record, self.Buffer = Record, Buffer
        self.handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        self.output = msvcrt.get_osfhandle(sys.stdout.fileno())
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.GetConsoleMode.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        self.kernel.SetConsoleMode.argtypes = [w.HANDLE, w.DWORD]
        self.kernel.ReadConsoleInputW.argtypes = [w.HANDLE, ctypes.POINTER(Record), w.DWORD, ctypes.POINTER(w.DWORD)]
        self.kernel.GetNumberOfConsoleInputEvents.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        self.kernel.GetConsoleScreenBufferInfo.argtypes = [w.HANDLE, ctypes.POINTER(Buffer)]
        old = w.DWORD()
        if not self.kernel.GetConsoleMode(self.handle, ctypes.byref(old)):
            raise OSError("终端不支持控制台鼠标输入")
        self.original = old.value
        self.current = (old.value | 0x0080 | 0x0010 | 0x0008) & ~(0x0040 | 0x0002 | 0x0004 | 0x0200)
        self.pending = deque()
        self.previous_buttons = 0
        self.press_position = None
        self.press_clicks = 1

    def enable(self):
        if not self.kernel.SetConsoleMode(self.handle, self.current):
            raise OSError("无法启用终端鼠标输入")

    def disable(self):
        self.kernel.SetConsoleMode(self.handle, self.original)
        self.previous_buttons = 0
        self.press_position = None

    def poll(self, block=True):
        if self.pending:
            return self.pending.popleft()
        c, w = self.ctypes, self.w
        while True:
            count = w.DWORD()
            if not self.kernel.GetNumberOfConsoleInputEvents(self.handle, c.byref(count)):
                raise EOFError
            if not count.value:
                if not block:
                    return None
                time.sleep(.015)
                continue
            item, read = self.Record(), w.DWORD()
            if not self.kernel.ReadConsoleInputW(self.handle, c.byref(item), 1, c.byref(read)):
                raise EOFError
            if item.kind == 1:
                key = item.event.key
                if not key.down:
                    continue
                names = {38: "up", 40: "down", 37: "left", 39: "right", 36: "home",
                         35: "end", 33: "pageup", 34: "pagedown", 9: "tab",
                         13: "enter", 27: "escape", 8: "backspace", 46: "delete"}
                value = names.get(key.vk) or key.char
                if value in ("\x00", ""):
                    continue
                if value == "\x03":
                    raise KeyboardInterrupt
                if value in ("\x04", "\x1a"):
                    raise EOFError
                self.pending.extend([value] * (min(key.repeat, 20) - 1))
                return value
            if item.kind == 4:
                return "resize"
            if item.kind != 2:
                continue
            pointer = item.event.mouse
            buttons = pointer.buttons & 0xFFFF
            before, self.previous_buttons = self.previous_buttons, buttons
            if pointer.control & 0x10:  # SHIFT_PRESSED
                continue
            info = self.Buffer()
            left = top = 0
            if self.kernel.GetConsoleScreenBufferInfo(self.output, c.byref(info)):
                left, top = info.window.left, info.window.top
            x, y = pointer.position.X - left, pointer.position.Y - top
            if pointer.flags == 4:
                delta = (pointer.buttons >> 16) & 0xFFFF
                return Mouse(x, y, "wheel-down" if delta & 0x8000 else "wheel-up")
            if pointer.flags == 2 and buttons & 1:
                self.press_position, self.press_clicks = (x, y), 2
                return Mouse(x, y, "press", 2)
            if pointer.flags == 0 and buttons & 1 and not before & 1:
                self.press_position, self.press_clicks = (x, y), 1
                return Mouse(x, y, "press")
            if pointer.flags == 1 and self.press_position != (x, y):
                self.press_position = None
            if pointer.flags == 0 and not buttons & 1 and before & 1:
                origin, self.press_position = self.press_position, None
                if origin == (x, y):
                    return Mouse(x, y, clicks=self.press_clicks)


_state = None
_depth = 0
_suspended = 0


def windows_reader():
    return _state[1] if _state and _state[1] is not None and not _suspended else None


def active():
    return _state is not None and not _suspended


@contextmanager
def menu_input():
    """Allow clickable choices nested inside a normal line-input form."""
    global _suspended
    if not _state or not _suspended:
        yield
        return
    term, reader = _state
    previous = _suspended
    if reader:
        reader.enable()
    else:
        term.write("\x1b[?1000h\x1b[?1006h")
    _suspended = 0
    try:
        yield
    finally:
        _suspended = previous
        if reader:
            reader.disable()
        else:
            term.write("\x1b[?1000l\x1b[?1006l")


@contextmanager
def mouse_mode(term, enabled=True):
    global _state, _depth
    if not enabled or not term.interactive():
        yield False
        return
    if _state is not None:
        _depth += 1
        try:
            yield True
        finally:
            _depth -= 1
        return
    reader = None
    try:
        if os.name == "nt":
            reader = WindowsInput()
            reader.enable()
        else:
            term.write("\x1b[?1000h\x1b[?1006h")
    except (OSError, ValueError, AttributeError):
        if reader:
            reader.disable()
        yield False
        return
    _state, _depth = (term, reader), 1
    try:
        yield True
    finally:
        try:
            if reader:
                reader.disable()
            else:
                term.write("\x1b[?1000l\x1b[?1006l")
        finally:
            _state, _depth = None, 0


@contextmanager
def suspended():
    global _suspended
    if _state is None:
        yield
        return
    term, reader = _state
    if not _suspended:
        if reader:
            reader.disable()
        else:
            term.write("\x1b[?1000l\x1b[?1006l")
    _suspended += 1
    try:
        yield
    finally:
        _suspended -= 1
        if not _suspended and _state:
            if reader:
                reader.enable()
            else:
                term.write("\x1b[?1000h\x1b[?1006h")
