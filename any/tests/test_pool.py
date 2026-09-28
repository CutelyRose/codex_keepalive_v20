"""Deterministic pool scheduling tests; no upstream requests or notifications."""
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_scheduler import WebRuntime, now_ms


def entry(count=2):
    keys = [f'key-{n}' for n in range(count)]
    config = dict(name='Pool test', keyIds=keys, channel='gpt', model='gpt-test', prompt='OK',
                  concurrency=1, intervalSeconds=.5, timeoutSeconds=120, keepalive=True,
                  keepaliveMinSeconds=1, keepaliveMaxSeconds=1, oneMillion=False,
                  telegramChatId='', telegramBotToken='')
    members = [dict(keyId=key, alias=key, keyTail=f'{n:04}', baseUrl='http://127.0.0.1:1',
                    sessionId=str(uuid.uuid4()), attemptsMade=0, successes=0, disabled=False)
               for n, key in enumerate(keys)]
    task = dict(id='python_' + str(uuid.uuid4()), scheduler='python', sessionId=str(uuid.uuid4()),
                config=config, status='running', healthy=False, attemptsMade=0, probeAttempts=0,
                successes=0, startedAt=now_ms(), updatedAt=now_ms(), events=[], responseSummary='',
                notificationConfigured=False, notificationStatus='not-requested', notificationAttempts=0,
                pool=dict(phase='racing', races=1, members=members))
    return dict(task=task, members=[dict(keyId=key, request=dict(url='http://127.0.0.1:1/v1/responses',
        headers={'Authorization': f'Bearer sk-test-{key}'}, body='{}')) for key in keys])


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='key-pool-tests-')
        self.addCleanup(self.directory.cleanup)
        self.start = patch.object(WebRuntime, 'start').start()
        self.addCleanup(patch.stopall)
        self.rt = WebRuntime(Path(self.directory.name) / 'tasks.sqlite', 'http://127.0.0.1:1')
        self.clock = 1000.
        self.rt.clock = lambda: self.clock
        self.rt.epoch = time.time() - self.clock
        self.addCleanup(self.rt.close)
        patch('python_pool.threading.Thread.start').start()

    def create(self, count=2):
        value = self.rt.add_entry(entry(count))
        pool = self.rt.pools[value['id']]
        self.rt.step()
        return pool

    def complete(self, pool, round_, *, accepted=False, interrupted=False, retryable=True, retry_after=0):
        lane = round_.winner or round_.lanes[0]
        pool.completed.put((round_, lane, dict(accepted=accepted, interrupted=interrupted,
            retryable=retryable, retryAfter=retry_after, finished=self.clock, error='simulated failure')))
        self.rt.step()

    def win(self, pool, key='key-0'):
        round_ = pool.active[key]
        pool.on_event(round_, round_.lanes[0], 'response.created', '{}', True)
        return round_

    def recovering(self, pool):
        round_ = self.win(pool)
        self.complete(pool, round_, accepted=True)
        self.clock += 1
        self.rt.step()
        self.complete(pool, pool.active['key-0'])
        return pool.deadline

    def test_all_members_share_one_slot_and_only_first_success_keeps_alive(self):
        pool = self.create(12)
        self.assertEqual(len(pool.active), 12)
        self.assertEqual(len(self.rt.workers), 1)
        other = pool.active['key-1']
        winner = self.win(pool)
        with self.assertRaises(InterruptedError):
            pool.on_event(other, other.lanes[0], 'response.created', '{}', True)
        self.assertEqual(pool.data['successes'], 1)
        self.assertEqual(pool.state['activeKeyId'], 'key-0')
        self.assertTrue(other.lanes[0].cancelled.is_set())
        self.complete(pool, winner, accepted=True)
        self.assertIsNone(pool.deadline)
        self.clock += 1
        self.rt.step()
        self.assertEqual(list(pool.active), ['key-0'])
        self.assertEqual(pool.members['key-1']['attemptsMade'], 1)

    def test_recovery_success_at_29_point_9_seconds(self):
        pool = self.create()
        deadline = self.recovering(pool)
        self.clock += .5
        self.rt.step()
        self.complete(pool, pool.active['key-0'])
        self.assertEqual(pool.deadline, deadline)
        self.clock = deadline - .1
        self.rt.step()
        self.win(pool)
        self.assertEqual(pool.state['phase'], 'keeping')
        self.assertNotIn('recoveryDeadline', pool.state)
        self.assertEqual(pool.members['key-1']['attemptsMade'], 1)

    def test_deadline_preempts_hung_120_second_request_and_rejects_late_success(self):
        pool = self.create()
        deadline = self.recovering(pool)
        self.clock += .5
        self.rt.step()
        old = pool.active['key-0']
        self.clock = deadline
        self.rt.step()
        self.assertEqual(set(pool.active), {'key-0', 'key-1'})
        self.assertEqual(pool.state['phase'], 'racing')
        self.assertEqual(pool.state['races'], 2)
        self.assertTrue(old.lanes[0].cancelled.is_set())
        with self.assertRaises(InterruptedError):
            pool.on_event(old, old.lanes[0], 'response.created', '{}', True)
        winner = self.win(pool, 'key-1')
        self.complete(pool, old, accepted=True)
        self.assertEqual(pool.state['activeKeyId'], 'key-1')
        self.assertEqual(pool.active['key-1'], winner)

    def test_event_at_deadline_cannot_retain_old_leader(self):
        pool = self.create()
        deadline = self.recovering(pool)
        self.clock += .5
        self.rt.step()
        old = pool.active['key-0']
        self.clock = deadline
        with self.assertRaises(InterruptedError):
            pool.on_event(old, old.lanes[0], 'response.created', '{}', True)
        self.assertEqual(pool.state['phase'], 'racing')

    def test_stream_interruption_starts_recovery_but_retry_now_does_not_reset_it(self):
        pool = self.create()
        winner = self.win(pool)
        self.complete(pool, winner, accepted=True, interrupted=True)
        deadline = pool.deadline
        self.assertEqual(deadline, self.clock + 30)
        self.clock += 5
        self.rt.command('retryNow', {'id': pool.task.id})
        self.rt.step()
        self.assertEqual(pool.deadline, deadline)
        self.assertEqual(list(pool.active), ['key-0'])

    def test_only_winner_submits_notification_with_member_identity(self):
        pool = self.create()
        pool.data['notificationConfigured'] = True
        other = pool.active['key-1']
        with patch('python_scheduler.threading.Thread') as thread:
            winner = self.win(pool)
            with self.assertRaises(InterruptedError):
                pool.on_event(other, other.lanes[0], 'response.created', '{}', True)
            self.assertEqual(thread.call_count, 1)
            args = thread.call_args.kwargs['args']
            self.assertEqual(args[2]['config']['name'], 'Pool test · key-0')
            self.assertEqual(args[3], '0000')
        self.complete(pool, winner, accepted=True)
        self.clock += 1
        self.rt.step()
        with patch('python_scheduler.threading.Thread') as thread:
            self.win(pool)
            thread.assert_not_called()

    def test_retry_after_is_per_member_and_survives_race_transition(self):
        pool = self.create()
        winner = self.win(pool)
        self.complete(pool, winner, accepted=True, interrupted=True, retry_after=60)
        self.clock += 30
        self.rt.step()
        self.assertEqual(list(pool.active), ['key-1'])
        self.assertEqual(pool.state['phase'], 'racing')
        self.clock += 30
        self.rt.step()
        self.assertEqual(set(pool.active), {'key-0', 'key-1'})

    def test_permanent_member_error_isolated_then_all_invalid_stops(self):
        pool = self.create()
        self.complete(pool, pool.active['key-0'], retryable=False)
        self.assertTrue(pool.members['key-0']['disabled'])
        self.assertFalse(pool.task.paused)
        self.complete(pool, pool.active['key-1'], retryable=False)
        self.assertEqual(pool.data['status'], 'exhausted')
        self.assertTrue(pool.task.paused)

    def test_pause_resume_cancel_delete_and_other_pool_are_independent(self):
        pool, other = self.create(), self.create()
        self.recovering(pool)
        self.rt.command('pause', {'id': pool.task.id})
        self.clock += 100
        self.rt.step()
        self.assertEqual(pool.data['status'], 'paused')
        self.assertFalse(pool.active)
        self.assertTrue(other.active)
        self.rt.command('resume', {'id': pool.task.id})
        self.assertEqual(pool.deadline, self.clock + 30)
        self.rt.step()
        old = pool.active['key-0']
        self.rt.command('cancel', {'id': pool.task.id})
        with self.assertRaises(InterruptedError):
            pool.on_event(old, old.lanes[0], 'response.created', '{}', True)
        self.assertEqual(pool.data['status'], 'cancelled')
        self.rt.command('remove', {'id': pool.task.id})
        self.complete(pool, old, accepted=True)
        self.assertNotIn(pool.task.id, self.rt.entries)

    def test_restore_uses_saved_deadline_and_preserves_sessions_and_pause(self):
        value = entry()
        value['task']['pool'].update(phase='recovering', activeKeyId='key-0', recoveryDeadline=now_ms() + 9000)
        sessions = [m['sessionId'] for m in value['task']['pool']['members']]
        saved_deadline = value['task']['pool']['recoveryDeadline']
        self.rt.add_entry(value, restore=True)
        pool = self.rt.pools[value['task']['id']]
        self.assertAlmostEqual(pool.deadline - self.clock, 9, delta=.2)
        self.assertEqual(pool.state['recoveryDeadline'], saved_deadline)
        self.assertEqual([m['sessionId'] for m in pool.state['members']], sessions)
        self.rt.close()
        restored = WebRuntime(Path(self.directory.name) / 'tasks.sqlite', 'http://127.0.0.1:1')
        self.addCleanup(restored.close)
        loaded = restored.pools[value['task']['id']]
        self.assertEqual(loaded.state['recoveryDeadline'], saved_deadline)
        self.assertEqual([m['sessionId'] for m in loaded.state['members']], sessions)
        expired = entry()
        expired['task']['pool'].update(phase='recovering', activeKeyId='key-0', recoveryDeadline=now_ms() - 1000)
        restored.add_entry(expired, restore=True)
        self.assertEqual(restored.pools[expired['task']['id']].state['phase'], 'racing')
        paused = entry()
        paused['task']['status'] = 'paused'
        restored.add_entry(paused, restore=True)
        restored.step()
        self.assertFalse(restored.pools[paused['task']['id']].active)

    def test_restore_keeping_validates_leader_immediately_not_after_old_keepalive_gap(self):
        value = entry()
        value['task'].update(status='keepalive', healthy=True)
        value['task']['pool'].update(phase='keeping', activeKeyId='key-0')
        value['task']['pool']['members'][0]['nextAttemptAt'] = now_ms() + 90000
        self.rt.add_entry(value, restore=True)
        pool = self.rt.pools[value['task']['id']]
        self.rt.step()
        self.assertEqual(list(pool.active), ['key-0'])
        self.assertEqual(pool.deadline, self.clock + 30)


if __name__ == '__main__':
    unittest.main()
