"""Local API profiles and request history. Uses only Python's standard library."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import sqlite3
import stat
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit


IS_WINDOWS = os.name == "nt"
TIMING_DEFAULTS = {"interval": 2.0, "success_interval": 60.0,
                   "success_interval_max": 90.0, "timeout": 30.0}
SETTING_FIELDS = ("mode", "base_url", "model", "api_style", "stream", "max_tokens", "token_param", "tool_mode",
                  *TIMING_DEFAULTS)


def default_data_directory(script_directory: Path) -> Path:
    portable = script_directory / "codex_poll_data"
    if IS_WINDOWS or portable.is_dir():
        return portable
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "CodexKeepalive"
    root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share").expanduser()
    if not root.is_absolute():
        root = Path.home() / ".local" / "share"
    return root / "codex-keepalive"


def validate_defaults(values: dict) -> dict:
    if not isinstance(values, dict) or values.get("schema_version") != 1:
        raise ValueError("默认配置格式不正确，请用 --setup 重新配置")
    required = ("api_id", "source", "codex_config", "profile", "reset_session_on_400",
                "display", "color", "start_paused", "schema_version")
    data = {name: values.get(name) for name in required}
    if not isinstance(data["api_id"], str) or not data["api_id"]:
        raise ValueError("默认 API 无效，请用 --setup 重新配置")
    if data["source"] not in ("codex", "saved"):
        raise ValueError("默认调用方式无效，请用 --setup 重新配置")
    if any(data[name] is not None and not isinstance(data[name], str) for name in ("codex_config", "profile")):
        raise ValueError("默认配置路径无效，请用 --setup 重新配置")
    if any(type(data[name]) is not bool for name in ("reset_session_on_400", "start_paused")):
        raise ValueError("默认启动选项无效，请用 --setup 重新配置")
    if data["display"] not in ("auto", "dashboard", "compact", "verbose") or data["color"] not in ("auto", "always", "never"):
        raise ValueError("默认显示选项无效，请用 --setup 重新配置")
    return data


def connection_key(settings: dict) -> str:
    fields = {key: settings.get(key) for key in
              ("mode", "base_url", "model", "api_style", "api_key", "extra_headers", "query_params")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _dpapi(data: bytes, encrypt: bool) -> bytes:
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    source = ctypes.create_string_buffer(data)
    blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    func = crypt.CryptProtectData if encrypt else crypt.CryptUnprotectData
    description_type = wintypes.LPCWSTR if encrypt else ctypes.POINTER(wintypes.LPWSTR)
    func.argtypes = [ctypes.POINTER(Blob), description_type, ctypes.POINTER(Blob),
                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    func.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    description = "Codex keepalive API credentials" if encrypt else None
    if not func(ctypes.byref(blob), description, None, None, None, 1, ctypes.byref(output)):
        raise OSError("Windows 无法加密/解密已保存的密钥，请在保存时使用的 Windows 账户下运行")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


class MemoryStore:
    def __init__(self, directory: Path):
        self.directory = Path(directory).expanduser().resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "memory.sqlite3"
        if not IS_WINDOWS:
            self._secure_posix_storage()
        self._session_credentials: dict[str, dict] = {}
        with self._connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS apis (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    fingerprint TEXT NOT NULL UNIQUE,
                    settings_json TEXT NOT NULL, secret_blob TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL, request_id INTEGER NOT NULL,
                    api_id TEXT, http_status INTEGER, started_at TEXT NOT NULL,
                    record_json TEXT NOT NULL, UNIQUE(run_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS requests_api ON requests(api_id, id);
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY, value_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS private_settings (
                    key TEXT PRIMARY KEY, settings_json TEXT NOT NULL, secret_blob TEXT NOT NULL
                );
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(requests)")}
            if "task_id" not in columns:
                db.execute("ALTER TABLE requests ADD COLUMN task_id TEXT")
            db.execute("CREATE INDEX IF NOT EXISTS requests_task ON requests(task_id, id)")

    def _secure_posix_storage(self) -> None:
        """Secure the dedicated data directory before storing any credentials."""
        self.directory.chmod(0o700)
        if self.path.is_symlink():
            raise OSError("记忆数据库不能是符号链接，请指定独立的 --data-dir")
        if self.path.exists() and not self.path.is_file():
            raise OSError("记忆数据库必须是普通文件")
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                raise OSError("记忆数据库必须由当前用户独立拥有，请指定其他 --data-dir")
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def save_profile(self, settings: dict, name: str | None = None, profile_id: str | None = None,
                     *, defaults: dict | None = None) -> dict:
        fingerprint = connection_key(settings)
        visible = {key: settings.get(key) for key in SETTING_FIELDS}
        credentials = {key: settings.get(key) or ("" if key == "api_key" else {})
                       for key in ("api_key", "extra_headers", "query_params")}
        raw = json.dumps(credentials, ensure_ascii=False).encode("utf-8")
        if IS_WINDOWS:
            protected = "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode("ascii")
        else:
            protected = "posix:" + raw.decode("utf-8")
        with self._connection() as db:
            existing = db.execute("SELECT id, name FROM apis WHERE fingerprint=?", (fingerprint,)).fetchone()
            if existing:
                profile_id = existing["id"]
                name = name or existing["name"]
            profile_id = profile_id or str(uuid.uuid4())
            name = (name or f"{urlsplit(settings['base_url']).netloc} / {settings['model']}").strip()
            if not name:
                raise ValueError("保存的 API 名称不能为空")
            startup = validate_defaults({**defaults, "api_id": profile_id}) if defaults is not None else None
            db.execute("""
                INSERT INTO apis(id,name,fingerprint,settings_json,secret_blob,updated_at)
                VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name, fingerprint=excluded.fingerprint,
                  settings_json=excluded.settings_json, secret_blob=excluded.secret_blob,
                  updated_at=excluded.updated_at
            """, (profile_id, name, fingerprint, json.dumps(visible, ensure_ascii=False), protected,
                  datetime.now().astimezone().isoformat(timespec="seconds")))
            if startup is not None:
                db.execute("""INSERT INTO app_settings(key,value_json) VALUES('startup_defaults',?)
                              ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json""",
                           (json.dumps(startup, ensure_ascii=False),))
        self._session_credentials[profile_id] = credentials
        return {"id": profile_id, "name": name}

    def load_defaults(self) -> dict | None:
        with self._connection() as db:
            row = db.execute("SELECT value_json FROM app_settings WHERE key='startup_defaults'").fetchone()
        return validate_defaults(json.loads(row[0])) if row else None

    def load_workspace(self) -> dict | None:
        with self._connection() as db:
            row = db.execute("SELECT value_json FROM app_settings WHERE key='workspace'").fetchone()
        return json.loads(row[0]) if row else None

    def _private_values(self, key, public, credentials):
        raw = json.dumps(credentials, ensure_ascii=False).encode("utf-8")
        protected = ("dpapi:" + base64.b64encode(_dpapi(raw, True)).decode("ascii") if IS_WINDOWS
                     else "posix:" + raw.decode("utf-8"))
        return key, json.dumps(public, ensure_ascii=False), protected

    def _write_private(self, db, values):
        db.execute("""INSERT INTO private_settings(key,settings_json,secret_blob) VALUES(?,?,?)
                      ON CONFLICT(key) DO UPDATE SET settings_json=excluded.settings_json,
                      secret_blob=excluded.secret_blob""", values)

    def _load_private(self, key, *, public_only=False):
        with self._connection() as db:
            row = db.execute("SELECT settings_json,secret_blob FROM private_settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        public = json.loads(row["settings_json"])
        if public_only:
            return public
        blob = row["secret_blob"]
        if blob.startswith("dpapi:") and IS_WINDOWS:
            credentials = json.loads(_dpapi(base64.b64decode(blob[6:]), False).decode("utf-8"))
        elif blob.startswith("posix:"):
            credentials = json.loads(blob[6:])
        else:
            raise ValueError("保存的任务凭据属于其他系统，请单独重新设置此任务的连接")
        notification = {**public.get("notification", {}), **credentials.pop("notification", {})}
        return {**public, **credentials, "notification": notification}

    def _task_snapshot_values(self, task_id, settings):
        from codex_tasks import OPTION_FIELDS
        from codex_notify import validate
        values = vars(settings) if not isinstance(settings, dict) else settings
        public = {key: values[key] for key in (*SETTING_FIELDS, *OPTION_FIELDS, "api_id", "api_name") if key in values}
        notification = validate(values.get("notification"))
        public["notification"] = {key: value for key, value in notification.items() if key not in ("bot_token", "proxy_url")}
        credentials = {key: values.get(key) or ("" if key == "api_key" else {})
                       for key in ("api_key", "extra_headers", "query_params")}
        credentials["notification"] = {key: notification[key] for key in ("bot_token", "proxy_url")}
        return self._private_values("task:" + task_id, public, credentials)

    def load_task_snapshot(self, task_id, *, public_only=False):
        return self._load_private("task:" + task_id, public_only=public_only)

    def save_notification_defaults(self, settings):
        from codex_notify import validate
        settings = validate(settings)
        public = {"notification": {k: v for k, v in settings.items() if k not in ("bot_token", "proxy_url")}}
        private = {"notification": {k: settings[k] for k in ("bot_token", "proxy_url")}}
        values = self._private_values("telegram:defaults", public, private)
        with self._connection() as db:
            self._write_private(db, values)

    def load_notification_defaults(self):
        from codex_notify import validate
        values = self._load_private("telegram:defaults")
        return validate(values["notification"] if values else None)

    def save_workspace(self, workspace: dict, *, task_snapshots=None) -> None:
        # The workspace stores profile references, never authentication fields.
        from codex_tasks import validate_workspace
        safe = validate_workspace(workspace)
        rows = [self._task_snapshot_values(task_id, values) for task_id, values in (task_snapshots or {}).items()]
        with self._connection() as db:
            db.execute("""INSERT INTO app_settings(key,value_json) VALUES('workspace',?)
                          ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json""",
                       (json.dumps(safe, ensure_ascii=False),))
            for values in rows:
                self._write_private(db, values)

    def delete_profile(self, profile_id: str) -> bool:
        group = self.load_workspace() or {}
        if any(task.get("api_id") == profile_id for task in group.get("tasks", [])):
            raise ValueError("此 API 仍被任务组使用，请先切换或移除相关任务")
        with self._connection() as db:
            changed = db.execute("DELETE FROM apis WHERE id=?", (profile_id,)).rowcount
            row = db.execute("SELECT value_json FROM app_settings WHERE key='startup_defaults'").fetchone()
            if row and json.loads(row[0]).get("api_id") == profile_id:
                db.execute("DELETE FROM app_settings WHERE key='startup_defaults'")
        return bool(changed)

    def profile_settings(self, profile_id: str) -> dict | None:
        with self._connection() as db:
            row = db.execute("SELECT settings_json FROM apis WHERE id=?", (profile_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list_profiles(self) -> list[dict]:
        with self._connection() as db:
            rows = db.execute("""
                SELECT a.id,a.name,a.settings_json,a.updated_at,
                  (SELECT COUNT(*) FROM requests r WHERE r.api_id=a.id) AS request_count,
                  (SELECT COUNT(*) FROM requests r WHERE r.api_id=a.id AND r.http_status=200) AS success_count,
                  (SELECT http_status FROM requests r WHERE r.api_id=a.id ORDER BY r.id DESC LIMIT 1) AS last_status
                FROM apis a ORDER BY a.updated_at DESC, a.name, a.id
            """).fetchall()
        return [{**dict(row), "settings": json.loads(row["settings_json"])} for row in rows]

    def connection_settings(self, settings: dict) -> dict:
        """Read public settings for the same connection without decrypting credentials."""
        with self._connection() as db:
            row = db.execute("SELECT settings_json FROM apis WHERE fingerprint=?",
                             (connection_key(settings),)).fetchone()
        return json.loads(row[0]) if row else {}

    def timing_for(self, settings: dict) -> dict:
        visible = self.connection_settings(settings)
        return {name: visible[name] for name in TIMING_DEFAULTS if name in visible}

    def load_profile(self, reference: str) -> dict:
        with self._connection() as db:
            rows = db.execute("SELECT * FROM apis WHERE id=? OR name=?", (reference, reference)).fetchall()
            if not rows:
                rows = db.execute("SELECT * FROM apis WHERE substr(id,1,?)=?", (len(reference), reference)).fetchall()
        if len(rows) != 1:
            raise ValueError("未找到唯一的已保存 API，请使用完整名称或列表中的编号")
        row = rows[0]
        blob = row["secret_blob"]
        if blob.startswith("dpapi:") and IS_WINDOWS:
            credentials = json.loads(_dpapi(base64.b64decode(blob[6:]), False).decode("utf-8"))
        elif blob.startswith("posix:"):
            credentials = json.loads(blob[6:])
        elif blob == "session-only" and row["id"] in self._session_credentials:
            credentials = self._session_credentials[row["id"]]
        else:
            credentials = {"api_key": "", "extra_headers": {}, "query_params": {}}
        return {"id": row["id"], "name": row["name"],
                "settings": {**json.loads(row["settings_json"]), **credentials}}

    def record(self, record: dict) -> None:
        with self._connection() as db:
            db.execute("""
                INSERT OR IGNORE INTO requests(run_id,request_id,api_id,http_status,started_at,record_json,task_id)
                VALUES(?,?,?,?,?,?,?)
            """, (record["run_id"], record["request_id"], record.get("api_id"), record.get("http_status"),
                  record["started_at"], json.dumps(record, ensure_ascii=False), record.get("task_id")))

    def history(self, limit: int = 10, api_id: str | None = None, *, task_id: str | None = None) -> list[dict]:
        query = "SELECT id, record_json FROM requests"
        params: list = []
        if task_id:
            query += " WHERE task_id=?"
            params.append(task_id)
        elif api_id:
            query += " WHERE api_id=?"
            params.append(api_id)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(limit, 1000)))
        with self._connection() as db:
            rows = db.execute(query, params).fetchall()
        return [{**json.loads(row['record_json']), 'record_id': row['id']} for row in reversed(rows)]

    def history_record(self, record_id: int) -> dict | None:
        with self._connection() as db:
            row = db.execute('SELECT id, record_json FROM requests WHERE id=?', (record_id,)).fetchone()
        return {**json.loads(row['record_json']), 'record_id': row['id']} if row else None

    def find_record(self, run_id: str, request_id: int) -> dict | None:
        with self._connection() as db:
            row = db.execute("SELECT id,record_json FROM requests WHERE run_id=? AND request_id=?",
                             (run_id, request_id)).fetchone()
        return {**json.loads(row["record_json"]), "record_id": row["id"]} if row else None

    def history_count(self, api_id: str | None = None, *, task_id: str | None = None) -> int:
        with self._connection() as db:
            if task_id is not None:
                return db.execute('SELECT COUNT(*) FROM requests WHERE task_id=?', (task_id,)).fetchone()[0]
            if api_id is not None:
                return db.execute('SELECT COUNT(*) FROM requests WHERE api_id=?', (api_id,)).fetchone()[0]
            return db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]

    def delete_history(self, *, record_id: int | None = None, api_id: str | None = None,
                       all_records: bool = False, task_id: str | None = None) -> int:
        if sum((record_id is not None, api_id is not None, bool(all_records), task_id is not None)) != 1:
            raise ValueError('必须明确选择单条记录、一个 API 或全部记录')
        params: tuple = ()
        clause = ''
        if record_id is not None:
            if type(record_id) is not int or not 0 < record_id <= 9223372036854775807:
                raise ValueError('记录 ID 必须是正整数')
            clause, params = ' WHERE id=?', (record_id,)
        elif api_id is not None:
            if not isinstance(api_id, str) or not api_id.strip():
                raise ValueError('请选择有效的 API')
            clause, params = ' WHERE api_id=?', (api_id,)
        elif task_id is not None:
            if not isinstance(task_id, str) or not task_id.strip():
                raise ValueError('请选择有效的任务')
            clause, params = ' WHERE task_id=?', (task_id,)
        with self._connection() as db:
            return db.execute('DELETE FROM requests' + clause, params).rowcount

    def delete_records(self, record_ids: list[int]) -> int:
        if any(type(value) is not int or not 0 < value <= 9223372036854775807 for value in record_ids):
            raise ValueError("记录 ID 无效")
        ids = list(dict.fromkeys(record_ids))
        deleted = 0
        with self._connection() as db:
            for start in range(0, len(ids), 400):
                batch = ids[start:start+400]
                deleted += db.execute("DELETE FROM requests WHERE id IN (" + ",".join("?" for _ in batch) + ")",
                                      batch).rowcount
        return deleted
