import unittest
from rest_body_tracking import RestBodyTracking
from person_tracking import merge_rest_bodies,PersonTracking


class RestBodyTrackingTests(unittest.TestCase):
    def setUp(self):
        self.tracker=RestBodyTracking();self.box=[.2,.2,.28,.2]
        self.body=dict(id=7,at=1000,box=self.box)
        self.proof=dict(active=True,confidence=.6,personConfidence=.04,candidateConfidence=.04,
            temporalPerson=True,personObservedAt=1000,observedAt=1000,box=self.box)

    def test_specialist_only_cannot_create_an_unknown_person(self):
        self.tracker.update([dict(box=self.box,confidence=.9)],1000)
        self.assertEqual(self.tracker.snapshot(1000),[])
        self.tracker.seed([self.body],{7:{**self.proof,'temporalPerson':False}},1000)
        self.assertEqual(self.tracker.snapshot(1000),[])

    def test_current_specialist_detections_continue_a_verified_body_without_fabricating_primary_measurements(self):
        self.tracker.seed([self.body],{7:self.proof},1000)
        for at in range(1500,8501,500):
            self.tracker.update([dict(box=self.box,confidence=.45)],at)
            output=self.tracker.snapshot(at)
            self.assertEqual([body['id'] for body in output],[7])
            rest=output[0]['observation']['deskRest']
            self.assertEqual(rest['observedAt'],at);self.assertEqual(rest['trackedBodyAt'],at)
            self.assertEqual(rest['personObservedAt'],1000);self.assertEqual(rest['personConfidence'],.04)
            self.assertEqual(rest['personConfirmedAt'],1000)
        self.tracker.update([],9000)
        self.assertFalse(self.tracker.snapshot(9000)[0]['observation']['deskRest']['active'])
        self.assertEqual(self.tracker.snapshot(10001),[])
        self.tracker.update([dict(box=self.box,confidence=.9)],11000)
        self.assertEqual(self.tracker.snapshot(11000),[],'an expired identity requires independent person confirmation again')

    def test_late_primary_reacquisition_keeps_the_known_specialist_id_and_does_not_rewind_its_box(self):
        self.tracker.seed([self.body],{7:self.proof},1000)
        moved=[.205,.2,.28,.2]
        self.tracker.update([dict(box=moved,confidence=.5)],2000)
        self.tracker.seed([dict(id=99,at=1500,box=self.box)],{99:{**self.proof,'observedAt':1500,'personObservedAt':1500}},1500)
        output=self.tracker.snapshot(2000)
        self.assertEqual([body['id'] for body in output],[7]);self.assertEqual(output[0]['box'],moved)
        self.assertEqual(output[0]['observation']['deskRest']['personObservedAt'],1500)
        self.tracker.update([],1500)
        self.assertTrue(self.tracker.snapshot(2000)[0]['observation']['deskRest']['active'],'out-of-order negative results cannot replace a newer image')

    def test_ambiguous_current_posture_does_not_confirm_two_overlapping_people(self):
        other=[.26,.2,.28,.2]
        self.tracker.seed([self.body,dict(id=8,at=1000,box=other)],
            {7:self.proof,8:{**self.proof,'box':other}},1000)
        self.tracker.update([dict(box=[.23,.2,.28,.2],confidence=.8)],1500)
        self.assertEqual(len(self.tracker.snapshot(1500)),2)
        self.assertFalse(any(body['observation']['deskRest']['active'] for body in self.tracker.snapshot(1500)))

    def test_merge_rest_body_keeps_other_people_and_never_manufactures_a_face(self):
        self.tracker.seed([self.body],{7:self.proof},1000)
        self.tracker.update([dict(box=self.box,confidence=.45)],1500)
        ordinary=dict(id=8,seen=1500,box=[.7,.1,.2,.7],observation=dict(valid=False))
        reacquired=dict(id=99,seen=1000,box=self.box,observation=dict(bodyPose={'observedAt':1000}))
        merged=merge_rest_bodies([ordinary,reacquired],self.tracker.snapshot(1500),1500)
        self.assertEqual({body['id'] for body in merged},{7,8})
        person=next(body for body in merged if body['id']==7)
        self.assertIn('bodyPose',person['observation'])
        self.assertEqual(person['observation']['deskRest']['observedAt'],1500)
        tracking=PersonTracking(async_prepare=False)
        try:
            published=tracking.assemble([person],[],1500)[0]
            self.assertEqual(published['faceVisibility'],'unavailable');self.assertNotIn('faceBox',published)
        finally:tracking.close()
        self.assertEqual(merge_rest_bodies([ordinary],self.tracker.snapshot(1500),4000),[ordinary])
