"""Key-pool state machine, driven by WebRuntime's existing scheduler lock/tick."""
from dataclasses import dataclass, field
import queue
import threading

import codex_poll as poll
from python_transport import Lane, request_stream

RECOVERY_SECONDS = 30


@dataclass
class MemberRound:
    key_id: str
    epoch: int
    started: float
    lanes: list = field(default_factory=list)
    outcomes: list = field(default_factory=list)
    pending: int = 0
    winner: object = None


class KeyPool:
    def __init__(self, owner, task, entry, restore=False):
        self.owner, self.task, self.data = owner, task, entry['task']
        self.state = self.data['pool']
        self.members = {m['keyId']: m for m in self.state['members']}
        self.requests = {m['keyId']: m['request'] for m in entry['members']}
        self.epoch = 0
        self.active = {}
        self.physical = set()
        self.completed = queue.Queue()
        self.deadline = None
        self.due = {key: self.from_wall(member['nextAttemptAt']) if 'nextAttemptAt' in member else owner.clock() for key, member in self.members.items()}
        self.retry_at = {key: self.from_wall(member['retryAfterAt']) if 'retryAfterAt' in member else owner.clock() for key, member in self.members.items()}
        if restore and not task.paused:
            if self.state['phase'] == 'keeping':
                self.recover(owner.clock())
                key = self.state['activeKeyId']
                self.set_due(key, max(owner.clock(), self.retry_at[key]))
            elif self.state['phase'] == 'recovering':
                self.deadline = self.from_wall(self.state['recoveryDeadline'])
                self.expire()
            self.data['status'] = 'waiting'

    def wall(self, at=None):
        return round((self.owner.epoch + (self.owner.clock() if at is None else at)) * 1000)

    def from_wall(self, at):
        return at / 1000 - self.owner.epoch

    def valid(self, round_):
        return (not self.owner.closing and not self.task.paused and
                self.owner.find(self.task.id) is self.task and round_.epoch == self.epoch and
                self.active.get(round_.key_id) is round_)

    def invalidate(self):
        self.epoch += 1
        for lane in self.physical:
            lane.cancel()
        self.active.clear()

    def stop(self):
        self.invalidate()
        self.deadline = None
        self.state.pop('recoveryDeadline', None)
        self.data.pop('nextAttemptAt', None)

    def resume(self):
        # retryNow while recovering skips the interval, never the recovery deadline.
        was_paused = self.task.paused
        self.invalidate()
        self.task.paused, self.task.spec['enabled'] = False, True
        if was_paused:
            key = self.state.get('activeKeyId')
            if key and not self.members[key]['disabled']:
                self.deadline = None
                self.recover(self.owner.clock())
            else:
                self.race()
        for key in self.eligible():
            self.set_due(key, max(self.owner.clock(), self.retry_at[key]))
        self.data['status'] = 'waiting'
        self.data.pop('completedAt', None)

    def eligible(self):
        ids = self.members if self.state['phase'] == 'racing' else [self.state.get('activeKeyId')]
        return [key for key in ids if key in self.members and not self.members[key]['disabled']]

    def set_due(self, key, at):
        self.due[key] = at
        self.members[key]['nextAttemptAt'] = self.wall(at)

    def recover(self, at):
        if self.deadline is None:
            self.deadline = at + RECOVERY_SECONDS
            self.state.update(phase='recovering', recoveryDeadline=self.wall(self.deadline))
            self.owner.event(self.task.id, 'pool.recovering', '保活号独自恢复', '30 秒内未成功则全池重新挤入。', 'warning')
        self.data['healthy'] = False

    def race(self):
        self.invalidate()
        self.deadline = None
        self.state.update(phase='racing', races=self.state['races'] + 1)
        self.state.pop('activeKeyId', None)
        self.state.pop('recoveryDeadline', None)
        self.data.update(healthy=False, status='waiting')
        for key in self.members:
            self.set_due(key, max(self.owner.clock(), self.retry_at[key]))
        self.owner.event(self.task.id, 'pool.racing', '全池重新挤入', '全部可用成员参与，首个成功者保活。', 'warning')

    def expire(self):
        if not self.task.paused and self.deadline is not None and self.owner.clock() >= self.deadline:
            self.race()
            self.owner.save(self.task.id)

    def on_event(self, round_, lane, kind, raw, accepted):
        with self.owner.lock:
            self.expire()
            if not self.valid(round_) or lane.cancelled.is_set():
                raise InterruptedError('池轮次已结束')
            if accepted and round_.winner is None:
                round_.winner = lane
                for key, other in list(self.active.items()):
                    for sibling in other.lanes:
                        if sibling is not lane:
                            sibling.cancel()
                    if other is not round_:
                        del self.active[key]
                self.deadline = None
                self.state.update(phase='keeping', activeKeyId=round_.key_id)
                self.state.pop('recoveryDeadline', None)
                member = self.members[round_.key_id]
                member['successes'] += 1
                member.pop('lastError', None)
                self.owner.accepted(self.task, kind, member)
            if round_.winner is lane:
                self.data['responseSummary'] = poll.redact(lane.summary, self.task.args.secrets)
            return round_.winner is lane

    def run_lane(self, round_, lane):
        result = request_stream(self.data['config'], self.requests[round_.key_id], lane,
                                self.task.args.secrets, self.owner.clock,
                                lambda kind, raw, accepted: self.on_event(round_, lane, kind, raw, accepted))
        self.completed.put((round_, lane, result))
        self.owner.wake.set()

    def launch(self, key):
        count = 1 if self.state['phase'] == 'keeping' else self.data['config']['concurrency']
        round_ = MemberRound(key, self.epoch, self.owner.clock(), [Lane() for _ in range(count)], pending=count)
        self.active[key] = round_
        self.physical.update(round_.lanes)
        self.members[key]['attemptsMade'] += count
        self.data['attemptsMade'] += count
        self.data.update(status='requesting', lastAttemptAt=self.wall())
        self.owner.event(self.task.id, 'request.started', '池成员请求', f'{self.members[key]["alias"]} · 并发 {count}')
        for lane in round_.lanes:
            threading.Thread(target=self.run_lane, args=(round_, lane), daemon=True).start()

    def finish(self, round_, lane, result):
        self.physical.discard(lane)
        round_.pending -= 1
        if not self.valid(round_) or lane.cancelled.is_set():
            return
        round_.outcomes.append(result)
        if round_.winner is not None:
            if round_.winner is not lane:
                return
        elif round_.pending:
            return
        del self.active[round_.key_id]
        member = self.members[round_.key_id]
        config = self.data['config']
        finished = result['finished']
        retry_at = max(r['finished'] + r.get('retryAfter', 0) for r in round_.outcomes)
        self.retry_at[round_.key_id] = max(self.retry_at[round_.key_id], retry_at)
        member['retryAfterAt'] = self.wall(self.retry_at[round_.key_id])
        if round_.winner and not result.get('interrupted'):
            gap = poll.sample_keepalive_interval(self.task.args)
            self.set_due(round_.key_id, max(finished, round_.started + gap))
        else:
            failure = next((r for r in round_.outcomes if not r.get('retryable', True)), result)
            member['lastError'] = failure.get('error', '请求未成功')
            member['disabled'] = not failure.get('retryable', True)
            self.data['lastError'] = f'{member["alias"]} · {member["lastError"]}'
            if self.state.get('activeKeyId') == round_.key_id:
                self.recover(finished)
            self.set_due(round_.key_id, max(finished + config['intervalSeconds'], self.retry_at[round_.key_id]))
            self.owner.event(self.task.id, 'request.failed', '成员不可用' if member['disabled'] else '成员等待重试', self.data['lastError'], 'warning')
        self.owner.save(self.task.id)

    def tick(self):
        attached = self.owner.find(self.task.id) is self.task
        if attached and not self.owner.closing:
            self.expire()
        while True:
            try:
                self.finish(*self.completed.get_nowait())
            except queue.Empty:
                break
        slot = (self.task.id, 0)
        if not self.physical:
            self.owner.workers.discard(slot)
        if not attached or self.task.paused or self.owner.closing:
            return
        if all(member['disabled'] for member in self.members.values()):
            self.stop()
            self.task.paused, self.task.spec['enabled'] = True, False
            self.data.update(status='exhausted', healthy=False, stopReason='permanent-error', completedAt=self.wall())
            self.owner.event(self.task.id, 'pool.exhausted', '池已停止', '全部成员不可用，请查看成员错误。', 'danger')
            self.owner.save(self.task.id)
            return
        launched = False
        for key in self.eligible():
            if key in self.active or self.owner.clock() < self.due[key]:
                continue
            if slot not in self.owner.workers and len(self.owner.workers) >= self.owner.limit:
                break
            self.owner.workers.add(slot)
            self.launch(key)
            launched = True
        if not self.active:
            self.data['status'] = 'keepalive' if self.state['phase'] == 'keeping' else 'waiting'
        if launched:
            self.owner.save(self.task.id)

    def view(self):
        state = {**self.state, 'members': []}
        stopped = self.task.paused or self.owner.find(self.task.id) is not self.task
        for key, source in self.members.items():
            member = dict(source)
            if source['disabled']:
                status = 'disabled'
            elif stopped:
                status = 'paused'
            elif self.state['phase'] == 'racing':
                status = 'racing'
            elif key == self.state.get('activeKeyId'):
                status = self.state['phase']
            else:
                status = 'standby'
            member['status'] = status
            if status in ('standby', 'disabled', 'paused') or key in self.active:
                member.pop('nextAttemptAt', None)
            state['members'].append(member)
        return state
