import unittest
import threading
from unittest.mock import Mock
from types import SimpleNamespace
from concurrent.futures import Future
import numpy as np
from person_tracking import PersonTracking,attach_faces

class PersonAssociationTests(unittest.TestCase):
    def test_unpaired_face_cannot_inherit_another_bodys_cached_identity_and_behavior(self):
        body=dict(id=7,seen=1000,box=[.1,.1,.2,.5])
        face=dict(boxKind='face',box=dict(x=.7,y=.2,width=.1,height=.1),geometryId=9,trackingState='face',personId=7,
            observation=dict(valid=True,facePresent=True,observedAt=1000,eyeAspectRatio=.3,yawDeg=35,
                personId=7,phoneHeld=True,headYaw=.4,bodyPose={'old':True},deskRest={'active':True}))
        output=self.persons.assemble([body],[face],1000);orphan=next(p for p in output if p.get('geometryId')==9)
        self.assertNotIn('personId',orphan)
        self.assertTrue(orphan['observation']['valid']);self.assertEqual(orphan['observation']['yawDeg'],35)
        for key in ['personId','phoneHeld','headYaw','bodyPose','deskRest']:self.assertNotIn(key,orphan['observation'])
    def test_a_torso_fragment_cannot_claim_a_neighboring_face_outside_its_bounds(self):
        bodies=[dict(id=1,seen=1000,box=[.45,.48,.06,.12]),dict(id=2,seen=1000,box=[.48,.44,.07,.18])]
        face=dict(boxKind='face',box=dict(x=.516,y=.47,width=.025,height=.045),geometryId=9,trackingState='face',personId=1)
        links,_=attach_faces(bodies,[face]);self.assertEqual(links,{1:0})
    def test_overlapping_body_duplicates_do_not_publish_two_students_for_one_face(self):
        bodies=[dict(id=1,seen=1000,box=[.2,.2,.3,.5]),dict(id=2,seen=1000,box=[.21,.2,.28,.4])]
        face=dict(boxKind='face',box=dict(x=.3,y=.21,width=.08,height=.1),geometryId=9,trackingState='face')
        output=self.persons.assemble(bodies,[face],1000)
        self.assertEqual(len(output),1)
        self.assertEqual(output[0]['geometryId'],9)

    def test_two_distinct_heads_and_corroborated_face_hidden_people_survive_overlap(self):
        bodies=[dict(id=1,seen=1000,box=[.2,.2,.3,.5]),dict(id=2,seen=1000,box=[.21,.2,.28,.4])]
        faces=[dict(boxKind='face',box=dict(x=x,y=.21,width=.06,height=.08),geometryId=i,personId=i+1,trackingState='face') for i,x in enumerate([.24,.38])]
        self.assertEqual(len(self.persons.assemble(bodies,faces,1000)),2)
        bodies[1]['observation']=dict(deskRest=dict(active=True,confidence=.6))
        self.assertEqual(len(self.persons.assemble(bodies,faces[:1],1100)),2)

    def test_body_completed_during_face_detection_is_published_in_the_same_result_without_a_second_pixel_update(self):
        visual=self.fake_visual();image=np.zeros((270,480,3),np.uint8)
        self.assertEqual(self.persons.update(image,1000,[],0),[])
        hint=dict(id=7,at=1000,box=[.1,.1,.4,.7])
        bodies=self.persons.refresh(1000,[hint],1000)
        face=dict(boxKind='face',box=dict(x=.2,y=.12,width=.1,height=.15),geometryId=9,trackingState='face')
        published=self.persons.assemble(bodies,[face],1000)
        self.assertEqual(len(published),1)
        self.assertIn('personBox',published[0]);self.assertIn('faceBox',published[0])
        self.assertEqual(published[0]['faceVisibility'],'visible')
        self.assertEqual(visual.update.call_count,1)
        self.assertEqual(len(self.persons.history),1)

    def test_same_image_refresh_cannot_replay_an_older_scan_or_restore_a_rejected_body(self):
        visual=self.fake_visual();image=np.zeros((270,480,3),np.uint8)
        hint=dict(id=7,at=1000,box=[.1,.1,.4,.7])
        self.persons.update(image,1000,[hint],1000)
        self.persons.update(image,1100,[],1100)
        self.assertEqual(self.persons.refresh(1100,[hint],1000),[])
        self.assertEqual(visual.update.call_count,2)
        self.assertEqual(self.persons.refresh(1200,[hint],1000),[],'unseen images cannot publish body geometry')

    def test_partial_body_scan_bridges_one_miss_only_with_current_native_pixels(self):
        visual=self.fake_visual();image=np.zeros((270,480,3),np.uint8)
        first=dict(id=7,seen=1000,box=[.1,.1,.2,.7],visualAt=1000)
        second=dict(id=8,seen=1000,box=[.6,.1,.2,.7],visualAt=1000)
        self.persons.tracks=[first,second];self.persons.last_scan=1000
        visual.items={7:dict(seen=1000,seededAt=1000),8:dict(seen=1000,seededAt=1000)}
        def update(frame,tracks,at,**kwargs):
            for track in tracks:track['visualAt']=at
        visual.update.side_effect=update
        for at,scan in [(1400,1300),(1600,1500)]:
            self.persons.history.append((scan,image))
            output=self.persons.update(image,at,[dict(id=7,at=scan,box=first['box'])],scan)
            self.assertEqual({track['id'] for track in output},{7,8} if at==1400 else {7})
            if at==1400:self.assertEqual(next(track for track in output if track['id']==8)['seen'],1000)

    def test_completed_dense_batch_is_not_discarded_for_being_more_than_two_images_behind(self):
        persons=PersonTracking();image=np.zeros((270,480,3),np.uint8)
        try:
            persons.history.extend((1000+n*100,image) for n in range(12))
            persons.allowed={7};persons.job=Future()
            track=dict(id=7,seen=1000,box=[.1,.1,.4,.7],visualAt=1500)
            persons.job.set_result(dict(generation=0,scan=1000,at=1500,tracks=[track],items={},shape=image.shape[:2]))
            persons._prepared(image,2100)
            self.assertEqual([t['id'] for t in persons.tracks],[7])
            self.assertEqual(persons.applied_scan,1000)
        finally:persons.close()

    def test_live_native_body_can_continue_a_slow_detector_without_renewing_behavior_timestamp(self):
        visual=self.fake_visual()
        track=dict(id=7,seen=1000,box=[.1,.1,.4,.7],visualAt=4500)
        self.persons.tracks=[track]
        image=np.zeros((270,480,3),np.uint8)
        result=self.persons.update(image,4500,[],0)
        self.assertEqual(result[0]['seen'],1000)
        track['visualLostAt']=4600
        self.assertEqual(self.persons.update(image,4600,[],0),[])
        track.pop('visualLostAt');track['visualAt']=6100
        self.assertEqual(self.persons.update(image,6100,[],0),[],'native continuation is bounded even with high score')

    def test_late_template_can_handover_recent_native_measurement_but_cannot_restore_expired_detection(self):
        persons=PersonTracking();image=np.zeros((270,480,3),np.uint8)
        try:
            def completed(scan,latest):
                job=Future();job.set_result(dict(generation=0,scan=scan,at=latest,
                    tracks=[dict(id=7,seen=scan,box=[.1,.1,.4,.7],visualAt=latest)],items={},shape=image.shape[:2]))
                return job
            persons.job=completed(1000,3800)
            persons._prepared(image,4700)
            self.assertEqual(persons.tracks[0]['seen'],1000,'native handover must retain the independent detector age')
            persons.tracks=[];persons.applied_scan=-1
            persons.job=completed(1000,5800)
            persons._prepared(image,6100)
            self.assertEqual(persons.tracks,[],'a recent native result cannot extend the detector lifetime indefinitely')
        finally:persons.close()

    def test_async_template_preparation_cannot_block_frames_or_restore_after_a_new_empty_scan(self):
        persons=PersonTracking();started=threading.Event();release=threading.Event()
        def prepare(*args):
            started.set();release.wait(2)
            return dict(generation=args[-1],scan=1000,at=1000,tracks=[],items={})
        persons._prepare=prepare
        image=np.zeros((270,480,3),np.uint8)
        try:
            detected=persons.update(image,1000,[dict(id=7,at=1000,box=[.1,.1,.4,.7])],1000)
            self.assertEqual(detected[0]['id'],7,'a fresh positive detector box must not wait for template preparation')
            self.assertNotIn('visualAt',detected[0],'detector fallback must not claim a current native pixel update')
            self.assertTrue(started.wait(1))
            self.assertEqual(persons.update(image,1100,[],1100),[])
            release.set();persons.job.result(timeout=2)
            self.assertEqual(persons.update(image,1200,[],1100),[])
            self.assertEqual(persons.tracks,[])
        finally:release.set();persons.close()

    def setUp(self):self.persons=PersonTracking(async_prepare=False)
    def tearDown(self):self.persons.close()
    def test_body_survives_hidden_face_without_manufacturing_face_or_eye_evidence(self):
        body=dict(id=7,seen=1000,box=[.1,.1,.4,.7],observation=dict(phoneHeld=True,objectsAt=1000))
        before=self.persons.assemble([body],[dict(boxKind='face',box=dict(x=.2,y=.12,width=.1,height=.15),geometryId=9,trackingState='face',observation=dict(valid=True))],1000)[0]
        after=self.persons.assemble([body],[],1100)[0]
        self.assertEqual(before['personId'],after['personId']);self.assertEqual(after['faceVisibility'],'unavailable')
        self.assertNotIn('faceBox',after);self.assertFalse(after['observation']['valid']);self.assertTrue(after['observation']['phoneHeld'])
    def test_one_face_cannot_be_assigned_to_two_overlapping_people(self):
        bodies=[dict(id=1,box=[.1,.1,.4,.7]),dict(id=2,box=[.2,.1,.4,.7])]
        links,used=attach_faces(bodies,[dict(boxKind='face',box=dict(x=.25,y=.12,width=.1,height=.15))])
        self.assertEqual(len(links),1);self.assertEqual(len(used),1)
    def test_close_up_face_is_retained_without_unsupported_body_rectangle(self):
        face=dict(boxKind='face',box=dict(x=.1,y=.1,width=.6,height=.8),geometryId=1,trackingState='face')
        person=self.persons.assemble([], [face],1000)[0]
        self.assertNotIn('personBox',person);self.assertEqual(person['faceBox'],face['box'])

    def fake_visual(self):
        self.persons.visual.close()
        visual=SimpleNamespace(items={},seed=Mock(),update=Mock())
        self.persons.visual=visual
        visual.close=lambda:None
        return visual

    def test_new_empty_scan_removes_old_people_even_when_visual_tracker_still_locks_on_background(self):
        visual=self.fake_visual();visual.items[7]=dict(seen=1000)
        self.persons.tracks=[dict(id=7,seen=1000,box=[.1,.1,.4,.7],visualAt=1000)]
        self.assertEqual(self.persons.update(np.zeros((270,480,3),np.uint8),1400,[],1300),[])
        self.assertEqual(self.persons.tracks,[]);self.assertEqual(visual.items,{})
        self.assertEqual(self.persons.last_scan,1300)

    def test_delayed_body_results_still_find_the_source_after_more_than_32_camera_frames(self):
        self.fake_visual();image=np.zeros((270,480,3),np.uint8)
        for n in range(60):self.persons.update(image,1000+n*33,[],0)
        hint=dict(id=7,at=1000,box=[.1,.1,.4,.7])
        result=self.persons.update(image,3000,[hint],1000)
        self.assertEqual(result[0]['id'],7);self.assertEqual(self.persons.last_scan,1000)
        self.assertLessEqual(len(self.persons.history),128)

    def test_agreeing_body_scan_refreshes_evidence_without_replaying_a_live_template(self):
        visual=self.fake_visual();visual.items[7]=dict(seen=1000,seededAt=1000)
        old=dict(id=7,seen=1000,box=[.1,.1,.4,.7],visualAt=1400)
        self.persons.tracks=[old]
        image=np.zeros((270,480,3),np.uint8)
        self.persons.history.append((1300,image))
        self.persons.update(image,1400,[dict(id=7,at=1300,box=[.105,.1,.4,.7])],1300)
        self.assertEqual(visual.items[7]['seen'],1300)
        self.assertEqual(self.persons.tracks[0]['box'],old['box'])
        self.assertEqual(visual.update.call_count,1,'agreeing scans must not replay old images over a live tracker')

if __name__=='__main__':unittest.main()
