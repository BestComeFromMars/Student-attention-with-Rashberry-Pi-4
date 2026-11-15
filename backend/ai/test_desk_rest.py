import json,unittest
from types import SimpleNamespace
import numpy as np
from desk_rest import decode_rest,corroborate_people,attach_rest,rest_person_candidates,activate_confirmed_rest_people,latest_rest_evidence,refresh_rest

class DeskRestTests(unittest.TestCase):
    def test_three_distinct_positive_posture_images_can_confirm_a_folded_person_after_one_strong_image(self):
        first=np.array([[100,100,240,200,.05,0]],np.float32)
        cue=dict(box=[.2,.2,.28,.2],confidence=.6)
        history=rest_person_candidates(first,[cue],500,500,1000,1000)
        partial=np.array([[100,100,240,300,.04,0]],np.float32)
        moderate=dict(box=cue['box'],confidence=.4)
        self.assertFalse(corroborate_people(partial,[moderate],500,500,1700,persistent=history,cue_at=1700)[1])
        history=rest_person_candidates(partial,[moderate],500,500,1700,1700,history)
        boosted,matched=corroborate_people(partial,[moderate],500,500,2400,persistent=history,cue_at=2400)
        self.assertTrue(matched[0]['temporalPerson'])
        self.assertAlmostEqual(matched[0]['personConfidence'],.04,places=5)
        self.assertEqual(len(history[0]['cueSamples']),2)
        self.assertFalse(corroborate_people(partial,[moderate],500,500,2400,persistent=history,cue_at=1700)[1],'cached posture is not a third image')

    def test_moderate_posture_sequence_without_a_strong_anchor_or_with_expired_anchor_cannot_start_a_person(self):
        rows=np.array([[100,100,240,200,.05,0]],np.float32)
        moderate=dict(box=[.2,.2,.28,.2],confidence=.4)
        history=[]
        for at in [1000,1700,2400,3100]:
            self.assertFalse(corroborate_people(rows,[moderate],500,500,at,persistent=history,cue_at=at)[1])
            history=rest_person_candidates(rows,[moderate],500,500,at,at,history)
        strong=[{**history[0],'personObservedAt':2400,'cueAt':2400,'cueSamples':[(500,.6),(1700,.4),(2400,.4)]}]
        self.assertFalse(corroborate_people(rows,[moderate],500,500,3100,persistent=strong,cue_at=3100)[1])

    def test_fresh_posture_metadata_does_not_wait_for_the_next_person_scan_or_renew_person_time(self):
        box=[.2,.2,.28,.2];bodies=[dict(id=7,box=box)]
        old={7:dict(active=True,confidence=.6,personConfidence=.04,candidateConfidence=.04,temporalPerson=True,personObservedAt=1000,observedAt=1000,box=box)}
        cue=dict(box=[.205,.2,.28,.2],confidence=.45)
        for now in [1800,2300]:
            current=refresh_rest(bodies,old,[cue],1700,now)[7]
            self.assertTrue(current['active']);self.assertEqual(current['observedAt'],1700)
            self.assertEqual(current['personObservedAt'],1000);self.assertEqual(current['personConfidence'],.04)
            self.assertEqual(current['confidence'],.45);self.assertEqual(bodies[0]['box'],box)
        self.assertFalse(refresh_rest(bodies,old,[cue],3100,3100),'a new posture image cannot renew expired independent-person evidence')
        self.assertFalse(refresh_rest(bodies,old,[cue],2000,1800),'future images are unavailable')
        self.assertFalse(refresh_rest(bodies,old,[cue],1000,2600),'posture evidence remains bounded')

    def test_fresh_posture_metadata_rejects_ambiguous_people_and_replaces_positive_with_negative_evidence(self):
        box=[.2,.2,.28,.2];bodies=[dict(id=7,box=box)]
        old={7:dict(active=True,confidence=.6,personConfidence=.04,candidateConfidence=.04,temporalPerson=True,personObservedAt=1000,observedAt=1000,box=box)}
        self.assertFalse(refresh_rest(bodies,old,[],1500,1500)[7]['active'])
        self.assertFalse(refresh_rest(bodies,old,[dict(box=[.7,.7,.28,.2],confidence=.9)],1500,1500)[7]['active'])
        self.assertFalse(refresh_rest(bodies,{7:{**old[7],'temporalPerson':False}},[dict(box=box,confidence=.9)],1500,1500))
        duplicated=[*bodies,dict(id=8,box=box)];both={**old,8:old[7]}
        output=refresh_rest(duplicated,both,[dict(box=box,confidence=.9)],1500,1500)
        self.assertFalse(any(cue['active'] for cue in output.values()))
        self.assertFalse(refresh_rest([dict(id=9,box=box)],old,[dict(box=box,confidence=.9)],1500,1500),'posture alone cannot create a new identity')

    def test_confirmed_body_survives_weaker_positive_posture_scores_without_relaxing_birth(self):
        rows=np.array([[100,100,240,200,.05,0]],np.float32)
        cue=dict(box=[.2,.2,.28,.2],confidence=.28)
        previous=[dict(box=cue['box'],supportBox=cue['box'],personConfidence=.06,personObservedAt=1000,cueAt=1000,cueConfidence=.6,confirmed=True)]
        candidates=rest_person_candidates(rows,[cue],500,500,1700,1700,previous)
        self.assertTrue(candidates[0]['confirmed'])
        boosted,matched=corroborate_people(rows,[cue],500,500,1700,persistent=previous,cue_at=1700)
        self.assertTrue(matched[0]['temporalPerson'])
        self.assertAlmostEqual(matched[0]['personConfidence'],.05,places=5)
        self.assertFalse(corroborate_people(rows,[cue],500,500,1700,persistent=[{**previous[0],'confirmed':False}],cue_at=1700)[1])
        self.assertFalse(rest_person_candidates(rows,[cue],500,500,1700,1700))

    def test_overlapping_primary_parts_continue_only_the_same_previously_confirmed_body(self):
        cue=dict(box=[.2,.2,.28,.2],confidence=.6)
        previous=[dict(box=cue['box'],supportBox=cue['box'],personConfidence=.06,personObservedAt=1000,cueAt=1000,cueConfidence=.6,confirmed=True)]
        rows=np.array([[100,100,240,200,.05,0],[100,100,240,200,.06,0]],np.float32)
        carried=rest_person_candidates(rows,[cue],500,500,1700,1700,previous)
        self.assertTrue(carried[0]['confirmed'])
        self.assertEqual(carried[0]['personObservedAt'],1700,'two current primary parts still observe the known person')
        matched=corroborate_people(rows,[cue],500,500,1700,persistent=previous,cue_at=1700)[1]
        self.assertEqual(len(matched),1)
        self.assertTrue(next(iter(matched.values()))['temporalPerson'])
        unconfirmed=[{**previous[0],'confirmed':False}]
        self.assertFalse(corroborate_people(rows,[cue],500,500,1700,persistent=unconfirmed,cue_at=1700)[1])
        self.assertTrue(corroborate_people(rows[:1],[cue],500,500,2400,persistent=carried,cue_at=2400)[1])
        self.assertFalse(rest_person_candidates(rows,[cue],500,500,3100,3100,previous))

    def test_missing_posture_image_preserves_bounded_history_but_cannot_publish_or_renew_evidence(self):
        old=dict(box=[.2,.2,.28,.2],supportBox=[.2,.2,.28,.2],personConfidence=.04,personObservedAt=1000,cueAt=1000,cueConfidence=.6,confirmed=True)
        carried=rest_person_candidates(np.empty((0,6)),[],500,500,1700,1700,[old])
        self.assertEqual(carried,[old]);self.assertFalse(corroborate_people(np.empty((0,6)),[],500,500,1700,persistent=carried,cue_at=1700)[1])
        self.assertFalse(rest_person_candidates(np.empty((0,6)),[],500,500,3100,3100,[old]))

    def test_continuation_uses_the_selected_primary_candidate_not_the_last_unrelated_person(self):
        cue=dict(box=[.2,.2,.28,.2],confidence=.45)
        history=[dict(box=cue['box'],supportBox=cue['box'],personConfidence=.05,personObservedAt=1000,cueAt=1000,cueConfidence=.6,confirmed=True)]
        reference=[dict(box=cue['box'],personConfidence=.15,personObservedAt=1000)]
        rows=np.array([[100,100,240,200,.05,0],[350,100,400,350,.8,0]],np.float32)
        boosted,matched=corroborate_people(rows,[cue],500,500,1700,recent=reference,persistent=history,cue_at=1700)
        self.assertTrue(matched[0]['temporalPerson'])
        self.assertEqual(matched[0]['candidateConfidence'],float(rows[0,4]))

    def test_faster_auxiliary_worker_does_not_hide_a_completed_cue_for_the_person_image(self):
        older=[dict(box=[.2,.2,.28,.2],confidence=.6)]
        newer=[dict(box=[.6,.6,.28,.2],confidence=.8)]
        history=[(1000,older),(1600,newer)]
        self.assertEqual(latest_rest_evidence(history,1300),(1000,older))
        self.assertEqual(latest_rest_evidence(history,1600),(1600,newer))
        self.assertEqual(latest_rest_evidence(history,900),(0,[]))
        self.assertEqual(latest_rest_evidence(history,3101),(0,[]))
        self.assertEqual(latest_rest_evidence([(1000,older),(1300,[])],1300),(1300,[]),'a newer negative observation replaces a positive one')

    def test_independent_async_models_can_confirm_a_folded_body_despite_changed_primary_extent(self):
        cues=[dict(box=[.2,.2,.28,.2],confidence=.6)]
        first=np.array([[100,100,240,200,.07,0]],np.float32)
        previous=rest_person_candidates(first,cues,500,500,1700,1000)
        second=np.array([[100,100,240,310,.04,0]],np.float32)
        next_cues=[dict(box=[.205,.2,.28,.2],confidence=.55)]
        boosted,matched=corroborate_people(second,next_cues,500,500,2300,persistent=previous,cue_at=1700)
        self.assertTrue(matched[0]['temporalPerson'])
        np.testing.assert_allclose(boosted[0,:4],[102.5,100,242.5,200],atol=.001)
        json.dumps(matched,allow_nan=False)
        self.assertFalse(corroborate_people(second,next_cues,500,500,2300,persistent=previous,cue_at=1000)[1])
        self.assertFalse(corroborate_people(second,[dict(box=next_cues[0]['box'],confidence=.4)],500,500,2300,persistent=previous,cue_at=1700)[1])

    def test_confirmed_folded_person_can_continue_a_changed_extent_and_one_missing_primary_frame(self):
        cues=[dict(box=[.2,.2,.28,.2],confidence=.4)]
        old=dict(box=cues[0]['box'],personConfidence=.07,personObservedAt=1000,cueAt=1000,cueConfidence=.6,confirmed=True)
        history=rest_person_candidates(np.empty((0,6)),cues,500,500,1500,1400,[old])
        self.assertEqual(history[0]['personObservedAt'],1000,'posture evidence cannot renew the last independent person observation')
        rows=np.array([[100,100,240,260,.05,0]],np.float32)
        boosted,matched=corroborate_people(rows,cues,500,500,1800,persistent=history,cue_at=1700)
        self.assertTrue(matched)
        np.testing.assert_allclose(boosted[0,:4],[100,100,240,200],atol=.001)
        self.assertAlmostEqual(matched[0]['personConfidence'],.05,places=5)
        json.dumps(matched,allow_nan=False)
        self.assertFalse(rest_person_candidates(np.empty((0,6)),cues,500,500,3100,3000,[old]))

    def test_temporal_confirmation_can_publish_a_real_bytetrack_birth_without_an_extra_primary_hit(self):
        born=SimpleNamespace(track_id=7,is_activated=False,result=[100,100,240,200,7,.5,0,0])
        tracker=SimpleNamespace(tracked_stracks=[born]);empty=np.empty((0,))
        cue=dict(box=[.2,.2,.28,.2],temporalPerson=False)
        self.assertEqual(len(activate_confirmed_rest_people(tracker,empty,{0:cue},500,500,np.ones(4))),0)
        cue['temporalPerson']=True
        output=activate_confirmed_rest_people(tracker,empty,{0:cue},500,500,np.ones(4))
        self.assertEqual(int(output[0,4]),7);self.assertTrue(born.is_activated)
        self.assertEqual(len(activate_confirmed_rest_people(tracker,output,{0:cue},500,500,np.ones(4))),1)

    def test_already_folded_person_can_start_from_repeated_independent_weak_body_and_strong_posture_detections(self):
        rows=np.array([[100,100,240,200,.07,0]],np.float32)
        cues=[dict(box=[.2,.2,.28,.2],confidence=.6)]
        previous=rest_person_candidates(rows,cues,500,500,1000,1000)
        self.assertFalse(corroborate_people(rows,cues,500,500,1000,persistent=previous,cue_at=1000)[1])
        boosted,matched=corroborate_people(rows,cues,500,500,1800,persistent=previous,cue_at=1700)
        self.assertEqual(set(matched),{0});self.assertTrue(matched[0]['temporalPerson'])
        self.assertGreater(boosted[0,4],.2)
        self.assertAlmostEqual(matched[0]['personConfidence'],.07,places=5,msg='weak evidence must not become a fabricated behavior confidence')
        previous[0]['confirmed']=True
        continued=corroborate_people(rows,[dict(box=cues[0]['box'],confidence=.4)],500,500,1800,persistent=previous,cue_at=1700)[1]
        self.assertTrue(continued,'two current models can continue the same folded person without a face')

    def test_temporal_rest_support_rejects_cached_cue_movement_expiry_and_single_model_evidence(self):
        rows=np.array([[100,100,240,200,.07,0]],np.float32)
        cues=[dict(box=[.2,.2,.28,.2],confidence=.6)]
        previous=rest_person_candidates(rows,cues,500,500,1000,900)
        for at,cue_at in [(1100,1000),(1800,900),(3100,3000)]:
            self.assertFalse(corroborate_people(rows,cues,500,500,at,persistent=previous,cue_at=cue_at)[1])
        self.assertFalse(corroborate_people(rows,cues,500,500,1800,persistent=[{**previous[0],'box':[.7,.7,.28,.2]}],cue_at=1700)[1])
        self.assertFalse(corroborate_people(rows,[dict(box=cues[0]['box'],confidence=.4)],500,500,1800,persistent=previous,cue_at=1700)[1])

    def test_weak_person_is_rescued_only_with_spatial_and_shape_agreement(self):
        rows=np.array([[100,100,240,200,.12,0],[300,100,380,300,.9,0]],np.float32)
        cues=[dict(box=[.2,.2,.28,.2],confidence=.4),dict(box=[.6,.2,.16,.2],confidence=.8)]
        boosted,matched=corroborate_people(rows,cues,500,500)
        self.assertEqual(set(matched),{0});self.assertAlmostEqual(boosted[0,4],.4,places=5)
        self.assertAlmostEqual(rows[0,4],.12,places=5)
        observed=attach_rest(np.array([[100,100,240,200,7]],float),boosted,matched,1000,500,500)
        self.assertTrue(observed[7]['active']);self.assertEqual(observed[7]['observedAt'],1000)

    def test_sleeping_label_alone_or_an_upright_reader_cannot_create_a_person(self):
        self.assertFalse(corroborate_people(np.empty((0,6)),[dict(box=[.2,.2,.2,.2],confidence=.9)],500,500)[1])
        rows=np.array([[100,100,180,300,.8,0]],np.float32)
        self.assertFalse(corroborate_people(rows,[dict(box=[.2,.2,.16,.2],confidence=.9)],500,500)[1])

    def test_ambiguous_overlapping_people_are_not_both_or_arbitrarily_assigned(self):
        rows=np.array([[100,100,240,200,.3,0],[100,100,240,200,.3,0]],np.float32)
        self.assertFalse(corroborate_people(rows,[dict(box=[.2,.2,.28,.2],confidence=.8)],500,500)[1])

    def test_very_weak_candidates_only_bridge_recent_independent_person_evidence(self):
        rows=np.array([[100,100,240,200,.04,0]],np.float32)
        cues=[dict(box=[.2,.2,.28,.2],confidence=.4)]
        reference=dict(box=[.2,.2,.28,.2],personConfidence=.15,personObservedAt=1000)
        self.assertFalse(corroborate_people(rows,cues,500,500,2500)[1])
        boosted,matched=corroborate_people(rows,cues,500,500,2500,[reference])
        self.assertAlmostEqual(boosted[0,4],.4,places=5)
        self.assertEqual(matched[0]['personObservedAt'],1000)
        self.assertAlmostEqual(matched[0]['candidateConfidence'],.04,places=5)
        for at in [999,3001]:
            self.assertFalse(corroborate_people(rows,cues,500,500,at,[reference])[1])
        moved={**reference,'box':[.7,.7,.2,.2]}
        self.assertFalse(corroborate_people(rows,cues,500,500,2500,[moved])[1])

    def test_decoder_preserves_class_scores_and_rejects_conflicting_reading_evidence(self):
        prediction=np.zeros((1,11,2),np.float32)
        prediction[0,:4,:]=np.array([[200,400],[200,400],[120,100],[100,100]])
        prediction[0,5,:]=[.4,.5];prediction[0,7,1]=.49
        result=decode_rest(prediction,(640,640,1,0,0))
        self.assertEqual(len(result),1);self.assertAlmostEqual(result[0]['confidence'],.4,places=5)

if __name__=='__main__':unittest.main()
