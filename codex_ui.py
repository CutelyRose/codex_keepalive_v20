"""Keyboard menus and a bounded terminal dashboard; standard library only."""

from __future__ import annotations

from collections import deque
from contextlib import contextmanager
import math
import os
import re
import shutil
import sys
import time
import unicodedata
import codex_mouse as mouse
from codex_mouse import Mouse


ESC = "\x1b["
RESET = ESC + "0m"
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
PALETTE = {"accent": "96", "muted": "90", "success": "92", "warning": "93",
           "error": "91", "title": "1", "selected": "7"}
IS_WINDOWS = os.name == "nt"
_keyboard_stack = []


def clean(value, *, multiline=False):
    text = ANSI.sub("", str(value))
    return "".join("\n" if char == "\n" and multiline else
                   " " if unicodedata.category(char).startswith("C") else char for char in text)


def cell_width(char):
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


def width(text):
    return sum(cell_width(char) for char in ANSI.sub("", text))


def clip(text, columns):
    """Clip colored text by terminal cells, not Unicode code point count."""
    columns = max(0, columns)
    if width(text) <= columns:
        return text
    if not columns:
        return ""
    parts, used, position = [], 0, 0
    while position < len(text):
        escape = ANSI.match(text, position)
        if escape:
            parts.append(escape.group())
            position = escape.end()
            continue
        char = text[position]
        if used + cell_width(char) > columns - 1:
            break
        parts.append(char)
        used += cell_width(char)
        position += 1
    return "".join(parts) + "…" + (RESET if "\x1b" in text else "")


def fit(text, columns):
    value = clip(text, columns)
    return value + " " * max(0, columns - width(value))


def wrap(text, columns):
    lines = []
    for paragraph in clean(text, multiline=True).split("\n"):
        current, used = [], 0
        for char in paragraph:
            size = cell_width(char)
            if current and used + size > max(1, columns):
                lines.append("".join(current))
                current, used = [], 0
            current.append(char)
            used += size
        lines.append("".join(current))
    return lines


class Terminal:
    def __init__(self, stream=None, color="auto"):
        self._stream = stream
        self.color_mode = color
        self._vt_handles = set()
        self.screen_open = False

    @property
    def stream(self):
        return self._stream if self._stream is not None else sys.stdout

    def ansi_available(self):
        try:
            if not self.stream.isatty() or not os.isatty(self.stream.fileno()):
                return False
            if not IS_WINDOWS:
                return os.getenv("TERM") != "dumb"
            import ctypes
            import msvcrt
            from ctypes import wintypes
            handle = msvcrt.get_osfhandle(self.stream.fileno())
            if handle in self._vt_handles:
                return True
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            mode = wintypes.DWORD()
            if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
                return False
            if not kernel.SetConsoleMode(handle, mode.value | 0x0004):
                return False
            self._vt_handles.add(handle)
            return True
        except (OSError, ValueError, AttributeError):
            return False

    def interactive(self):
        try:
            return self.ansi_available() and sys.stdin.isatty() and os.isatty(sys.stdin.fileno())
        except (OSError, ValueError, AttributeError):
            return False

    def style(self, text, tone):
        enabled = self.color_mode == "always" or (
            self.color_mode == "auto" and "NO_COLOR" not in os.environ and self.ansi_available())
        return ESC + PALETTE[tone] + "m" + text + RESET if enabled else text

    def size(self):
        size = shutil.get_terminal_size((90, 26))
        return max(12, size.columns - 1), max(6, size.lines - 1)

    def write(self, text):
        self.stream.write(text)
        self.stream.flush()

    def clear(self):
        self.write(ESC + "2J" + ESC + "H")

    def paint(self, lines):
        columns, rows = self.size()
        shown = [clip(line, columns) for line in lines[:rows]]
        self.write(ESC + "H" + "\r\n".join(ESC + "2K" + line for line in shown) + ESC + "J")


terminal = Terminal()


@contextmanager
def keyboard_mode():
    if IS_WINDOWS:
        yield
        return
    try:
        descriptor = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        descriptor = None
    if descriptor is None or not os.isatty(descriptor):
        yield
        return
    import termios
    import tty
    saved = termios.tcgetattr(descriptor)
    _keyboard_stack.append((descriptor, saved))
    try:
        # TCSAFLUSH would discard keys already received from an SSH terminal.
        tty.setcbreak(descriptor, termios.TCSANOW)
        yield
    finally:
        _keyboard_stack.pop()
        try:
            termios.tcsetattr(descriptor, termios.TCSANOW, saved)
        except (OSError, termios.error):
            pass  # The terminal may have closed during shutdown.


@contextmanager
def _cooked_keyboard_mode():
    """Temporarily restore line editing for input()/getpass inside a running UI."""
    if not _keyboard_stack:
        yield
        return
    import termios
    descriptor, original = _keyboard_stack[0]
    current = termios.tcgetattr(descriptor)
    try:
        termios.tcsetattr(descriptor, termios.TCSANOW, original)
        yield
    finally:
        try:
            termios.tcsetattr(descriptor, termios.TCSANOW, current)
        except (OSError, termios.error):
            pass


@contextmanager
def cooked_keyboard_mode():
    with mouse.suspended(), _cooked_keyboard_mode():
        yield


mouse_mode = mouse.mouse_mode


def _posix_key(*, block):
    import select

    descriptor = sys.stdin.fileno()

    def read_byte(timeout):
        if not select.select([descriptor], [], [], timeout)[0]:
            return None
        return os.read(descriptor, 1)

    # Raw descriptor reads avoid TextIOWrapper buffering half of an escape sequence.
    char = read_byte(None if block else 0)
    if char is None:
        return None
    if char == b"\x1b":
        following = read_byte(0.06)
        if not following:
            return "escape"
        sequence = following
        if following not in (b"[", b"O"):
            return "unknown"
        while len(sequence) < 64:
            following = read_byte(0.06)
            if not following:
                break
            sequence += following
            if b"@" <= following <= b"~":
                break
        sequence = sequence.decode("ascii", errors="replace")
        if sequence.startswith("[<"):
            return mouse.sgr(sequence)
        keys = {"[A": "up", "[B": "down", "[H": "home", "[F": "end",
                "OA": "up", "OB": "down", "OH": "home", "OF": "end",
                "[1~": "home", "[4~": "end", "[7~": "home", "[8~": "end",
                "[5~": "pageup", "[6~": "pagedown"}
        modified = re.fullmatch(r"\[1;[2-8]([ABHF])", sequence)
        if modified:
            sequence = "[" + modified[1]
        return keys.get(sequence, "unknown")
    if char and char[0] >= 0xC2:
        length = 2 if char[0] < 0xE0 else 3 if char[0] < 0xF0 else 4 if char[0] < 0xF5 else 1
        for _ in range(length - 1):
            following = read_byte(0.06)
            if not following:
                break
            char += following
    return char.decode("utf-8", errors="replace")


def read_key(*, block=True):
    if IS_WINDOWS:
        native = mouse.windows_reader()
        if native is not None:
            return native.poll(block)
        import msvcrt
        if not block and not msvcrt.kbhit():
            return None
        char = msvcrt.getwch()
        if char in ("\x00", "\xe0"):
            return {"H": "up", "P": "down", "G": "home", "O": "end",
                    "I": "pageup", "Q": "pagedown"}.get(msvcrt.getwch(), "unknown")
        if char == "\x1b" and msvcrt.kbhit():
            following = msvcrt.getwch()
            if following in ("[", "O") and msvcrt.kbhit():
                return {"A": "up", "B": "down", "H": "home", "F": "end"}.get(msvcrt.getwch(), "unknown")
            msvcrt.ungetwch(following)
    else:
        with keyboard_mode():
            char = _posix_key(block=block)
        if char is None:
            return None
    if isinstance(char, Mouse):
        return char
    if char in ("\x03",):
        raise KeyboardInterrupt
    if char in ("", "\x04", "\x1a"):
        raise EOFError
    return {"\r": "enter", "\n": "enter", "\t": "tab", "\x1b": "escape", "\b": "backspace",
            "\x7f": "backspace"}.get(char, char)


def choose(title, options, *, default=None, cancel=None, blank=None, aliases=None, subtitle="", term=None, key_reader=None):
    """Options are (stable key, label[, detail]); numbered input remains available."""
    term = term or terminal
    options = [(str(item[0]), clean(item[1]), clean(item[2]) if len(item) > 2 else "") for item in options]
    if not options:
        return cancel
    keys = [item[0] for item in options]
    aliases = aliases or {}
    if not term.interactive():
        print(title)
        if subtitle:
            print(clean(subtitle))
        for key, label, detail in options:
            print(f"  {key}. {label}" + (f" | {detail}" if detail else ""))
        while True:
            answer = input("选择选项，回车使用默认值：").strip()
            if not answer:
                answer = blank if blank is not None else default
                if answer is None:
                    answer = cancel
            answer = aliases.get(answer, aliases.get(answer.lower(), answer) if isinstance(answer, str) else answer)
            if cancel is not None and answer == "q" and "q" not in keys:
                return cancel
            if answer in keys or (cancel is not None and answer == cancel):
                return answer
            print("请选择列表中的编号或名称。")
    reader = key_reader or read_key
    owns_screen = not term.screen_open
    if owns_screen:
        term.write(ESC + "?1049h")
        term.screen_open = True
    term.write(ESC + "?25l")
    try:
        with keyboard_mode(), mouse.menu_input():
            return _choose_interactive(title, options, default, cancel, subtitle, term, reader)
    finally:
        term.write(RESET + ESC + "?25h")
        if owns_screen:
            term.write(ESC + "?1049l")
            term.screen_open = False
        else:
            term.clear()


def _choose_interactive(title, options, default, cancel, subtitle, term, reader):
    keys = [item[0] for item in options]
    selected = keys.index(default) if default in keys else 0
    query = ""
    while True:
        columns, rows = term.size()
        visible = [index for index, option in enumerate(options)
                   if not query or query.casefold() in (option[0] + " " + option[1]).casefold()]
        exact = next((index for index in visible if options[index][0] == query), None)
        if selected not in visible and visible:
            selected = exact if exact is not None else visible[0]
        page_size = max(1, rows - 8)
        position = visible.index(selected) if selected in visible else 0
        start = max(0, min(position - page_size // 2, len(visible) - page_size))
        page = visible[start:start + page_size]
        lines = [term.style("  " + clean(title), "title"), "  " + clip(clean(subtitle), columns - 2), ""]
        for index in page:
            key, label, _ = options[index]
            line = fit(f" {'›' if index == selected else ' '} {key}. {label}", columns)
            lines.append(term.style(line, "selected") if index == selected else line)
        if not page:
            lines.append("  没有匹配项，请按 Backspace 修改搜索。")
        detail = options[selected][2] if selected in visible else ""
        lines += ["", term.style("  " + clip(detail, columns - 2), "muted"),
                  term.style(f"  ↑↓ 移动  Enter 确认  Esc 返回  ·  {position + 1 if visible else 0}/{len(visible)}", "accent"),
                  "  查找：" + clean(query) if query else term.style("  可输入编号或文字快速查找", "muted")]
        term.paint(lines)
        key = reader()
        if isinstance(key, Mouse):
            if key.kind == "left" and 3 <= key.y < 3 + len(page):
                return options[page[key.y - 3]][0]
            if key.kind in ("wheel-up", "wheel-down") and visible:
                position = max(0, min(len(visible) - 1, position + (-3 if key.kind == "wheel-up" else 3)))
                selected = visible[position]
            continue
        if key == "escape":
            if cancel is None:
                raise KeyboardInterrupt
            return cancel
        if key == "enter" and selected in visible:
            return options[selected][0]
        if key in ("up", "down", "home", "end", "pageup", "pagedown") and visible:
            if key == "home":
                position = 0
            elif key == "end":
                position = len(visible) - 1
            else:
                delta = {"up": -1, "down": 1, "pageup": -page_size, "pagedown": page_size}[key]
                position = (position + delta) % len(visible)
            selected = visible[position]
        elif key == "backspace":
            query = query[:-1]
        elif isinstance(key, str) and len(key) == 1 and key.isprintable():
            query += key
            selected = next((index for index, item in enumerate(options) if item[0] == query), -1)


def status_label(status, error="", *, term=None):
    term = term or terminal
    if status is not None:
        label = f"HTTP {status}"
        tone = "success" if status == 200 else "error" if status >= 500 else "warning"
    elif "用户停止" in error:
        label, tone = "已结束", "muted"
    else:
        label = "超时" if any(word in error.lower() for word in ("超时", "时限", "timed out", "timeout")) else "错误"
        tone = "error"
    return term.style(label, tone)


def keepalive_label(minimum, maximum):
    return f"{minimum:g}–{maximum:g}s 随机" if minimum != maximum else f"{minimum:g}s"


def short_result(answer="", error=""):
    if error:
        if "max_output_tokens" in error or "输出 token 上限" in error or "token 上限" in error:
            return "输出达上限（点开查看）"
        if "未收到完成事件" in error or "incomplete" in error:
            return "响应未完成（点开查看）"
        if any(word in error.lower() for word in ("timed out", "timeout", "超时", "总时限")):
            return "请求超时"
        return clean(error).split("；")[0]
    return clean(answer or "暂无文字回答")


def strip_mouse_reports(value):
    # A fast double-click/SSH packet may contain trailing mouse reports when a
    # menu transitions to cooked input. They must never become a field value.
    return re.sub(r"\x1b\[<\d{1,5};\d{1,5};\d{1,5}[Mm]", "", value)


def edit_fields(title, fields, values, *, subtitle="", validate=None):
    """Clickable field list with normal line input; return an atomic draft."""
    import copy
    import getpass
    draft = copy.deepcopy(values)
    current = "1"
    while True:
        options = []
        for number, field in enumerate(fields, 1):
            key, label = field["key"], field["label"]
            value = draft.get(key, "")
            if field.get("kind") == "password":
                shown = "已保存（留空保留）" if value else "未填写"
            elif field.get("choices"):
                shown = next((label for candidate, label in field["choices"] if candidate == value), str(value))
            elif isinstance(value, float):
                shown = f"{value:g}"
            else:
                shown = str(value if value is not None else "")
            options.append((str(number), fit(label, 22) + "  " + shown,
                            field.get("hint", "点击或 Enter 编辑；输入时回车保留当前值")))
        options += [("save", "保存修改", "完成所有字段后统一保存"),
                    ("cancel", "取消", "放弃本次编辑")]
        try:
            choice = choose(title, options, default=current, cancel="cancel", blank="cancel", subtitle=subtitle)
            if choice == "cancel":
                return None
            if choice == "save":
                try:
                    if validate:
                        validate(draft)
                    return draft
                except (ValueError, TypeError) as exc:
                    view_text("请检查设置", str(exc))
                    continue
            current = choice
            field = fields[int(choice) - 1]
            key = field["key"]
            if field.get("choices"):
                choices = field["choices"]
                selected = choose(field["label"], [(str(i), label) for i, (_, label) in enumerate(choices, 1)],
                                  default=str(next((i for i, (value, _) in enumerate(choices, 1)
                                                    if value == draft.get(key)), 1)), cancel="0")
                if selected != "0":
                    draft[key] = choices[int(selected) - 1][0]
                continue
            with cooked_keyboard_mode():
                print("\n" + clean(field["label"]) + "（回车保留当前值）")
                value = strip_mouse_reports(
                    getpass.getpass("> ") if field.get("kind") == "password" else input("> ")).strip()
            if value:
                try:
                    if field.get("kind") in ("number", "integer"):
                        number = float(value)
                        if not math.isfinite(number) or number <= 0 or (field["kind"] == "integer" and number != int(number)):
                            raise ValueError
                        draft[key] = int(number) if field["kind"] == "integer" else number
                    else:
                        draft[key] = value
                except ValueError:
                    view_text("请输入有效值", "请输入大于 0 的有限数值；整数字段不能输入小数。")
        except (KeyboardInterrupt, EOFError) as exc:
            if getattr(exc, "signal_number", None):
                raise
            return None


def copy_text(value, *, term=None):
    """Copy only explicitly selected, already-redacted text."""
    import base64
    import subprocess
    term = term or terminal
    value = clean(value, multiline=True)
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes as w
        kernel, user = ctypes.WinDLL("kernel32"), ctypes.WinDLL("user32")
        kernel.GlobalAlloc.argtypes = [w.UINT, ctypes.c_size_t]
        kernel.GlobalAlloc.restype = w.HGLOBAL
        kernel.GlobalLock.argtypes, kernel.GlobalLock.restype = [w.HGLOBAL], ctypes.c_void_p
        kernel.GlobalUnlock.argtypes = [w.HGLOBAL]
        kernel.GlobalFree.argtypes = [w.HGLOBAL]
        user.OpenClipboard.argtypes, user.OpenClipboard.restype = [w.HWND], w.BOOL
        user.SetClipboardData.argtypes, user.SetClipboardData.restype = [w.UINT, w.HANDLE], w.HANDLE
        encoded = (value + "\0").encode("utf-16le")
        handle = kernel.GlobalAlloc(0x0042, len(encoded))
        if not handle:
            raise OSError("无法分配剪贴板内存")
        owned = True
        try:
            pointer = kernel.GlobalLock(handle)
            if not pointer:
                raise OSError("无法锁定剪贴板内存")
            ctypes.memmove(pointer, encoded, len(encoded))
            kernel.GlobalUnlock(handle)
            if not user.OpenClipboard(None):
                raise OSError("剪贴板正被其他程序使用")
            try:
                user.EmptyClipboard()
                if not user.SetClipboardData(13, handle):
                    raise OSError("无法写入剪贴板")
                owned = False
            finally:
                user.CloseClipboard()
        finally:
            if owned:
                kernel.GlobalFree(handle)
        return "已复制"
    if sys.platform == "darwin" and not os.getenv("SSH_CONNECTION"):
        subprocess.run(["/usr/bin/pbcopy"], input=value.encode("utf-8"), check=True, timeout=3)
        return "已复制"
    encoded = base64.b64encode(value[:24000].encode("utf-8")).decode("ascii")
    term.write("\x1b]52;c;" + encoded + "\x07")
    return "已发送复制请求（终端需支持 OSC 52）"


def result_phase(record):
    # Stored phase describes dispatch; the visible column describes the result.
    return "保活" if record.get("http_status") == 200 else "探活"


def record_line(record, columns, *, term=None):
    term = term or terminal
    timestamp = str(record.get("started_at", ""))[11:19]
    phase = result_phase(record)
    summary = clean(record.get("error") or record.get("answer") or "暂无文字结果")
    status = status_label(record.get("http_status"), record.get("error", ""), term=term)
    number = f"#{record['request_id']:06d}"
    if columns < 65:
        return clip(fit(number, 9) + fit(status, 10) + clip(summary, max(0, columns - 19)), columns)
    cells = [(number, 8), (timestamp, 10), (phase, 6), (status, 12),
             (f"{record.get('duration_seconds', 0):.2f}s", 8)]
    return "".join(fit(value, size) for value, size in cells) + clip(summary, max(0, columns - 44))


def view_text(title, text, *, term=None, key_reader=None, actions=None):
    term = term or terminal
    if not term.interactive():
        print(clean(title))
        print(clean(text, multiline=True))
        return
    offset = 0
    reader = key_reader or read_key
    owns_screen = not term.screen_open
    if owns_screen:
        term.write(ESC + "?1049h")
        term.screen_open = True
    term.write(ESC + "?25l")
    try:
        while True:
            columns, rows = term.size()
            body = wrap(text, columns - 2)
            page = max(1, rows - 4)
            offset = min(offset, max(0, len(body) - page))
            lines = [term.style("  " + clean(title), "title"), ""]
            lines += ["  " + line for line in body[offset:offset + page]]
            lines += ["", term.style("  ↑↓ 滚动  PgUp/PgDn 翻页  Enter / Esc 返回", "accent")]
            action_hits = []
            if actions:
                footer, column = [], 2
                for key, label in actions:
                    button = "[" + label + "] "
                    action_hits.append((column, column + width(button), key))
                    footer.append(button)
                    column += width(button)
                lines[-1] = "  " + "".join(footer)
            term.paint(lines)
            key = reader()
            if isinstance(key, Mouse):
                if key.kind in ("wheel-up", "wheel-down"):
                    offset = max(0, min(max(0, len(body) - page), offset + (-3 if key.kind == "wheel-up" else 3)))
                elif key.kind == "left" and key.y >= len(lines) - 1:
                    if actions:
                        chosen = next((value for start, end, value in action_hits if start <= key.x < end), None)
                        if chosen:
                            return chosen
                    return
                continue
            if actions and key in [item[0] for item in actions]:
                return key
            if key in ("enter", "escape", "q"):
                return
            offset = max(0, min(max(0, len(body) - page), offset + {
                "up": -1, "down": 1, "pageup": -page, "pagedown": page,
                "home": -len(body), "end": len(body)}.get(key, 0)))
    finally:
        term.write(RESET + ESC + "?25h")
        if owns_screen:
            term.write(ESC + "?1049l")
            term.screen_open = False
        else:
            term.clear()


def record_details(record):
    tools = record.get("tool_calls") or []
    details = (f"任务：{record.get('task_label', '')} {record.get('task_name') or record.get('api_name', '')}\n"
            f"记录 ID：{record.get('record_id', '本次运行')}  |  请求 #{record['request_id']:06d}\n"
            f"时间：{record.get('started_at', '')}\nAPI：{record.get('api_name', '')}\n"
            f"方式：{result_phase(record)}  |  状态：{record.get('http_status') or '错误/超时/已结束'}\n"
            f"会话 ID：{record.get('session_id') or '未记录'}\n"
            f"用时：{record.get('duration_seconds', 0):g} 秒\n\n"
            f"问题\n{record.get('prompt', '')}\n\n回答\n{record.get('answer') or '无'}\n\n"
            f"提示\n{record.get('error') or '无'}")
    if tools:
        details += f"\n\n工具调用：{len(tools)} 次 | HTTP 请求：{record.get('http_requests', 1)} 次\n"
        details += "\n".join(f"{call.get('qualified_name') or call.get('name', '')}\n"
                              f"参数：{call.get('arguments', '')}\n结果：{call.get('output', '')}" for call in tools)
    return details


def browse_records(records, title="调用记录", *, term=None):
    term = term or terminal
    if not records:
        view_text(title, "暂无请求记录。", term=term)
        return
    while True:
        options = [(str(index), clean(record_line(record, 110, term=term)),
                    f"会话 ID：{record.get('session_id', '未记录')}")
                   for index, record in enumerate(reversed(records), 1)]
        choice = choose(title, options, default="1", cancel="0", subtitle="选择一条查看完整问题、结果和会话 ID", term=term)
        if choice == "0":
            return
        record = records[-int(choice)]
        view_text(title + "详情", record_details(record), term=term)


class Dashboard:
    def __init__(self, version, *, term=None):
        self.term = term or terminal
        self.version = version
        self.records = deque(maxlen=100)
        self.total = self.successes = 0
        self.started = time.monotonic()
        self.message = "按 Enter 打开操作菜单。"
        self.last_frame = None
        self.state = {}

    def __enter__(self):
        self.term.write(ESC + "?1049h" + ESC + "?25l")
        self.term.screen_open = True
        self.term.clear()
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.term.write(RESET + ESC + "?25h" + ESC + "?1049l")
        self.term.screen_open = False
        if exc_type is None:
            print(f"本次运行已结束：完成 {self.total} 次，HTTP 200 {self.successes} 次，其他结果 {self.total - self.successes} 次。")
            if self.records:
                print(record_line(self.records[-1], self.term.size()[0], term=self.term))
                print("会话 ID：" + self.records[-1].get("session_id", "未记录"))

    @contextmanager
    def suspend(self):
        self.term.write(RESET + ESC + "?25h")
        self.term.clear()
        try:
            yield
        finally:
            self.term.write(ESC + "?25l")
            self.term.clear()
            self.last_frame = None

    def add(self, record):
        self.records.append(record)
        self.total += 1
        self.successes += record.get("http_status") == 200

    def frame(self, state, columns, rows, now):
        term = self.term
        active = "暂停中" if state.get("paused") else "保活中" if state.get("status") == 200 else "探活中"
        tone = "warning" if state.get("paused") else "success" if state.get("status") == 200 else "accent"
        status = status_label(state.get("status"), state.get("last_error", ""), term=term) if state.get("has_result") else term.style("等待结果", "muted")
        if state.get("menu_pending"):
            due = "正在等待已发请求结束"
        elif state.get("paused"):
            due = "等待继续"
        else:
            due = f"下次 {max(0, math.ceil(state.get('next_due', now) - now))}s"
            if state.get("status") == 200 and state.get("scheduled_interval") is not None:
                due += f" / 本轮 {state['scheduled_interval']:.1f}s"
        session = state.get("session_id", "")
        name, model = clean(state.get("api_name", "")), clean(state.get("model", ""))
        connection = name if not model or model in name else name + " · " + model
        lines = [term.style(f"  Codex 保活  {self.version}", "title"),
                 "  " + clip(connection + " · " + clean(state.get("api_style", "")), columns - 2),
                 term.style("  " + clip(clean(state.get("endpoint", "")), columns - 2), "muted")]
        lines += ["  " + line for line in wrap("会话 " + session, columns - 2)]
        minimum = state.get("keepalive_interval", 60)
        keepalive = keepalive_label(minimum, state.get("keepalive_max", minimum))
        lines += [f"  探活 {state.get('probe_interval', 2):g}s  ·  保活 {keepalive}  ·  超时 {state.get('timeout', 30):g}s",
                  f"  {term.style('● ' + active, tone)}  {status}  ·  {due}  ·  请求中 {state.get('inflight', 0)}"]
        elapsed = int(now - self.started)
        lines += [term.style("─" * columns, "muted"),
                  f"  本次完成 {self.total}  ·  {term.style('200 成功 ' + str(self.successes), 'success')}  ·  其他 {self.total - self.successes}  ·  运行 {elapsed // 3600:02d}:{elapsed // 60 % 60:02d}:{elapsed % 60:02d}"]
        capacity = min(8, max(1, rows - len(lines) - 7))
        entries = [record for record in self.records if record.get("api_id") == state.get("api_id")][-capacity:]
        fields = [("编号", 9), ("状态", 10)] if columns < 65 else [
            ("编号", 8), ("时间", 10), ("方式", 6), ("状态", 12), ("耗时", 8)]
        lines += [term.style(f"  当前 API 最近 {capacity} 条请求", "title"),
                  term.style("".join(fit(name, size) for name, size in fields) + "结果", "muted")]
        lines += [record_line(record, columns, term=term) for record in entries]
        if not entries:
            lines.append(term.style("  尚无结果。首条请求完成后会显示在这里。", "muted"))
        lines += [""] * max(0, capacity - max(1, len(entries)))
        lines += [term.style("─" * columns, "muted"), "  " + clip(clean(self.message), columns - 2),
                  term.style("  ↑↓ / Enter 菜单  ·  s 设置  ·  h 详情  ·  t 时间  ·  m API", "accent"),
                  term.style("  p 暂停  ·  r 继续  ·  v 单次探活  ·  q 结束", "muted")]
        if rows < 16:
            lines = [lines[0], f"  {term.style(active, tone)} {status} · {due}"]
            lines += ["  " + part for part in wrap("会话 " + session, columns - 2)]
            lines += [f"  完成 {self.total} · 成功 {self.successes}", "  请放大窗口以显示请求表格。",
                      "  Enter 菜单 · s 设置 · p 暂停 · r 继续 · q 结束"]
        return [clip(line, columns) for line in lines[:rows]]

    def render(self, state):
        self.state = state
        columns, rows = self.term.size()
        lines = self.frame(state, columns, rows, time.monotonic())
        if lines != self.last_frame:
            self.term.paint(lines)
            self.last_frame = lines
