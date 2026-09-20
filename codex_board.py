"""Cell-based, clickable multi-task terminal UI; no browser or GUI dependency."""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
import time
import urllib.parse
import uuid

import codex_ui as ui
import codex_notify as notify
from codex_tasks import (Runtime, TEMPLATE_DEFAULTS, OPTION_FIELDS, make_spec, resolve_task,
                         validate_options, validate_workspace)

ui.PALETTE.update({"board": "38;5;252;48;5;233", "border": "38;5;60;48;5;233",
                  "heading": "1;38;5;117;48;5;233", "selected_row": "38;5;255;48;5;24",
                  "button": "38;5;117;48;5;236", "focus": "1;38;5;16;48;5;117",
                  "tag_ok": "38;5;120;48;5;22", "tag_warn": "38;5;222;48;5;58",
                  "tag_bad": "38;5;210;48;5;52"})

TOKEN_LIMIT_FIELD = {"key": "max_tokens", "label": "输出上限（tokens）", "kind": "integer",
                     "hint": "可输入任意正整数，如 64、128、300、512；受模型支持范围限制"}
TOKEN_LIMIT_HELP = "每次模型响应的输出上限，输入另计；上限不是每次固定消耗量。"


class Canvas:
    def __init__(self, columns, rows, term, focus=None):
        self.columns, self.rows, self.term = columns, rows, term
        self.cells = [[(" ", "board") for _ in range(columns)] for _ in range(rows)]
        self.hits = []
        self.focus = focus
        self.buttons = []

    def put(self, x, y, text, tone="board", limit=None):
        if not 0 <= y < self.rows:
            return
        maximum = self.columns if limit is None else min(self.columns, x + max(0, limit))
        text = ui.clean(text)
        if limit is not None:
            text = ui.clip(text, max(0, limit))
        for char in text:
            width = ui.cell_width(char)
            if width == 0:
                continue
            if x < 0:
                x += width
                continue
            if x + width > maximum:
                break
            # Replace an orphaned half of a wide glyph before overwriting.
            if self.cells[y][x][0] is None and x:
                self.cells[y][x-1] = (" ", tone)
            if x+width < self.columns and self.cells[y][x+width][0] is None:
                self.cells[y][x+width] = (" ", tone)
            self.cells[y][x] = (char, tone)
            for offset in range(1, width):
                self.cells[y][x+offset] = (None, tone)
            x += width

    def line(self, y, x=0, width=None):
        self.put(x, y, "─" * (width if width is not None else self.columns), "border")

    def box(self, x, y, width, height, title=""):
        if width < 2 or height < 2:
            return
        self.put(x, y, "┌" + "─" * (width-2) + "┐", "border")
        self.put(x, y+height-1, "└" + "─" * (width-2) + "┘", "border")
        for row in range(y+1, y+height-1):
            self.put(x, row, "│", "border")
            self.put(x+width-1, row, "│", "border")
        if title:
            self.put(x+2, y, " " + title + " ", "heading", width-4)

    def hit(self, x, y, width, height, action):
        self.hits.append((x, y, x+width, y+height, action))

    def button(self, x, y, label, action, *, enabled=True, width=None):
        text = "[" + label + "]"
        size = ui.width(text) if width is None else width
        if x + size > self.columns or not 0 <= y < self.rows:
            return x
        tone = "focus" if action == self.focus else "button" if enabled else "muted"
        self.put(x, y, ui.fit(text, size), tone, size)
        if enabled:
            self.hit(x, y, size, 1, action)
            self.buttons.append(action)
        return x + size + 1

    def target(self, event):
        return next((action for x0, y0, x1, y1, action in reversed(self.hits)
                     if x0 <= event.x < x1 and y0 <= event.y < y1), None)

    def lines(self):
        output = []
        for row in self.cells:
            spans, chars, previous = [], [], None
            for char, tone in row:
                if char is None:
                    continue
                if tone != previous and chars:
                    spans.append(self.term.style("".join(chars), previous))
                    chars = []
                previous = tone
                chars.append(char)
            if chars:
                spans.append(self.term.style("".join(chars), previous))
            output.append("".join(spans))
        return output


def http_text(status):
    return ("HTTP " + str(status), "tag_ok" if status == 200 else "tag_bad" if status and status >= 500 else "tag_warn") if status else ("未请求", "muted")


def remaining(value):
    return "—" if value is None else f"{value//60:02d}:{value%60:02d}"


class Board:
    def __init__(self, engine, *, term=None):
        self.engine, self.poll, self.common, self.store = engine, engine.poll, engine.common, engine.store
        self.term = term or ui.terminal
        self.route = "overview"
        self.selected = engine.tasks[0].id if engine.tasks else None
        self.filter = "全部"
        self.query = ""
        self.scroll = 0
        self.focus = None
        self.canvas = None
        self.message = "点击任务查看参数；双击或 Enter 打开详情。"
        self.completion_deadline = None
        self.mouse_enabled = False
        self.last_frame = None
        self.last_click = (None, 0)
        self.pressed_target = None
        self.history = []
        self.history_all = []
        self.history_status = "全部"
        self.history_query = ""
        self.history_scope = None
        self.history_scroll = 0
        self.record_cursor = 0
        self.api_cursor = 0
        self.api_cache = []
        self.setting_section = "启动"
        self.snapshot = {}

    def safe(self, text):
        return self.poll.redact(str(text), self.engine.secrets())

    def current(self, snapshot=None):
        snapshot = snapshot or self.snapshot
        return next((t for t in snapshot.get("tasks", []) if t["id"] == self.selected), None)

    def filtered(self, snapshot):
        return [t for t in snapshot["tasks"] if
                (self.filter == "全部" or self.filter in t["phase"]) and
                (not self.query or self.query.casefold() in (t["name"]+" "+t["model"]+" "+t["endpoint"]).casefold())]

    def refresh_history(self):
        if self.store:
            self.history_all = list(reversed(self.store.history(1000, task_id=self.history_scope)))
        else:
            self.history_all = [r for r in reversed(self.engine.snapshot()["records"])
                            if not self.history_scope or r.get("task_id") == self.history_scope]
        self.filter_history()

    def filter_history(self):
        def matches(record):
            code = record.get("http_status")
            status = (self.history_status == "全部" or self.history_status == "HTTP 200" and code == 200
                      or self.history_status == "非 200" and code != 200
                      or self.history_status == "输出未完成" and code == 200 and bool(record.get("error")))
            text = " ".join(str(record.get(k, "")) for k in ("task_name","api_name","prompt","answer","error"))
            return status and (not self.history_query or self.history_query.casefold() in text.casefold())
        self.history = [record for record in self.history_all if matches(record)]
        self.record_cursor = min(self.record_cursor, max(0, len(self.history)-1))
        self.history_scroll = min(self.history_scroll, max(0, len(self.history)-1))

    def refresh_apis(self):
        self.api_cache = self.store.list_profiles() if self.store else []

    def header(self, c, snapshot):
        c.put(1, 0, "Codex 保活 " + self.poll.VERSION, "heading", 23)
        x = 25 if c.columns >= 88 else 20
        for key, label in (("overview", "任务"), ("records", "记录"), ("apis", "API"), ("settings", "默认设置")):
            x = c.button(x, 0, label, ("route", key))
        c.button(max(x, c.columns-10), 0, "新增 N", ("add",))
        c.line(1)
        total = len(snapshot["tasks"])
        live = sum(t["phase"] == "保活中" for t in snapshot["tasks"])
        probing = sum(t["phase"] in ("探活中", "请求中", "等待空位") for t in snapshot["tasks"])
        paused = sum(t["paused"] for t in snapshot["tasks"])
        c.put(1, 2, {"overview": "任务总览", "detail": "任务详情", "records": "请求记录",
                     "apis": "API 管理", "settings": "默认设置"}.get(self.route, ""), "title")
        c.put(1, 3, f"任务 {total}   ", "title")
        c.put(12, 3, f"保活 {live}", "success")
        c.put(24, 3, f"探活 {probing}", "warning")
        c.put(36, 3, f"暂停 {paused}", "muted")
        if c.columns >= 77:
            elapsed = int(snapshot["elapsed"])
            c.put(c.columns-30, 3, f"请求中 {snapshot['inflight']}/{snapshot['limit']}  {elapsed//3600:02d}:{elapsed//60%60:02d}:{elapsed%60:02d}", "muted")
        c.line(4)

    def footer(self, c, current):
        y = c.rows - 3
        c.line(y)
        label = (f"当前任务：{current['label']} {current['name']}" if self.route in ("overview", "detail") and current
                 else "范围：新任务默认值" if self.route == "settings" else "点击选项操作 / Esc 返回总览")
        c.put(1, y+1, label, "accent", min(42, c.columns-1))
        c.put(45, y+1, self.message, "muted", c.columns-46)
        x = 1
        if self.route in ("overview", "detail"):
            for name, action, enabled in [
                ("详情↵", ("detail",), bool(current)), ("暂停P", ("pause",), bool(current and not current["paused"])),
                ("继续R", ("resume",), bool(current and current["paused"])), ("探活V", ("probe",), bool(current)),
                ("时间T", ("time",), bool(current)), ("设置S", ("edit",), bool(current)),
                ("记录H", ("task_records",), bool(current))]:
                x = c.button(x, y+2, name, action, enabled=enabled)
        else:
            x = c.button(x, y+2, "任务 Esc", ("route", "overview"))
        x = c.button(x, y+2, "帮助?", ("help",))
        c.button(x, y+2, "退出Q", ("quit",))

    def overview(self, c, snapshot):
        tasks = self.filtered(snapshot)
        if not self.current(snapshot) and snapshot["tasks"]:
            self.selected = snapshot["tasks"][0]["id"]
        current = self.current(snapshot)
        side = c.columns >= 116 and c.rows >= 25
        main_width = c.columns - 37 if side else c.columns
        x = 1
        for label in ("全部", "保活", "探活", "暂停"):
            x = c.button(x, 5, label, ("filter", label))
        c.button(x, 5, "查找 /", ("search",))
        if c.columns >= 78:
            c.button(c.columns-23, 2, "暂停全部", ("pause_all",))
            c.button(c.columns-11, 2, "继续全部", ("resume_all",))
        event_rows = 4 if c.rows >= 34 else 0
        capacity = max(1, (c.rows - 13 - event_rows) // 2)
        capacity = min(12, capacity)
        capacity = min(capacity, max(4, len(tasks)))
        self.scroll = min(self.scroll, max(0, len(tasks)-capacity))
        height = capacity*2+3
        c.box(0, 6, main_width, height)
        name_width = max(12, main_width-49)
        state_x = name_width+7
        code_x, next_x, action_x = state_x+9, state_x+19, main_width-9
        c.put(2, 7, "任务 / 连接与模型", "muted", name_width+4)
        c.put(state_x, 7, "状态", "muted")
        c.put(code_x, 7, "最近响应", "muted")
        c.put(next_x, 7, "下次", "muted")
        c.line(8, 1, main_width-2)
        for index, task in enumerate(tasks[self.scroll:self.scroll+capacity]):
            y = 9+index*2
            tone = "selected_row" if task["id"] == self.selected else "board"
            c.put(1, y, " "*(main_width-2), tone)
            c.put(1, y+1, " "*(main_width-2), tone)
            c.hit(1, y, main_width-2, 2, ("select", task["id"]))
            c.put(2, y, (">" if task["id"] == self.selected else " ") + task["label"], tone, 5)
            c.put(8, y, task["name"], tone, name_width-1)
            origin = urllib.parse.urlsplit(task["endpoint"]).netloc
            c.put(3, y+1, f"{origin} · {task['model']}", "muted", max(0, main_width-13))
            phase_tone = "success" if task["phase"] == "保活中" else "warning" if task["phase"] in ("探活中", "等待空位") else "muted"
            c.put(state_x, y, task["phase"], phase_tone, 8)
            text, tone_http = http_text(task["status"])
            c.put(code_x, y, text, tone_http, 8)
            c.put(next_x, y, remaining(task["next"]), "title", 7)
            c.button(action_x, y, "继续" if task["paused"] else "暂停",
                     ("resume" if task["paused"] else "pause", task["id"]))
        if not tasks:
            c.put(3, 10, "暂无任务。点击 [新增 N] 添加连接与模型。" if not snapshot["tasks"] else "没有匹配的任务。", "muted", main_width-5)
            c.button(3, 12, "新增任务", ("add",))
        bottom = 6+height
        c.put(1, bottom, f"{self.scroll+1 if tasks else 0}–{min(self.scroll+capacity,len(tasks))} / {len(tasks)}  ↑↓ 选任务 · 滚轮翻页", "muted", main_width-1)
        event_start = bottom+3
        event_capacity = max(0, c.rows-3-event_start)
        if event_capacity:
            c.line(bottom+1, 0, main_width)
            events = snapshot["events"][-event_capacity:]
            c.put(1, bottom+2, f"最近变化 · 最新 {len(events)} 条", "title", main_width-2)
            for n, event in enumerate(events):
                c.put(1, event_start+n, event["time"]+"  "+event["message"], event["kind"] if event["kind"] in ui.PALETTE else "muted", main_width-2)
        if side and current:
            self.detail_panel(c, main_width+1, 6, 36, c.rows-10, current)

    def detail_panel(self, c, x, y, width, height, task):
        c.box(x, y, width, height, task["label"]+" 选中任务")
        c.put(x+2, y+2, task["name"], "title", width-4)
        c.put(x+2, y+3, task["phase"], "success" if task["status"] == 200 and not task["paused"] else "warning", width-4)
        code, tone = http_text(task["status"])
        c.put(x+20, y+3, code, tone, width-22)
        values = [
            ("下次发送", remaining(task["next"])), ("本轮间隔", f"{task['interval']:.1f}s"),
            ("探活 / 超时", f"{task['probe']:g}s / {task['timeout']:g}s"),
            ("保活范围", f"{task['minimum']:g}–{task['maximum']:g}s"),
            ("输出上限", f"{task['max_tokens']} tokens"),
            ("成功 / 总数", f"{task['successes']} / {task['total']}"),
        ]
        row = y+5
        for label, value in values:
            if row >= y+height-4:
                break
            c.put(x+2, row, label, "muted")
            if label == "输出上限":
                c.button(x+16, row, f"{task['max_tokens']} 改 B", ("tokens", task["id"]), width=width-18)
            else:
                c.put(x+16, row, value, "board", width-18)
            row += 1
        if height >= 24:
            c.put(x+2, row+1, "当前会话 ID", "muted")
            c.button(x+width-9, row+1, "复制", ("copy_session", task["id"]))
            for n, line in enumerate(ui.wrap(task["session_id"], width-4)):
                c.put(x+2, row+2+n, line, "muted", width-4)
            c.put(x+2, row+5, ui.short_result(task["answer"], task["error"]), "warning" if task["error"] else "success", width-4)
            if row+7 < y+height-3:
                c.put(x+2, row+7, "通知："+task["notification_status"], "muted", width-4)
        c.button(x+2, y+height-3, "编辑时间 T", ("time", task["id"]))
        c.button(x+18, y+height-3, "任务设置 S", ("edit", task["id"]))
        c.button(x+2, y+height-2, "打开任务详情 Enter", ("detail", task["id"]))

    def detail(self, c, snapshot):
        task = self.current(snapshot)
        if task is None:
            c.put(2, 7, "请先选择或新增任务。", "muted")
            c.button(2, 9, "返回任务总览", ("route", "overview"))
            return
        c.put(1, 5, f"{task['label']}  {task['name']}  · {task['phase']}", "heading", c.columns-2)
        x = 1
        for title, action in (("返回", ("route","overview")), ("暂停" if not task["paused"] else "继续",
                              ("pause" if not task["paused"] else "resume",)),
                              ("单次探活", ("probe",)), ("Token B", ("tokens",)),
                              ("编辑任务", ("edit",)), ("移除…", ("remove",))):
            x = c.button(x, 6, title, action)
        c.line(7)
        info = [("连接", task["endpoint"]), ("模型 / 格式", task["model"]+" / "+task["api_style"]),
                ("探活 / 保活", f"{task['probe']:g}s / {task['minimum']:g}–{task['maximum']:g}s"),
                ("超时 / 输出上限", f"{task['timeout']:g}s / {task['max_tokens']} tokens"),
                ("会话 ID", task["session_id"])]
        for row, (label, value) in enumerate(info, 8):
            c.put(2, row, label, "muted", 19)
            c.put(22, row, value, "board", c.columns-24)
        c.button(c.columns-13, 13, "复制会话", ("copy_session",))
        c.put(2, 14, "最近结果：" + ui.short_result(task["answer"], task["error"]), "warning" if task["error"] else "success", c.columns-4)
        c.line(15)
        c.put(2, 16, "最近请求 · 通知："+task["notification_status"], "title", c.columns-4)
        records = [r for r in reversed(snapshot["records"]) if r.get("task_id") == task["id"]]
        for i, record in enumerate(records[:max(0,c.rows-21)]):
            self.record_line(c, 18+i, record)

    def record_line(self, c, row, record):
        label = record.get("task_label") or "旧记录"
        code = record.get("http_status")
        text, tone = http_text(code)
        number = record["request_id"]
        c.put(1, row, str(record.get("started_at", ""))[11:19], "muted", 8)
        c.put(11, row, label, "accent", 6)
        c.put(18, row, f"#{number:04d}", "muted", 8)
        c.put(27, row, "保活" if code == 200 else "探活", "success" if code == 200 else "warning")
        c.put(33, row, text, tone, 9)
        c.put(44, row, f"{record.get('duration_seconds',0):.2f}s", "muted", 8)
        c.put(54, row, ui.short_result(record.get("answer",""), record.get("error","")),
              "warning" if record.get("error") else "board", c.columns-56)
        c.hit(1, row, c.columns-2, 1, ("record", record.get("run_id"), number))

    def records_page(self, c):
        scope = next((t["name"] for t in self.snapshot["tasks"] if t["id"] == self.history_scope),
                     "已移除任务" if self.history_scope else "全部任务")
        scope = ui.clip(scope, 20)
        x = c.button(1, 5, "范围："+scope, ("history_scope",))
        x = c.button(x, 5, self.history_status, ("history_status",))
        x = c.button(x, 5, "查找", ("history_search",))
        x = c.button(x, 5, "刷新", ("refresh_records",))
        c.button(x, 5, "删除…", ("delete_history",))
        c.put(1,6,"关键词："+(self.history_query or "无")+" · 当前范围最近 1000 条，点击刷新更新","muted",c.columns-2)
        c.put(1, 7, "时间      任务   编号     方式  最近响应   耗时      结果", "muted", c.columns-2)
        c.line(8)
        capacity = max(1,c.rows-13)
        self.history_scroll = min(self.history_scroll, max(0,len(self.history)-capacity))
        for n, record in enumerate(self.history[self.history_scroll:self.history_scroll+capacity]):
            if self.history_scroll+n == self.record_cursor:
                c.put(0,9+n,">","accent")
            self.record_line(c, 9+n, record)
        if not self.history:
            c.put(2, 10, "暂无记录。旧版本的记录仍可在“全部任务”中查看。", "muted", c.columns-4)
        c.put(1, c.rows-4, f"{self.history_scroll+1 if self.history else 0}–{min(self.history_scroll+capacity,len(self.history))} / {len(self.history)}  滚轮或 PgUp/PgDn 翻页", "muted", c.columns-2)

    def apis_page(self, c):
        c.button(1, 5, "新增 API A", ("new_api",))
        c.put(1, 7, "已保存 API / 地址                         模型与任务数", "muted", c.columns-2)
        c.line(8)
        capacity = max(1,(c.rows-13)//3)
        self.scroll = min(self.scroll,max(0,len(self.api_cache)-capacity))
        for index, profile in enumerate(self.api_cache[self.scroll:self.scroll+capacity]):
            y=9+index*3
            if self.scroll+index==self.api_cursor:c.put(0,y,">","accent")
            settings=profile["settings"]
            c.put(2,y,profile["name"],"title",max(14,c.columns-54))
            c.put(2,y+1,settings["base_url"],"muted",max(14,c.columns-54))
            used=sum(t["api_id"]==profile["id"] for t in self.snapshot["tasks"])
            model_x=max(28,c.columns-51)
            c.put(model_x,y,f"{settings['model']} · {used} 项","muted",max(0,c.columns-26-model_x))
            x=c.columns-25
            x=c.button(x,y,"建任务",("add_api_task",profile["id"]))
            x=c.button(x,y,"编辑",("edit_api",profile["id"]))
            c.button(x,y,"删",("delete_api",profile["id"]))
        if not self.api_cache:
            c.put(2,10,"暂无已保存 API。点击新增 API，或从 Codex 配置创建任务。","muted",c.columns-4)

    def settings_page(self, c):
        sections = ("启动", "时间模板", "请求与并发", "通知", "显示", "记录")
        for index, name in enumerate(sections):
            c.button(1,6+index*2,name,("setting_section",name),width=18)
        c.put(23,6,self.setting_section,"heading",c.columns-25)
        defaults=self.engine.workspace["defaults"]
        notification=notify.validate(getattr(self.common,"notification_defaults",None))
        values={
            "启动":[("启动确认","每次询问是否沿用已保存任务组"),("确认后","先暂停" if defaults["start_paused"] else "开始已启用任务")],
            "时间模板":[("探活",f"{defaults['interval']:g}s"),("保活",f"{defaults['success_interval']:g}–{defaults['success_interval_max']:g}s"),
                        ("超时",f"{defaults['timeout']:g}s")],
            "请求与并发":[("总同时请求",str(self.engine.limit)),("单任务默认上限",str(defaults["max_inflight"])),
                            ("输出上限",str(defaults["max_tokens"])+" tokens"),("工具格式",defaults["tool_mode"])],
            "通知":[("Telegram","已启用" if notification["enabled"] else "已关闭"),
                    ("接收 Chat ID",notification["chat_id"] or "未配置"),
                    ("首次 / 恢复",f"{'开' if notification['first_success'] else '关'} / {'开' if notification['recovery'] else '关'}"),
                    ("冷却间隔",f"{notification['cooldown']:g} 秒"),
                    ("最近测试",self.engine.notification_message or "尚未测试")],
            "显示":[("显示方式",defaults["display"]),("颜色",defaults["color"]),("鼠标","已启用" if self.mouse_enabled else "键盘模式")],
            "记录":[("配置和记录","已保存到本地数据库" if self.store else "仅保留本次运行"),("旧记录","在全部任务记录中继续查看")]
        }[self.setting_section]
        spacing=2 if c.rows>=24 else 1
        for index,(label,value) in enumerate(values):
            row=8+index*spacing
            c.put(23,row,label,"muted",19)
            if self.setting_section=="请求与并发" and label=="输出上限":
                c.button(44,row,f"{defaults['max_tokens']} 改 B",("default_tokens",),width=min(20,c.columns-46))
            else:
                c.put(44,row,value,"board",c.columns-46)
        button_row=min(21,c.rows-4)
        c.put(23,min(19,button_row-1),"模板用于新任务；已有任务在任务设置中修改。","muted",c.columns-25)
        x=c.button(23,button_row,"配置 Telegram" if self.setting_section=="通知" else "修改本组设置",("edit_defaults",))
        if self.setting_section=="通知":c.button(x,button_row,"测试连通",("test_notification",))

    def render(self):
        self.snapshot=self.engine.snapshot()
        columns, rows=self.term.size()
        c=Canvas(columns,rows,self.term,self.focus)
        if columns<64 or rows<20:
            c.put(1,0,"Codex 多任务保活","heading",columns-2)
            c.put(1,2,"请放大到至少 64 列、20 行。","warning",columns-2)
            c.put(1,4,f"任务 {len(self.snapshot['tasks'])} · 请求中 {self.snapshot['inflight']}","muted",columns-2)
            c.button(1,6,"操作菜单 Enter",("menu",))
            c.button(1,8,"退出 Q",("quit",))
        else:
            self.header(c,self.snapshot)
            {"overview":self.overview,"detail":self.detail}.get(self.route,lambda canvas,snapshot:None)(c,self.snapshot)
            if self.route=="records":self.records_page(c)
            elif self.route=="apis":self.apis_page(c)
            elif self.route=="settings":self.settings_page(c)
            self.footer(c,self.current())
        frame=[self.safe(line) for line in c.lines()]
        if frame!=self.last_frame:
            self.term.write(ui.ESC+"?25l")
            self.term.paint(frame)
            self.last_frame=frame
        self.canvas=c

    def choose_task(self):
        snapshot=self.engine.snapshot()
        options=[(t["id"],f"{t['label']} {t['name']}",f"{t['model']} · {t['phase']}") for t in snapshot["tasks"]]
        choice=ui.choose("选择任务",options,default=self.selected,cancel="0")
        if choice!="0":self.selected=choice

    def confirm(self,title,message,label="确认"):
        return ui.choose(title,[("0","取消"),("yes",label,message)],default="0",cancel="0",blank="0",subtitle=message)=="yes"

    def transition(self, route):
        self.route=route;self.scroll=0;self.focus=None
        if route=="records":self.refresh_history()
        elif route=="apis":self.refresh_apis()
        self.last_frame=None

    def action(self, command):
        name,*extra=command
        if extra and name in ("pause","resume","detail","time","tokens","edit","select","copy_session"):
            self.selected=extra[0]
        current=self.engine.find(self.selected)
        if name=="route":self.transition(extra[0])
        elif name=="filter":self.filter=extra[0];self.scroll=0;self.focus=None
        elif name=="select":self.selected=extra[0];self.focus=None
        elif name=="detail":
            if current:self.transition("detail")
        elif name=="pause":
            if current:self.engine.pause(current.id);self.message=current.label+" 已暂停"
        elif name=="resume":
            if current:self.engine.resume(current.id);self.message=current.label+" 已继续"
        elif name=="probe":
            if current and self.confirm("单次探活 · "+current.label,"将暂停该任务的持续发送，单次请求结束后保持暂停。","暂停并探活"):
                self.engine.probe(current.id)
        elif name in ("pause_all","resume_all"):
            if self.confirm("操作全部任务",f"范围：本终端中的 {len(self.engine.tasks)} 个任务。","暂停全部" if name=="pause_all" else "继续全部"):
                (self.engine.pause if name=="pause_all" else self.engine.resume)()
        elif name=="remove":
            if current and self.confirm("移除 "+current.label,"停止并移除此任务，API 和历史记录保留。","移除任务"):
                self.engine.remove(current.id);self.selected=self.engine.tasks[0].id if self.engine.tasks else None;self.transition("overview")
        elif name=="quit":
            if self.confirm("结束本终端？","停止本终端所有任务，保存的配置和记录保留。","结束运行"):
                return False
        elif name=="add":self.add_task()
        elif name=="add_api_task":self.add_task(extra[0])
        elif name=="edit":
            if current:self.edit_task(current)
        elif name=="time":
            if current:self.edit_task(current,timing_only=True)
        elif name=="tokens":
            if current:self.edit_task(current,tokens_only=True)
        elif name=="task_records":
            self.history_scope=current.id if current else None;self.transition("records")
        elif name=="refresh_records":self.refresh_history()
        elif name=="history_status":
            choice=ui.choose("筛选状态",[(x,x) for x in ("全部","HTTP 200","非 200","输出未完成")],
                             default=self.history_status,cancel="cancel")
            if choice!="cancel":self.history_status=choice;self.history_scroll=0;self.filter_history()
        elif name=="history_search":
            with ui.cooked_keyboard_mode():
                self.history_query=ui.strip_mouse_reports(input("\n搜索任务、问题、回答或错误（回车清空）：")).strip()
            self.history_scroll=0;self.filter_history()
        elif name=="history_scope":
            options=[("all","全部任务，含旧版本记录")]+[(t.id,f"{t.label} {t.spec['name']}") for t in self.engine.tasks]
            choice=ui.choose("记录范围",options,default=self.history_scope or "all",cancel="cancel")
            if choice!="cancel":self.history_scope=None if choice=="all" else choice;self.history_scroll=0;self.record_cursor=0;self.refresh_history()
        elif name=="record":self.record_detail(extra[0],extra[1])
        elif name=="delete_history":self.delete_history()
        elif name=="copy_session":
            if current:self.message=ui.copy_text(current.session_id,term=self.term)
        elif name=="search":
            with ui.cooked_keyboard_mode():
                self.query=ui.strip_mouse_reports(input("\n查找任务名称、模型或地址（回车清空）：")).strip()
            self.scroll=0
        elif name=="setting_section":self.setting_section=extra[0]
        elif name=="edit_defaults":self.edit_defaults()
        elif name=="default_tokens":self.edit_defaults(tokens_only=True)
        elif name=="test_notification":
            self.send_test_notification(getattr(self.common,"notification_defaults",None))
        elif name in ("new_api","edit_api"):
            self.edit_api(extra[0] if extra else None)
        elif name=="delete_api":self.delete_api(extra[0])
        elif name=="api_menu":
            if self.api_cache:
                profile=self.api_cache[min(self.api_cursor,len(self.api_cache)-1)]
                choice=ui.choose(profile["name"],[("add","创建任务"),("edit","编辑连接"),("delete","删除 API")],
                                 default="add",cancel="0")
                if choice!="0":
                    return self.action(({"add":"add_api_task","edit":"edit_api","delete":"delete_api"}[choice],profile["id"]))
        elif name=="help":
            ui.view_text("操作说明",
                "点击任务：选中；双击 / Enter：详情。\n↑↓ 选任务，滚轮翻页，Tab 切换按钮。\n"
                "P 暂停 / R 继续 / V 单次探活：只作用于当前任务。\nT 时间 / B 输出 token 上限 / S 任务设置 / H 当前任务记录。\n"
                "N 新增任务 / M API / G 默认设置 / Q 结束本终端。\n"
                "在默认设置中按 B 修改新任务的默认输出上限。\n"
                "暂停全部、继续全部、移除及删除均先确认范围。\n"
                "终端支持鼠标时可以点击菜单和按钮；输入文字时先完成当前字段。\n"
                "复制文本可用复制按钮；需要终端选择文字时可尝试按住 Shift 拖动。")
        elif name=="menu":
            options=[("task","选择任务"),("add","新增任务"),("detail","任务详情"),("pause","暂停当前"),
                     ("resume","继续当前"),("probe","单次探活"),("edit","任务设置"),("apis","API 管理"),
                     ("settings","默认设置"),("records","全部记录"),("quit","结束")]
            choice=ui.choose("工作台操作",options,default="task",cancel="0")
            if choice=="task":self.choose_task()
            elif choice in ("apis","settings","records"):self.transition(choice)
            elif choice!="0":return self.action((choice,))
        self.last_frame=None
        return True

    def handle(self, key):
        if key is None:return True
        if isinstance(key,ui.Mouse):
            if key.kind=="press":
                self.pressed_target=self.canvas.target(key) if self.canvas else None
                return True
            if key.kind.startswith("wheel"):
                step=-3 if key.kind=="wheel-up" else 3
                if self.route=="records":
                    self.history_scroll=max(0,self.history_scroll+step);self.record_cursor=self.history_scroll
                else:self.scroll=max(0,self.scroll+step)
                return True
            if key.kind!="left" or not self.canvas:return True
            target=self.pressed_target or self.canvas.target(key)
            self.pressed_target=None
            self.focus=None
            if target:
                if target[0]=="select":
                    now=time.monotonic()
                    double=key.clicks==2 or (target==self.last_click[0] and now-self.last_click[1]<.35)
                    self.last_click=(target,now)
                    if double:self.selected=target[1];return self.action(("detail",))
                elif key.clicks==2:return True
                return self.action(target)
            return True
        if key=="tab" and self.canvas and self.canvas.buttons:
            i=self.canvas.buttons.index(self.focus)+1 if self.focus in self.canvas.buttons else 0
            self.focus=self.canvas.buttons[i%len(self.canvas.buttons)]
        elif key in ("up","down") and self.route=="overview":
            items=self.filtered(self.engine.snapshot())
            if items:
                ids=[t["id"] for t in items];i=ids.index(self.selected) if self.selected in ids else 0
                i=(i+(-1 if key=="up" else 1))%len(items);self.selected=ids[i];self.focus=None
                capacity=max(1,(self.term.size()[1]-13-(4 if self.term.size()[1]>=34 else 0))//2)
                self.scroll=max(0,min(self.scroll,i))
                if i>=self.scroll+capacity:self.scroll=i-capacity+1
        elif key in ("pageup","pagedown","up","down"):
            step=(-1 if key in ("pageup","up") else 1)*(8 if key.startswith("page") else 1)
            if self.route=="records":
                self.record_cursor=max(0,min(max(0,len(self.history)-1),self.record_cursor+step))
                cap=max(1,self.term.size()[1]-13)
                self.history_scroll=min(self.history_scroll,self.record_cursor)
                if self.record_cursor>=self.history_scroll+cap:self.history_scroll=self.record_cursor-cap+1
            elif self.route=="apis":
                self.api_cursor=max(0,min(max(0,len(self.api_cache)-1),self.api_cursor+step))
                cap=max(1,(self.term.size()[1]-13)//3)
                self.scroll=min(self.scroll,self.api_cursor)
                if self.api_cursor>=self.scroll+cap:self.scroll=self.api_cursor-cap+1
            elif self.route=="settings":
                sections=("启动","时间模板","请求与并发","通知","显示","记录")
                self.setting_section=sections[(sections.index(self.setting_section)+step)%len(sections)]
            else:self.scroll=max(0,self.scroll+step)
            self.focus=None
        elif key=="enter":
            if self.canvas and (self.canvas.columns<64 or self.canvas.rows<20):
                return self.action(("menu",))
            if self.focus:return self.action(self.focus)
            if self.route=="records" and self.history:
                record=self.history[min(self.record_cursor,len(self.history)-1)]
                return self.action(("record",record.get("run_id"),record["request_id"]))
            if self.route=="apis":return self.action(("api_menu",))
            if self.route=="settings":return self.action(("edit_defaults",))
            return self.action(("detail",) if self.current() else ("menu",))
        elif key=="escape":self.transition("overview")
        else:
            action={"p":"pause","r":"resume","v":"probe","t":"time","b":"tokens","s":"edit","h":"task_records",
                    "n":"add","q":"quit","?":"help","/":"search","a":"new_api"}.get(str(key).lower())
            if self.route=="settings" and action=="tokens":action="default_tokens"
            if self.route not in ("overview","detail") and action in ("pause","resume","probe","time","tokens","edit","task_records","search"):
                action="history_search" if action=="search" and self.route=="records" else None
            if action=="new_api" and self.route!="apis":action=None
            if str(key).lower() in ("m","g"):
                self.transition("apis" if str(key).lower()=="m" else "settings")
            elif action:return self.action((action,))
        return True

    def record_detail(self, run_id, request_id):
        records=self.history+self.engine.snapshot()["records"]
        record=next((r for r in records if r.get("run_id")==run_id and r["request_id"]==request_id),None)
        if not record:return
        while True:
            actions=[("c","复制 C"),("esc","返回 Esc")]
            if self.store:actions.insert(1,("d","删除此条 D"))
            choice=ui.view_text("请求详情 · "+record.get("task_label","旧记录"),ui.record_details(record),actions=actions)
            if not self.term.interactive():
                choice=ui.choose("记录操作",actions,default="esc",cancel="esc",blank="esc")
            if choice not in ("c","d"):return
            if choice=="c":
                self.message=ui.copy_text(json.dumps(record,ensure_ascii=False,indent=2),term=self.term)
            elif self.store:
                stored=self.store.find_record(run_id,request_id)
                if stored and self.confirm("删除这一条记录？",f"仅删除 {record.get('task_label','')} #{request_id:06d}，其他记录与 API 保留。","删除此条"):
                    self.store.delete_history(record_id=stored["record_id"])
                    self.clear_cached_history(lambda r:r.get("run_id")==run_id and r["request_id"]==request_id)
                    self.refresh_history();self.message="所选记录已删除";return

    def clear_cached_history(self, predicate):
        from collections import deque
        with self.engine.lock:
            self.engine.records=deque((r for r in self.engine.records if not predicate(r)),maxlen=2000)
            for task in self.engine.tasks:
                task.records=deque((r for r in task.records if not predicate(r)),maxlen=200)

    def delete_history(self):
        count=len(self.history)
        choice=ui.choose("删除记录的范围",[("0","取消"),("filtered",f"删除当前筛选的 {count} 条记录"),
                        ("scope","清空当前任务记录" if self.history_scope else "清空全部任务与旧记录")],
                        default="0",cancel="0",blank="0",subtitle="单条记录可点开详情后删除。")
        if choice=="0":return
        if choice=="filtered":
            chosen=list(self.history)
            if not chosen:return
            if not self.confirm("删除当前筛选结果？",f"仅删除显示的 {len(chosen)} 条记录，API 和任务保留。","删除这些记录"):return
            keys={(r["run_id"],r["request_id"]) for r in chosen}
            if self.store:
                ids=[]
                for record in chosen:
                    stored=record if record.get("record_id") else self.store.find_record(record["run_id"],record["request_id"])
                    if stored:ids.append(stored["record_id"])
                self.store.delete_records(ids)
            self.clear_cached_history(lambda r:(r["run_id"],r["request_id"]) in keys)
        else:
            count=self.store.history_count(task_id=self.history_scope) if self.store else len(self.history_all)
            if not self.confirm("清空调用记录",f"范围：{'当前任务' if self.history_scope else '全部任务（含旧记录）'}，共 {count} 条。任务和 API 保留。","确认清空"):return
            if self.store:
                if self.history_scope:self.store.delete_history(task_id=self.history_scope)
                else:self.store.delete_history(all_records=True)
            self.clear_cached_history(lambda r:not self.history_scope or r.get("task_id")==self.history_scope)
        self.refresh_history();self.message="所选记录已删除，运行中的任务仍可写入新记录"

    def edit_task(self, task, timing_only=False, tokens_only=False):
        if not timing_only and not tokens_only:
            choice=ui.choose("任务设置 · "+task.label,[("parameters","名称、模型、时间与请求设置"),
                             ("tokens","输出 token 上限","自行输入数值，保存后用于本任务后续请求"),
                             ("notification","Telegram 通知","只修改本任务的通知配置"),
                             ("connection","切换 API / Codex 连接"),("0","返回")],
                             default="parameters",cancel="0",blank="0",subtitle=task.spec["name"])
            if choice=="0":return
            if choice=="tokens":tokens_only=True
            if choice=="notification":
                self.notification_settings(task);return
            if choice=="connection":
                args=choose_connection(self.poll,self.common,self.store,self.engine.workspace["defaults"])
                if args is None:return
                if task.args:
                    for key in ("interval","success_interval","success_interval_max","timeout","max_tokens","tool_mode","reset_session_on_400","max_inflight"):
                        setattr(args,key,getattr(task.args,key))
                    args.task_inflight=args.max_inflight
                    args.notification=copy.deepcopy(task.args.notification)
                spec=make_spec(args,task.spec["number"],task.spec["name"],task_id=task.id,enabled=task.spec["enabled"])
                self.engine.update(task.id,spec,args);self.message=task.label+" 连接已切换"
                return
        values={**task.spec["options"]}
        if task.args:
            values.update({k:getattr(task.args,k) for k in OPTION_FIELDS if k!="prompts" and hasattr(task.args,k)})
        values["name"]=task.spec["name"]
        fields=[{"key":"interval","label":"时间 · 探活间隔（秒）","kind":"number"},
                {"key":"success_interval","label":"时间 · 保活最短（秒）","kind":"number"},
                {"key":"success_interval_max","label":"时间 · 保活最长（秒）","kind":"number"},
                {"key":"timeout","label":"时间 · 请求超时（秒）","kind":"number"}]
        if tokens_only:
            fields=[TOKEN_LIMIT_FIELD]
        elif not timing_only:
            fields=[{"key":"name","label":"任务名称"},{"key":"model","label":"模型"}]+fields+[
                TOKEN_LIMIT_FIELD,
                {"key":"tool_mode","label":"请求 · 工具格式","choices":[("client","客户端结构"),("compatible","通用兼容"),("off","关闭工具")]},
                {"key":"reset_session_on_400","label":"请求 · HTTP 400","choices":[(True,"更新本任务会话 ID"),(False,"保留会话 ID")]},
                {"key":"max_inflight","label":"单任务同时请求上限","kind":"integer"}]
        if not task.args:
            self.message="连接配置异常，请先编辑对应 API 或重新创建任务";return
        subtitle="仅修改本任务，其他任务继续运行；点击字段后输入。"
        if tokens_only:
            subtitle=TOKEN_LIMIT_HELP+" 保存后从下次请求生效。"
            if values.get("token_param")=="none":subtitle+=" 当前未发送上限参数，保存后启用。"
        draft=ui.edit_fields(("输出 token 上限" if tokens_only else "时间设置" if timing_only else "任务设置")+" · "+task.label,
            fields,values,subtitle=subtitle,validate=lambda v:validate_options(v))
        if draft is None:return
        if tokens_only and draft.get("token_param")=="none":draft["token_param"]="auto"
        args=self.poll.copy_settings(task.args)
        for key in OPTION_FIELDS:
            if key in draft and key!="prompts":setattr(args,key,draft[key])
        self.poll.refresh_connection(args)
        spec=copy.deepcopy(task.spec)
        spec["name"]=draft["name"].strip()
        spec["options"].update(validate_options(draft))
        if not timing_only and not tokens_only and draft.get("model")!=getattr(task.args,"model",None):
            spec["source"]="saved"
        elif spec["source"]=="codex":
            for field in ("model","api_style","stream"):spec["options"].pop(field,None)
        self.engine.update(task.id,spec,args)
        self.message=(f"{task.label} 输出上限已保存：{args.max_tokens} tokens，下次请求生效" if tokens_only else task.label+" 设置已保存")

    def edit_defaults(self, tokens_only=False):
        if self.setting_section=="通知" and not tokens_only:
            self.notification_settings();return
        values={**self.engine.workspace["defaults"],"concurrency":self.engine.limit}
        mapping={
          "启动":[{"key":"start_paused","label":"确认配置后","choices":[(False,"开始已启用任务"),(True,"所有任务先暂停")]}],
          "时间模板":[{"key":key,"label":label,"kind":"number"} for key,label in
                      (("interval","默认探活（秒）"),("success_interval","默认保活最短"),("success_interval_max","默认保活最长"),("timeout","默认请求超时"))],
          "请求与并发":[{"key":"concurrency","label":"全局同时请求上限","kind":"integer"},
                         {"key":"max_inflight","label":"单任务默认上限","kind":"integer"},
                         {**TOKEN_LIMIT_FIELD,"label":"默认上限（tokens）"},
                         {"key":"tool_mode","label":"默认工具格式","choices":[("client","客户端结构"),("compatible","通用兼容"),("off","关闭工具")]}],
          "显示":[{"key":"color","label":"状态颜色","choices":[("auto","跟随终端"),("always","启用颜色"),("never","关闭颜色")]},
                   {"key":"display","label":"显示方式","choices":[("auto","自动"),("dashboard","多任务面板"),("compact","简洁文本"),("verbose","完整文本")]}]
        }
        if self.setting_section=="记录" and not tokens_only:
            self.history_scope=None;self.transition("records");return
        def validate(values):
            validate_workspace({**self.engine.workspace,"defaults":values,"concurrency":values["concurrency"]})
        fields=[{**TOKEN_LIMIT_FIELD,"label":"默认上限（tokens）"}] if tokens_only else mapping[self.setting_section]
        draft=ui.edit_fields("默认设置 · "+("输出 token 上限" if tokens_only else self.setting_section),fields,values,
                            subtitle=("新连接使用默认上限；已保存 API 和任务保留各自数值。"+TOKEN_LIMIT_HELP if tokens_only else
                                      "模板用于新任务；已有任务单独修改。启动时仍先确认是否沿用任务组。"),validate=validate)
        if draft is None:return
        candidate=validate_workspace({**self.engine.workspace,"defaults":draft,"concurrency":draft["concurrency"]})
        with self.engine.lock:
            if self.store:self.store.save_workspace(candidate,task_snapshots={t.id:t.args for t in self.engine.tasks if t.args})
            self.engine.workspace=candidate;self.engine.limit=candidate["concurrency"]
        self.term.color_mode=candidate["defaults"]["color"]
        self.message="默认设置已保存；任务参数在各自设置中修改"

    def send_test_notification(self, config):
        try:
            config=notify.validate(config)
            self.engine.notification_message=self.engine.notifier.submit("notification-test",0,config,
                "✅ Codex 保活测试通知\nTelegram 通知通道已连接。\n正式通知将在首次探活成功或故障恢复时发送。",test=True)
        except ValueError as exc:
            ui.view_text("无法发送测试通知",str(exc));return False
        self.message="测试通知已加入队列；手机收到测试消息即可确认通知链路。"
        if self.engine.thread is None:
            with ui.cooked_keyboard_mode():
                print("正在发送测试通知…")
                deadline=time.monotonic()+12
                while time.monotonic()<deadline:
                    self.engine.collect_notifications()
                    if self.engine.notification_message!="等待发送":break
                    time.sleep(.05)
            ui.view_text("测试通知",self.engine.notification_message)
        return True

    def notification_settings(self, task=None):
        if task is not None and not task.args:
            self.message="请先修复此任务的连接配置";return
        scope=task.label+" · "+task.spec["name"] if task else "新任务默认通知"

        def current():
            return notify.validate(task.args.notification if task else getattr(self.common,"notification_defaults",None))

        def save(values):
            values=notify.validate(values)
            if task:
                args=self.poll.copy_settings(task.args);args.notification=values
                self.engine.update(task.id,copy.deepcopy(task.spec),args)
            else:
                if self.store:
                    if self.engine.tasks:self.engine.persist()
                    self.store.save_notification_defaults(values)
                self.common.notification_defaults=copy.deepcopy(values)
            self.message=scope+" 已保存"

        while True:
            config=current()
            choices=[("edit","编辑 Telegram 配置","Bot Token、Chat ID、通知开关和冷却时间"),
                     ("chat","读取 Chat ID","先给机器人发送 /start；读取其最近消息来源"),
                     ("test","发送测试通知","发送一条测试消息到当前配置的 Chat ID")]
            if task:
                choices.append(("defaults","将默认通知配置应用到此任务","仅替换当前任务，其他任务不变"))
            if config["proxy_url"]:choices.append(("clear_proxy","清空此处的代理设置"))
            choices += [("help","接入说明"),("0","返回")]
            choice=ui.choose("Telegram · "+scope,choices,default="edit",cancel="0",blank="0",
                subtitle=("已启用" if config["enabled"] else "已关闭")+" · "+(config["chat_id"] or "尚未设置 Chat ID")+
                         ("；只修改本任务。" if task else "；默认值仅供新任务使用。"))
            if choice=="0":return
            if choice=="edit":
                fields=[{"key":"bot_token","label":"Bot Token","kind":"password"},
                        {"key":"chat_id","label":"接收 Chat ID","hint":"数字 ID；群组 ID 通常为负数。也可返回后读取 Chat ID。"},
                        {"key":"enabled","label":"Telegram 通知","choices":[(True,"启用"),(False,"关闭")]},
                        {"key":"first_success","label":"首次探活成功","choices":[(True,"通知一次"),(False,"不通知")]},
                        {"key":"recovery","label":"失败后恢复","choices":[(True,"通知一次"),(False,"不通知")]},
                        {"key":"cooldown","label":"冷却间隔（秒）","kind":"number"},
                        {"key":"proxy_url","label":"HTTP(S) 代理","kind":"password",
                         "hint":"可选，例如 http://127.0.0.1:7890；回车保留，清空代理请返回菜单。"}]
                draft=ui.edit_fields("Telegram 配置 · "+scope,fields,config,
                    subtitle="可以先关闭通知、保存 Token，再读取 Chat ID。保活成功不重复推送。",validate=notify.validate)
                if draft is not None:save(draft)
            elif choice=="chat":
                try:
                    with ui.cooked_keyboard_mode():
                        print("正在读取机器人最近收到的消息…（其他任务继续运行）")
                        chats=notify.discover_chats(config)
                except (notify.DeliveryError,ValueError) as exc:
                    ui.view_text("读取 Chat ID 未完成",self.safe(str(exc)));continue
                if not chats:
                    ui.view_text("未找到 Chat ID","请先在 Telegram 给这个机器人发送 /start，再重新读取。若使用群组，请先将机器人加入群组并发送消息。")
                else:
                    chosen=ui.choose("选择通知接收位置",[(identifier,ui.clean(name),identifier) for identifier,name in chats],
                                     default=chats[0][0],cancel="cancel")
                    if chosen!="cancel":save({**config,"chat_id":chosen})
            elif choice=="test":
                if self.send_test_notification(config):return
            elif choice=="defaults":save(getattr(self.common,"notification_defaults",None))
            elif choice=="clear_proxy":save({**config,"proxy_url":""})
            elif choice=="help":
                ui.view_text("Telegram 接入",
                    "1. 在 Telegram 打开 @BotFather，发送 /newbot 创建机器人，复制 Bot Token。\n"
                    "2. 在这里保存 Token，先保持通知关闭；给新机器人发送 /start。\n"
                    "3. 返回选择“读取 Chat ID”，选择你自己的聊天或目标群组。\n"
                    "4. 开启通知并保存，点击“发送测试通知”。\n"
                    "运行电脑需要能访问 api.telegram.org，可配置本地 HTTP(S) 代理。\n"
                    "每个任务独立保存通知设置。改默认值只影响新任务，已有任务可单独选择应用默认配置。\n"
                    "正常保活不重复通知；成功以 HTTP 200 为准。已提交 Telegram 不等于手机已读。")

    def add_task(self, api_id=None):
        args=choose_connection(self.poll,self.common,self.store,self.engine.workspace["defaults"],api_id=api_id)
        if args is None:return
        values={**{k:getattr(args,k) for k in OPTION_FIELDS if k!="prompts" and hasattr(args,k)},
                "name":getattr(args,"api_name",args.model),"enabled":False}
        fields=[{"key":"name","label":"任务名称"},{"key":"model","label":"模型"}]+[
            {"key":key,"label":label,"kind":"number"} for key,label in
            (("interval","探活间隔（秒）"),("success_interval","保活最短（秒）"),("success_interval_max","保活最长（秒）"),("timeout","请求超时（秒）"))]+[
            TOKEN_LIMIT_FIELD,
            {"key":"max_inflight","label":"同时请求上限","kind":"integer"},
            {"key":"enabled","label":"保存后","choices":[(False,"待启动，稍后点击继续"),(True,"立即启动本任务")]}]
        draft=ui.edit_fields("新增任务",fields,values,subtitle="每个任务独立计时和会话。选择保存后是否启动。",
                            validate=lambda v:validate_options(v))
        if draft is None:return
        for key in OPTION_FIELDS:
            if key in draft:setattr(args,key,draft[key])
        number=max((t.spec["number"] for t in self.engine.tasks),default=0)+1
        args.task_inflight=args.max_inflight
        spec=make_spec(args,number,draft["name"],enabled=draft["enabled"])
        self.selected=self.engine.add(spec,args)
        self.transition("overview");self.message=f"T{number:02d} 已添加"

    def edit_api(self, api_id=None):
        if self.store is None:
            ui.view_text("API 记忆已关闭","可以直接新增任务，本次输入的连接不会持久保存。");return
        saved=self.store.load_profile(api_id) if api_id else None
        args=manual_connection(self.poll,self.common,self.store,self.engine.workspace["defaults"],saved=saved)
        if args is None:return
        self.refresh_apis();self.message="API 已保存，供新建任务使用；已有任务保留独立配置"

    def delete_api(self, api_id):
        if not self.store:return
        count=sum(t.spec["api_id"]==api_id for t in self.engine.tasks)
        if count:
            ui.view_text("API 正在使用","请先切换或移除使用此 API 的任务，再删除连接。");return
        if self.confirm("删除 API","删除连接凭据，历史记录保留。","删除 API"):
            self.store.delete_profile(api_id);self.refresh_apis();self.message="API 已删除"

    def run(self):
        rich=self.term.interactive() and self.common.display in ("auto","dashboard")
        if not rich:
            return self.run_plain()
        self.engine.emit_text=False
        self.term.write(ui.ESC+"?1049h"+ui.ESC+"?25l")
        self.term.screen_open=True
        try:
            with ui.keyboard_mode(), ui.mouse_mode(self.term, getattr(self.common,"mouse",None) is not False) as enabled:
                self.mouse_enabled=enabled
                self.engine.start()
                self.render()
                while True:
                    if self.engine.failure:
                        ui.view_text("运行停止",self.engine.failure);return 1
                    if self.finished():return 0
                    key=ui.read_key(block=False)
                    try:
                        if not self.handle(key):return 0
                    except (KeyboardInterrupt,EOFError) as exc:
                        if getattr(exc,"signal_number",None):raise
                        self.message="已取消当前操作";self.last_frame=None
                    except (ValueError,OSError) as exc:
                        ui.view_text("操作未完成",self.safe(exc))
                        self.last_frame=None
                    self.render()
                    time.sleep(.04)
        except (KeyboardInterrupt,EOFError):
            return 130
        finally:
            self.engine.stop()
            self.term.write(ui.RESET+ui.ESC+"?25h"+ui.ESC+"?1049l")
            self.term.screen_open=False
            snap=self.engine.snapshot()
            print(f"运行已结束：{len(snap['tasks'])} 个任务，完成 {sum(t['total'] for t in snap['tasks'])} 次请求。")

    def finished(self):
        if not self.engine.finished():
            self.completion_deadline=None
            return False
        if not self.engine.notifier.pending_count:
            self.engine.collect_notifications()
            return True
        if self.completion_deadline is None:
            self.completion_deadline=time.monotonic()+12
            self.engine.notifier.finish_pending()
            self.message="请求次数已完成，等待 Telegram 提交通知…"
        if time.monotonic()>=self.completion_deadline:
            self.message="请求次数已完成；仍有通知未提交，退出时取消等待"
            self.engine._event(self.message,"warning")
            print(self.message,flush=True)
            return True
        return False

    def run_plain(self):
        import select
        print(f"Codex 多任务保活 {self.poll.VERSION} | {len(self.engine.tasks)} 个任务 | 总并发 {self.engine.limit}",flush=True)
        interactive=bool(self.common.controls and __import__("sys").stdin.isatty())
        self.engine.emit_text=True
        self.engine.start()
        try:
            while not self.finished():
                if self.engine.failure:print(self.engine.failure);return 1
                if interactive:
                    key=self.poll.ConsoleControls().poll()
                    if key:
                        self.engine.emit_text=False
                        try:
                            if not self.handle(key):return 0
                        finally:self.engine.emit_text=True
                if not interactive and self.engine.tasks and all(t.error or not t.spec["enabled"] for t in self.engine.tasks):
                    print("没有可运行任务，请检查任务配置或使用交互模式编辑。",flush=True)
                    return 1 if any(t.error for t in self.engine.tasks) else 0
                time.sleep(.05)
            return 1 if any(t.error for t in self.engine.tasks) else 0
        except (KeyboardInterrupt,EOFError):
            return 130
        finally:self.engine.stop()


def base_connection(poll, common, defaults):
    args=poll.copy_settings(common)
    args._timing_overrides={}
    args._request_overrides={}
    args._preference_overrides=set()
    args.extra_headers,args.query_params,args.secrets={},{},[]
    args.api_id,args.api_name=None,None
    args.connection_source="saved"
    args.token_param="auto";args.stream=None;args.api_style="responses"
    args.mode="api";args.base_url=None;args.api_key=None;args.model=None
    args.codex_config,args.profile=None,None
    args.prompts=list(getattr(common,"prompt",None) or poll.DEFAULT_PROMPTS)
    args.notification=notify.validate(getattr(common,"notification_defaults",None))
    for key,value in defaults.items():setattr(args,key,value)
    args.task_inflight=defaults.get("max_inflight",1)
    return args


def manual_connection(poll, common, store, defaults, saved=None):
    args=base_connection(poll,common,defaults)
    old=saved["settings"] if saved else {}
    values={"name":saved["name"] if saved else "", "base_url":old.get("base_url",""),
            "api_key":old.get("api_key",""),"model":old.get("model",""),
            "api_style":old.get("api_style","responses")}
    fields=[{"key":"name","label":"API 名称"},{"key":"base_url","label":"API 地址"},
            {"key":"api_key","label":"API 密钥","kind":"password"},
            {"key":"api_style","label":"接口格式","choices":[("responses","Responses"),("chat","Chat Completions")]},
            {"key":"model","label":"默认模型","hint":"留空时，保存后读取模型列表并选择"}]
    def validate(v):
        if not v["base_url"].strip() or not v["api_key"].strip():raise ValueError("地址和密钥不能为空")
        poll.resolve_endpoint(v["base_url"],v["api_style"])
        if saved and urllib.parse.urlsplit(v["base_url"])[:2]!=urllib.parse.urlsplit(old["base_url"])[:2] and v["api_key"]==old.get("api_key"):
            raise ValueError("地址来源改变，请重新填写该平台的密钥")
    draft=ui.edit_fields("编辑 API" if saved else "新增 API",fields,values,validate=validate,
                        subtitle="密钥不显示；保存前验证模型列表。其他任务继续运行。")
    if draft is None:return None
    args.base_url,args.api_key,args.model=draft["base_url"].strip(),draft["api_key"].strip(),draft["model"].strip() or None
    args.api_style=draft["api_style"];args.stream=args.api_style=="responses"
    args.config_source,args.key_source="任务工作台输入","用户输入"
    if saved and draft["base_url"]==old["base_url"]:
        args.extra_headers=old.get("extra_headers",{})
        args.query_params=old.get("query_params",{})
    poll.refresh_connection(args)
    with ui.cooked_keyboard_mode():
        poll.prepare_api(args)
    poll.remember_api(args,store,name=draft["name"] or None,profile_id=saved["id"] if saved else None,make_default=False)
    return args


def choose_connection(poll, common, store, defaults, api_id=None):
    if api_id:
        profile=store.load_profile(api_id)
        source=profile["settings"]
        options={key:value for key,value in source.items() if key in OPTION_FIELDS and value is not None}
        if not source.get("tool_mode") and source.get("max_tokens")==32:
            options["max_tokens"]=defaults["max_tokens"]
        spec={"id":str(uuid.uuid4()),"number":1,"name":profile["name"],"api_id":api_id,
              "enabled":False,"source":"saved","options":{**validate_options(defaults),**options,"max_inflight":defaults.get("max_inflight",1)}}
        args=resolve_task(poll,common,store,validate_workspace({"version":1,"tasks":[spec]})["tasks"][0])
        args.task_inflight=defaults.get("max_inflight",1)
        return args
    options=[("new","新增第三方 API"),("codex","读取 Codex 当前配置")]
    if store:options.insert(0,("saved","选择已保存 API"))
    choice=ui.choose("选择任务连接",options,default="saved" if store else "new",cancel="0",blank="0")
    if choice=="0":return None
    if choice=="saved":
        selected=poll.choose_saved_api(store)
        return choose_connection(poll,common,store,defaults,selected["id"]) if selected else None
    if choice=="new":return manual_connection(poll,common,store,defaults)
    args=base_connection(poll,common,defaults)
    args.mode="codex";args.api_style="auto"
    args.codex_config=getattr(common,"codex_config",None)
    args.profile=getattr(common,"profile",None)
    args.no_codex_config=False
    poll.apply_configuration(args);poll.refresh_connection(args)
    if not args.model:raise ValueError("Codex 配置中没有模型")
    poll.remember_api(args,store,make_default=False)
    return args


def legacy_workspace(store):
    """Offer the previous single default as one task; do not write during preview."""
    saved=store.load_defaults() if store else None
    if saved is None:return None
    profile=store.profile_settings(saved["api_id"])
    if profile is None:return None
    options={key:value for key,value in profile.items() if key in OPTION_FIELDS and value is not None}
    options["reset_session_on_400"]=saved["reset_session_on_400"]
    options["max_inflight"]=1
    if not profile.get("tool_mode") and profile.get("max_tokens")==32:
        options["max_tokens"]=TEMPLATE_DEFAULTS["max_tokens"]
    defaults={**TEMPLATE_DEFAULTS,**validate_options(options),
              **{key:saved[key] for key in ("display","color","start_paused")}}
    spec={"id":str(uuid.uuid4()),"number":1,"name":profile.get("model") or "默认任务",
          "api_id":saved["api_id"],"source":saved["source"],"codex_config":saved.get("codex_config"),
          "profile":saved.get("profile"),"enabled":True,"options":options}
    if spec["source"]=="codex":
        for name in ("model","api_style","stream"):spec["options"].pop(name,None)
    return validate_workspace({"version":1,"concurrency":8,"defaults":defaults,"tasks":[spec]})


def prepare_explicit(poll,common,store,defaults):
    args=poll.copy_settings(common)
    for key in ("_timing_overrides","_request_overrides","_preference_overrides"):
        setattr(args,key,copy.deepcopy(getattr(common,key,{} if key!="_preference_overrides" else set())))
    args._memory_store=store
    args._default_timing_settings=defaults
    args._use_startup_defaults=False
    args._prompt_session_policy=False
    if "reset_session_on_400" not in common._preference_overrides:
        args.reset_session_on_400=defaults["reset_session_on_400"]
    poll.select_mode(args)
    poll.apply_configuration(args)
    poll.refresh_connection(args)
    poll.restore_timing(args,store)
    poll.restore_request_settings(args,store)
    args.prompts=common.prompts
    args.notification=notify.validate(getattr(common,"notification_defaults",None))
    if not common.show_config:
        if args.mode=="api" and not getattr(args,"_from_saved",False):
            with ui.cooked_keyboard_mode():poll.prepare_api(args)
        poll.remember_api(args,store,name=common.save_as,make_default=False)
    args.max_inflight=common.task_inflight or defaults.get("max_inflight",1)
    args.task_inflight=args.max_inflight
    return args


def start_workspace(poll, common):
    import sys
    store=common._memory_store
    common.notification_defaults=store.load_notification_defaults() if store and not common.show_config else notify.validate()
    interactive=bool(sys.stdin.isatty() and sys.stdout.isatty())
    saved=store.load_workspace() if store else None
    if common.setup and not common._explicit_connection and not common.task:
        saved=None
    saved=validate_workspace(saved) if saved else legacy_workspace(store)
    group=copy.deepcopy(saved) if saved else {"version":1,"concurrency":8,"defaults":copy.deepcopy(TEMPLATE_DEFAULTS),"tasks":[]}
    should_save=False
    resolved=[]
    direct=bool(common._explicit_connection or common.task)
    if common.setup and not direct:
        group["tasks"]=[]
    elif interactive and saved and not direct and not common.settings and not common.show_config:
        enabled=sum(t["enabled"] for t in group["tasks"])
        summary=f"已保存 {len(group['tasks'])} 个任务，{enabled} 个启用。确认后才发送请求。"
        with ui.mouse_mode(ui.terminal,common.mouse is not False):
            choice=ui.choose("是否沿用已保存配置？",[
                ("1","沿用已保存的任务组",summary),("2","不沿用，重新选择任务","已保存 API 与历史记录保留"),
                ("0","退出","不发送请求")],default="1",cancel="0",blank="1",subtitle=summary)
        if choice=="0":return 130
        if choice=="2":group["tasks"]=[]
        else:should_save=True
    elif saved and not common.setup:
        should_save=not common.show_config and not common.settings
    if direct:
        group["tasks"]=[]
        if common._explicit_connection:
            with ui.mouse_mode(ui.terminal,common.mouse is not False):
                args=prepare_explicit(poll,common,store,group["defaults"])
            spec=make_spec(args,1,getattr(args,"api_name",None),enabled=True)
            group["tasks"].append(spec);resolved.append(args)
        for reference in common.task or []:
            if store is None:raise ValueError("--task 需要开启记忆并使用已保存 API")
            profile=store.load_profile(reference)
            args=choose_connection(poll,common,store,group["defaults"],profile["id"])
            spec=make_spec(args,len(group["tasks"])+1,profile["name"],enabled=True)
            group["tasks"].append(spec);resolved.append(args)
        should_save=not common.show_config and not common.settings
    if common.concurrency is not None:group["concurrency"]=common.concurrency
    for field in ("display","color","start_paused"):
        if field not in common._preference_overrides:setattr(common,field,group["defaults"][field])
    ui.terminal.color_mode=common.color
    if common.count<0:raise ValueError("--count 不能小于 0")
    group=validate_workspace(group)
    if common.show_config:
        print(f"版本：{poll.VERSION}\n任务组：{len(group['tasks'])} 个任务 | 总同时请求上限：{group['concurrency']}")
        for index,spec in enumerate(group["tasks"]):
            public=store.load_task_snapshot(spec["id"],public_only=True) if store else None
            if not public:public=store.profile_settings(spec["api_id"]) if store and spec["api_id"] else {}
            public=public or {}
            if direct and index<len(resolved):
                public={**public,"base_url":resolved[index].base_url,"model":resolved[index].model}
            print(f"T{spec['number']:02d} {ui.clean(spec['name'])} | {ui.clean(public.get('base_url','Codex 当前配置'))} | "
                  f"{ui.clean(spec['options'].get('model') or public.get('model','跟随配置'))} | "
                  f"{'启用' if spec['enabled'] else '暂停'}")
        print("交互启动先确认是否沿用；密钥不显示。")
        return 0
    if not direct:
        for spec in group["tasks"]:
            try:
                args=resolve_task(poll,common,store,spec,persist=should_save and not common.settings)
                for name in (*common._timing_overrides,*common._request_overrides):
                    spec["options"][name]=getattr(args,name)
                if common.task_inflight is not None:spec["options"]["max_inflight"]=common.task_inflight
                resolved.append(args)
            except (ValueError,OSError) as exc:
                resolved.append((None,str(exc)))
    if not interactive and not group["tasks"] and not common.settings:
        raise ValueError("没有可运行任务，请先交互新增任务，或使用 --multi --task API名称")
    if common.start_paused and not interactive and not common.settings:
        raise ValueError("后台运行不能先暂停，请加 --no-start-paused")
    if should_save and store:store.save_workspace(group)
    logfile=None
    engine=None
    try:
        if common.log_file and not common.settings:
            common.log_file.parent.mkdir(parents=True,exist_ok=True)
            logfile=common.log_file.open("a",encoding="utf-8")
        engine=Runtime(poll,common,group,resolved,store=store,logfile=logfile)
        board=Board(engine)
        if common.settings:
            if not interactive:raise ValueError("--settings 需要交互终端")
            with ui.mouse_mode(ui.terminal,common.mouse is not False):
                while True:
                    choice=ui.choose("默认设置",[(x,x) for x in ("启动","时间模板","请求与并发","通知","显示")]+[("0","退出设置")],
                                     default="启动",cancel="0",blank="0",subtitle="修改模板，不发送生成请求")
                    if choice=="0":return 0
                    board.setting_section=choice;board.edit_defaults()
        return board.run()
    finally:
        if engine:engine.stop()
        if logfile:logfile.close()
