import unittest
from association import object_evidence, associate_objects


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.bodies=[dict(id=1,box=[.1,.1,.4,.8]),dict(id=2,box=[.45,.1,.4,.8])]
        self.phone=dict(class_=67,box=[.35,.4,.05,.1])
        self.phone['class']=self.phone.pop('class_')

    def test_unique_nearest_owner(self):
        output=object_evidence(self.bodies,[self.phone],{1:[(.37,.45)],2:[(.7,.5)]})
        self.assertIs(output[1][67],True)
        self.assertIs(output[2][67],False)

    def test_no_hand_is_unknown(self):
        self.assertIsNone(object_evidence(self.bodies,[self.phone],{})[1][67])

    def test_visible_phone_gets_a_candidate_box_without_claiming_hand_interaction(self):
        self.phone['confidence']=.85
        values,regions=associate_objects(self.bodies[:1],[self.phone],{})
        self.assertIsNone(values[1][67])
        self.assertEqual(len(regions[1]),1)
        self.assertEqual(regions[1][0]['kind'],'phone')
        self.assertIs(regions[1][0]['interaction'],False)

    def test_hand_evidence_promotes_the_detected_phone_to_interaction(self):
        values,regions=associate_objects(self.bodies[:1],[self.phone],{1:[(.37,.45)]})
        self.assertIs(values[1][67],True)
        self.assertIs(regions[1][0]['interaction'],True)

    def test_overlap_ambiguous_does_not_flag_both(self):
        self.phone['box']=[.46,.4,.04,.1]
        output=object_evidence(self.bodies,[self.phone],{1:[(.48,.45)],2:[(.48,.45)]})
        self.assertIsNone(output[1][67])
        self.assertIsNone(output[2][67])

    def test_laptop_requires_keyboard_interaction(self):
        laptop={'class':63,'box':[.2,.4,.2,.2]}
        self.assertIsNone(object_evidence(self.bodies,[laptop],{1:[(.3,.41)]})[1][63])
        self.assertIs(object_evidence(self.bodies,[laptop],{1:[(.3,.56)]})[1][63],True)

    def test_book_context_has_separate_owner(self):
        book={'class':73,'box':[.6,.4,.08,.1]}
        output=object_evidence(self.bodies,[book],{2:[(.64,.45)]})
        self.assertIs(output[2][73],True)
        self.assertIs(output[1][73],False)
        self.assertIs(output[2][67],False)

    def test_clear_scene_is_negative(self):
        self.assertEqual(object_evidence(self.bodies,[],{}),
                         {1:{63:False,67:False,73:False},2:{63:False,67:False,73:False}})

    def test_regions_preserve_each_object_and_its_unique_owner(self):
        book={'class':73,'box':[.6,.4,.08,.1],'confidence':.9}
        self.phone['confidence']=.85
        values,regions=associate_objects(self.bodies,[self.phone,book],{1:[(.37,.45)],2:[(.64,.45)]})
        self.assertTrue(values[1][67])
        self.assertEqual([region['kind'] for region in regions[1]],['phone'])
        self.assertEqual([region['kind'] for region in regions[2]],['book'])
        self.assertEqual(regions[1][0]['box'],dict(x=.35,y=.4,width=.35+.05-.35,height=.4+.1-.4))
        self.assertEqual(regions[1][0]['confidence'],.85)

    def test_ambiguous_or_unsupported_owner_has_no_object_region(self):
        for hands in [{},{1:[(.48,.45)],2:[(.48,.45)]}]:
            self.phone['box']=[.46,.4,.04,.1]
            _,regions=associate_objects(self.bodies,[self.phone],hands)
            self.assertEqual(regions,{1:[],2:[]})


if __name__=='__main__':
    unittest.main()
