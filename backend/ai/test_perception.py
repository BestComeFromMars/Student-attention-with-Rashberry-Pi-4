import math
import threading
import unittest
from unittest.mock import Mock
from types import SimpleNamespace
import numpy as np
from perception import FACE_OVAL, Perception
from body_pose import pack_pose


class FaceMeasurementTests(unittest.TestCase):
    def test_body_snapshot_publishes_new_posture_evidence_while_person_geometry_is_older(self):
        engine=Perception.__new__(Perception);engine.lock=threading.Lock();engine.actions=SimpleNamespace(snapshot=Mock(return_value=[]))
        box=[.2,.2,.28,.2]
        engine.sessions={'one':dict(bodies=[dict(id=7,at=1000,box=box)],peopleAt=1000,lastAt=1800,
            restObservations={7:dict(active=True,confidence=.6,personConfidence=.04,candidateConfidence=.04,
                temporalPerson=True,personObservedAt=1000,observedAt=1000,box=box)},
            restHistory=[(1000,[dict(box=box,confidence=.6)]),(1700,[dict(box=box,confidence=.45)])])}
        result=engine.body_snapshot('one');rest=result['bodies'][0]['observation']['deskRest']
        self.assertEqual(result['bodyAt'],1000);self.assertEqual(result['bodies'][0]['box'],box)
        self.assertEqual(rest['observedAt'],1700);self.assertEqual(rest['personObservedAt'],1000)
        self.assertTrue(rest['temporalPerson']);self.assertEqual(rest['confidence'],.45)

    def test_folded_body_starts_and_keeps_its_id_when_auxiliary_results_are_ahead_of_people(self):
        import json,torch
        from ultralytics.engine.results import Boxes
        from ultralytics.trackers.byte_tracker import BYTETracker
        engine=Perception.__new__(Perception);engine.lock=threading.Lock();engine.device='cpu';engine.timings={};engine.person_limit=40
        frame=np.zeros((500,500,3),np.uint8)
        raw=[torch.tensor([[100,100,240,200,.07,0]]),torch.tensor([[100,100,240,310,.04,0]]),torch.tensor([[100,100,240,250,.05,0]])]
        engine.people=SimpleNamespace(predict=Mock(side_effect=[[SimpleNamespace(boxes=Boxes(rows,(500,500)))] for rows in raw]))
        args=SimpleNamespace(track_high_thresh=.2,track_low_thresh=.1,new_track_thresh=.2,track_buffer=30,match_thresh=.8,fuse_score=True)
        state=dict(tracker=BYTETracker(args,frame_rate=5),peopleAt=0,bodyHistory=[],restHistory=[
            (1000,[dict(box=[.2,.2,.28,.2],confidence=.6)]),
            (1700,[dict(box=[.205,.2,.28,.2],confidence=.55)]),(3000,[])])
        engine._people(state,frame,1000)
        self.assertFalse(state['bodies'],'one weak person/posture pair cannot start a body')
        engine._people(state,frame,1700)
        self.assertEqual(len(state['bodies']),1)
        identity=state['bodies'][0]['id']
        self.assertTrue(state['restPersonCandidates'][0]['confirmed'])
        engine._people(state,frame,2300)
        self.assertEqual([b['id'] for b in state['bodies']],[identity])
        self.assertEqual(engine.timings['restEvidenceAgeMs'],600)
        self.assertLess(state['restObservations'][identity]['personConfidence'],.1)
        json.dumps(state['restObservations'],allow_nan=False)

    def test_object_geometry_is_published_while_interaction_analysis_is_blocked(self):
        engine=Perception.__new__(Perception);engine.lock=threading.Lock();engine.stop=threading.Event()
        engine.scene_results={};engine.scene_boxes={};engine.scene_objects={};engine.timings={}
        state=dict(objectsAt=0,objects=[],bodies=[])
        engine.sessions={'one':state};engine.scene_latest={'one':(np.zeros((100,100,3),np.uint8),[],1000,state)}
        entered=threading.Event();release=threading.Event()
        def detect(*args):
            state.update(objectsAt=1000,objects=[dict(detectionId=0,**{'class':73},confidence=.9,box=[.1,.2,.3,.2])])
        def ownership(*args):
            entered.set();release.wait(2);return {}
        engine._scene=detect;engine._ownership=ownership
        worker=threading.Thread(target=engine._scene_loop);worker.start()
        try:
            self.assertTrue(entered.wait(1))
            snapshot=engine.object_hints('one')
            self.assertEqual(snapshot['at'],1000)
            self.assertEqual(snapshot['objects'][0]['kind'],'book')
            self.assertFalse(snapshot['objects'][0]['interaction'])
            engine.sessions.clear();engine._publish_object_geometry('one',state)
        finally:engine.stop.set();release.set();worker.join(2)

    def test_person_ids_survive_adaptive_upload_resolution_without_reinitializing_bytetrack(self):
        import torch
        from ultralytics.engine.results import Boxes
        from ultralytics.trackers.byte_tracker import BYTETracker
        engine=Perception.__new__(Perception);engine.lock=threading.Lock();engine.device='cpu';engine.timings={};engine.person_limit=40
        engine.desk_rest=SimpleNamespace(predict=Mock(side_effect=AssertionError('auxiliary posture inference must not block people')))
        def prediction(frame,**kwargs):
            h,w=frame.shape[:2]
            rows=torch.tensor([[.1*w,.1*h,.3*w,.9*h,.9,0],[.6*w,.1*h,.9*w,.9*h,.9,0]])
            return [SimpleNamespace(boxes=Boxes(rows,(h,w)))]
        engine.people=SimpleNamespace(predict=prediction)
        args=SimpleNamespace(track_high_thresh=.2,track_low_thresh=.1,new_track_thresh=.2,track_buffer=30,match_thresh=.8,fuse_score=True)
        state=dict(tracker=BYTETracker(args,frame_rate=5),peopleAt=0,bodyHistory=[])
        first=None
        for n,(w,h) in enumerate([(1280,720),(1920,1080),(1280,720),(1920,1080),(960,540),(1280,720)]):
            engine._people(state,np.zeros((h,w,3),np.uint8),1000+n*400)
            ids=[b['id'] for b in state['bodies']]
            if first is None:first=ids
            self.assertEqual(ids,first,'changing JPEG resolution must not replace the same two people')
            self.assertEqual(len(ids),2)
            self.assertAlmostEqual(state['bodies'][0]['box'][0],.1,places=5)
            self.assertAlmostEqual(state['bodies'][1]['box'][2],.3,places=5)
    def test_object_regions_follow_the_same_unique_body_as_the_face(self):
        engine=Perception.__new__(Perception)
        engine.timings={}
        engine._hands_for=Mock(return_value=[(.4,.55)])
        state=dict(bodies=[dict(id=7,box=[.1,.1,.7,.8])],wrists=[],
            objects=[{'class':67,'box':[.37,.5,.06,.1],'confidence':.88}])
        frame=np.zeros((400,400,3),dtype=np.uint8)
        faces=[dict(id=1,box=[.2,.15,.2,.2])]
        owner,values,regions=engine._ownership(frame,state,faces)[1]
        self.assertEqual(owner,7)
        self.assertTrue(values[67])
        self.assertEqual(regions[0]['kind'],'phone')
        faces.append(dict(id=2,box=[.5,.15,.2,.2]))
        output=engine._ownership(frame,state,faces)
        self.assertIsNone(output[1][1])
        self.assertIsNone(output[2][1])
        self.assertEqual(output[1][2],[])
        self.assertEqual(output[2][2],[])

    def measure(self, found=True, center=.5, radius=.33, box=None, dark=False, retry=False):
        points = [SimpleNamespace(x=.5, y=.5) for _ in range(478)]
        for i, index in enumerate(FACE_OVAL):
            angle = i*2*math.pi/len(FACE_OVAL)
            points[index] = SimpleNamespace(x=center+radius*math.cos(angle), y=.5+radius*math.sin(angle))
        result = SimpleNamespace(face_landmarks=[points] if found else [],
                                 face_blendshapes=[], facial_transformation_matrixes=[])
        engine = Perception.__new__(Perception)
        engine.face = Mock()
        engine.face.detect.side_effect = ([SimpleNamespace(face_landmarks=[]),result] if retry else lambda image: result)
        engine.engagement = SimpleNamespace(model=None)
        box = [.25, .25, .25, .3] if box is None else box
        frame = np.random.default_rng(0).integers(40,220,(400,400,3),dtype=np.uint8)
        if dark:
            frame = (frame*.1).astype(np.uint8)
        return engine._face(frame,
                            dict(id=1, box=box, facePixels=box[2]*400), 1000, 'session', {})

    def test_matched_mesh_produces_face_confirmation(self):
        observation = self.measure()
        self.assertIs(observation['facePresent'], True)
        self.assertIs(observation['valid'], True)
        self.assertIn('refinement', observation)

    def test_dark_pixels_do_not_skip_measurement_or_reject_a_matching_mesh(self):
        for retry in (False,True):
            observation = self.measure(dark=True,retry=retry)
            self.assertFalse(observation['quality']['usable'])
            self.assertTrue(observation['facePresent'])
            self.assertTrue(observation['valid'])

    def test_mesh_of_neighbor_cannot_supply_behavior_or_refinement(self):
        observation = self.measure(center=.98, radius=.1)
        self.assertIs(observation['facePresent'], False)
        self.assertIs(observation['valid'], False)
        self.assertNotIn('refinement', observation)

    def test_small_face_is_confirmed_without_enabling_behavior(self):
        observation = self.measure(box=[.25, .25, .08, .1])
        self.assertIs(observation['facePresent'], True)
        self.assertIs(observation['valid'], False)

    def test_observation_mode_has_no_engagement_score(self):
        observation=self.measure()
        self.assertNotIn('cavtScore',observation)
        self.assertNotIn('cavtAvailable',observation)

    def test_body_keypoints_are_associated_once_even_without_faces(self):
        engine=Perception.__new__(Perception);engine.timings={}
        engine._hands_for=Mock(return_value=[])
        state=dict(bodies=[dict(id=7,box=[.1,.1,.7,.8])],wrists=[],objects=[],objectsAt=1000,
            poseAt=900,headings=[([.1,.1,.7,.8],.4)])
        engine._ownership(np.zeros((400,400,3),np.uint8),state,[])
        self.assertEqual(state['bodyObservations'][7]['headYaw'],.4)
        self.assertEqual(state['bodyObservations'][7]['headObservedAt'],900)
        state['bodies'].append(dict(id=8,box=[.1,.1,.7,.8]))
        engine._ownership(np.zeros((400,400,3),np.uint8),state,[])
        self.assertEqual(sum('headYaw' in row for row in state['bodyObservations'].values()),0)

    def test_pose_payload_survives_ownership_without_face_and_expires_without_refresh(self):
        engine=Perception.__new__(Perception);engine.timings={}
        engine._hands_for=Mock(return_value=[])
        packed=pack_pose([40,40,320,360],np.tile([200,200,.9],(17,1)),.9,400,400,900)
        state=dict(bodies=[dict(id=7,box=[.1,.1,.7,.8])],wrists=[],objects=[],objectsAt=1000,
            poseAt=900,poseRegions=[packed])
        engine._ownership(np.zeros((400,400,3),np.uint8),state,[])
        self.assertEqual(state['bodyObservations'][7]['bodyPose']['observedAt'],900)
        self.assertEqual(len(state['bodyObservations'][7]['bodyPose']['keypoints']),17)
        state['poseAt']=4000
        engine._ownership(np.zeros((400,400,3),np.uint8),state,[])
        self.assertNotIn('bodyPose',state['bodyObservations'][7])

    def test_pose_publication_does_not_wait_for_objects_or_reuse_an_old_pose(self):
        engine=Perception.__new__(Perception);engine.lock=threading.Lock()
        engine.actions=SimpleNamespace(snapshot=lambda *args:[])
        engine._ownership=Mock(side_effect=RuntimeError('Object pipeline is busy'))
        body=dict(id=7,box=[.1,.1,.7,.8],at=900)
        packed=pack_pose([40,40,320,360],np.tile([200,200,.9],(17,1)),.9,400,400,900)
        state=dict(bodies=[body],bodyHistory=[(900,[body])],bodyObservations={7:dict(bodyPose=dict(observedAt=100))})
        engine.sessions={'one':state}
        result=dict(poseRegions=[packed],headings=[([.1,.1,.7,.8],.3)],poseAt=900)
        engine._publish_pose(state,result,900)
        self.assertEqual(engine.body_hints('one')[0]['observation']['bodyPose']['observedAt'],900)
        engine._ownership.assert_not_called()
        engine._publish_pose(state,dict(poseRegions=[],headings=[],poseAt=1100),1100)
        self.assertNotIn('bodyPose',engine.body_hints('one')[0]['observation'])

    def test_early_body_submission_does_not_clear_face_or_object_work(self):
        engine=Perception.__new__(Perception);engine.lock=threading.Lock()
        engine.memory_budget=SimpleNamespace(update=lambda _:40);engine.sessions={}
        state=dict(bodies=[]);engine._state=Mock(return_value=state)
        engine.actions=SimpleNamespace(observe=Mock())
        engine.latest={'one':'old-face-job'};engine.scene_latest={'one':'old-scene-job'}
        engine.body_latest={};engine.pose_latest={};engine.rest_latest={}
        engine.submit('one',object(),[],1000,body_only=True)
        self.assertEqual(engine.latest['one'],'old-face-job')
        self.assertEqual(engine.scene_latest['one'],'old-scene-job')
        self.assertEqual(engine.pose_latest['one'][1],1000)
        engine.actions.observe.assert_not_called()

    def test_object_ownership_never_uses_wrists_from_a_future_pose_frame(self):
        engine=Perception.__new__(Perception);engine.timings={};engine._hands_for=Mock(return_value=[])
        body=dict(id=7,box=[.1,.1,.7,.8]);wrists=[(body['box'],[(.4,.55)])]
        state=dict(bodies=[body],bodyHistory=[(900,[body])],wrists=wrists,poseAt=2000,
            poseHistory=[(2000,dict(wrists=wrists))],objectsAt=1000,
            objects=[dict({'class':67},box=[.37,.5,.06,.1],confidence=.88)])
        owner,values,_=engine._ownership(np.zeros((400,400,3),np.uint8),state,[dict(id=1,box=[.2,.15,.2,.2])],1000)[1]
        self.assertEqual(owner,7);self.assertIsNot(values[67],True)

    def test_missing_mesh_or_empty_crop_clears_previous_confirmation(self):
        for observation in [self.measure(found=False), self.measure(box=[1.5, .25, .25, .3])]:
            self.assertIs(observation['facePresent'], False)
            self.assertIs(observation['valid'], False)
            self.assertEqual(observation['observedAt'], 1000)
            self.assertNotIn('refinement', observation)


if __name__ == '__main__':
    unittest.main()
