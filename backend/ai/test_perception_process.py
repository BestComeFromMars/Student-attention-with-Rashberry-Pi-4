import unittest
from unittest.mock import patch
from queue import Queue
from types import SimpleNamespace
from perception_process import PerceptionProcess


class PerceptionMailboxTests(unittest.TestCase):
    def test_first_face_response_can_include_the_body_scan_completed_in_parallel(self):
        proxy=self.proxy();proxy.sessions.add('one')
        bodies=[dict(id=7,at=1000,box=[.1,.1,.4,.7])]
        payload=dict(type='snapshot',sessions={'one':dict(bodies=bodies,bodyAt=1000)},timings={},error=None,cavt='ready')
        with patch('perception_process.time.sleep',side_effect=lambda _:proxy.results.put(payload)) as wait:
            snapshot=proxy.body_snapshot('one',wait_ms=750)
            wait.assert_called_once()
        self.assertEqual(snapshot,dict(bodies=bodies,bodyAt=1000,candidateCount=1))
        with patch('perception_process.time.sleep',side_effect=AssertionError('ready scans must not wait')):
            self.assertEqual(proxy.body_snapshot('one',wait_ms=750),snapshot)

    def test_initial_wait_is_bounded_and_a_completed_empty_scan_never_invents_a_body(self):
        proxy=self.proxy();proxy.sessions.add('one')
        with patch('perception_process.time.monotonic',side_effect=[0,0,1]),patch('perception_process.time.sleep') as wait:
            self.assertEqual(proxy.body_snapshot('one',wait_ms=10000),dict(bodies=[],bodyAt=0,candidateCount=0))
            wait.assert_called_once_with(.01)
        proxy.state={'one':dict(bodies=[],bodyAt=1000)}
        with patch('perception_process.time.sleep',side_effect=AssertionError('an empty completed scan is ready')):
            self.assertEqual(proxy.body_snapshot('one',wait_ms=750),dict(bodies=[],bodyAt=1000,candidateCount=0))

    def test_failed_or_released_sessions_do_not_wait_for_a_first_body_scan(self):
        proxy=self.proxy();proxy.sessions.add('one');proxy._error='model failed'
        with patch('perception_process.time.sleep',side_effect=AssertionError('failed sessions must not wait')):
            self.assertEqual(proxy.body_snapshot('one',wait_ms=750),dict(bodies=[],bodyAt=0,candidateCount=0))
        proxy._error=None;proxy.sessions.clear()
        with patch('perception_process.time.sleep',side_effect=AssertionError('released sessions must not wait')):
            self.assertEqual(proxy.body_snapshot('one',wait_ms=750),dict(bodies=[],bodyAt=0,candidateCount=0))

    def proxy(self):
        proxy=PerceptionProcess.__new__(PerceptionProcess)
        proxy.frames=Queue(maxsize=1);proxy.commands=Queue(maxsize=8);proxy.results=Queue(maxsize=2)
        proxy.sessions=set();proxy.state={};proxy.submitted={};proxy.last_faces={}
        proxy.timings={};proxy._error=None;proxy.closed=False;proxy.body_submitted={}
        proxy.process=SimpleNamespace(is_alive=lambda:True)
        proxy.engagement=SimpleNamespace(status='ready')
        return proxy

    def test_latest_frame_is_bounded_and_new_face_bypasses_behavior_sampling_cadence(self):
        proxy=self.proxy();image=object()
        proxy.submit('one',image,[dict(id=1)],1000)
        proxy.submit('one',image,[dict(id=1)],1033)
        self.assertEqual(proxy.frames.get_nowait()[-1],1000)
        proxy.submit('one',image,[dict(id=1)],1100)
        proxy.submit('one',image,[dict(id=1),dict(id=2)],1133)
        self.assertEqual(proxy.frames.qsize(),1)
        self.assertEqual(proxy.frames.get_nowait()[-1],1133)

    def test_snapshot_preserves_measurement_timestamps_and_release_rejects_late_results(self):
        proxy=self.proxy();proxy.sessions.add('one')
        payload=dict(type='snapshot',sessions={'one':dict(observations={1:dict(observedAt=1000,valid=True)},bodies=[])},
                     timings={'faceLatencyMs':50},error=None,cavt='ready')
        proxy.results.put(payload)
        self.assertEqual(proxy.snapshot('one')[1]['observedAt'],1000)
        proxy.release('one')
        proxy.results.put(payload)
        self.assertEqual(proxy.snapshot('one'),{})
        self.assertEqual(proxy.commands.get_nowait(),('release','one'))

    def test_early_body_phase_does_not_suppress_same_timestamp_face_submission(self):
        proxy=self.proxy();image=object()
        self.assertTrue(proxy.submit('one',image,[],1000,body_only=True))
        self.assertTrue(proxy.frames.get_nowait()[-2])
        self.assertTrue(proxy.submit('one',image,[dict(id=7)],1000))
        payload=proxy.frames.get_nowait()
        self.assertFalse(payload[-2]);self.assertEqual(payload[2],[dict(id=7)])
        self.assertEqual(payload[-1],1000)

    def test_behavior_process_exit_is_reported_without_inventing_measurements(self):
        proxy=self.proxy()
        proxy.process=SimpleNamespace(is_alive=lambda:False,exitcode=7)
        self.assertIn('7',proxy.error)
        self.assertEqual(proxy.snapshot('one'),{})
