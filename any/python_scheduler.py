"""Web adapter for the existing Python Runtime; JSON commands travel over stdio."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import queue
import socket
import sqlite3
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import codex_poll as poll
from codex_memory import IS_WINDOWS, _dpapi
from codex_tasks import Runtime, make_spec

TLS_CONTEXT = ssl.create_default_context()


def now_ms():
    return round(time.time() * 1000)


def compact(value, limit=8192):
    raw = value.encode('utf-8')
    return value if len(raw) <= limit else raw[:limit - 3].decode('utf-8', errors='ignore') + '…'


def retryable(detail, status=None):
    import re
    if re.search(r'insufficient_quota|quota exceeded|insufficient credit|credit balance|billing limit|额度不足|配额不足|余额不足|invalid[ _](?:token|api[ _]key|request)|authentication_error|permission_error|not_found_error|unauthorized|令牌无效|无效的令牌|model_not_found', detail, re.I):
        return False
    return status is None or status in (408, 409, 425, 429, 500, 502, 503, 504, 529)


class Lane(urllib.request.HTTPHandler, urllib.request.HTTPSHandler):
    def __init__(self):
        super().__init__(context=TLS_CONTEXT)
        self.cancelled = threading.Event()
        self.sock = None
        self.summary = ''

    def do_open(self, http_class, req, **kwargs):
        lane = self
        deadline = time.monotonic() + req.timeout

        class Connection(http_class):
            def connect(self):
                if lane.cancelled.is_set():
                    raise InterruptedError('任务已停止')
                super().connect()
                lane.sock = self.sock
                if lane.cancelled.is_set():
                    raise InterruptedError('任务已停止')

            def getresponse(self):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('等待成功首事件超时')
                self.sock.settimeout(remaining)
                return super().getresponse()

        return super().do_open(Connection, req, **kwargs)

    def cancel(self):
        self.cancelled.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class WebRuntime(Runtime):
    def __init__(self, db_path, notification_url):
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.notification_url = notification_url
        self.entries = {}
        self.rounds = {}
        self.closing = False
        common = argparse.Namespace(count=0, start_paused=False)
        super().__init__(poll, common, {'version': 1, 'concurrency': 8, 'tasks': []}, [], request=self.request_round)
        self.epoch = time.time() - self.clock()
        self.db = sqlite3.connect(self.db_path, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload BLOB NOT NULL)')
        saved = self.db.execute('SELECT payload FROM tasks').fetchall()
        if not IS_WINDOWS:
            self.db_path.parent.chmod(0o700)
            self.db_path.chmod(0o600)
        for (blob,) in saved:
            entry = json.loads((_dpapi(blob, False) if IS_WINDOWS else blob).decode('utf-8'))
            self.add_entry(entry, restore=True)
        self.start()

    def save(self, task_id):
        with self.lock:
            entry = self.entries.get(task_id)
            if not entry or self.closing:
                return
            raw = json.dumps({**entry, 'task': self.view(task_id, private=True)}, ensure_ascii=False).encode('utf-8')
            blob = _dpapi(raw, True) if IS_WINDOWS else raw
            with self.db:
                self.db.execute('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (task_id, blob))

    def event(self, task_id, kind, title, detail='', tone='info'):
        task = self.entries[task_id]['task']
        task['events'].append({'id': str(uuid.uuid4()), 'at': now_ms(), 'type': kind, 'title': title,
                               'detail': poll.redact(detail, self.secrets()), 'tone': tone})
        del task['events'][:-200]
        task['updatedAt'] = now_ms()

    def add_entry(self, entry, restore=False):
        with self.lock:
            if len(self.tasks) >= 128:
                raise ValueError('Python 端最多保存 128 个任务')
            data, request = entry['task'], entry['request']
            if data['id'] in self.entries:
                raise ValueError('任务 ID 重复')
            config = data['config']
            key = request['headers']['Authorization'].removeprefix('Bearer ')
            args = argparse.Namespace(
                mode='api', base_url=config['baseUrl'], api_key=key, model=config['model'], api_style='responses',
                stream=True, interval=config['intervalSeconds'], success_interval=config['keepaliveMinSeconds'],
                success_interval_max=config['keepaliveMaxSeconds'], timeout=600., max_inflight=1, max_tokens=128,
                tool_mode='off', token_param='auto', reset_session_on_400=False, prompts=[config['prompt']],
                extra_headers={}, query_params={}, secrets=[key, config['telegramBotToken'], config.get('serverchanSendKey', '')],
                display_endpoint=request['url'], api_name=config['name'], web_config=config, web_request=request,
            )
            active = data['status'] in ('running', 'requesting', 'waiting', 'keepalive') or (
                data['status'] == 'accepted-streaming' and config['keepalive'])
            spec = make_spec(args, max((t.spec['number'] for t in self.tasks), default=0) + 1,
                             config['name'], task_id=data['id'], enabled=active)
            self.entries[data['id']] = entry
            task = self._add(spec, args)
            task.session_id = data['sessionId']
            task.sessions[task.key] = task.session_id
            task.status = 200 if data['healthy'] else None
            if restore:
                if active:
                    if not data['healthy'] and data['probeAttempts'] >= config['maxAttempts']:
                        task.paused, task.spec['enabled'] = True, False
                        data.update(status='exhausted', completedAt=now_ms())
                        self.save(task.id)
                        return self.view(task.id)
                    data['status'] = 'keepalive' if data['healthy'] else 'waiting'
                    task.next_due = self.clock() + max(0, data.get('nextAttemptAt', now_ms()) - now_ms()) / 1000
                    self.event(task.id, 'task.restored', 'Python 任务已恢复', '按保存的状态继续调度。')
                elif data['status'] == 'accepted-streaming':
                    data['status'] = 'accepted-stream-interrupted'
                    data['completedAt'] = now_ms()
                    self.event(task.id, 'stream.interrupted', '成功流已中断', '服务重启前已确认成功，本任务不会重复请求。', 'warning')
            self.save(task.id)
            self.wake.set()
            return self.view(task.id)

    def view(self, task_id, private=False, details=True):
        source = self.entries[task_id]['task']
        data = {**source, 'config': dict(source['config']),
                'events': list(source['events']) if details or private else [],
                'responseSummary': source['responseSummary'] if details or private else ''}
        task = self.find(task_id)
        if task and data['status'] in ('running', 'waiting', 'keepalive') and not task.paused:
            data['nextAttemptAt'] = round((self.epoch + task.next_due) * 1000)
        else:
            data.pop('nextAttemptAt', None)
        if not private:
            data['config']['telegramBotToken'] = ''
            data['config']['serverchanSendKey'] = ''
        return data

    def command(self, method, params):
        if method == 'models':
            req = urllib.request.Request(params['url'], headers={'Authorization': 'Bearer ' + params['token'], 'Accept': 'application/json'})
            try:
                with urllib.request.build_opener(poll.NoRedirect()).open(req, timeout=20) as response:
                    result = json.loads(response.read(1024 * 1024))
            except urllib.error.HTTPError as exc:
                raise ValueError(f'模型鉴权失败：HTTP {exc.code}') from None
            return {'ok': True, 'models': sorted({item['id'] for item in result.get('data', [])
                if isinstance(item, dict) and isinstance(item.get('id'), str)})}
        with self.lock:
            if method == 'health':
                return not self.closing and not self.failure and self.thread is not None and self.thread.is_alive()
            if method == 'list':
                if self.failure:
                    raise ValueError('Python 调度已停止：' + self.failure)
                return [self.view(t.id, details=t.id == params.get('detail')) for t in self.tasks]
            if method == 'create':
                return self.add_entry(params)
            task_id = params['id']
            task = self.find(task_id)
            if task is None:
                raise ValueError('Python 任务不存在')
            data = self.entries[task_id]['task']
            if method == 'restart':
                return copy.deepcopy(self.entries[task_id])
            if method in ('pause', 'cancel', 'remove'):
                if method != 'remove' and data['status'] not in ('running', 'requesting', 'waiting', 'keepalive', 'paused', 'accepted-streaming'):
                    return False
                self.abort_task(task_id)
                task.revision += 1
                if method == 'remove':
                    super().remove(task_id)
                    del self.entries[task_id]
                    with self.db:
                        self.db.execute('DELETE FROM tasks WHERE id=?', (task_id,))
                    return True
                task.paused, task.spec['enabled'] = True, False
                data['status'] = 'paused' if method == 'pause' else 'cancelled'
                if method == 'cancel':
                    data['completedAt'] = now_ms()
                self.event(task_id, 'task.' + method, '任务已暂停' if method == 'pause' else '任务已取消')
            elif method in ('resume', 'retryNow'):
                if data['status'] not in ('paused', 'waiting', 'keepalive'):
                    return False
                if not data['healthy'] and data['probeAttempts'] >= data['config']['maxAttempts']:
                    raise ValueError('探活次数已耗尽，请重新开始任务')
                self.abort_task(task_id)
                task.revision += 1
                super().resume(task_id)
                data['status'] = 'running'
                data.pop('completedAt', None)
                self.event(task_id, 'task.resumed', '任务已继续')
            else:
                raise ValueError('未知 Python 操作')
            self.save(task_id)
            return True

    def abort_task(self, task_id):
        for lane in self.rounds.get(task_id, []):
            lane.cancel()

    def current(self, task_id, revision):
        task = self.find(task_id)
        return not self.closing and task is not None and task.revision == revision

    def request_round(self, args, job):
        config = args.web_config
        with self.lock:
            task = self.find(job.task_id)
            if task is None or job.number not in task.awaiting or task.awaiting[job.number][1] != task.revision or task.paused:
                return poll.Result(job, self.clock(), None, error='任务已移除')
            revision = task.revision
            data = self.entries[task.id]['task']
            count = 1 if data['healthy'] else min(config['concurrency'], config['maxAttempts'] - data['probeAttempts'])
            data['attemptsMade'] += count
            if not data['healthy']:
                data['probeAttempts'] += count
            data.update(status='requesting', lastAttemptAt=now_ms(), responseSummary='')
            data.pop('completedAt', None)
            self.event(task.id, 'request.started', f'第 {data["attemptsMade"]} 次探针', f'Python 本轮并发 {count} 个请求。')
            lanes = [Lane() for _ in range(count)]
            self.rounds[task.id] = lanes
            self.save(task.id)
        completed = queue.Queue()
        winner = []
        for lane in lanes:
            threading.Thread(target=self.request_lane, args=(args, job, revision, lane, lanes, winner, completed), daemon=True).start()
        results = [completed.get() for _ in lanes]
        with self.lock:
            if self.rounds.get(job.task_id) is lanes:
                del self.rounds[job.task_id]
        selected = next((value for value in results if value.get('accepted')), None)
        if selected is None:
            selected = next((value for value in results if not value.get('retryable', True)), results[0])
        result = poll.Result(job, self.clock(), 200 if selected.get('accepted') else selected.get('status'),
                             text=selected.get('summary', ''), error=selected.get('error', ''))
        result.web = {**selected, 'retryAfter': max(r.get('retryAfter', 0) for r in results)}
        return result

    def request_lane(self, args, job, revision, lane, lanes, winner, completed):
        config, request = args.web_config, args.web_request
        response = None
        outcome = {'accepted': False, 'retryable': True}
        started, last_data = self.clock(), self.clock()
        try:
            headers = dict(request['headers'])
            if config['channel'] == 'gpt':
                headers['x-client-request-id'] = str(uuid.uuid4())
            req = urllib.request.Request(request['url'], data=request['body'].encode('utf-8'), headers=headers)
            try:
                response = urllib.request.build_opener(poll.NoRedirect(), lane).open(req, timeout=config['timeoutSeconds'])
            except urllib.error.HTTPError as exc:
                response = exc
            if response.status != 200:
                raw = response.read(8192).decode('utf-8', errors='replace')
                outcome.update(status=response.status, error=f'HTTP {response.status} · {raw[:500]}', retryable=retryable(raw, response.status))
                retry_after = response.headers.get('Retry-After')
                if retry_after:
                    from email.utils import parsedate_to_datetime
                    try:
                        outcome['retryAfter'] = max(0, float(retry_after))
                    except ValueError:
                        try:
                            outcome['retryAfter'] = max(0, parsedate_to_datetime(retry_after).timestamp() - time.time())
                        except (ValueError, TypeError, OverflowError):
                            pass
                return
            buffer, data_lines, event_type, size = b'', [], '', 0
            last_data = self.clock()

            def event():
                nonlocal event_type
                raw = '\n'.join(data_lines)
                data_lines.clear()
                kind, event_type = event_type, ''
                if not raw:
                    return
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = {}
                if kind in ('', 'message'):
                    kind = payload.get('type', 'message') if isinstance(payload, dict) else 'message'
                lane.summary = compact(lane.summary + f'event: {kind}\ndata: {raw}\n\n')
                accepted = kind in (('response.created', 'response.in_progress') if config['channel'] == 'gpt' else ('message_start',))
                with self.lock:
                    if not self.current(job.task_id, revision) or lane.cancelled.is_set():
                        raise InterruptedError('任务已停止')
                    task_data = self.entries[job.task_id]['task']
                    if accepted and not winner:
                        winner.append(lane)
                        outcome['accepted'] = True
                        for sibling in lanes:
                            if sibling is not lane:
                                sibling.cancel()
                        notify = not task_data['healthy'] and now_ms() - task_data.get('lastNotifiedAt', 0) >= 300_000
                        task_data.update(status='accepted-streaming', healthy=True, probeAttempts=0,
                                         acceptedAt=now_ms(), successes=task_data['successes'] + 1)
                        task_data.pop('lastError', None)
                        self.event(job.task_id, kind, '已成功挤入', '成功后自动保活。' if config['keepalive'] else '成功后结束任务。', 'success')
                        if notify and task_data['notificationConfigured']:
                            task_data['lastNotifiedAt'] = now_ms()
                            task_data['notificationStatus'] = 'queued'
                            threading.Thread(target=self.notify_task, args=(job.task_id, revision), daemon=True).start()
                        self.save(job.task_id)
                    if len(lanes) == 1 or winner == [lane]:
                        task_data['responseSummary'] = poll.redact(lane.summary, args.secrets)
                    if kind in ('error', 'response.failed'):
                        raise ValueError(raw[:500])

            while True:
                elapsed = self.clock() - started
                remaining = min(600 - elapsed, 60 - (self.clock() - last_data))
                if not outcome['accepted']:
                    remaining = min(remaining, config['timeoutSeconds'] - elapsed)
                if lane.cancelled.is_set():
                    raise InterruptedError('任务已停止')
                if remaining <= 0:
                    raise TimeoutError('响应流超过超时时限')
                lane.sock.settimeout(remaining)
                chunk = response.read1(65536)
                if not chunk:
                    break
                last_data = self.clock()
                size += len(chunk)
                if size > 2 * 1024 * 1024:
                    outcome['retryable'] = False
                    raise ValueError('SSE 响应超过 2 MiB 大小限制')
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    line = line.rstrip(b'\r').decode('utf-8', errors='replace')
                    if not line:
                        event()
                    elif line.startswith('data:'):
                        data_lines.append(line[5:].removeprefix(' '))
                    elif line.startswith('event:'):
                        event_type = line[6:].strip()
            if buffer.startswith(b'data:'):
                data_lines.append(buffer[5:].strip().decode('utf-8', errors='replace'))
            event()
            if not outcome['accepted']:
                outcome['error'] = 'SSE 流结束但未收到成功信号'
        except Exception as exc:
            outcome['error'] = poll.redact(str(exc) or type(exc).__name__, args.secrets)
            outcome['retryable'] = outcome['retryable'] and retryable(outcome['error'])
            outcome['interrupted'] = outcome['accepted']
        finally:
            if response is not None:
                response.close()
            outcome['summary'] = poll.redact(lane.summary, args.secrets)
            completed.put(outcome)

    def _emit(self, task, result):
        # Web events are stored on entries; terminal records duplicate unused response history.
        task.total += 1
        task.successes += result.status == 200

    def _accept(self, task, revision, result):
        active = result.job.number in task.awaiting and revision == task.revision and not self.closing
        if active and result.status != 200 and self.entries[task.id]['task']['status'] == 'accepted-streaming':
            self.abort_task(task.id)
            result.status = 200
            result.web = {'interrupted': True}
        super()._accept(task, revision, result)
        if not active or task.id not in self.entries:
            return
        data = self.entries[task.id]['task']
        web = getattr(result, 'web', {})
        if result.status == 200:
            data['status'] = 'keepalive' if data['config']['keepalive'] else 'accepted-stream-interrupted' if web.get('interrupted') else 'accepted-completed'
            if web.get('interrupted'):
                data['lastError'] = result.error
                self.event(task.id, 'stream.interrupted', '成功流已中断', result.error, 'warning')
            if not data['config']['keepalive']:
                task.paused, task.spec['enabled'] = True, False
                data['completedAt'] = now_ms()
            else:
                self.event(task.id, 'keepalive.waiting', '自动保活', f'下一次间隔 {task.interval:.1f} 秒。', 'success')
        else:
            if data['healthy']:
                data['probeAttempts'] = 1
            data.update(healthy=False, status='waiting', lastError=poll.redact(result.error, self.secrets()))
            task.next_due = max(task.next_due, self.clock() + web.get('retryAfter', 0))
            if not web.get('retryable', True) or data['probeAttempts'] >= data['config']['maxAttempts']:
                task.paused, task.spec['enabled'] = True, False
                data.update(status='exhausted', completedAt=now_ms())
                if not web.get('retryable', True):
                    data['stopReason'] = 'permanent-error'
            self.event(task.id, 'request.failed', '错误停止' if data['status'] == 'exhausted' else '等待重新探活', data['lastError'], 'warning')
        self.save(task.id)

    def notify_task(self, task_id, revision):
        with self.lock:
            if not self.current(task_id, revision):
                return
            data = self.view(task_id, private=True, details=False)
            key = self.find(task_id).args.api_key
        config = data['config']
        payload = {'taskId': f'{task_id}:{data["acceptedAt"]}', 'taskName': config['name'], 'channel': config['channel'],
                   'model': config['model'], 'keyTail': key[-4:], 'attempts': data['attemptsMade'],
                   'elapsedMs': data['acceptedAt'] - data['startedAt'], 'acceptedAt': data['acceptedAt'],
                   'chatId': config['telegramChatId'], 'botToken': config['telegramBotToken'],
                   'sendKey': config.get('serverchanSendKey', ''), 'tags': config.get('serverchanTags', '')}
        try:
            headers = {'Content-Type': 'application/json'}
            if os.environ.get('ANYROUTER_INTERNAL_AUTH'):
                headers['Authorization'] = os.environ['ANYROUTER_INTERNAL_AUTH']
            req = urllib.request.Request(self.notification_url, data=json.dumps(payload).encode(), headers=headers)
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), poll.NoRedirect()).open(req, timeout=20) as response:
                receipt = json.loads(response.read(16384))
            with self.lock:
                if self.current(task_id, revision):
                    current = self.entries[task_id]['task']
                    current.update(notificationId=receipt['id'], notificationStatus=receipt['status'], notificationAttempts=receipt['attempts'])
                    self.save(task_id)
        except Exception as exc:
            with self.lock:
                if self.current(task_id, revision):
                    self.entries[task_id]['task']['notificationStatus'] = 'dead'
                    self.event(task_id, 'notification.dead', '通知提交失败', str(exc), 'warning')
                    self.save(task_id)

    def close(self):
        with self.lock:
            if self.closing:
                return
            for task in self.tasks:
                self.save(task.id)
                self.abort_task(task.id)
            self.closing = True
        self.stop()
        with self.lock:
            self.db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True)
    parser.add_argument('--notification-url', required=True)
    args = parser.parse_args()
    service = WebRuntime(args.db, args.notification_url)
    output_lock = threading.Lock()

    def reply(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False), flush=True)

    def command(message):
        try:
            result = service.command(message['method'], message.get('params', {}))
            reply({'id': message['id'], 'result': result})
        except Exception as exc:
            reply({'id': message.get('id'), 'error': poll.redact(str(exc), service.secrets())})

    reply({'ready': True})
    try:
        for line in sys.stdin:
            message = json.loads(line)
            if message['method'] == 'models':
                threading.Thread(target=command, args=(message,), daemon=True).start()
            else:
                command(message)
    finally:
        service.close()


if __name__ == '__main__':
    main()
