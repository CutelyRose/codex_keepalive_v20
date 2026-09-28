"""Web adapter for the existing Python Runtime; JSON commands travel over stdio."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import queue
import sqlite3
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import codex_poll as poll
from codex_memory import IS_WINDOWS, _dpapi
from codex_tasks import Runtime, make_spec

from python_transport import Lane, request_stream
from python_pool import KeyPool


def now_ms():
    return round(time.time() * 1000)


class WebRuntime(Runtime):
    def __init__(self, db_path, notification_url):
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.notification_url = notification_url
        self.entries = {}
        self.rounds = {}
        self.pools = {}
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
            data = entry['task']
            is_pool = 'pool' in data
            requests = [m['request'] for m in entry['members']] if is_pool else [entry['request']]
            request = requests[0]
            if data['id'] in self.entries:
                raise ValueError('任务 ID 重复')
            config = data['config']
            key = request['headers']['Authorization'].removeprefix('Bearer ')
            args = argparse.Namespace(
                mode='api', base_url=data['pool']['members'][0]['baseUrl'] if is_pool else config['baseUrl'], api_key=key, model=config['model'], api_style='responses',
                stream=True, interval=config['intervalSeconds'], success_interval=config['keepaliveMinSeconds'],
                success_interval_max=config['keepaliveMaxSeconds'], timeout=600., max_inflight=1, max_tokens=128,
                tool_mode='off', token_param='auto', reset_session_on_400=False, prompts=[config['prompt']],
                extra_headers={}, query_params={}, secrets=[*[r['headers']['Authorization'].removeprefix('Bearer ') for r in requests], config['telegramBotToken'], config.get('serverchanSendKey', ''),
                    config.get('showdocPushUrl', ''), config.get('showdocPushUrl', '').rsplit('/', 1)[-1]],
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
            if is_pool:
                self.pools[task.id] = KeyPool(self, task, entry, restore)
            if restore and not is_pool:
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
        if task_id in self.pools:
            pool = self.pools[task_id]
            data['pool'] = pool.view()
            due = [pool.due[key] for key in pool.eligible() if key not in pool.active]
            if due and not task.paused:
                data['nextAttemptAt'] = pool.wall(min(due))
            else:
                data.pop('nextAttemptAt', None)
        elif task and data['status'] in ('running', 'waiting', 'keepalive') and not task.paused:
            data['nextAttemptAt'] = round((self.epoch + task.next_due) * 1000)
        else:
            data.pop('nextAttemptAt', None)
        if not private:
            data['config']['telegramBotToken'] = ''
            data['config']['serverchanSendKey'] = ''
            data['config']['showdocPushUrl'] = ''
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
                if task_id in self.pools:
                    self.pools[task_id].resume()
                    self.event(task_id, 'task.resumed', '池任务已继续')
                    self.save(task_id)
                    self.wake.set()
                    return True
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
        if task_id in self.pools:
            self.pools[task_id].stop()
        for lane in self.rounds.get(task_id, []):
            lane.cancel()

    def scheduled_externally(self, task):
        return task.id in self.pools

    def step(self):
        with self.lock:
            for task_id, pool in list(self.pools.items()):
                pool.tick()
                if self.find(task_id) is None and not pool.physical:
                    del self.pools[task_id]
            super().step()

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
        def on_event(kind, raw, accepted):
            with self.lock:
                if not self.current(job.task_id, revision) or lane.cancelled.is_set():
                    raise InterruptedError('任务已停止')
                task_data = self.entries[job.task_id]['task']
                if accepted and not winner:
                    winner.append(lane)
                    for sibling in lanes:
                        if sibling is not lane:
                            sibling.cancel()
                    self.accepted(self.find(job.task_id), kind)
                if len(lanes) == 1 or winner == [lane]:
                    task_data['responseSummary'] = poll.redact(lane.summary, args.secrets)

                return winner == [lane]
        completed.put(request_stream(args.web_config, args.web_request, lane, args.secrets, self.clock, on_event))

    def accepted(self, task, kind, member=None):
        data = self.entries[task.id]['task']
        notify = not data['healthy'] and now_ms() - data.get('lastNotifiedAt', 0) >= 300_000
        data.update(status='accepted-streaming', healthy=True, probeAttempts=0,
                    acceptedAt=now_ms(), successes=data['successes'] + 1)
        data.pop('lastError', None)
        detail = f'{member["alias"]} · 尾号 {member["keyTail"]} 独自保活。' if member else '成功后自动保活。' if data['config']['keepalive'] else '成功后结束任务。'
        self.event(task.id, kind, '已成功挤入', detail, 'success')
        if notify and data['notificationConfigured']:
            data['lastNotifiedAt'] = now_ms()
            data['notificationStatus'] = 'queued'
            snapshot = self.view(task.id, private=True, details=False)
            if member:
                snapshot['config']['name'] += f' · {member["alias"]}'
            key_tail = member['keyTail'] if member else task.args.api_key[-4:]
            threading.Thread(target=self.notify_task, args=(task.id, task.revision, snapshot, key_tail), daemon=True).start()
        self.save(task.id)

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

    def notify_task(self, task_id, revision, data, key_tail):
        config = data['config']
        payload = {'taskId': f'{task_id}:{data["acceptedAt"]}', 'taskName': config['name'], 'channel': config['channel'],
                   'model': config['model'], 'keyTail': key_tail, 'attempts': data['attemptsMade'],
                   'elapsedMs': data['acceptedAt'] - data['startedAt'], 'acceptedAt': data['acceptedAt'],
                   'chatId': config['telegramChatId'], 'botToken': config['telegramBotToken'],
                   'showdocUrl': config.get('showdocPushUrl', ''),
                   'sendKey': config.get('serverchanSendKey', ''), 'tags': config.get('serverchanTags', '')}
        try:
            headers = {'Content-Type': 'application/json'}
            if os.environ.get('ANYROUTER_INTERNAL_AUTH'):
                headers['Authorization'] = os.environ['ANYROUTER_INTERNAL_AUTH']
            req = urllib.request.Request(self.notification_url, data=json.dumps(payload).encode(), headers=headers)
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), poll.NoRedirect()).open(req, timeout=20) as response:
                receipt = json.loads(response.read(16384))
            with self.lock:
                if self.current(task_id, revision) and self.entries[task_id]['task']['acceptedAt'] == data['acceptedAt']:
                    current = self.entries[task_id]['task']
                    current.update(notificationId=receipt['id'], notificationStatus=receipt['status'], notificationAttempts=receipt['attempts'])
                    self.save(task_id)
        except Exception as exc:
            with self.lock:
                if self.current(task_id, revision) and self.entries[task_id]['task']['acceptedAt'] == data['acceptedAt']:
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
