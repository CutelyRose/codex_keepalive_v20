"""Telegram notifications with bounded, independent delivery and no model calls."""
from __future__ import annotations

import copy
from dataclasses import dataclass
import hashlib
import json
import math
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULTS = {"enabled": False, "bot_token": "", "chat_id": "", "proxy_url": "",
            "first_success": True, "recovery": True, "cooldown": 300.0}


def validate(raw=None):
    if raw is not None and not isinstance(raw, dict):
        raise ValueError("Telegram 通知配置格式无效")
    values = {**DEFAULTS, **{k: v for k, v in (raw or {}).items() if k in DEFAULTS}}
    for key in ("enabled", "first_success", "recovery"):
        if type(values[key]) is not bool:
            raise ValueError("通知开关必须是是或否")
    for key in ("bot_token", "chat_id", "proxy_url"):
        if not isinstance(values[key], str):
            raise ValueError("通知连接设置必须是文本")
        values[key] = values[key].strip()
    if values["bot_token"] and not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]{20,}", values["bot_token"]):
        raise ValueError("Bot Token 格式不正确，请填写 BotFather 提供的完整 Token")
    if values["chat_id"] and not re.fullmatch(r"-?[0-9]+|@[A-Za-z][A-Za-z0-9_]{4,}", values["chat_id"]):
        raise ValueError("Chat ID 应为数字（群组可带负号）或 @频道用户名")
    if values["proxy_url"]:
        parsed = urllib.parse.urlsplit(values["proxy_url"])
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("代理地址需要以 http:// 或 https:// 开头")
    try:
        cooldown = float(values["cooldown"])
    except (ValueError, TypeError):
        raise ValueError("通知冷却时间必须是非负秒数") from None
    if isinstance(values["cooldown"], bool) or not math.isfinite(cooldown) or cooldown < 0:
        raise ValueError("通知冷却时间必须是非负秒数")
    values["cooldown"] = cooldown
    if values["enabled"] and not (values["bot_token"] and values["chat_id"]):
        raise ValueError("启用 Telegram 前请填写 Bot Token 和 Chat ID")
    return values


def secrets(settings):
    return [str(settings.get(k, "")) for k in ("bot_token", "proxy_url") if settings.get(k)]


def redact(text, settings):
    for value in secrets(settings):
        text = str(text).replace(value, "[通知凭据已隐藏]")
    return str(text)


class DeliveryError(Exception):
    def __init__(self, message, *, retryable=False, retry_after=0):
        super().__init__(message)
        self.retryable, self.retry_after = retryable, retry_after


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call_api(settings, method, payload):
    settings = validate(settings)
    if not settings["bot_token"]:
        raise ValueError("请先保存 Bot Token")
    if method not in ("sendMessage", "getUpdates"):
        raise ValueError("不支持的 Telegram 操作")
    handlers = [NoRedirect()]
    if settings["proxy_url"]:
        handlers.append(urllib.request.ProxyHandler({"http": settings["proxy_url"], "https": settings["proxy_url"]}))
    request = urllib.request.Request("https://api.telegram.org/bot" + settings["bot_token"] + "/" + method,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "codex-keepalive"}, method="POST")
    try:
        try:
            response = urllib.request.build_opener(*handlers).open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            data = response.read(1_000_001)
        if len(data) > 1_000_000:
            raise DeliveryError("Telegram 响应过大")
        try:
            result = json.loads(data)
        except (ValueError, UnicodeError):
            raise DeliveryError(f"Telegram HTTP {status}：响应格式无效", retryable=status >= 500) from None
        if not isinstance(result, dict):
            raise DeliveryError("Telegram 响应格式无效")
        if status != 200 or result.get("ok") is not True:
            code = result.get("error_code", status)
            try:
                retry_after = float((result.get("parameters") or {}).get("retry_after", 0))
                retry_after = min(86400, max(0, retry_after)) if math.isfinite(retry_after) else 0
            except (TypeError, ValueError, AttributeError):
                retry_after = 0
            description = redact(str(result.get("description", "发送失败")), settings)[:240]
            raise DeliveryError(f"Telegram {code}：{description}",
                                retryable=code == 429 or status >= 500, retry_after=retry_after)
        return result.get("result")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise DeliveryError(redact("Telegram 网络错误：" + str(error), settings), retryable=True) from None


def discover_chats(settings):
    updates = call_api({**settings, "enabled": False}, "getUpdates", {"timeout": 0, "limit": 30})
    chats = {}
    for item in updates if isinstance(updates, list) else []:
        if not isinstance(item, dict):
            continue
        message = item.get("message") or item.get("channel_post") or {}
        chat = message.get("chat", {}) if isinstance(message, dict) else {}
        if isinstance(chat, dict) and isinstance(chat.get("id"), int):
            chats[str(chat["id"])] = str(chat.get("title") or chat.get("username") or chat.get("first_name") or chat["id"])
    return list(chats.items())


@dataclass
class Notice:
    task_id: str
    revision: int
    settings: dict
    text: str
    due: float
    attempts: int = 0

    @property
    def destination(self):
        value = self.settings["bot_token"] + "\0" + self.settings["chat_id"] + "\0" + self.settings["proxy_url"]
        return hashlib.sha256(value.encode()).hexdigest()


class Dispatcher:
    def __init__(self, *, transport=None, clock=time.monotonic, merge_seconds=3, chat_interval=3):
        self.transport, self.clock = transport or call_api, clock
        self.merge_seconds, self.chat_interval = merge_seconds, chat_interval
        self.pending = []
        self.results = queue.Queue()
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.closed = False
        self.thread = None
        self.revisions = {}
        self.last_queued = {}
        self.next_destination = {}
        self.next_send = 0
        self.active = 0

    @property
    def pending_count(self):
        with self.lock:
            return len(self.pending) + self.active

    def finish_pending(self):
        with self.lock:
            for notice in self.pending:
                if notice.attempts == 0:
                    notice.due = min(notice.due, self.clock())
        self.wake.set()

    def set_revision(self, task_id, revision):
        with self.lock:
            self.revisions[task_id] = revision
            self.pending = [n for n in self.pending if n.task_id != task_id]

    def submit(self, task_id, revision, settings, text, *, test=False):
        settings = validate(settings)
        if not test and not settings["enabled"]:
            return "已关闭"
        if not settings["bot_token"] or not settings["chat_id"]:
            raise ValueError("请先保存 Bot Token 和 Chat ID")
        now = self.clock()
        with self.lock:
            if self.closed:
                return "已停止"
            if not test and now - self.last_queued.get(task_id, -math.inf) < settings["cooldown"]:
                return "冷却中，已合并提醒"
            if len(self.pending) >= 256:
                return "通知队列已满"
            self.revisions[task_id] = revision
            self.pending.append(Notice(task_id, revision, copy.deepcopy(settings), redact(text, settings)[:1800],
                                       now if test else now + self.merge_seconds))
            if not test:
                self.last_queued[task_id] = now
        self.start()
        self.wake.set()
        return "等待发送"

    def start(self):
        with self.lock:
            if self.closed or self.thread:
                return
            self.thread = threading.Thread(target=self._run, name="telegram-notifications", daemon=True)
            self.thread.start()

    def _run(self):
        while not self.closed:
            if not self.deliver():
                self.wake.wait(.1)
                self.wake.clear()

    def deliver(self):
        now = self.clock()
        with self.lock:
            if self.closed:
                return False
            if now < self.next_send:
                return False
            self.pending = [n for n in self.pending if self.revisions.get(n.task_id) == n.revision]
            ready = next((n for n in self.pending if n.due <= now and self.next_destination.get(n.destination, 0) <= now), None)
            if ready is None:
                return False
            batch, length = [], 0
            for item in self.pending:
                if (item.destination == ready.destination and item.due <= now and
                        length + len(item.text.encode("utf-16-le")) // 2 + 2 <= 3800):
                    batch.append(item)
                    length += len(item.text.encode("utf-16-le")) // 2 + 2
            selected = {id(n) for n in batch}
            self.pending = [n for n in self.pending if id(n) not in selected]
            self.next_destination[ready.destination] = now + self.chat_interval
            self.next_send = now + .05
            self.active = len(batch)
        error = None
        try:
            self.transport(ready.settings, "sendMessage", {"chat_id": ready.settings["chat_id"],
                "text": "\n\n".join(n.text for n in batch), "link_preview_options": {"is_disabled": True}})
        except Exception as caught:
            error = caught
        with self.lock:
            self.active = 0
            for item in batch:
                if self.closed or self.revisions.get(item.task_id) != item.revision:
                    continue
                if isinstance(error, DeliveryError) and error.retryable and item.attempts < 2 and len(self.pending) < 256:
                    item.attempts += 1
                    item.due = self.clock() + max(error.retry_after, 2 ** item.attempts)
                    self.pending.append(item)
                    status = f"等待重试 {item.attempts}/2"
                else:
                    status = "已提交 Telegram" if error is None else redact("发送失败：" + str(error), item.settings)[:260]
                self.results.put((item.task_id, item.revision, status))
        return True

    def stop(self):
        with self.lock:
            self.closed = True
            self.pending.clear()
        self.wake.set()
