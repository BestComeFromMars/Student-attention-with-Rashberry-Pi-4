import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Camera, handler_for


class CameraTest(unittest.TestCase):
    def test_balanced_capture_keeps_720p_and_drops_frames_before_encoding(self):
        camera = Camera()
        command = camera.command()
        self.assertEqual(command[command.index('-video_size')+1],'1280x720')
        self.assertEqual(command[command.index('-framerate')+1],'25')
        self.assertEqual(command[command.index('-vf')+1],'fps=15')
        self.assertEqual(command[command.index('-b:v')+1],'4000000')
        self.assertEqual(camera.status()['fps'],15)
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'state.json'
        self.now = 100.
        self.process = Mock()
        self.process.poll.return_value = None
        self.process.stdout = io.BytesIO()
        self.spawn = Mock(return_value=self.process)
        self.poweroff = Mock()
        self.camera = Camera(self.path, clock=lambda: self.now, popen=self.spawn, poweroff=self.poweroff)
        patch('agent.threading.Thread').start()
        patch('agent.os.killpg', create=True).start()
        self.addCleanup(patch.stopall)

    def test_cold_boot_stays_off_with_backend_ready(self):
        self.camera.heartbeat(True)
        self.camera.recover()
        self.assertEqual(self.camera.status()['state'], 'off')
        self.spawn.assert_not_called()

    def test_start_waits_for_backend_and_progress(self):
        self.camera.start()
        self.camera.recover()
        self.assertEqual(self.camera.status()['state'], 'waiting_backend')
        self.camera.heartbeat(True)
        self.camera.recover()
        self.assertEqual(self.camera.status()['state'], 'starting')
        self.assertEqual(self.spawn.call_count, 1)
        self.camera.has_frames = True
        self.assertEqual(self.camera.status()['state'], 'streaming')

    def test_lease_expiry_releases_camera_preserving_intent_and_recovers(self):
        self.camera.start()
        self.camera.heartbeat(True)
        self.camera.recover()
        self.now += 10.1
        self.camera.recover()
        self.assertTrue(self.camera.status()['camera_released'])
        self.assertTrue(self.camera.desired)
        self.assertEqual(self.camera.status()['state'], 'waiting_backend')
        self.camera.heartbeat(True)
        self.camera.recover()
        self.assertEqual(self.spawn.call_count, 2)

    def test_loading_backend_stops_capture_without_clearing_choice(self):
        self.camera.start()
        self.camera.heartbeat(True)
        self.camera.recover()
        self.camera.heartbeat(False)
        self.camera.recover()
        self.assertIsNone(self.camera.process)
        self.assertTrue(self.camera.desired)

    def test_explicit_off_survives_heartbeat_and_service_restart(self):
        self.camera.start()
        self.camera.stop()
        restored = Camera(self.path)
        restored.heartbeat(True)
        self.assertFalse(restored.desired)
        self.assertEqual(restored.status()['state'], 'off')

    def test_service_restart_preserves_on_but_requires_new_lease(self):
        self.camera.start()
        restored = Camera(self.path)
        self.assertTrue(restored.desired)
        self.assertEqual(restored.status()['state'], 'waiting_backend')

    def test_start_is_idempotent_and_stop_reaps_child(self):
        self.camera.heartbeat(True)
        self.camera.start()
        self.camera.recover()
        self.camera.start()
        self.camera.recover()
        self.assertEqual(self.spawn.call_count, 1)
        self.camera.stop()
        self.process.wait.assert_called_once()
        self.assertTrue(self.camera.status()['camera_released'])

    def test_missing_webcam_has_bounded_retries(self):
        self.spawn.side_effect = OSError('missing')
        self.camera.start()
        self.camera.heartbeat(True)
        self.camera.recover()
        self.camera.recover()
        self.assertEqual(self.spawn.call_count, 1)
        self.assertEqual(self.camera.status()['state'], 'reconnecting')
        self.now += 1.1
        self.camera.recover()
        self.assertEqual(self.spawn.call_count, 2)

    def test_fast_exiting_ffmpeg_surfaces_reconnecting_and_retries(self):
        exited = Mock()
        exited.poll.return_value = 1
        exited.stdout = io.BytesIO()
        self.spawn.side_effect = [exited, self.process]
        self.camera.start()
        self.camera.heartbeat(True)
        self.camera.recover()
        self.now += 1.1
        self.camera.recover()
        self.assertEqual(self.spawn.call_count, 2)
        self.assertEqual(self.camera.status()['state'], 'reconnecting')
        self.camera.has_frames = True
        self.camera.error = None
        self.assertEqual(self.camera.status()['state'], 'streaming')

    def test_shutdown_is_once_and_prevents_restart(self):
        self.camera.start()
        self.camera.shutdown()
        self.camera.shutdown()
        self.poweroff.assert_called_once()
        self.assertFalse(self.camera.desired)
        self.assertEqual(self.camera.status()['state'], 'shutting_down')
        with self.assertRaises(RuntimeError):
            self.camera.start()

    def test_failed_poweroff_does_not_mark_request_accepted(self):
        self.poweroff.side_effect = RuntimeError('denied')
        with self.assertRaises(RuntimeError):
            self.camera.shutdown()
        self.assertFalse(self.camera.shutting_down)

    def test_invalid_saved_state_defaults_to_off(self):
        self.path.write_text('{')
        self.assertFalse(Camera(self.path).desired)


class AuthenticationTest(unittest.TestCase):
    def test_bad_token_and_non_boolean_heartbeat_are_rejected(self):
        camera = Mock()
        Handler = handler_for(camera, 'private-token')
        handler = Handler.__new__(Handler)
        handler.headers = {'Authorization': 'Bearer wrong'}
        handler.path = '/shutdown'
        handler.reply = Mock()
        handler.dispatch(True)
        handler.reply.assert_called_with(401, {'message': 'Unauthorized'})
        camera.shutdown.assert_not_called()
        data = json.dumps({'ready': 'yes'}).encode()
        handler.headers = {'Authorization': 'Bearer private-token', 'Content-Length': str(len(data))}
        handler.path = '/heartbeat'
        handler.rfile = io.BytesIO(data)
        handler.dispatch(True)
        self.assertEqual(handler.reply.call_args.args[0], 400)
        camera.heartbeat.assert_not_called()


if __name__ == '__main__':
    unittest.main()
