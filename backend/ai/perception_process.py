"""Isolate Tier-2 behavior AI (FaceLandmarker, Pose, DeskRest, optional Objects)
in a dedicated process so slow behavior analysis never delays Tier-1 bboxes.
"""
import multiprocessing as mp
import os
from queue import Empty, Full
import time
from types import SimpleNamespace
import psutil
from memory_budget import DEFAULT_CEILING


def latest_put(mailbox, value):
    try:
        mailbox.put_nowait(value)
        return True
    except Full:
        try:
            mailbox.get_nowait()
        except Empty:
            return False
        try:
            mailbox.put_nowait(value)
            return True
        except Full:
            return False


def run(models, frames, commands, results, export_native_lock=None, parent_pid=None):
    import native_runtime
    native_runtime.EXPORT_NATIVE_LOCK = export_native_lock
    from perception import Perception
    analysis = None
    try:
        analysis = Perception(models)
        results.put(dict(
            type='ready',
            device=analysis.device,
            cavt=analysis.engagement.status,
            actions=analysis.actions.status,
            personLimit=analysis.person_limit,
            actionModel=analysis.actions.model_name,
            actionClasses=analysis.actions.class_count,
            profile=analysis.profile_cfg['name'],
            personModel=analysis.person_model_name,
        ))
        sessions = set()
        released = set()
        stopped = False
        last_push = 0.0
        last_parent_check = time.monotonic()
        while not stopped:
            now_check = time.monotonic()
            if parent_pid is not None and now_check - last_parent_check >= 1.0:
                last_parent_check = now_check
                try:
                    if not psutil.pid_exists(parent_pid) or psutil.Process(parent_pid).status() == psutil.STATUS_ZOMBIE:
                        stopped = True
                        break
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    stopped = True
                    break
            got_work = False
            while True:
                try:
                    command = commands.get_nowait()
                except Empty:
                    break
                if command[0] == 'stop':
                    stopped = True
                    break
                if command[0] == 'configure':
                    _, session, features = command
                    analysis.configure(session, features)
                    got_work = True
                if command[0] == 'release':
                    session = command[1]
                    released.add(session)
                    sessions.discard(session)
                    analysis.release(session)
            if stopped:
                break
            try:
                session, frame, bodies, faces, at = frames.get(timeout=.025)
                if session not in released:
                    sessions.add(session)
                    analysis.submit(session, frame, faces, at, bodies=bodies)
                    got_work = True
            except Empty:
                pass
            if not sessions:
                continue
            now_mono = time.monotonic()
            if not got_work and now_mono - last_push < .06:
                continue
            last_push = now_mono
            latest_put(results, dict(
                type='snapshot',
                sessions={
                    session: dict(
                        **analysis.snapshot(session, with_timestamp=True),
                        objects=analysis.object_hints(session),
                        restBodies=analysis.rest_bodies(session),
                        **analysis.body_snapshot(session),
                    )
                    for session in sessions
                },
                error=analysis.error,
                personLimit=analysis.person_limit,
                timings={
                    **analysis.timings,
                    **analysis.actions.timings,
                    'actionsStatus': analysis.actions.status,
                    'actionsError': analysis.actions.error,
                },
                cavt=analysis.engagement.status,
            ))
    except Exception as error:
        import traceback
        traceback.print_exc()
        latest_put(results, dict(type='error', error=str(error)))
    finally:
        if analysis is not None:
            analysis.close()
        results.cancel_join_thread()


class PerceptionProcess:
    def __init__(self, models):
        context = mp.get_context('spawn')
        self.frames = context.Queue(maxsize=1)
        self.commands = context.Queue(maxsize=128)
        self.results = context.Queue(maxsize=2)
        from native_runtime import EXPORT_NATIVE_LOCK
        self.process = context.Process(
            target=run,
            args=(str(models), self.frames, self.commands, self.results, EXPORT_NATIVE_LOCK, os.getpid()),
            name='behavior-models',
        )
        self.process.start()
        self.sessions = set()
        self.state = {}
        self.submitted = {}
        self.last_faces = {}
        self.timings = {}
        self._error = None
        self.closed = False
        self.engagement = SimpleNamespace(status='loading')
        try:
            ready = self.results.get(timeout=85)
            if ready.get('type') != 'ready':
                raise RuntimeError(ready.get('error', 'Behavior models failed to load'))
            self.device = ready['device']
            self.engagement.status = ready['cavt']
            self.person_limit = ready.get('personLimit', DEFAULT_CEILING)
            self.actions_status = ready.get('actions', 'not_prepared')
            self.actions_model = ready.get('actionModel', 'MobileViCLIP-Tiny')
            self.actions_classes = ready.get('actionClasses', 15)
            self.profile_name = ready.get('profile', 'balanced')
            self.person_model_name = ready.get('personModel', 'yolo11n.onnx')
        except Exception:
            self.close()
            raise

    def _drain(self):
        while True:
            try:
                message = self.results.get_nowait()
            except Empty:
                break
            if message['type'] == 'error':
                self._error = message['error']
            elif message['type'] == 'snapshot':
                self.person_limit = message.get('personLimit', getattr(self, 'person_limit', DEFAULT_CEILING))
                self.state = message['sessions']
                self.timings = message['timings']
                self._error = message['error']
                self.engagement.status = message['cavt']
        if not self.closed and not self.process.is_alive():
            self._error = 'Behavior AI process exited (' + str(self.process.exitcode) + ')'

    def submit(self, session, frame, faces, at, bodies=None, wait=False):
        self.sessions.add(session)
        identities = {face['id'] for face in faces}
        if not wait and at - self.submitted.get(session, 0) < 55 and identities == self.last_faces.get(session):
            return False
        payload = (session, frame, bodies, faces, at)
        if wait:
            self.frames.put(payload, timeout=5)
        if wait or latest_put(self.frames, payload):
            self.submitted[session] = at
            self.last_faces[session] = identities
            return True
        return False

    def snapshot(self, session):
        self._drain()
        return self.state.get(session, {}).get('observations', {}) if session in self.sessions else {}

    def wait_for_faces(self, session, at, timeout=15):
        deadline = time.monotonic() + timeout
        while True:
            observations = self.snapshot(session)
            if self._error:
                raise RuntimeError(self._error)
            if self.state.get(session, {}).get('faceAt', 0) >= at:
                return observations
            if self.closed or session not in self.sessions or time.monotonic() >= deadline:
                raise TimeoutError('Landmark analysis did not finish for the offline frame')
            time.sleep(.01)

    def body_hints(self, session):
        self._drain()
        return self.state.get(session, {}).get('bodies', []) if session in self.sessions else []

    def object_hints(self, session):
        self._drain()
        return self.state.get(session, {}).get('objects', {}) if session in self.sessions else {}

    def rest_bodies(self, session):
        self._drain()
        return self.state.get(session, {}).get('restBodies', []) if session in self.sessions else []

    @property
    def error(self):
        self._drain()
        return self._error

    def configure(self, session, features):
        self.sessions.add(session)
        try:
            self.commands.put(('configure', session, features), timeout=1)
        except Full:
            pass

    def release(self, session):
        self.sessions.discard(session)
        self.state.pop(session, None)
        self.submitted.pop(session, None)
        self.last_faces.pop(session, None)
        self.commands.put(('release', session), timeout=1)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.commands.put(('stop',), timeout=1)
        except Full:
            pass
        self.process.join(timeout=10)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
        for mailbox in (self.frames, self.commands, self.results):
            mailbox.cancel_join_thread()
            mailbox.close()
