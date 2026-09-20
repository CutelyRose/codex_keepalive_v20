#!/usr/bin/env python3
"""Fixed probe intervals and randomized keepalive, with ordered API results.

Python 3.11+, standard library only. Reuses Codex / CC Switch configuration.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import json
import math
import os
import queue
import random
import signal
import sqlite3
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
from codex_memory import MemoryStore, TIMING_DEFAULTS, connection_key, default_data_directory
import codex_ui as ui
import codex_client as client

VERSION = "3.1.0"
TIMING_LABELS = {"interval": "探活间隔（初始/失败）", "success_interval": "保活最短间隔（HTTP 200 后）",
                 "success_interval_max": "保活最长间隔（HTTP 200 后）",
                 "timeout": "单次请求超时"}
QUESTION_BANK = client.load_questions(Path(__file__).with_name("logic_questions.json"))
DEFAULT_PROMPTS = tuple(item["question"] for item in QUESTION_BANK)
MAX_BODY_BYTES = 1024 * 1024


class StopSignal(KeyboardInterrupt):
    def __init__(self, signum):
        self.signal_number = signum


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep the original HTTP status and never forward credentials on redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass
class Job:
    number: int
    prompt: str
    started_at: str
    started: float
    session_id: str
    settings: Any = None
    phase: str = "探活"
    task_id: str = ""
    task_name: str = ""
    task_label: str = ""


@dataclass
class Result:
    job: Job
    finished: float
    status: int | None
    text: str = ""
    error: str = ""
    usage: Any = None
    response_data: Any = None
    tool_calls: Any = None
    http_requests: int = 1


def positive_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise argparse.ArgumentTypeError("必须是大于 0 的有限数值")
    return result


def positive_int(value: str) -> int:
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("必须是大于 0 的整数")
    return result


def load_codex_config(path: Path, profile_name: str | None, key_override: str | None) -> dict:
    path = path.expanduser()
    config = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    profile_name = profile_name or config.get("profile")
    profile = {}
    if profile_name:
        profiles = config.get("profiles", {})
        if profile_name not in profiles:
            raise ValueError(f"Codex 配置中没有 profile：{profile_name}")
        profile = profiles[profile_name]
    provider_name = profile.get("model_provider", config.get("model_provider", "openai"))
    provider = config.get("model_providers", {}).get(provider_name, {})
    base_url = provider.get("base_url")
    if not base_url and provider_name == "openai":
        base_url = config.get("openai_base_url", "https://api.openai.com/v1")
    if not base_url:
        raise ValueError(f"Codex 服务商 {provider_name} 没有配置 base_url")

    headers = dict(provider.get("http_headers", {}))
    for name, env_name in provider.get("env_http_headers", {}).items():
        if os.getenv(env_name):
            headers[name] = os.environ[env_name]

    key, key_source = key_override, "--api-key"
    if not key:
        key = provider.get("experimental_bearer_token")
        key_source = "Codex 服务商配置"
    if not key and provider.get("env_key"):
        env_name = provider["env_key"]
        key, key_source = os.getenv(env_name), f"环境变量 {env_name}"
        if not key:
            raise ValueError(f"Codex 服务商需要环境变量 {env_name}，当前未设置")
    if not key:
        authorization = next((str(value) for name, value in headers.items()
                              if name.lower() == "authorization"), "")
        if authorization.lower().startswith("bearer "):
            key, key_source = authorization[7:].strip(), "Codex 服务商请求头"
    if not key:
        auth_path = path.parent / "auth.json"
        if auth_path.exists():
            auth = json.loads(auth_path.read_text(encoding="utf-8-sig"))
            key, key_source = auth.get("OPENAI_API_KEY"), "Codex auth.json"
    if not key and (provider_name == "openai" or provider.get("requires_openai_auth")):
        key, key_source = os.getenv("OPENAI_API_KEY"), "环境变量 OPENAI_API_KEY"
    if not key:
        raise ValueError("当前 Codex 配置中没有可用的 API 密钥；可用 --api-key 指定")

    wire_api = provider.get("wire_api", "responses")
    if wire_api not in ("responses", "chat", "chat_completions"):
        raise ValueError(f"暂不支持 Codex wire_api：{wire_api}")
    return {
        "base_url": base_url,
        "api_key": key,
        "model": profile.get("model", config.get("model")),
        "api_style": "responses" if wire_api == "responses" else "chat",
        "headers": headers,
        "query_params": provider.get("query_params", {}),
        "source": f"{path}（服务商：{provider_name}）",
        "key_source": key_source,
    }


def apply_configuration(args: argparse.Namespace) -> None:
    saved = getattr(args, "_saved_settings", None)
    if saved:
        key_override, model_override = args.api_key, args.model
        for name, value in saved["settings"].items():
            if name not in TIMING_DEFAULTS and name not in client.REQUEST_DEFAULTS:
                setattr(args, name, copy.deepcopy(value))
        args.api_key = key_override or args.api_key
        args.model = model_override or args.model
        if not args.api_key and sys.stdin.isatty():
            args.api_key = getpass.getpass("此环境未保存可用密钥，请输入 API 密钥：").strip()
        args.config_source, args.key_source = "已保存 API：" + saved["name"], "本地记忆"
        args.api_id, args.api_name = saved["id"], saved["name"]
        args.connection_source = "saved"
        args._from_saved = True
        args.secrets = []
        return
    codex_root = Path(os.getenv("CODEX_HOME") or Path.home() / ".codex").expanduser()
    config_path = args.codex_config or codex_root / "config.toml"
    if args.codex_config and (args.base_url or args.no_codex_config):
        raise ValueError("--codex-config 不能与 --base-url 或 --no-codex-config 同时使用")
    use_codex = args.mode == "codex"
    args.extra_headers, args.query_params = {}, {}
    if use_codex:
        args.connection_source = "saved" if args.api_key or args.model else "codex"
        config = load_codex_config(config_path, args.profile, args.api_key)
        args.base_url = config["base_url"]
        args.api_key = config["api_key"]
        args.model = args.model or config["model"]
        if args.api_style == "auto":
            args.api_style = config["api_style"]
        args.extra_headers = config["headers"]
        args.query_params = config["query_params"]
        args.config_source, args.key_source = config["source"], config["key_source"]
    else:
        args.connection_source = "saved"
        args.base_url = args.base_url or os.getenv("OPENAI_BASE_URL")
        args.api_key = args.api_key or os.getenv("OPENAI_API_KEY")
        args.model = args.model or os.getenv("OPENAI_MODEL")
        if sys.stdin.isatty() and not args.show_config:
            if not args.base_url:
                args.base_url = input("API 调用地址：https://… 或完整接口地址\n> ").strip()
            if not args.api_key:
                args.api_key = getpass.getpass("API 密钥（输入时不显示）：").strip()
        args.config_source = "手动参数 / 环境变量"
        args.key_source = "--api-key / OPENAI_API_KEY"
    args.secrets = [str(value) for value in
                    [args.api_key, *args.extra_headers.values(), *args.query_params.values()]
                    if value]


def apply_startup_defaults(args: argparse.Namespace, store: MemoryStore | None) -> None:
    args._use_startup_defaults = False
    if store is None or args.setup:
        return
    defaults = store.load_defaults()
    if defaults is None:
        return
    explicit_connection = bool(args.mode or args.base_url or args.codex_config or args.profile
                               or args.no_codex_config or args.saved_api)
    settings = store.profile_settings(defaults["api_id"])
    if settings is None and not explicit_connection:
        raise ValueError("默认 API 已不存在，请使用 --setup 重新配置")
    args._default_timing_settings = settings or {}
    for field in ("reset_session_on_400", "start_paused", "display", "color"):
        if field not in args._preference_overrides:
            setattr(args, field, defaults[field])
    if (not explicit_connection and not args.settings and not args.show_config
            and sys.stdin.isatty() and sys.stdout.isatty()):
        ui.terminal.color_mode = args.color
        description = ("跟随 Codex 当前配置" if defaults["source"] == "codex" else
                       f"{settings.get('base_url', '')} | {settings.get('model', '')}")
        description += " | 确认后先暂停" if args.start_paused else " | 确认后开始请求"
        choice = ui.choose("是否沿用已保存配置？", [
            ("1", "沿用已保存配置", description),
            ("2", "不沿用，重新选择", "重新选择调用方式、API 和模型，原有配置与记录保留"),
            ("0", "退出", "本次不发送请求")], default="1", cancel="0", blank="1",
            subtitle="请选择本窗口使用的配置，确认后才启动。")
        if choice == "0":
            raise EOFError
        if choice == "2":
            return
    args._prompt_session_policy = False
    args._use_startup_defaults = True
    args.defaults_saved = True
    if not explicit_connection:
        if defaults["source"] == "saved":
            args.saved_api = defaults["api_id"]
        else:
            args.mode = "codex"
            args.codex_config = Path(defaults["codex_config"]) if defaults["codex_config"] else None
            args.profile = defaults["profile"]


def select_mode(args: argparse.Namespace) -> None:
    store = getattr(args, "_memory_store", None)
    if getattr(args, "saved_api", None):
        if not store:
            raise ValueError("--saved-api 需要启用记忆模式")
        if args.base_url:
            raise ValueError("--saved-api 不能与 --base-url 同时使用；可在暂停菜单中修改已保存 API")
        args._saved_settings = store.load_profile(args.saved_api)
        args.mode = args._saved_settings["settings"]["mode"]
        return
    inferred = "api" if args.base_url or args.no_codex_config else None
    if args.codex_config or args.profile:
        inferred = inferred or "codex"
    if not args.mode:
        args.mode = inferred
    if not args.mode and sys.stdin.isatty() and not args.show_config:
        has_saved = bool(store and store.list_profiles())
        options = [("1", "第三方模型 API", "输入地址和密钥，验证后选择模型"),
                   ("2", "Codex 桌面端配置", "复用 Codex / CC Switch 的连接配置")]
        if has_saved:
            options.append(("3", "使用已保存的 API", "载入连接、模型和时间设置"))
        while True:
            choice = ui.choose("请选择调用方式", options, default="2")
            if choice == "3" and has_saved:
                saved = choose_saved_api(store)
                if saved:
                    args._saved_settings = saved
                    args.mode = saved["settings"]["mode"]
                    return
                continue
            if choice in ("", "1", "2"):
                args.mode = "api" if choice == "1" else "codex"
                break
            print("请输入 1 或 2。")
    args.mode = args.mode or "codex"
    if args.mode == "codex" and (args.base_url or args.no_codex_config):
        raise ValueError("Codex 模式不接受 --base-url；指定其他网址请使用 --mode api")
    if args.mode == "api" and (args.codex_config or args.profile):
        raise ValueError("--codex-config 和 --profile 仅用于 --mode codex")


def resolve_endpoint(base_url: str, style: str) -> tuple[str, str]:
    url = urllib.parse.urlsplit(base_url.strip())
    if url.scheme not in ("http", "https") or not url.hostname:
        raise ValueError("网址必须是完整的 http:// 或 https:// 地址")
    if url.username is not None or url.password is not None or url.query or url.fragment:
        raise ValueError("网址不能包含用户名、密码、查询参数或 # 片段；密钥请单独配置")
    _ = url.port  # Validate the port before starting the loop.
    path = url.path.rstrip("/")
    detected = None
    if path.endswith("/chat/completions"):
        detected = "chat"
    elif path.endswith("/responses"):
        detected = "responses"
    if detected:
        if style != "auto" and style != detected:
            raise ValueError("完整接口地址与 --api-style 不一致")
        return urllib.parse.urlunsplit(url._replace(path=path)), detected
    style = "responses" if style == "auto" else style
    path = (path or "/v1") + ("/chat/completions" if style == "chat" else "/responses")
    return urllib.parse.urlunsplit(url._replace(path=path)), style


def refresh_connection(args: argparse.Namespace) -> None:
    if not args.base_url or not str(args.base_url).strip():
        raise ValueError("请提供 API 地址")
    if not args.api_key or not str(args.api_key).strip():
        raise ValueError("请提供 API 密钥")
    args.base_url, args.api_key = args.base_url.strip(), args.api_key.strip()
    if "\r" in args.api_key or "\n" in args.api_key:
        raise ValueError("密钥不能包含换行符")
    args.endpoint, args.api_style = resolve_endpoint(args.base_url, args.api_style)
    if args.stream is None:
        args.stream = args.mode == "codex" or args.api_style == "responses"
    args.display_endpoint = args.endpoint
    if args.query_params:
        args.endpoint += "?" + urllib.parse.urlencode(args.query_params)
        args.display_endpoint += "?（已隐藏配置的查询参数）"
    args.secrets = [str(value) for value in
                    [args.api_key, *args.extra_headers.values(), *args.query_params.values()] if value]


def copy_settings(args: argparse.Namespace) -> argparse.Namespace:
    return argparse.Namespace(**copy.deepcopy({key: value for key, value in vars(args).items()
                                               if not key.startswith("_")}))


def timing_summary(args: argparse.Namespace) -> str:
    keepalive = ui.keepalive_label(args.success_interval, getattr(args, "success_interval_max", args.success_interval))
    return (f"探活间隔：{args.interval:g}s | 保活间隔：{keepalive} | "
            f"单次请求超时：{args.timeout:g}s")


def saved_timing_values(values: dict) -> dict:
    resolved = {name: values.get(name) if values.get(name) is not None else default
                for name, default in TIMING_DEFAULTS.items()}
    # A pre-range profile starts using the user's new 60–90 second default.
    if values.get("success_interval_max") is None:
        resolved["success_interval"] = TIMING_DEFAULTS["success_interval"]
        resolved["success_interval_max"] = TIMING_DEFAULTS["success_interval_max"]
    return resolved


def sample_keepalive_interval(args: argparse.Namespace) -> float:
    minimum = args.success_interval
    maximum = getattr(args, "success_interval_max", minimum)
    if minimum > maximum:
        raise ValueError("保活最短间隔不能大于最长间隔")
    return random.uniform(minimum, maximum) if minimum < maximum else minimum


def restore_timing(args: argparse.Namespace, store: MemoryStore | None) -> None:
    saved = getattr(args, "_saved_settings", None)
    raw = saved["settings"] if saved else (store.timing_for(vars(args)) if store else {})
    values = saved_timing_values(raw or getattr(args, "_default_timing_settings", {}))
    overrides = getattr(args, "_timing_overrides", {})
    for name, default in TIMING_DEFAULTS.items():
        value = overrides.get(name, values.get(name))
        try:
            setattr(args, name, positive_float(str(default if value is None else value)))
        except (ValueError, argparse.ArgumentTypeError):
            raise ValueError(f"已保存的{TIMING_LABELS[name]}无效，请用对应时间参数指定正数") from None
    if args.success_interval > args.success_interval_max:
        raise ValueError("保活最短间隔不能大于最长间隔；请检查 --keepalive-min 和 --keepalive-max")


def configure_timing(args: argparse.Namespace, *, startup: bool = False) -> None:
    if startup and getattr(args, "_use_startup_defaults", False):
        return
    if startup and (not sys.stdin.isatty() or not sys.stdout.isatty()):
        return
    overrides = getattr(args, "_timing_overrides", {}) if startup else {}
    fields = [name for name in TIMING_DEFAULTS if name not in overrides]
    if not fields:
        return
    print(f"\n时间设置 | {timing_summary(args)}\n单位：秒，支持小数；回车保留当前值。")
    values = {}
    for name in fields:
        current = getattr(args, name)
        while True:
            value = input(f"{TIMING_LABELS[name]}（当前 {current:g} 秒）：").strip()
            try:
                seconds = positive_float(value) if value else current
            except (ValueError, argparse.ArgumentTypeError):
                print("请输入大于 0 的有限秒数，例如 0.5、2 或 60。")
                continue
            if name == "success_interval_max" and seconds < values.get("success_interval", args.success_interval):
                print(f"最长间隔不能小于最短间隔 {values.get('success_interval', args.success_interval):g} 秒。")
                continue
            if name == "success_interval" and "success_interval_max" not in fields and seconds > args.success_interval_max:
                print(f"最短间隔不能大于已指定的最长间隔 {args.success_interval_max:g} 秒。")
                continue
            values[name] = seconds
            break
    # Commit the edit only after every field has been entered successfully.
    vars(args).update(values)


def restore_request_settings(args: argparse.Namespace, store: MemoryStore | None) -> None:
    saved = getattr(args, "_saved_settings", None)
    raw = saved["settings"] if saved else (store.connection_settings(vars(args)) if store else {})
    raw = raw or getattr(args, "_default_timing_settings", {})
    overrides = getattr(args, "_request_overrides", {})
    mode = overrides.get("tool_mode", raw.get("tool_mode") or client.REQUEST_DEFAULTS["tool_mode"])
    if mode not in client.TOOL_MODES:
        raise ValueError("请求工具模式无效，请用 --tool-mode 指定 client、compatible 或 off")
    limit = overrides.get("max_tokens", raw.get("max_tokens") or client.REQUEST_DEFAULTS["max_tokens"])
    if not raw.get("tool_mode") and limit == 32 and "max_tokens" not in overrides and mode != "off":
        limit = client.REQUEST_DEFAULTS["max_tokens"]
    try:
        args.max_tokens = positive_int(str(limit))
    except (ValueError, argparse.ArgumentTypeError):
        raise ValueError("输出 token 上限必须是正整数") from None
    args.tool_mode = mode


def manage_timing(args: argparse.Namespace, store: MemoryStore | None) -> argparse.Namespace:
    draft = copy_settings(args)
    try:
        configure_timing(draft)
        remember_api(draft, store)
        print(f"时间设置已{'保存到当前 API' if store else '生效（记忆关闭，仅本次运行）'}。{timing_summary(draft)}",
              flush=True)
        return draft
    except (KeyboardInterrupt, EOFError) as exc:
        if getattr(exc, "signal_number", None):
            raise
        print("\n已取消时间设置，继续使用原值并保持暂停。")
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(redact(f"时间设置未更改：{exc}", args.secrets))
    return args


def show_saved_apis(store: MemoryStore) -> list[dict]:
    profiles = store.list_profiles()
    if not profiles:
        print("暂无已保存 API。首次配置并运行后会自动保存。")
    for number, profile in enumerate(profiles, 1):
        settings = profile["settings"]
        times = argparse.Namespace(**saved_timing_values(settings))
        status = profile["last_status"] if profile["request_count"] else "未请求"
        print(f"  {number}. {profile['name']} [{profile['id'][:8]}]\n"
              f"     {settings['base_url']} | {settings['model']} | {settings['api_style']}\n"
              f"     {timing_summary(times)}\n"
              f"     已请求 {profile['request_count']} 次，HTTP 200 {profile['success_count']} 次，最近：{status}")
    return profiles


def choose_saved_api(store: MemoryStore) -> dict | None:
    profiles = store.list_profiles()
    if not profiles:
        print("暂无已保存 API。")
        return None
    options = []
    for number, profile in enumerate(profiles, 1):
        settings = profile["settings"]
        options.append((str(number), f"{profile['name']} · 已请求 {profile['request_count']} 次",
                        f"{settings['base_url']} | {settings['model']} | {settings['api_style']}"))
    choice = ui.choose("选择已保存的 API", options, default="1", cancel="0", blank="0")
    return None if choice == "0" else store.load_profile(profiles[int(choice) - 1]["id"])


def startup_preferences(args: argparse.Namespace) -> dict:
    source = getattr(args, "connection_source", "codex" if args.mode == "codex" else "saved")
    path = getattr(args, "codex_config", None)
    return {"schema_version": 1, "source": source,
            "codex_config": str(Path(path).expanduser().resolve()) if source == "codex" and path else None,
            "profile": getattr(args, "profile", None) if source == "codex" else None,
            "reset_session_on_400": args.reset_session_on_400,
            "display": getattr(args, "default_display", getattr(args, "display", "auto")),
            "color": getattr(args, "default_color", getattr(args, "color", "auto")),
            "start_paused": getattr(args, "start_paused", False)}


def remember_api(args: argparse.Namespace, store: MemoryStore | None,
                 name: str | None = None, profile_id: str | None = None,
                 *, make_default: bool | None = None) -> None:
    if store:
        save_default = getattr(args, "defaults_saved", False) if make_default is None else make_default
        extra = {"defaults": startup_preferences(args)} if save_default else {}
        saved = store.save_profile(vars(args), name=name or getattr(args, "api_name", None),
                                   profile_id=profile_id or getattr(args, "api_id", None), **extra)
        args.api_id, args.api_name = saved["id"], saved["name"]
        if save_default:
            args.defaults_saved = True
    else:
        args.api_id = connection_key(vars(args))
        args.api_name = name or getattr(args, "api_name", None) or f"{urllib.parse.urlsplit(args.base_url).netloc} / {args.model}"


def print_history_record(record: dict) -> None:
    status = ui.status_label(record["http_status"], record.get("error", ""))
    print(f"记录 ID：{record['record_id']} | {record['started_at']} | #{record['request_id']:06d} | {record.get('api_name', '')} | {status}\n"
          f"  会话 ID：{record.get('session_id') or '未记录'}\n"
          f"  问题：{record['prompt']}\n  结果：{(record['answer'] or record['error'])[:300]}")


def show_history(store: MemoryStore | None, api_id: str | None = None, limit: int = 10) -> None:
    if store is None:
        print("记忆模式已关闭；使用 --memory 启动可以记录请求。")
        return
    records = store.history(limit, api_id)
    if ui.terminal.interactive():
        ui.browse_records(records)
        return
    if not records:
        print("暂无请求记录。")
    for record in records:
        print_history_record(record)


def manage_history(args: argparse.Namespace, store: MemoryStore | None) -> None:
    if store is None:
        print("记忆模式已关闭，没有可管理的本地调用记录。")
        return
    api_id = getattr(args, "api_id", None)
    api_name = getattr(args, "api_name", args.model)
    try:
        while True:
            total = store.history_count()
            current = store.history_count(api_id) if api_id else 0
            if not ui.terminal.interactive():
                show_history(store, limit=20)
            choice = ui.choose("调用记录管理", [
                ("1", "删除单条记录", "选择记录并确认后删除"),
                ("2", "清空当前 API 的调用记录", f"{api_name} · {current} 条"),
                ("3", "清空全部 API 的调用记录", f"全部 API · {total} 条"),
                ("0", "返回", "保持暂停")], default="0", cancel="0", blank="0",
                subtitle=f"当前 API：{api_name}（{current} 条）| 全部：{total} 条")
            if choice in ("", "0", "q"):
                return
            if choice == "1":
                if ui.terminal.interactive():
                    records = store.history(limit=1000)
                    value = ui.choose("选择要删除的记录", [
                        (str(row['record_id']), ui.clean(ui.record_line(row, 110)),
                         f"{row.get('api_name', '')} | 会话 {row.get('session_id', '未记录')}")
                        for row in records], default=str(records[-1]['record_id']) if records else None,
                        cancel="0", subtitle="最近 1000 条，可输入记录 ID 查找；Esc 取消")
                else:
                    value = input("输入要删除的记录 ID，0 取消：").strip()
                if value in ("", "0"):
                    continue
                try:
                    record_id = int(value)
                except ValueError:
                    print("请输入有效的记录 ID。")
                    continue
                # SQLite INTEGER identifiers are signed 64-bit values.
                if not 0 < record_id <= 9223372036854775807:
                    print("请输入有效的记录 ID。")
                    continue
                record = store.history_record(record_id)
                if record is None:
                    print("未找到这条记录，可能已被删除。")
                    continue
                print("即将删除：")
                print_history_record(record)
                scope, count, label = {"record_id": record_id}, 1, f"记录 ID {record_id}"
            elif choice == "2":
                if not api_id:
                    print("当前没有已保存的 API，无法按 API 删除记录。")
                    continue
                scope, count, label = {"api_id": api_id}, store.history_count(api_id), f"当前 API“{api_name}”的调用记录"
            elif choice == "3":
                scope, count, label = {"all_records": True}, store.history_count(), "全部 API 的调用记录"
            else:
                print("请输入 0、1、2 或 3。")
                continue
            if count == 0:
                print("没有需要删除的记录。")
                continue
            if ui.terminal.interactive():
                confirm = ui.choose(f"删除{label}？共 {count} 条", [
                    ("no", "取消，保留记录"), ("yes", "确认删除", "API 配置、密钥和时间设置会保留")],
                    default="no", cancel="no", subtitle="此操作会删除选中的本地调用记录")
            else:
                confirm = input(f"删除{label}，共 {count} 条？输入 y 确认，回车取消：").strip().lower()
            if confirm not in ("y", "yes", "是"):
                print("已取消删除。")
                continue
            deleted = store.delete_history(**scope)
            print(f"已删除 {deleted} 条调用记录。API 配置和密钥已保留。", flush=True)
    except (KeyboardInterrupt, EOFError) as exc:
        if getattr(exc, "signal_number", None):
            raise
        print("\n已退出调用记录管理，仍保持暂停。")
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(redact(f"调用记录操作失败：{exc}", args.secrets))


class ConsoleControls:
    """Single-key controls without a competing stdin reader during edit menus."""

    def poll(self) -> str | None:
        if not sys.stdin.isatty():
            return None
        if os.name == "nt" or ui.terminal.interactive():
            key = ui.read_key(block=False)
            return key.lower() if isinstance(key, str) else None
        import select
        if select.select([sys.stdin], [], [], 0)[0]:
            return sys.stdin.readline().strip().lower()
        return None


def controls_help() -> None:
    print("控制：↑↓/Enter 操作菜单 | p 暂停 | r 继续 | v 单次探活 | s 设置 | t 时间 | m API | h 记录详情 | d 删除记录 | q 结束",
          flush=True)


def manage_apis(args: argparse.Namespace, store: MemoryStore | None) -> argparse.Namespace:
    draft = copy_settings(args)
    draft.secrets = list(args.secrets)
    try:
        choice = ui.choose("API 管理", [
            ("1", "修改当前地址、密钥和模型"), ("2", "切换已保存 API"), ("3", "新增 API"),
            ("4", "重新读取 Codex 当前配置"), ("5", "验证当前连接并重新选择模型"),
            ("6", "查看全部最近请求"), ("7", "时间设置（探活 / 保活 / 超时）"),
            ("8", "删除调用记录"), ("0", "返回运行面板", "保持暂停")],
            default="1", cancel="0", blank="0",
            subtitle=f"{getattr(args, 'api_name', args.model)} | {timing_summary(args)}")
        if choice in ("", "0"):
            return args
        if choice == "6":
            show_history(store, limit=20)
            return args
        if choice == "8":
            manage_history(args, store)
            return args
        if choice == "7":
            return manage_timing(args, store)
        if choice == "2":
            if store is None:
                print("切换已保存 API 需要开启记忆模式。")
                return args
            saved = choose_saved_api(store)
            if not saved:
                return args
            draft._saved_settings = saved
            draft.api_key, draft.model = None, None
            apply_configuration(draft)
            refresh_connection(draft)
            restore_timing(draft, store)
            restore_request_settings(draft, store)
            if getattr(draft, "defaults_saved", False):
                remember_api(draft, store)
            return draft
        if choice == "4":
            draft.mode, draft.base_url, draft.api_key, draft.model = "codex", None, None, None
            draft.api_style, draft.stream = "auto", None
            draft.no_codex_config = False
            draft.api_id, draft.api_name = None, None
            apply_configuration(draft)
            refresh_connection(draft)
            if not draft.model:
                raise ValueError("Codex 配置中没有模型名")
            restore_timing(draft, store)
            restore_request_settings(draft, store)
            remember_api(draft, store)
            return draft
        if choice == "5":
            draft.model = None
            prepare_api(draft)
            draft.connection_source = "saved"
            remember_api(draft, store)
            return draft
        if choice not in ("1", "3"):
            print("无效操作，仍保持暂停。")
            return args
        is_new = choice == "3"
        old_url = "" if is_new else args.base_url
        draft.api_name = input(f"API 名称（回车{'自动命名' if is_new else '保留原名称'}）：").strip() or (None if is_new else getattr(args, "api_name", None))
        draft.base_url = input(f"调用地址{'（回车保留 ' + old_url + '）' if old_url else ''}：").strip() or old_url
        old_origin = urllib.parse.urlsplit(old_url)[:2]
        new_origin = urllib.parse.urlsplit(draft.base_url)[:2]
        may_keep_key = not is_new and old_origin == new_origin
        prompt = "密钥（输入不显示" + ("，回车保留" if may_keep_key else "，地址改变时需重新输入") + "）："
        new_key = getpass.getpass(prompt).strip()
        draft.api_key = new_key or (args.api_key if may_keep_key else "")
        draft.secrets = [*args.secrets, draft.api_key] if draft.api_key else list(args.secrets)
        style = ui.choose("选择接口格式", [("1", "Responses"), ("2", "Chat Completions")],
                          default="2" if args.api_style == "chat" else "1")
        draft.api_style = {"1": "responses", "2": "chat"}.get(style, args.api_style)
        draft.stream = draft.api_style == "responses"
        draft.mode = "api"
        draft.connection_source = "saved"
        draft.codex_config, draft.profile = None, None
        draft.extra_headers, draft.query_params = {}, {}
        draft.config_source, draft.key_source = "暂停时配置的 API", "用户输入"
        draft.model = None
        draft.api_id = None if is_new else getattr(args, "api_id", None)
        refresh_connection(draft)
        prepare_api(draft)
        if is_new:
            restore_timing(draft, store)
            restore_request_settings(draft, store)
        remember_api(draft, store)
        return draft
    except (KeyboardInterrupt, EOFError) as exc:
        if getattr(exc, "signal_number", None):
            raise
        print("\n已取消操作，继续使用原配置并保持暂停。")
    except (ValueError, OSError, sqlite3.Error, argparse.ArgumentTypeError) as exc:
        print(redact(f"配置未更改：{exc}", draft.secrets))
    return args


def request_headers(args: argparse.Namespace, *, generation=False) -> dict:
    headers = {name: value for name, value in args.extra_headers.items()
               if name.lower() != "authorization"}
    headers.update({
        "Authorization": f"Bearer {args.api_key}",
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "text/event-stream" if generation and args.stream else "application/json",
        "User-Agent": (
            "codex_cli_rs/0.153.4 (Windows 10.0.22631; x86_64) "
            "pebrel/1.8.0__615ace7_ (codex_cli_rs; 0.153.4)"
        ),
    })
    if args.mode == "codex":
        headers["originator"] = "codex_cli_rs"
    return headers


def fetch_models(args: argparse.Namespace) -> list[str]:
    url = urllib.parse.urlsplit(args.endpoint)
    suffix = "/chat/completions" if args.api_style == "chat" else "/responses"
    models_url = urllib.parse.urlunsplit(url._replace(path=url.path[:-len(suffix)] + "/models"))
    request = urllib.request.Request(models_url, headers=request_headers(args), method="GET")
    results: queue.Queue = queue.Queue()

    def probe() -> None:
        try:
            opener = urllib.request.build_opener(NoRedirect())
            try:
                response = opener.open(request, timeout=args.timeout)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                status = response.code
                raw = response.read(MAX_BODY_BYTES + 1)
            if len(raw) > MAX_BODY_BYTES:
                raise ValueError("模型列表响应超过 1 MiB")
            results.put((status, raw, None))
        except Exception as exc:
            results.put((None, b"", exc))

    print(f"正在验证连接及密钥，并获取模型列表：{models_url}", flush=True)
    threading.Thread(target=probe, daemon=True).start()
    try:
        status, raw, error = results.get(timeout=args.timeout)
    except queue.Empty:
        raise ValueError(f"连接验证超过 {args.timeout:g} 秒；请检查网址、网络和代理") from None
    if error:
        raise ValueError(f"无法连接模型接口：{error}")
    text = raw.decode("utf-8-sig", errors="replace")
    if status != 200:
        detail = text[:500]
        try:
            payload = json.loads(text)
            detail = str(payload.get("error", payload))[:500]
        except (ValueError, AttributeError):
            pass
        raise ValueError(f"接口已连通（HTTP {status}），但未通过模型列表/鉴权验证：{detail}")
    try:
        data = json.loads(text)
    except ValueError:
        raise ValueError("模型接口返回 HTTP 200，但不是 JSON；请检查 API 地址") from None
    entries = data.get("data") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError("模型接口返回 HTTP 200，但没有标准 data 模型列表")
    models = sorted({item.get("id", "").strip() for item in entries
                     if isinstance(item, dict) and isinstance(item.get("id"), str)
                     and item["id"].strip()}, key=str.casefold)
    if not models:
        raise ValueError("连接正常，但平台返回的可用模型列表为空")
    print(f"连接及鉴权通过（HTTP 200），获取到 {len(models)} 个模型。", flush=True)
    return models


def prepare_api(args: argparse.Namespace) -> None:
    models = fetch_models(args)
    if args.model:
        if args.model not in models:
            raise ValueError(f"指定模型 {args.model} 不在平台返回的列表中；可选：" + ", ".join(models))
    else:
        if not sys.stdin.isatty():
            if len(models) != 1:
                raise ValueError("非交互运行时请用 --model 指定列表中的模型")
            args.model = models[0]
        else:
            choice = ui.choose("选择模型", [(str(index), model) for index, model in enumerate(models, 1)],
                               default="1", aliases={model: str(index) for index, model in enumerate(models, 1)})
            args.model = models[int(choice) - 1]
    print(f"已选择模型：{args.model}\n", flush=True)


def make_body(args: argparse.Namespace, prompt: str) -> dict[str, Any]:
    body: dict[str, Any] = {"model": args.model, "stream": args.stream}
    client.add_client_fields(body, args, prompt)
    token_param = args.token_param
    if token_param == "auto":
        token_param = "max_tokens" if args.api_style == "chat" else "max_output_tokens"
    if token_param != "none":
        body[token_param] = args.max_tokens
    return body


def extract_answer(data: Any) -> tuple[str, str, Any]:
    if not isinstance(data, dict):
        return "", "响应 JSON 不是对象", None
    error = data.get("error")
    if isinstance(error, dict):
        error = error.get("message") or json.dumps(error, ensure_ascii=False)
    messages = []
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        if choices[0].get("finish_reason") == "length":
            error = error or "响应达到输出 token 上限"
        message = choices[0].get("message") or {}
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                messages.append(content)
            elif isinstance(content, list):
                messages.extend(part["text"] for part in content
                                if isinstance(part, dict) and isinstance(part.get("text"), str))
            if not messages and message.get("refusal"):
                messages.append(str(message["refusal"]))
    elif isinstance(data.get("output_text"), str):
        messages.append(data["output_text"])
    elif isinstance(data.get("output"), list):
        for item in data["output"]:
            if not isinstance(item, dict) or not isinstance(item.get("content"), list):
                continue
            for part in item["content"]:
                if isinstance(part, dict):
                    value = part.get("text") or part.get("refusal")
                    if isinstance(value, str):
                        messages.append(value)
    if data.get("status") in ("incomplete", "failed", "cancelled"):
        details = data.get("incomplete_details") or error or ""
        error = f"响应状态 {data['status']}：{details}"
    text = "\n".join(messages).strip()
    if not text and not error and not client.extract_calls(data):
        error = "响应没有可显示的回答；请检查接口格式、模型和输出 token 上限"
    return text, str(error or ""), data.get("usage")


class SSECollector:
    """Incremental SSE reader for both Responses and Chat Completions."""

    def __init__(self):
        self.buffer = b""
        self.data_lines: list[str] = []
        self.parts: list[str] = []
        self.response = None
        self.usage = None
        self.error = ""
        self.done = False
        self.chat_calls: dict[int, dict] = {}
        self.response_calls: dict[str, dict] = {}
        self.chat_finished = False

    def event(self) -> None:
        raw = "\n".join(self.data_lines)
        self.data_lines.clear()
        if not raw:
            return
        if raw.strip() == "[DONE]":
            self.done = True
            return
        try:
            event = json.loads(raw)
        except ValueError:
            self.error = "流式响应包含无法解析的事件"
            return
        if not isinstance(event, dict):
            return
        event_type = event.get("type")
        if event_type == "response.output_text.delta" and isinstance(event.get("delta"), str):
            self.parts.append(event["delta"])
        elif event_type in ("response.output_item.added", "response.output_item.done"):
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                self.response_calls[item.get("id") or item.get("call_id") or "unknown"] = dict(item)
        elif event_type in ("response.function_call_arguments.delta", "response.function_call_arguments.done"):
            item = self.response_calls.get(event.get("item_id"))
            if item is not None:
                if event_type.endswith(".done"):
                    item["arguments"] = event.get("arguments", item.get("arguments", ""))
                else:
                    item["arguments"] = (item.get("arguments") or "") + event.get("delta", "")
        elif event_type in ("response.completed", "response.incomplete", "response.failed"):
            self.response = event.get("response")
            self.done = True
        elif event_type == "error" or event.get("error"):
            detail = event.get("error") or event.get("message") or event
            self.error = str(detail.get("message", detail) if isinstance(detail, dict) else detail)
            self.done = True
        for choice in event.get("choices", []) or []:
            if isinstance(choice, dict):
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str):
                    self.parts.append(content)
                for part in delta.get("tool_calls", []) or []:
                    if not isinstance(part, dict):
                        continue
                    call = self.chat_calls.setdefault(part.get("index", 0),
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    if part.get("id"):
                        call["id"] = part["id"]
                    function = part.get("function") or {}
                    for key in ("name", "arguments"):
                        if isinstance(function.get(key), str):
                            call["function"][key] += function[key]
                if choice.get("finish_reason") in ("stop", "tool_calls", "function_call", "length"):
                    self.chat_finished = True
                    if choice.get("finish_reason") == "length":
                        self.error = "响应达到输出 token 上限"
        if event.get("usage"):
            self.usage = event["usage"]

    def feed(self, chunk: bytes) -> None:
        self.buffer += chunk
        while b"\n" in self.buffer and not self.done:
            line, self.buffer = self.buffer.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if not line:
                self.event()
            elif line.startswith(b"data:"):
                self.data_lines.append(line[5:].lstrip(b" ").decode("utf-8", errors="replace"))

    def response_payload(self):
        if isinstance(self.response, dict):
            if self.response_calls and not client.extract_calls(self.response):
                return {**self.response, "output": [*(self.response.get("output") or []), *self.response_calls.values()]}
            return self.response
        if self.chat_calls:
            return {"choices": [{"message": {"role": "assistant", "content": "".join(self.parts) or None,
                      "tool_calls": [self.chat_calls[index] for index in sorted(self.chat_calls)]}}], "usage": self.usage}
        if self.response_calls:
            return {"output": list(self.response_calls.values()), "usage": self.usage}
        return None

    def finish(self) -> tuple[str, str, Any]:
        if not self.done:
            self.feed(b"\n\n")
        if self.chat_finished:
            self.done = True
        payload = self.response_payload()
        if isinstance(payload, dict):
            text, error, usage = extract_answer(payload)
            if not self.done and not error:
                error = "流式连接结束，但未收到完成事件"
            return text or "".join(self.parts), error or self.error, usage or self.usage
        text = "".join(self.parts).strip()
        error = self.error
        if not self.done and not error:
            error = "流式连接结束，但未收到完成事件"
        if not text and not error:
            error = "流式响应没有文字回答，可检查输出 token 上限"
        return text, error, self.usage


def request_message(args: argparse.Namespace, job: Job, payload: dict) -> Result:
    status = None
    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = request_headers(args, generation=True)
        headers["X-Client-Request-Id"] = str(uuid.uuid4())
        headers["session-id"] = job.session_id
        headers["thread-id"] = job.session_id
        request = urllib.request.Request(
            args.endpoint,
            data=body,
            headers=headers,
            method="POST",
        )
        opener = urllib.request.build_opener(NoRedirect())
        remaining = args.timeout - (time.monotonic() - job.started)
        if remaining <= 0:
            raise TimeoutError("请求超过总超时时限")
        try:
            response = opener.open(request, timeout=remaining)
        except urllib.error.HTTPError as exc:
            response = exc  # Read and display non-200 responses too.
        with response:
            status = response.code
            chunks = []
            size = 0
            sse = SSECollector() if "text/event-stream" in response.headers.get("Content-Type", "").lower() else None
            while True:
                if time.monotonic() - job.started >= args.timeout:
                    raise TimeoutError("请求超过总超时时限")
                chunk = response.read1(min(65536, MAX_BODY_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise ValueError("响应超过 1 MiB，已停止读取")
                if sse is not None:
                    sse.feed(chunk)
                    if sse.done:
                        break
        raw = b"".join(chunks).decode("utf-8-sig", errors="replace")
        # Some gateways label JSON errors as SSE; keep their actual error message.
        if sse is not None and raw.lstrip().startswith(("{", "[")):
            sse = None
        if sse is None and raw.lstrip().startswith(("data:", "event:")):
            sse = SSECollector()
            sse.feed(b"".join(chunks))
        if sse is not None:
            text, error, usage = sse.finish()
            data = sse.response_payload()
            if status != 200 and data is None and not sse.parts and not sse.error and raw.strip():
                error = f"HTTP {status}：" + raw[:800]
        else:
            data = None
            try:
                data = json.loads(raw)
                text, error, usage = extract_answer(data)
            except (ValueError, TypeError):
                text, error, usage = "", "响应不是 JSON：" + raw[:800], None
        if status != 200 and not error:
            error = f"HTTP {status}"
        if status == 404:
            error += (f"；当前请求：POST {args.display_endpoint}（{args.api_style}）；"
                      "请核对完整 API 地址、模型名和平台支持的格式。模型列表可用不代表此生成接口可用；"
                      "可通过 --api-style responses 或 --api-style chat 指定格式")
        return Result(job, time.monotonic(), status, text, error, usage, response_data=data)
    except (TimeoutError, urllib.error.URLError, OSError) as exc:
        return Result(job, time.monotonic(), None, error=f"网络错误或超时：{exc}")
    except Exception as exc:
        return Result(job, time.monotonic(), status, error=f"{type(exc).__name__}：{exc}")


def request_once(args: argparse.Namespace, job: Job) -> Result:
    usage, traces, sent = None, [], 0

    def finish(result):
        result.usage = usage
        result.tool_calls = traces
        result.http_requests = sent
        result.response_data = None
        return result

    try:
        payload = make_body(args, job.prompt)
        if args.api_style == "responses":
            payload["prompt_cache_key"] = job.session_id
            payload["include"] = ["reasoning.encrypted_content"]
        for round_number in range(client.MAX_TOOL_ROUNDS + 1):
            result = request_message(args, job, payload)
            sent += 1
            usage = client.sum_usage(usage, result.usage)
            calls = client.extract_calls(result.response_data)
            if result.status != 200 or result.error or not calls:
                return finish(result)
            if getattr(args, "tool_mode", "client") == "off":
                result.error = "模型返回工具调用，但本次未启用工具"
                return finish(result)
            if round_number >= client.MAX_TOOL_ROUNDS:
                result.error = "已达到单次工具处理上限，未继续追加模型请求"
                return finish(result)
            try:
                payload, executed = client.continue_with_tools(payload, result.response_data, args.api_style, calls)
                traces.extend(executed)
            except (ValueError, TypeError, KeyError) as exc:
                result.error = f"工具请求无效：{exc}"
                return finish(result)
    except Exception as exc:
        return finish(Result(job, time.monotonic(), None, error=f"{type(exc).__name__}：{exc}"))


def worker(args: argparse.Namespace, job: Job, completed: queue.Queue) -> None:
    completed.put(request_once(args, job))


def redact(text: str, secrets) -> str:
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            text = text.replace(secret, "[密钥已隐藏]")
            text = text.replace(urllib.parse.quote_plus(secret), "[密钥已隐藏]")
    return text


def print_result(result: Result, args: argparse.Namespace, logfile,
                 memory: MemoryStore | None = None, run_id: str = "", display=None) -> None:
    status_label = f"HTTP {result.status}" if result.status is not None else "ERROR/TIMEOUT"
    duration = max(0.0, result.finished - result.job.started)
    header = f"[#{result.job.number:06d}] {result.job.started_at} | {status_label} | {duration:.2f}s"
    if getattr(args, "api_name", None):
        header += " | API=" + args.api_name
    if isinstance(result.usage, dict) and result.usage.get("total_tokens") is not None:
        header += f" | tokens={result.usage['total_tokens']}"
    lines = [header, "  会话 ID：" + result.job.session_id, "  问题：" + result.job.prompt]
    if result.text:
        lines.append("  回答：" + result.text)
    if result.error:
        lines.append("  提示：" + result.error)
    if logfile or memory or display or getattr(args, "display", "auto") == "compact":
        record = {
            "run_id": run_id,
            "api_id": getattr(args, "api_id", None),
            "api_name": getattr(args, "api_name", args.model),
            "request_id": result.job.number,
            "phase": result.job.phase,
            "session_id": result.job.session_id,
            "request_url": args.display_endpoint,
            "api_style": args.api_style,
            "started_at": result.job.started_at,
            "duration_seconds": round(duration, 3),
            "http_status": result.status,
            "prompt": result.job.prompt,
            "answer": result.text,
            "error": result.error,
            "usage": result.usage,
            "tool_calls": result.tool_calls or [],
            "http_requests": result.http_requests,
        }
        if result.job.task_id:
            record.update(task_id=result.job.task_id, task_name=result.job.task_name,
                          task_label=result.job.task_label)
        serialized = redact(json.dumps(record, ensure_ascii=False), args.secrets)
        safe_record = json.loads(serialized)
        if display:
            display.add(safe_record)
        elif getattr(args, "display", "auto") == "compact":
            print(ui.record_line(safe_record, ui.terminal.size()[0]), flush=True)
        if logfile:
            logfile.write(serialized + "\n")
            logfile.flush()
        if memory:
            memory.record(safe_record)
    if display is None and getattr(args, "display", "auto") != "compact":
        rendered = redact("\n".join(lines), args.secrets)
        colored_status = (ui.status_label(result.status, result.error) if result.status is not None
                          else ui.terminal.style(status_label, "error"))
        print(rendered.replace(status_label, colored_status, 1), flush=True)


def configure_session_policy(args: argparse.Namespace) -> None:
    choice = ui.choose("HTTP 400 时是否更新会话 ID？", [
        ("1", "是，更换会话 ID", "当前会话返回 400 时才更换"),
        ("2", "否，保留会话 ID", "400 后继续使用当前会话")],
        default="1" if args.reset_session_on_400 else "2",
        aliases={"y": "1", "yes": "1", "是": "1", "n": "2", "no": "2", "否": "2"})
    args.reset_session_on_400 = choice == "1"


def select_session_policy(args: argparse.Namespace) -> None:
    # Windows can report NUL stdin as a TTY; prompts also need terminal output.
    if args._prompt_session_policy and sys.stdin.isatty() and sys.stdout.isatty():
        configure_session_policy(args)


def manage_settings(args: argparse.Namespace, store: MemoryStore | None,
                    *, standalone: bool = False) -> argparse.Namespace:
    current = args
    while True:
        try:
            source = "跟随 Codex 当前配置" if getattr(current, "connection_source", "saved") == "codex" else "已保存 API"
            choice = ui.choose("设置 · 修改后保存为默认配置" if store else "设置 · 仅本次运行", [
                ("1", "探活 / 保活范围 / 超时", timing_summary(current)),
                ("2", "HTTP 400 时的会话处理", "更新会话 ID" if current.reset_session_on_400 else "保留会话 ID"),
                ("3", "默认连接与模型", f"{source} | {getattr(current, 'api_name', current.model)}"),
                ("4", "确认配置后的启动方式", "先暂停" if current.start_paused else "确认后开始请求"),
                ("5", "下次启动的显示与颜色", f"{getattr(current, 'default_display', current.display)} / {getattr(current, 'default_color', current.color)}"),
                ("6", "将当前配置保存为默认", "下次启动可选择沿用，无需重新填写"),
                ("7", "请求工具与输出预算", f"{getattr(current, 'tool_mode', 'client')} | 上限 {current.max_tokens} tokens"),
                ("0", "退出设置" if standalone else "返回运行面板", "已保存的修改会保留")],
                default="1", cancel="0", blank="0",
                subtitle=("修改后自动保存；" if store else "记忆关闭；") + ("退出后不发送请求" if standalone else "返回面板后按 r 继续"))
            if choice == "0":
                return current
            draft = copy_settings(current)
            if choice == "1":
                configure_timing(draft)
            elif choice == "2":
                configure_session_policy(draft)
            elif choice == "3":
                draft.defaults_saved = store is not None
                candidate = manage_apis(draft, store)
                if candidate is not draft:
                    current = candidate
                continue
            elif choice == "4":
                selected = ui.choose("确认配置后的启动方式", [
                    ("1", "确认后开始请求"), ("2", "确认后先暂停，按 r 后开始")],
                    default="2" if current.start_paused else "1",
                    subtitle="下次交互启动仍会先询问是否沿用已保存配置。")
                draft.start_paused = selected == "2"
            elif choice == "5":
                displays = ["auto", "dashboard", "compact", "verbose"]
                colors = ["auto", "always", "never"]
                selected = ui.choose("下次启动的显示方式", [
                    ("1", "自动选择"), ("2", "固定面板"), ("3", "简洁文本，每条一行"), ("4", "完整文本")],
                    default=str(displays.index(getattr(current, "default_display", current.display)) + 1))
                draft.default_display = displays[int(selected) - 1]
                selected = ui.choose("下次启动的颜色", [
                    ("1", "跟随终端"), ("2", "启用颜色"), ("3", "关闭颜色")],
                    default=str(colors.index(getattr(current, "default_color", current.color)) + 1))
                draft.default_color = colors[int(selected) - 1]
            elif choice == "7":
                selected = ui.choose("请求工具格式", [
                    ("1", "客户端结构", "命名空间、工具定义和声明；最多一轮工具处理"),
                    ("2", "通用兼容结构", "标准函数工具，适合较旧的兼容接口"),
                    ("3", "关闭工具", "仅发送短逻辑题")],
                    default=str(client.TOOL_MODES.index(getattr(current, "tool_mode", "client")) + 1))
                draft.tool_mode = client.TOOL_MODES[int(selected) - 1]
                while True:
                    value = input(f"每次模型响应的输出上限（回车保留 {current.max_tokens}）：").strip()
                    try:
                        draft.max_tokens = positive_int(value) if value else current.max_tokens
                        break
                    except (ValueError, argparse.ArgumentTypeError):
                        print("请输入正整数。")
            remember_api(draft, store, make_default=True)
            current = draft
            print("已保存为默认配置。" if store else "记忆模式已关闭，修改仅对本次运行生效。", flush=True)
        except (KeyboardInterrupt, EOFError) as exc:
            if getattr(exc, "signal_number", None):
                raise
            print("\n已取消本次编辑，先前保存的设置保留。")
            return current
        except (ValueError, OSError, sqlite3.Error) as exc:
            message = redact(f"设置未保存：{exc}", current.secrets)
            if ui.terminal.interactive():
                ui.view_text("设置未保存", message)
            else:
                print(message)


def run(args: argparse.Namespace, logfile=None, memory: MemoryStore | None = None,
        controls=None, manager=None) -> int:
    raw_keys = ui.terminal.interactive() and (getattr(args, "controls", False) or controls is not None)
    use_dashboard = (getattr(args, "display", "auto") in ("auto", "dashboard")
                     and raw_keys)
    with ui.keyboard_mode() if raw_keys else nullcontext(), \
         ui.Dashboard(VERSION) if use_dashboard else nullcontext() as display:
        return run_loop(args, logfile, memory, controls, manager, display)


def run_loop(args, logfile, memory, controls, manager, display) -> int:
    completed: queue.Queue = queue.Queue()
    workers: set[int] = set()
    awaiting: dict[int, Job] = {}
    ready: dict[int, Result] = {}
    launched, next_print, latest_decision = 0, 1, 0
    run_id = str(uuid.uuid4())
    active_key = connection_key(vars(args))
    current_session_id = str(uuid.uuid4())
    session_ids = {active_key: current_session_id}
    latest_status = None
    latest_error = ""
    interval = args.interval
    last_send: float | None = None
    next_due = time.monotonic()
    skipped = 0
    paused = getattr(args, "start_paused", False)
    menu_pending = None
    probe_requested = False
    stop_code = None
    if controls is None and getattr(args, "controls", False):
        controls = ConsoleControls()
    manager = manager or manage_apis
    if display and getattr(args, "defaults_saved", False):
        display.message = "已使用默认配置。按 s 修改设置，按 Enter 选择操作。"
    def say(message, *, error=False):
        message = redact(message, args.secrets)
        if display:
            display.message = message
        else:
            print(message, file=sys.stderr if error else sys.stdout, flush=True)

    if display is None:
        print(
            f"Codex 保活脚本 {VERSION}\n配置：{args.config_source}\n接口：{args.display_endpoint}\n"
            f"模型：{args.model} | 格式：{args.api_style} | 流式：{'是' if args.stream else '否'}\n"
            f"当前会话 ID：{current_session_id}\n"
            f"HTTP 400 更新会话 ID：{'是' if args.reset_session_on_400 else '否'}\n"
            f"{timing_summary(args)}\n"
            f"并发/缓冲上限：{args.max_inflight} | Ctrl+C 停止\n", flush=True)
        if memory:
            print(f"记忆已开启：{memory.path}\n已保存 API：{getattr(args, 'api_name', args.model)}", flush=True)
        if controls:
            controls_help()
            if paused:
                say("已暂停。v 单次探活，t 时间设置，m 修改/切换 API，d 删除调用记录，r 继续。")

    def emit(result: Result) -> None:
        print_result(result, result.job.settings or args, logfile, memory, run_id, display)

    def job_timeout(job: Job) -> float:
        return (job.settings or args).timeout

    def accept(result: Result) -> None:
        nonlocal interval, next_due, latest_decision, current_session_id, latest_status, latest_error
        number = result.job.number
        if number not in awaiting:
            return  # A late response to a request already reported as timed out.
        del awaiting[number]
        ready[number] = result
        if result.status == 400:
            if not args.reset_session_on_400:
                result.error += f"；接口可达，已关闭 400 更新会话 ID，继续复用原会话 ID：{current_session_id}"
            elif result.job.session_id == current_session_id:
                current_session_id = str(uuid.uuid4())
                session_ids[active_key] = current_session_id
                result.error += f"；接口可达，已切换新的会话 ID：{current_session_id}，后续请求复用该会话"
            else:
                result.error += f"；该 400 来自旧会话，继续复用当前会话 ID：{current_session_id}"
        # A stale, slow request cannot overwrite the state from a newer request.
        if number > latest_decision:
            was_keepalive = latest_status == 200
            latest_decision = number
            latest_status = result.status
            latest_error = result.error
            if result.status == 200:
                new_interval = interval if was_keepalive else sample_keepalive_interval(args)
            else:
                new_interval = args.interval
            # Concurrent successes must not keep replacing the armed deadline.
            if new_interval != interval or was_keepalive != (result.status == 200):
                interval = new_interval
                if last_send is not None:
                    next_due = max(last_send + interval, time.monotonic())

    def handle_completed(result: Result) -> None:
        workers.discard(result.job.number)
        timeout = job_timeout(result.job)
        if result.finished - result.job.started >= timeout:
            result = Result(result.job, result.job.started + timeout, None,
                            error=f"请求超过 {timeout:g} 秒总时限", usage=result.usage,
                            tool_calls=result.tool_calls, http_requests=result.http_requests)
        accept(result)

    try:
        while True:
            command = controls.poll() if controls else None
            if command in ("enter", "up", "down"):
                with ui.cooked_keyboard_mode(), display.suspend() if display else nullcontext():
                    command = ui.choose("运行操作", [
                        ("p", "暂停发送", "已发送的请求继续返回"),
                        ("r", "继续探活 / 保活", "暂停后立即请求一次，再按设置的间隔运行"),
                        ("v", "单次探活", "请求一次后保持暂停"),
                        ("s", "设置与默认配置", "修改后保存，下次启动可选择沿用"),
                        ("t", "时间设置", "修改探活间隔、保活随机范围和超时"),
                        ("m", "API 管理", "修改、添加或切换连接"),
                        ("h", "请求记录和详情", "查看完整问题、回答和会话 ID"),
                        ("d", "删除调用记录"), ("q", "结束运行")],
                        default="r" if paused else "p", cancel="", blank="",
                        subtitle="菜单打开期间暂不发送新请求，Esc 返回")
                if command == "v":
                    paused = True
            if command in ("q", "quit", "stop", "结束"):
                stop_code = 0
                break
            if command in ("p", "pause", "暂停"):
                paused, probe_requested = True, False
                say(f"已暂停发送；等待中的 {len(awaiting)} 个请求会继续返回。r 继续，m 管理 API，v 单次探活。")
            elif command in ("r", "resume", "继续"):
                if paused:
                    paused, menu_pending, probe_requested = False, None, False
                    next_due = time.monotonic()
                    say("已继续：立即请求一次，再按当前间隔运行。")
            elif command in ("m", "menu", "管理"):
                paused, menu_pending, probe_requested = True, "api", False
                if awaiting:
                    say(f"已暂停；等待 {len(awaiting)} 个已发送请求完成或超时后打开 API 管理。q 可直接结束。")
            elif command in ("t", "timing", "时间"):
                paused, menu_pending, probe_requested = True, "timing", False
                if awaiting:
                    say(f"已暂停；等待 {len(awaiting)} 个已发送请求完成或超时后打开时间设置。q 可直接结束。")
            elif command in ("s", "settings", "设置"):
                paused, menu_pending, probe_requested = True, "settings", False
                if awaiting:
                    say(f"已暂停；等待 {len(awaiting)} 个已发送请求完成或超时后打开设置。q 可直接结束。")
            elif command in ("d", "delete-history", "删除记录"):
                if memory is None:
                    say("记忆模式已关闭，没有可管理的本地调用记录。")
                else:
                    paused, menu_pending, probe_requested = True, "history", False
                    if awaiting:
                        say(f"已暂停；等待 {len(awaiting)} 个已发送请求完成或超时后打开调用记录管理。q 可直接结束。")
            elif command in ("v", "probe", "探活"):
                if paused and not menu_pending:
                    probe_requested, next_due = True, time.monotonic()
                    say("安排一次探活，完成后仍保持暂停。")
                else:
                    say("请先按 p 暂停，再按 v 单次探活。")
            elif command in ("h", "history", "历史"):
                if display:
                    paused, menu_pending, probe_requested = True, "records", False
                    say("已暂停，等待已发请求结束后查看完整记录。")
                else:
                    show_history(memory, getattr(args, "api_id", None))
            elif command in ("?", "help", "帮助"):
                if display:
                    say("↑↓/Enter 打开菜单；p 暂停，r 继续，v 单次探活，t 时间，m API，h 详情，q 结束。")
                else:
                    controls_help()
            while True:
                try:
                    handle_completed(completed.get_nowait())
                except queue.Empty:
                    break

            now = time.monotonic()
            for job in list(awaiting.values()):
                timeout = job_timeout(job)
                if now >= job.started + timeout:
                    accept(Result(job, job.started + timeout, None,
                                  error=f"请求超过 {timeout:g} 秒总时限"))

            while next_print in ready:
                emit(ready.pop(next_print))
                next_print += 1

            if menu_pending and not awaiting:
                with ui.cooked_keyboard_mode(), display.suspend() if display else nullcontext():
                    if menu_pending == "history":
                        manage_history(args, memory)
                    elif menu_pending == "records":
                        records = (memory.history(100, getattr(args, "api_id", None)) if memory else
                                   [row for row in display.records if row.get("api_id") == getattr(args, "api_id", None)])
                        ui.browse_records(records)
                    else:
                        if menu_pending == "timing":
                            candidate = manage_timing(args, memory)
                        elif menu_pending == "settings":
                            candidate = manage_settings(args, memory)
                        else:
                            candidate = manager(args, memory)
                        new_key = connection_key(vars(candidate))
                        args = candidate
                        if new_key != active_key:
                            active_key = new_key
                            current_session_id = session_ids.setdefault(active_key, str(uuid.uuid4()))
                            latest_decision, latest_status, latest_error = 0, None, ""
                            last_send = None
                if latest_status != 200:
                    interval = args.interval
                menu_pending = None
                if display:
                    say("仍保持暂停。按 r 继续，或按 Enter 选择操作。")
                else:
                    say(f"当前 API：{getattr(args, 'api_name', args.model)} | {args.display_endpoint}\n"
                        f"当前会话 ID：{current_session_id}\n{timing_summary(args)}\n"
                        "仍保持暂停。v 单次探活，r 持续探活/保活，t 时间设置，m 管理 API，d 删除记录，q 结束。")

            can_launch = args.count == 0 or launched < args.count
            if not can_launch and not awaiting:
                break

            now = time.monotonic()
            sending = (not paused or probe_requested) and not menu_pending
            if can_launch and sending and now >= next_due:
                sent = False
                # Limit both active network workers and responses waiting to print.
                if len(workers) < args.max_inflight and launched - next_print + 1 < args.max_inflight:
                    launched += 1
                    job = Job(launched, args.prompts[(launched - 1) % len(args.prompts)],
                              datetime.now().astimezone().isoformat(timespec="milliseconds"), now,
                              session_id=current_session_id, settings=copy_settings(args),
                              phase="单次探活" if paused else "保活" if latest_status == 200 else "探活")
                    awaiting[launched] = job
                    workers.add(launched)
                    threading.Thread(target=worker, args=(job.settings, job, completed), daemon=True).start()
                    last_send = now
                    probe_requested = False
                    sent = True
                else:
                    skipped += 1
                    if skipped == 1:
                        say("已达到并发/缓冲上限，跳过拥堵期间的发送时点；可调大 --max-inflight。", error=True)
                if sent and latest_status == 200:
                    # Draw once for the next keepalive gap, never on screen refresh.
                    interval = sample_keepalive_interval(args)
                    next_due = now + interval
                else:
                    # Preserve probe cadence and skip blocked/missed send times.
                    next_due += (math.floor(max(0.0, now - next_due) / interval) + 1) * interval

            if display:
                display.render({"api_id": getattr(args, "api_id", None),
                                "api_name": redact(getattr(args, "api_name", args.model), args.secrets),
                                "model": redact(args.model, args.secrets), "api_style": args.api_style,
                                "endpoint": redact(args.display_endpoint, args.secrets),
                                "session_id": current_session_id, "paused": paused,
                                "status": latest_status, "has_result": latest_decision > 0,
                                "last_error": redact(latest_error, args.secrets),
                                "inflight": len(awaiting), "next_due": next_due,
                                "menu_pending": menu_pending, "probe_interval": args.interval,
                                "keepalive_interval": args.success_interval,
                                "keepalive_max": args.success_interval_max,
                                "scheduled_interval": interval if latest_status == 200 else None,
                                "timeout": args.timeout})
            deadlines = [job.started + job_timeout(job) for job in awaiting.values()]
            if (not paused or probe_requested) and (args.count == 0 or launched < args.count):
                deadlines.append(next_due)
            delay = max(0.0, min(deadlines) - time.monotonic()) if deadlines else 0.1
            try:
                handle_completed(completed.get(timeout=min(delay, 0.1)))
            except queue.Empty:
                pass
    except KeyboardInterrupt:
        stop_code = 130
    except EOFError:
        stop_code = 0
    if stop_code is not None:
        while True:
            try:
                handle_completed(completed.get_nowait())
            except queue.Empty:
                break
        for job in list(awaiting.values()):
            ready[job.number] = Result(job, time.monotonic(), None, error="用户停止；本地不再等待结果")
        while next_print in ready:
            emit(ready.pop(next_print))
            next_print += 1
        say("已停止发送。", error=True)
        return stop_code
    if skipped:
        say(f"完成；因并发/缓冲上限跳过 {skipped} 个发送时点。", error=True)
    return 0


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="定时探活与随机保活，按请求编号输出第三方兼容 API 的结果。")
    parser.add_argument("--version", action="version", version=f"codex-poll {VERSION}")
    parser.add_argument("--mode", choices=("api", "codex"), help="调用方式；未指定时在终端询问是否沿用已保存配置，首次启动显示调用方式菜单")
    parser.add_argument("--codex-config", type=Path, help="指定 Codex config.toml；默认自动查找")
    parser.add_argument("--profile", help="使用 Codex 配置中的指定 profile")
    parser.add_argument("--no-codex-config", action="store_true", help="不读取 Codex 配置，仅使用手动参数或环境变量")
    parser.add_argument("--show-config", action="store_true", help="只显示已解析的配置，不发送请求，不显示密钥")
    parser.add_argument("--settings", action="store_true", help="启动时进入设置，保存后退出，不发送生成请求")
    parser.add_argument("--setup", action="store_true", help="重新运行启动配置流程，完成后保存为新的默认配置")
    display_mode = parser.add_mutually_exclusive_group()
    display_mode.add_argument("--multi", action="store_true", help="运行多任务工作台；交互终端默认启用")
    display_mode.add_argument("--single", action="store_true", help="使用原单任务界面和命令行行为")
    parser.add_argument("--task", action="append", help="多任务：添加已保存 API 的名称或 ID，可重复传入")
    parser.add_argument("--concurrency", type=positive_int, help="多任务总同时请求上限，默认 8，最多 64")
    parser.add_argument("--task-inflight", type=positive_int, help="每个任务同时请求上限，默认 1，最多 64")
    parser.add_argument("--mouse", action=argparse.BooleanOptionalAction, default=None,
                        help="启用/关闭终端鼠标点击；支持的终端默认开启")
    parser.add_argument("--base-url", help="手动指定网址时不继承 Codex 密钥，需同时配置密钥或 OPENAI_API_KEY")
    parser.add_argument("--api-key", help="覆盖当前密钥；手动模式也可用 OPENAI_API_KEY")
    parser.add_argument("--model", help="Codex 模式覆盖模型；API 模式验证列表后选择该模型")
    parser.add_argument("--api-style", choices=("auto", "chat", "responses"), default="auto", help="默认识别完整地址，否则用 Responses；chat 需显式选择")
    parser.add_argument("--stream", action=argparse.BooleanOptionalAction, default=None, help="流式请求；Responses 和 Codex 模式默认开启，可用 --no-stream 关闭")
    parser.add_argument("--interval", "--error-interval", "--probe-interval", type=positive_float,
                        help="探活间隔：初始及非 200 时的发送间隔，未保存时默认 2 秒")
    parser.add_argument("--success-interval", "--keepalive-interval", type=positive_float,
                        help="使用固定保活间隔；与 --keepalive-min/--keepalive-max 互斥")
    parser.add_argument("--keepalive-min", "--success-interval-min", type=positive_float,
                        help="随机保活的最短间隔，未保存时默认 60 秒")
    parser.add_argument("--keepalive-max", "--success-interval-max", dest="success_interval_max", type=positive_float,
                        help="随机保活的最长间隔，未保存时默认 90 秒；与最短间隔相等时固定发送")
    parser.add_argument("--timeout", "--request-timeout", type=positive_float,
                        help="单个请求总超时时限，未保存时默认 30 秒")
    parser.add_argument("--max-inflight", type=positive_int, default=64, help="并发请求数及待打印窗口上限，默认 64")
    parser.add_argument("--max-tokens", type=positive_int, default=None, help="每次模型响应输出 token 上限，默认 128")
    parser.add_argument("--tool-mode", choices=client.TOOL_MODES, default=None,
                        help="client 客户端命名空间；compatible 通用函数；off 关闭工具，默认 client")
    parser.add_argument("--token-param", choices=("auto", "max_tokens", "max_completion_tokens", "max_output_tokens", "none"), default="auto", help="token 上限字段；none 表示不传此字段")
    parser.add_argument("--prompt", action="append", help="自定义短问题，可重复传入；默认轮换 200 道短逻辑题")
    parser.add_argument("--count", type=int, default=0, help="总请求数，默认 0 表示无限")
    parser.add_argument("--log-file", type=Path, help="可选：将结果按编号追加到 UTF-8 JSONL 文件")
    parser.add_argument("--memory", action=argparse.BooleanOptionalAction, default=True, help="保存 API 配置和请求记录，默认开启；--no-memory 关闭")
    parser.add_argument("--data-dir", type=Path, default=default_data_directory(Path(__file__).resolve().parent),
                        help="本地记忆目录；Linux 使用 XDG 用户目录，macOS 使用 Application Support，已有脚本旁数据优先")
    parser.add_argument("--saved-api", help="使用已保存 API 的名称或 ID")
    parser.add_argument("--save-as", help="当前 API 在记忆中的名称")
    parser.add_argument("--list-saved", action="store_true", help="列出已保存 API 后退出，不发请求")
    parser.add_argument("--controls", action=argparse.BooleanOptionalAction, default=None, help="启用运行控制键；交互终端默认开启")
    parser.add_argument("--display", choices=("auto", "dashboard", "compact", "verbose"), default=None,
                        help="显示方式：默认终端固定面板；compact 每条一行；verbose 完整文本")
    parser.add_argument("--color", choices=("auto", "always", "never"), default=None,
                        help="状态颜色；默认仅在支持颜色的终端启用，也支持 NO_COLOR 环境变量")
    parser.add_argument("--start-paused", action=argparse.BooleanOptionalAction, default=None,
                        help="启动后先暂停；--no-start-paused 直接开始；未指定时使用默认配置")
    parser.add_argument("--reset-session-on-400", action=argparse.BooleanOptionalAction, default=None,
                        help="HTTP 400 时更新会话 ID；--no-reset-session-on-400 保留；未指定时沿用默认配置，首次交互时选择")
    args = parser.parse_args(argv)
    args._explicit_connection = bool(args.mode or args.base_url or args.codex_config or args.profile
                                    or args.no_codex_config or args.saved_api)
    if args.single and args.task:
        parser.error("--task 不能与 --single 同时使用")
    if any(value is not None and value > 64 for value in (args.concurrency, args.task_inflight)):
        parser.error("同时请求上限不能超过 64")
    if args.count < 0:
        parser.error("--count 不能小于 0")
    if args.prompt and any(not prompt.strip() for prompt in args.prompt):
        parser.error("--prompt 不能是空白内容")
    args._request_overrides = {field: getattr(args, field) for field in client.REQUEST_DEFAULTS
                               if getattr(args, field) is not None}
    for field, default in client.REQUEST_DEFAULTS.items():
        setattr(args, field, args._request_overrides.get(field, default))
    preferences = {"reset_session_on_400": True, "start_paused": False, "display": "auto", "color": "auto"}
    args._preference_overrides = {field for field in preferences if getattr(args, field) is not None}
    args._prompt_session_policy = args.reset_session_on_400 is None
    for field, default in preferences.items():
        if getattr(args, field) is None:
            setattr(args, field, default)
    ui.terminal.color_mode = args.color
    if args.success_interval is not None:
        if args.keepalive_min is not None or args.success_interval_max is not None:
            parser.error("固定保活间隔与随机范围不能同时指定；请选择 --success-interval 或 --keepalive-min/--keepalive-max")
        args.success_interval_max = args.success_interval
    else:
        args.success_interval = args.keepalive_min
    del args.keepalive_min
    args._timing_overrides = {name: getattr(args, name) for name in TIMING_DEFAULTS
                              if getattr(args, name) is not None}
    for name, default in TIMING_DEFAULTS.items():
        setattr(args, name, args._timing_overrides.get(name, default))
    try:
        args.controls = sys.stdin.isatty() if args.controls is None else args.controls
        has_memory = args.memory and (not args.show_config or args.saved_api
                                      or (args.data_dir.expanduser() / "memory.sqlite3").is_file())
        args._memory_store = MemoryStore(args.data_dir) if has_memory else None
        if args.list_saved:
            if not args._memory_store:
                raise ValueError("--list-saved 需要开启记忆模式")
            show_saved_apis(args._memory_store)
            return args
        has_workspace = bool(args._memory_store and args._memory_store.load_workspace())
        args._workspace_mode = not args.single and bool(
            args.multi or args.task or
            (args.controls and ui.terminal.interactive() and not args.show_config) or
            (has_workspace and not args._explicit_connection))
        if args._workspace_mode:
            args.prompts = args.prompt or DEFAULT_PROMPTS
            args.secrets = [args.api_key] if args.api_key else []
            return args
        apply_startup_defaults(args, args._memory_store)
        ui.terminal.color_mode = args.color
        if args.settings and (not sys.stdin.isatty() or not sys.stdout.isatty()):
            raise ValueError("--settings 需要在交互终端中使用")
        if args.start_paused and not args.settings and not args.show_config and (not args.controls or not sys.stdin.isatty()):
            raise ValueError("--start-paused 需要在交互终端中启用控制键")
        select_mode(args)
        apply_configuration(args)
    except (tomllib.TOMLDecodeError, json.JSONDecodeError, TypeError, AttributeError):
        parser.error("配置文件格式不正确；请检查 Codex config.toml 和 auth.json")
    except (OSError, sqlite3.Error) as exc:
        parser.error(f"无法读取配置或记忆：{getattr(exc, 'filename', None) or type(exc).__name__}；可用 --no-memory 关闭记忆或 --mode api 手动配置")
    except ValueError as exc:
        parser.error(str(exc))
    for field, flag, env_name in (("base_url", "--base-url", "OPENAI_BASE_URL"),
                                  ("api_key", "--api-key", "OPENAI_API_KEY")):
        value = getattr(args, field)
        if not value or not value.strip():
            parser.error(f"请设置 {flag} 或环境变量 {env_name}")
        setattr(args, field, value.strip())
    args.secrets.append(args.api_key)
    if args.model:
        args.model = args.model.strip()
    if args.mode == "codex" and not args.model:
        parser.error("Codex 配置中没有模型名，请用 --model 指定")
    if "\r" in args.api_key or "\n" in args.api_key:
        parser.error("密钥不能包含换行符")
    if args.count < 0:
        parser.error("--count 不能小于 0")
    if args.prompt and any(not prompt.strip() for prompt in args.prompt):
        parser.error("--prompt 不能是空白内容")
    try:
        refresh_connection(args)
        restore_timing(args, args._memory_store)
        restore_request_settings(args, args._memory_store)
    except ValueError as exc:
        parser.error(str(exc))
    args.prompts = args.prompt or DEFAULT_PROMPTS
    return args


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        args = parse_args(argv)
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。", file=sys.stderr)
        return 130
    if args.list_saved:
        return 0
    if getattr(args, "_workspace_mode", False):
        try:
            from codex_board import start_workspace
            return start_workspace(sys.modules[__name__], args)
        except (KeyboardInterrupt, EOFError):
            print("\n已取消。", file=sys.stderr)
            return 130
        except (ValueError, OSError, sqlite3.Error) as exc:
            print(redact(f"工作台错误：{exc}", args.secrets), file=sys.stderr)
            return 1
    if args.show_config:
        print(f"版本：{VERSION}\n配置：{args.config_source}\n接口：{args.display_endpoint}\n"
              f"模型：{args.model or '待获取列表并选择'}\n格式：{args.api_style}\n"
              f"流式：{'是' if args.stream else '否'}\n"
              f"请求工具：{args.tool_mode} | 每次响应输出上限：{args.max_tokens} tokens\n"
              f"内置题库：{len(DEFAULT_PROMPTS)} 道短逻辑题\n"
              f"HTTP 400 更新会话 ID：{'是' if args.reset_session_on_400 else '否'}\n"
              f"密钥：已读取（{args.key_source}；不显示内容）\n"
              f"{timing_summary(args)}")
        return 0
    logfile = None
    try:
        memory = args._memory_store
        model_known = bool(args.model)
        if model_known:
            configure_timing(args, startup=True)
        if args.mode == "api" and not getattr(args, "_from_saved", False):
            prepare_api(args)
        if not model_known:
            restore_timing(args, memory)
            restore_request_settings(args, memory)
            configure_timing(args, startup=True)
        select_session_policy(args)
        remember_api(args, memory, name=args.save_as, make_default=True)
        if memory and not getattr(args, "_use_startup_defaults", False):
            print("已保存为默认配置，下次启动可选择是否沿用。运行中按 s 修改设置。", flush=True)
        if args.settings:
            manage_settings(args, memory, standalone=True)
            return 0
        if args.log_file:
            args.log_file.parent.mkdir(parents=True, exist_ok=True)
            logfile = args.log_file.open("a", encoding="utf-8")
        return run(args, logfile, memory=memory)
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。", file=sys.stderr)
        return 130
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(redact(f"运行错误：{exc}", args.secrets), file=sys.stderr)
        return 1
    finally:
        if logfile:
            logfile.close()


def cli(argv=None) -> int:
    if os.name == "nt" or threading.current_thread() is not threading.main_thread():
        return main(argv)
    received_signal = None

    def terminate(signum, frame):
        nonlocal received_signal
        received_signal = signum
        raise StopSignal(signum)

    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        result = main(argv)
        return 128 + received_signal if received_signal is not None else result
    except KeyboardInterrupt:
        return 128 + received_signal if received_signal is not None else 130
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    raise SystemExit(cli())
