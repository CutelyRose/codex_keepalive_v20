"""Shared cancellable HTTP/SSE transport for ordinary tasks and Key pools."""
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
import json

import codex_poll as poll

TLS_CONTEXT = ssl.create_default_context()


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


def request_stream(config, request, lane, secrets, clock, on_event):
    response = None
    outcome = {'accepted': False, 'retryable': True}
    started, last_data = clock(), clock()
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
            return outcome
        buffer, data_lines, event_type, size = b'', [], '', 0
        last_data = clock()

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
            confirmed = on_event(kind, raw, accepted)
            if accepted and confirmed:
                outcome['accepted'] = True
            if kind in ('error', 'response.failed'):
                raise ValueError(raw[:500])

        while not response.isclosed():
            elapsed = clock() - started
            remaining = min(600 - elapsed, 60 - (clock() - last_data))
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
            last_data = clock()
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
        outcome['error'] = poll.redact(str(exc) or type(exc).__name__, secrets)
        outcome['retryable'] = outcome['retryable'] and retryable(outcome['error'])
        outcome['interrupted'] = outcome['accepted']
    finally:
        if response is not None:
            response.close()
        outcome['summary'] = poll.redact(lane.summary, secrets)
        if 'error' in outcome:
            outcome['error'] = poll.redact(outcome['error'], secrets)
        outcome['finished'] = clock()
    return outcome
