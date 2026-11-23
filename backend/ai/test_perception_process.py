import unittest
from unittest.mock import patch
from queue import Queue
from types import SimpleNamespace
from perception_process import PerceptionProcess


class PerceptionMailboxTests(unittest.TestCase):
    def proxy(self):
        proxy = PerceptionProcess.__new__(PerceptionProcess)
        proxy.frames = Queue(maxsize=1)
        proxy.commands = Queue(maxsize=8)
        proxy.results = Queue(maxsize=2)
        proxy.sessions = set()
        proxy.state = {}
        proxy.submitted = {}
        proxy.last_faces = {}
        proxy.timings = {}
        proxy._error = None
        proxy.closed = False
        proxy.process = SimpleNamespace(is_alive=lambda: True)
        proxy.engagement = SimpleNamespace(status='ready')
        return proxy

    def test_latest_frame_is_bounded_and_new_face_bypasses_behavior_sampling_cadence(self):
        proxy = self.proxy()
        image = object()
        proxy.submit('one', image, [dict(id=1)], 1000, bodies=[dict(id=1)])
        proxy.submit('one', image, [dict(id=1)], 1033, bodies=[dict(id=1)])
        self.assertEqual(proxy.frames.get_nowait()[-1], 1000)
        proxy.submit('one', image, [dict(id=1)], 1100, bodies=[dict(id=1)])
        proxy.submit('one', image, [dict(id=1), dict(id=2)], 1133, bodies=[dict(id=1)])
        self.assertEqual(proxy.frames.qsize(), 1)
        payload = proxy.frames.get_nowait()
        self.assertEqual(payload[-1], 1133)
        self.assertEqual(payload[2], [dict(id=1)])

    def test_snapshot_preserves_measurement_timestamps_and_release_rejects_late_results(self):
        proxy = self.proxy()
        proxy.sessions.add('one')
        payload = dict(
            type='snapshot',
            sessions={'one': dict(observations={1: dict(observedAt=1000, valid=True)}, bodies=[])},
            timings={'faceLatencyMs': 50},
            error=None,
            cavt='ready',
        )
        proxy.results.put(payload)
        self.assertEqual(proxy.snapshot('one')[1]['observedAt'], 1000)
        proxy.release('one')
        proxy.results.put(payload)
        self.assertEqual(proxy.snapshot('one'), {})
        self.assertEqual(proxy.commands.get_nowait(), ('release', 'one'))

    def test_offline_face_wait_accepts_completed_empty_samples_and_ignores_another_session(self):
        proxy = self.proxy()
        proxy.sessions.add('one')
        proxy.state = {'one': dict(faceAt=1000, observations={1: dict(observedAt=1000)})}
        unrelated = dict(
            type='snapshot',
            sessions={'other': dict(faceAt=2000, observations={}), **proxy.state},
            timings={},
            error=None,
            cavt='ready',
        )
        payload = dict(
            type='snapshot',
            sessions={'one': dict(faceAt=1400, observations={})},
            timings={},
            error=None,
            cavt='ready',
        )
        updates = iter((unrelated, payload))
        with patch('perception_process.time.sleep', side_effect=lambda _: proxy.results.put(next(updates))) as wait:
            self.assertEqual(proxy.wait_for_faces('one', 1400), {})
            self.assertEqual(wait.call_count, 2)

    def test_behavior_process_exit_is_reported_without_inventing_measurements(self):
        proxy = self.proxy()
        proxy.process = SimpleNamespace(is_alive=lambda: False, exitcode=7)
        self.assertIn('7', proxy.error)
        self.assertEqual(proxy.snapshot('one'), {})


if __name__ == '__main__':
    unittest.main()
