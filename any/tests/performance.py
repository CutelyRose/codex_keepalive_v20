"""Local synthetic benchmark; no model or notification requests are sent."""
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time
import tracemalloc
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_scheduler import Lane, WebRuntime, now_ms, poll


def milliseconds(action, count=20):
    samples = []
    for _ in range(3):
        started = time.perf_counter()
        for _ in range(count):
            action()
        samples.append((time.perf_counter() - started) * 1000 / count)
    return round(statistics.median(samples), 3)


with tempfile.TemporaryDirectory(prefix='anyrouter-perf-') as directory:
    assert Path(directory).resolve().parent == Path(tempfile.gettempdir()).resolve()
    with patch.object(WebRuntime, 'start'):
        runtime = WebRuntime(Path(directory) / 'tasks.sqlite', 'http://127.0.0.1:1/api/notifications')
    try:
        for index in range(32):
            task_id = 'python_' + str(uuid.uuid4())
            config = dict(name=f'Benchmark {index}', channel='gpt', keyId='benchmark',
                          baseUrl='http://127.0.0.1:1', model='gpt-benchmark', prompt='Reply OK',
                          maxAttempts=300, concurrency=1, intervalSeconds=2, timeoutSeconds=30,
                          keepalive=True, keepaliveMinSeconds=60, keepaliveMaxSeconds=90,
                          telegramChatId='', telegramBotToken='', oneMillion=False)
            task = dict(id=task_id, scheduler='python', sessionId=str(uuid.uuid4()), config=config,
                        status='paused', attemptsMade=200, probeAttempts=0, successes=200, healthy=True,
                        startedAt=now_ms(), updatedAt=now_ms(), responseSummary='x' * 8192,
                        events=[dict(id=str(n), at=now_ms(), type='request.started', title='Benchmark',
                                     detail='x' * 100, tone='info') for n in range(200)],
                        notificationConfigured=False, notificationStatus='not-requested', notificationAttempts=0)
            runtime.add_entry(dict(task=task, request=dict(url=config['baseUrl'] + '/v1/responses',
                headers={'Authorization': 'Bearer sk-benchmark-only'}, body=json.dumps({'padding': 'x' * 50000}))))
        result = {'tasks': 32, 'events_per_task': 200, 'request_bytes': 50000}
        result['save_ms'] = milliseconds(lambda: runtime.save(task_id))
        result['list_json_ms'] = milliseconds(lambda: json.dumps(runtime.command('list', {})))
        result['list_bytes'] = len(json.dumps(runtime.command('list', {})).encode())
        result['lane_init_ms'] = milliseconds(Lane)
        task = runtime.tasks[0]
        job = poll.Job(1, 'Reply OK', '', runtime.clock(), task.session_id, settings=task.args, task_id=task.id)
        response = poll.Result(job, runtime.clock(), 200, text='x' * 8192)
        tracemalloc.start()
        result['record_ms'] = milliseconds(lambda: runtime._emit(task, response))
        result['record_memory_bytes'] = tracemalloc.get_traced_memory()[0]
        tracemalloc.stop()
        print(json.dumps(result, indent=2))
    finally:
        runtime.close()
