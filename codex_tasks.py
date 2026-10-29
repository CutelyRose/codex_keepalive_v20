"""Independent, bounded probe/keepalive jobs for a shared terminal workspace."""
from __future__ import annotations

import argparse
from collections import deque
import copy
from dataclasses import dataclass, field
from datetime import datetime
import math
import queue
import threading
import time
import uuid

from codex_memory import TIMING_DEFAULTS, connection_key
from codex_client import REQUEST_DEFAULTS, TOOL_MODES
import codex_notify as notify

OPTION_FIELDS = (*TIMING_DEFAULTS, *REQUEST_DEFAULTS, "model", "api_style", "stream",
                 "token_param", "reset_session_on_400", "max_inflight", "prompts")
TEMPLATE_DEFAULTS = {**TIMING_DEFAULTS, **REQUEST_DEFAULTS, "reset_session_on_400": True,
                     "max_inflight": 1, "display": "auto", "color": "auto", "start_paused": False}


def _positive(value, label, integer=False):
    if isinstance(value, bool):
        raise ValueError(f"{label}必须是正数")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}必须是正数") from None
    if not math.isfinite(number) or number <= 0 or (integer and number != int(number)):
        raise ValueError(f"{label}必须是正数")
    return int(number) if integer else number


def validate_options(raw):
    if not isinstance(raw, dict):
        raise ValueError("任务设置格式无效")
    values = {name: copy.deepcopy(raw[name]) for name in OPTION_FIELDS if name in raw and raw[name] is not None}
    for name in TIMING_DEFAULTS:
        if name in values:
            values[name] = _positive(values[name], name)
    if values.get("success_interval", 0) > values.get("success_interval_max", math.inf):
        raise ValueError("保活最短间隔不能大于最长间隔")
    for name in ("max_tokens", "max_inflight"):
        if name in values:
            values[name] = _positive(values[name], name, True)
    if values.get("max_inflight", 1) > 64:
        raise ValueError("单任务同时请求上限不能超过 64")
    if "model" in values and (not isinstance(values["model"], str) or not values["model"].strip()):
        raise ValueError("模型名称不能为空")
    if values.get("api_style", "responses") not in ("chat", "responses"):
        raise ValueError("接口格式无效")
    if values.get("tool_mode", "client") not in TOOL_MODES:
        raise ValueError("工具格式无效")
    if values.get("token_param", "auto") not in ("auto", "max_tokens", "max_completion_tokens", "max_output_tokens", "none"):
        raise ValueError("输出上限字段无效")
    for name in ("stream", "reset_session_on_400"):
        if name in values and type(values[name]) is not bool:
            raise ValueError(f"{name}必须是是或否")
    if "prompts" in values:
        prompts = values["prompts"]
        if not isinstance(prompts, (list, tuple)) or not 1 <= len(prompts) <= 2000 or any(
                not isinstance(p, str) or not p.strip() or len(p) > 10000 for p in prompts):
            raise ValueError("自定义问题列表无效")
        values["prompts"] = list(prompts)
    return values


def validate_workspace(raw):
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ValueError("任务组格式无效，请重新选择任务")
    concurrency = _positive(raw.get("concurrency", 8), "总并发", True)
    if concurrency > 64:
        raise ValueError("总同时请求上限不能超过 64")
    entries = raw.get("tasks", [])
    if not isinstance(entries, list) or len(entries) > 128:
        raise ValueError("一个任务组最多保存 128 个任务")
    tasks, ids, numbers = [], set(), set()
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("任务条目无效")
        task_id, name, api_id = item.get("id"), item.get("name"), item.get("api_id")
        number = _positive(item.get("number"), "任务编号", True)
        if (not isinstance(task_id, str) or not task_id or len(task_id) > 64 or task_id in ids
                or number in numbers or number > 99999):
            raise ValueError("任务 ID 或编号无效、重复")
        if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
            raise ValueError("任务名称须为 1–80 个可显示字符")
        if api_id is not None and (not isinstance(api_id, str) or len(api_id) > 128):
            raise ValueError("API 引用无效")
        if type(item.get("enabled", True)) is not bool:
            raise ValueError("任务启用状态无效")
        source = item.get("source", "saved")
        if source not in ("saved", "codex"):
            raise ValueError("任务连接来源无效")
        for name_field in ("codex_config", "profile"):
            if item.get(name_field) is not None and not isinstance(item[name_field], str):
                raise ValueError("Codex 配置引用无效")
        tasks.append({"id": task_id, "number": number, "name": name.strip(), "api_id": api_id,
                      "enabled": item.get("enabled", True), "source": source,
                      "codex_config": item.get("codex_config"), "profile": item.get("profile"),
                      "options": validate_options(item.get("options", {}))})
        ids.add(task_id)
        numbers.add(number)
    template = raw.get("defaults", {})
    if not isinstance(template, dict):
        raise ValueError("默认模板无效")
    defaults = {**TEMPLATE_DEFAULTS,
                **{key: value for key, value in validate_options(template).items() if key in TEMPLATE_DEFAULTS}}
    for key in ("display", "color", "start_paused"):
        if key in template:
            defaults[key] = template[key]
    if defaults["display"] not in ("auto", "dashboard", "compact", "verbose"):
        raise ValueError("显示选项无效")
    if defaults["color"] not in ("auto", "always", "never") or type(defaults["start_paused"]) is not bool:
        raise ValueError("默认启动或颜色选项无效")
    return {"version": 1, "concurrency": concurrency, "defaults": defaults, "tasks": tasks}


def make_spec(args, number=1, name=None, *, task_id=None, enabled=True):
    source = getattr(args, "connection_source", "saved")
    options = {key: getattr(args, key) for key in OPTION_FIELDS if hasattr(args, key)}
    options["max_inflight"] = getattr(args, "task_inflight", None) or 1
    # Follow current Codex model/provider only for tasks explicitly bound to that file.
    if source == "codex":
        for key in ("model", "api_style", "stream"):
            options.pop(key, None)
    options.pop("prompts", None)
    spec = {"id": task_id or str(uuid.uuid4()), "number": number,
            "name": name or getattr(args, "api_name", None) or args.model,
            "api_id": getattr(args, "api_id", None), "enabled": enabled, "source": source,
            "codex_config": str(args.codex_config) if getattr(args, "codex_config", None) else None,
            "profile": getattr(args, "profile", None), "options": options}
    return validate_workspace({"version": 1, "tasks": [spec]})["tasks"][0]


def resolve_task(poll, common, store, spec, *, persist=False):
    """Resolve a profile snapshot without making a model or catalog request."""
    args = poll.copy_settings(common)
    args.api_key, args.model, args.base_url = None, None, None
    args.api_id, args.api_name = spec["api_id"], spec["name"]
    args.no_codex_config = False
    args.api_style, args.stream = "auto", None
    args.extra_headers, args.query_params, args.secrets = {}, {}, []
    frozen = store.load_task_snapshot(spec["id"]) if store else None
    if frozen:
        for key, value in frozen.items():
            if value is not None:
                setattr(args, key, copy.deepcopy(value))
        args.connection_source = "saved"
        args.config_source, args.key_source = "任务独立配置：" + spec["name"], "任务独立凭据"
        if not args.api_key:
            raise ValueError("此任务的密钥不可用，请单独修改任务连接")
    elif spec["source"] == "codex":
        from pathlib import Path
        args.mode = "codex"
        args.codex_config = Path(spec["codex_config"]) if spec.get("codex_config") else None
        args.profile = spec.get("profile")
        poll.apply_configuration(args)
    else:
        if store is None or not spec["api_id"]:
            raise ValueError("此任务没有可读取的已保存 API")
        saved = store.load_profile(spec["api_id"])
        for key, value in saved["settings"].items():
            if value is not None:
                setattr(args, key, copy.deepcopy(value))
        args.api_name = saved["name"]
        args.connection_source = "saved"
        args.config_source, args.key_source = "已保存 API：" + saved["name"], "本地记忆"
    values = spec["options"]
    for key, value in values.items():
        if key != "prompts":
            setattr(args, key, copy.deepcopy(value))
    for key, value in getattr(common, "_timing_overrides", {}).items():
        setattr(args, key, value)
    for key, value in getattr(common, "_request_overrides", {}).items():
        setattr(args, key, value)
    if "reset_session_on_400" in getattr(common, "_preference_overrides", set()):
        args.reset_session_on_400 = common.reset_session_on_400
    args.prompts = list(getattr(common, "prompt", None) or values.get("prompts") or
                        (frozen or {}).get("prompts") or poll.DEFAULT_PROMPTS)
    args.notification = notify.validate((frozen or {}).get("notification") if frozen else
                                         getattr(common, "notification_defaults", None))
    args.max_inflight = getattr(common, "task_inflight", None) or values.get("max_inflight", 1)
    poll.refresh_connection(args)
    args.secrets += notify.secrets(args.notification)
    if not args.model:
        raise ValueError("任务没有配置模型")
    # Validate effective values, including migrated/default values.
    validated = validate_options({k: getattr(args, k) for k in OPTION_FIELDS if hasattr(args, k)})
    if args.success_interval > args.success_interval_max:
        raise ValueError("保活最短间隔不能大于最长间隔")
    for key, value in validated.items():
        setattr(args, key, value)
    if persist and store and not frozen:
        poll.remember_api(args, store, make_default=False)
        spec["api_id"] = args.api_id
    args.controls = False
    return args


@dataclass
class Task:
    spec: dict
    args: object | None
    error: str = ""
    paused: bool = False
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    sessions: dict = field(default_factory=dict)
    key: str = ""
    revision: int = 0
    launched: int = 0
    next_emit: int = 1
    latest: int = 0
    total: int = 0
    successes: int = 0
    status: int | None = None
    latest_error: str = ""
    answer: str = ""
    duration: float = 0
    last_send: float | None = None
    next_due: float = 0
    interval: float = 2
    single: bool = False
    force_due: bool = False
    queued: bool = False
    awaiting: dict = field(default_factory=dict)
    ready: dict = field(default_factory=dict)
    records: deque = field(default_factory=lambda: deque(maxlen=200))
    ever_live: bool = False
    notification_status: str = "已关闭"

    @property
    def id(self):
        return self.spec["id"]

    @property
    def label(self):
        return f"T{self.spec['number']:02d}"


class Runtime:
    """Scheduler thread owns completion order; UI changes take a short lock only."""

    def __init__(self, poll, common, workspace, resolved, *, store=None, logfile=None,
                 request=None, clock=time.monotonic, emit_text=False, notifier=None):
        self.poll, self.common, self.store, self.logfile = poll, common, store, logfile
        self.workspace = validate_workspace(workspace)
        self.limit = self.workspace["concurrency"]
        self.clock = clock
        self.request = request or poll.request_once
        self.emit_text = emit_text
        self.run_id = str(uuid.uuid4())
        self.started = clock()
        self.lock = threading.RLock()
        self.completed = queue.Queue()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.thread = None
        self.tasks = []
        self.workers = set()
        self.records = deque(maxlen=2000)
        self.events = deque(maxlen=200)
        self.cursor = 0
        self.failure = ""
        self.notifier = notifier or notify.Dispatcher()
        self.notification_message = ""
        self.count_limit = getattr(common, "count", 0)
        for spec, value in zip(self.workspace["tasks"], resolved):
            args, error = value if isinstance(value, tuple) else (value, "")
            self._add(spec, args, error, initially_paused=getattr(common, "start_paused", False))

    def _add(self, spec, args, error="", *, initially_paused=False):
        task = Task(copy.deepcopy(spec), args, error,
                    paused=not spec["enabled"] or initially_paused)
        task.next_due = self.clock()
        if args is not None:
            args.notification = notify.validate(getattr(args, "notification", None))
            args.secrets = list(getattr(args, "secrets", [])) + notify.secrets(args.notification)
            task.notification_status = "等待探活成功" if args.notification["enabled"] else "已关闭"
            task.interval = args.interval
            task.key = connection_key(vars(args))
            task.sessions[task.key] = task.session_id
        self.tasks.append(task)
        return task

    def _event(self, message, kind="info"):
        self.events.append({"time": datetime.now().astimezone().strftime("%H:%M:%S"),
                            "message": self.poll.redact(message, self.secrets()), "kind": kind})

    def find(self, task_id):
        return next((task for task in self.tasks if task.id == task_id), None)

    def persist(self):
        with self.lock:
            self.workspace["tasks"] = [copy.deepcopy(t.spec) for t in self.tasks]
            self.workspace["concurrency"] = self.limit
            if self.store:
                self.store.save_workspace(self.workspace, task_snapshots={t.id: t.args for t in self.tasks if t.args})

    def _save_specs(self, specs, *, task_snapshots=None):
        candidate = validate_workspace({**self.workspace, "tasks": specs, "concurrency": self.limit})
        if self.store:
            if task_snapshots:
                self.store.save_workspace(candidate, task_snapshots=task_snapshots)
            else:
                self.store.save_workspace(candidate)
        self.workspace = candidate

    def start(self):
        if self.thread is not None:
            return
        if self.tasks:
            self.persist()
        self.thread = threading.Thread(target=self._loop, name="keepalive-scheduler", daemon=True)
        self.thread.start()

    def _loop(self):
        try:
            while not self.stopping.is_set():
                self.step()
                self.wake.wait(.025)
                self.wake.clear()
        except Exception as exc:
            with self.lock:
                self.failure = self.poll.redact(f"{type(exc).__name__}: {exc}", self.secrets())
            self.stopping.set()

    def secrets(self):
        return list({str(value) for t in self.tasks if t.args for value in getattr(t.args, "secrets", []) if value})

    def _work(self, task_id, revision, job):
        try:
            result = self.request(job.settings, job)
        except Exception as exc:
            result = self.poll.Result(job, self.clock(), None, error=f"{type(exc).__name__}: {exc}")
        self.completed.put((task_id, revision, result))
        self.wake.set()

    def _accept(self, task, revision, result):
        number = result.job.number
        if number not in task.awaiting:
            return
        del task.awaiting[number]
        task.ready[number] = result
        if revision != task.revision:
            return
        if result.status == 400:
            if result.job.settings.reset_session_on_400 and result.job.session_id == task.session_id:
                task.session_id = str(uuid.uuid4())
                task.sessions[task.key] = task.session_id
                result.error += "；此任务已更新会话 ID：" + task.session_id
                self._event(f"{task.label} HTTP 400，已更新该任务的会话", "warning")
            elif not result.job.settings.reset_session_on_400:
                result.error += "；保留该任务的会话 ID"
        if number <= task.latest:
            return
        was_live = task.status == 200
        task.latest, task.status = number, result.status
        task.latest_error, task.answer = result.error, result.text
        task.duration = max(0, result.finished - result.job.started)
        if result.status == 200:
            config = notify.validate(task.args.notification)
            kind = "first_success" if not task.ever_live else "recovery" if not was_live else None
            task.ever_live = True
            if kind and config["enabled"] and config[kind]:
                title = "首次探活成功" if kind == "first_success" else "探活恢复成功"
                text = (f"✅ {title}\n任务：{task.label} · {task.spec['name']}\n模型：{task.args.model}\n"
                        f"状态：HTTP 200 · {'已暂停' if task.paused else '已进入保活'}\n响应耗时：{task.duration:.2f} 秒\n"
                        f"保活范围：{task.args.success_interval:g}–{task.args.success_interval_max:g} 秒\n"
                        f"时间：{datetime.now().astimezone().strftime('%m-%d %H:%M:%S')}")
                if result.error:
                    text += "\n提示：" + self.poll.ui.short_result(result.text, result.error)
                task.notification_status = self.notifier.submit(task.id, task.revision, config,
                                                                 self.poll.redact(text, self.secrets()))
        interval = (task.interval if was_live else self.poll.sample_keepalive_interval(task.args)) if result.status == 200 else task.args.interval
        if interval != task.interval or was_live != (result.status == 200):
            task.interval = interval
            task.next_due = max((task.last_send if task.last_send is not None else self.clock()) + interval, self.clock())
        if task.single or task.force_due:
            task.next_due = self.clock()

    def _emit(self, task, result):
        class Sink:
            def add(_, record):
                task.records.append(record)
                self.records.append(record)
                if self.emit_text:
                    summary = self.poll.ui.clean(record.get("answer") or record.get("error") or "无文字结果")
                    code = record.get("http_status") or "TIMEOUT"
                    print(f"[{task.label} #{record['request_id']:06d}] HTTP {code} | {record['duration_seconds']:.2f}s | {summary[:180]}", flush=True)
        self.poll.print_result(result, result.job.settings, self.logfile, self.store,
                               self.run_id + ":" + task.id, display=Sink())
        task.total += 1
        task.successes += result.status == 200
        if result.status != 200 or result.error:
            message = self.poll.ui.short_result(result.text, result.error)
            message = self.poll.redact(message, result.job.settings.secrets)
            self._event(f"{task.label} {result.status or '超时'} · {message[:80]}", "error" if result.status != 200 else "warning")

    def step(self):
        with self.lock:
            self.collect_notifications()
            while True:
                try:
                    task_id, revision, result = self.completed.get_nowait()
                except queue.Empty:
                    break
                self.workers.discard((task_id, result.job.number))
                task = self.find(task_id)
                if task is None:
                    continue
                limit = result.job.settings.timeout
                if result.finished - result.job.started >= limit:
                    result = self.poll.Result(result.job, result.job.started + limit, None,
                        error=f"请求超过 {limit:g} 秒总时限", usage=result.usage,
                        tool_calls=result.tool_calls, http_requests=result.http_requests)
                self._accept(task, revision, result)
            now = self.clock()
            for task in self.tasks:
                for number, (job, revision) in list(task.awaiting.items()):
                    if now >= job.started + job.settings.timeout:
                        self._accept(task, revision, self.poll.Result(
                            job, job.started + job.settings.timeout, None,
                            error=f"请求超过 {job.settings.timeout:g} 秒总时限"))
                while task.next_emit in task.ready:
                    self._emit(task, task.ready.pop(task.next_emit))
                    task.next_emit += 1
                task.queued = False
            if self.stopping.is_set() or not self.tasks:
                return
            order = self.tasks[self.cursor:] + self.tasks[:self.cursor]
            for task in order:
                if not task.args or task.error or (task.paused and not task.single):
                    continue
                if self.count_limit and task.launched >= self.count_limit:
                    continue
                if now < task.next_due:
                    continue
                occupied = sum(key[0] == task.id for key in self.workers)
                pending_window = task.launched - task.next_emit + 1
                per_task = task.args.max_inflight
                if len(self.workers) >= self.limit or occupied >= per_task or pending_window >= per_task:
                    task.queued = True
                    continue
                task.launched += 1
                args = self.poll.copy_settings(task.args)
                job = self.poll.Job(task.launched, args.prompts[(task.launched - 1) % len(args.prompts)],
                    datetime.now().astimezone().isoformat(timespec="milliseconds"), now, task.session_id,
                    settings=args, phase="单次探活" if task.single else "保活" if task.status == 200 else "探活",
                    task_id=task.id, task_name=task.spec["name"], task_label=task.label)
                task.awaiting[job.number] = (job, task.revision)
                self.workers.add((task.id, job.number))
                task.single, task.force_due, task.last_send = False, False, now
                if task.status == 200:
                    task.interval = self.poll.sample_keepalive_interval(task.args)
                else:
                    task.interval = task.args.interval
                task.next_due = now + task.interval
                threading.Thread(target=self._work, args=(task.id, task.revision, job), daemon=True).start()
                self.cursor = (self.tasks.index(task) + 1) % len(self.tasks)

    def pause(self, task_id=None):
        with self.lock:
            specs = [copy.deepcopy(t.spec) for t in self.tasks]
            for spec in specs:
                if task_id is None or spec["id"] == task_id:
                    spec["enabled"] = False
            self._save_specs(specs)
            for task in self.tasks:
                if task_id is None or task.id == task_id:
                    task.paused, task.single, task.force_due, task.spec["enabled"] = True, False, False, False
                    self._event(f"{task.label} 已暂停")
        self.wake.set()

    def resume(self, task_id=None):
        with self.lock:
            specs = [copy.deepcopy(t.spec) for t in self.tasks]
            for spec, task in zip(specs, self.tasks):
                if (task_id is None or task.id == task_id) and not task.error:
                    spec["enabled"] = True
            self._save_specs(specs)
            for task in self.tasks:
                if (task_id is None or task.id == task_id) and not task.error:
                    task.paused, task.single, task.force_due, task.spec["enabled"] = False, False, True, True
                    task.next_due = self.clock()
                    self._event(f"{task.label} 已继续")
        self.wake.set()

    def probe(self, task_id):
        with self.lock:
            task = self.find(task_id)
            if task is None or task.error:
                raise ValueError("请先修复任务连接配置")
            if self.count_limit and task.launched >= self.count_limit:
                raise ValueError("此任务已达到本次 --count 上限，请重新启动运行")
            specs = [copy.deepcopy(t.spec) for t in self.tasks]
            for spec in specs:
                if spec["id"] == task_id:
                    spec["enabled"] = False
            self._save_specs(specs)
            task.paused, task.single, task.spec["enabled"] = True, True, False
            task.next_due = self.clock()
        self.wake.set()

    def add(self, spec, args):
        with self.lock:
            args.notification = notify.validate(getattr(args, "notification", getattr(self.common, "notification_defaults", None)))
            self._save_specs([t.spec for t in self.tasks] + [spec], task_snapshots={spec["id"]: args})
            task = self._add(spec, args)
            self._event(f"{task.label} 已添加")
        self.wake.set()
        return task.id

    def update(self, task_id, spec, args):
        with self.lock:
            task = self.find(task_id)
            if task is None:
                raise ValueError("任务已不存在")
            spec = validate_workspace({"version": 1, "tasks": [spec]})["tasks"][0]
            if spec["id"] != task.id or spec["number"] != task.spec["number"]:
                raise ValueError("编辑不能更改任务 ID 或编号")
            args.notification = notify.validate(getattr(args, "notification", None))
            args.secrets = list(getattr(args, "secrets", [])) + notify.secrets(args.notification)
            self._save_specs([spec if t.id == task_id else t.spec for t in self.tasks], task_snapshots={task_id: args})
            if args.notification != getattr(task.args, "notification", None):
                task.ever_live = False
            task.revision += 1
            self.notifier.set_revision(task.id, task.revision)
            task.notification_status = "等待下次成功事件" if args.notification["enabled"] else "已关闭"
            new_key = connection_key(vars(args))
            if new_key != task.key:
                task.key = new_key
                task.session_id = task.sessions.setdefault(new_key, str(uuid.uuid4()))
                task.status, task.latest_error, task.answer, task.latest = None, "", "", 0
                task.ever_live = False
            task.spec, task.args, task.error = copy.deepcopy(spec), args, ""
            task.paused = not spec["enabled"]
            task.interval = self.poll.sample_keepalive_interval(args) if task.status == 200 else args.interval
            task.next_due = self.clock()
            self._event(f"{task.label} 配置已更新")
        self.wake.set()

    def remove(self, task_id):
        with self.lock:
            task = self.find(task_id)
            if task is None:
                return
            self._save_specs([t.spec for t in self.tasks if t.id != task_id])
            self.notifier.set_revision(task_id, None)
            self._cancel_pending(task, "任务已移除；本地不再等待结果")
            self.tasks.remove(task)
            self.cursor = 0
            self._event(f"{task.label} 已移除，记录与 API 保留")

    def _cancel_pending(self, task, reason):
        for number, (job, revision) in list(task.awaiting.items()):
            self._accept(task, revision, self.poll.Result(job, self.clock(), None, error=reason))
        while task.next_emit in task.ready:
            self._emit(task, task.ready.pop(task.next_emit))
            task.next_emit += 1

    def finished(self):
        with self.lock:
            return bool(self.count_limit) and all(
                (t.launched >= self.count_limit or t.error or (not t.spec["enabled"] and not t.single)) and not t.awaiting
                for t in self.tasks)

    def snapshot(self):
        with self.lock:
            self.collect_notifications()
            now = self.clock()
            rows = []
            for task in self.tasks:
                args = task.args
                inflight = sum(key[0] == task.id for key in self.workers)
                if task.error:
                    phase = "配置异常"
                elif task.single or (inflight and not task.latest and not task.paused):
                    phase = "请求中"
                elif self.count_limit and task.launched >= self.count_limit and not task.awaiting:
                    phase = "已完成"
                elif task.paused:
                    phase = "已暂停"
                elif task.queued:
                    phase = "等待空位"
                else:
                    phase = "保活中" if task.status == 200 else "探活中"
                rows.append({"id": task.id, "label": task.label, "name": task.spec["name"],
                    "api_id": task.spec["api_id"], "model": getattr(args, "model", "未配置"),
                    "api_name": getattr(args, "api_name", ""), "endpoint": getattr(args, "display_endpoint", ""),
                    "api_style": getattr(args, "api_style", ""), "phase": phase, "paused": task.paused,
                    "status": task.status, "error": task.error or task.latest_error, "answer": task.answer,
                    "next": None if task.paused or task.error or phase == "已完成" else max(0, math.ceil(task.next_due - now)),
                    "interval": task.interval, "probe": getattr(args, "interval", 2),
                    "minimum": getattr(args, "success_interval", 60), "maximum": getattr(args, "success_interval_max", 90),
                    "timeout": getattr(args, "timeout", 30), "max_tokens": getattr(args, "max_tokens", 128),
                    "tool_mode": getattr(args, "tool_mode", "client"), "reset": getattr(args, "reset_session_on_400", True),
                    "session_id": task.session_id, "total": task.total, "successes": task.successes,
                    "duration": task.duration, "inflight": inflight, "spec": copy.deepcopy(task.spec),
                    "notification_status": task.notification_status})
            return {"tasks": rows, "inflight": len(self.workers), "limit": self.limit,
                    "elapsed": now - self.started, "events": list(self.events),
                    "records": list(self.records), "failure": self.failure}

    def stop(self):
        self.stopping.set()
        self.notifier.stop()
        self.wake.set()
        if self.thread and threading.current_thread() is not self.thread:
            self.thread.join(timeout=2)
        with self.lock:
            for task in self.tasks:
                self._cancel_pending(task, "用户停止；本地不再等待结果")

    def collect_notifications(self):
        while True:
            try:
                task_id, revision, status = self.notifier.results.get_nowait()
            except queue.Empty:
                break
            task = self.find(task_id)
            if task_id == "notification-test":
                self.notification_message = "测试通知：" + status
                self._event(self.notification_message, "warning" if "失败" in status else "info")
            elif task and task.revision == revision:
                task.notification_status = status
                self._event(task.label + " 通知：" + status, "warning" if "失败" in status else "info")
