import time
import unittest
from pathlib import Path
import cv2
import numpy as np
from object_tracking import ObjectVisualTracker, overlap, same_target

ROOT=Path(__file__).resolve().parents[1]
cv2.setNumThreads(1)


class IndependentObjectTrackingTests(unittest.TestCase):
    def test_one_conflicting_class_on_the_same_pixels_does_not_replace_object_id_or_label(self):
        tracker=ObjectVisualTracker()
        try:
            image,phone,book=self.fixture()
            tracker.update(image,1000);tracker.remember_source(image,1000)
            tracker.update(image,1100,self.detections(1000,phone,book));self.wait_prepared(tracker)
            initial=tracker.update(image,1200);identity=next(item['id'] for item in initial if item['kind']=='book')
            tracker.remember_source(image,1200)
            conflicting=self.detections(1200,phone,book);conflicting['objects'][1]['kind']='laptop'
            tracker.update(image,1300,conflicting);self.wait_prepared(tracker)
            output=tracker.update(image,1400)
            self.assertEqual(next(item['id'] for item in output if item['kind']=='book'),identity)
            self.assertFalse(any(item['kind']=='laptop' for item in output))
        finally:tracker.close()

    def test_completed_batch_hands_over_before_a_new_positive_scan_and_keeps_late_interaction_metadata(self):
        tracker=ObjectVisualTracker()
        try:
            image,phone,book=self.fixture()
            tracker.update(image,1000);tracker.remember_source(image,1000)
            snapshot=self.detections(1000,phone,book)
            for index,obj in enumerate(snapshot['objects']):obj['detectionId']=index
            tracker.update(image,1100,snapshot);tracker.remember_source(image,1100)
            self.wait_prepared(tracker)
            newer=self.detections(1100,phone,book)
            for index,obj in enumerate(newer['objects']):obj['detectionId']=index
            output=tracker.update(image,1200,newer)
            self.assertEqual({item['kind'] for item in output},{'phone','book'},'new scan must not cancel a finished positive result')
            self.wait_prepared(tracker)
            newer['objects'][0].update(interaction=True,ownerPersonId=7)
            # Metadata can arrive separately for the same source. It must not
            # move the box or fabricate a newer detector timestamp.
            output=tracker.update(image,1250,newer)
            actual=next(item for item in output if item['kind']=='phone')
            self.assertTrue(actual['interaction']);self.assertEqual(actual['ownerPersonId'],7)
            self.assertEqual(actual['observedAt'],1100)
        finally:tracker.close()

    def test_phone_screen_inside_the_same_phone_is_not_a_second_object(self):
        self.assertTrue(same_target([.5,.2,.2,.3],[.53,.26,.13,.15],True))
        self.assertFalse(same_target([.5,.2,.2,.3],[.73,.26,.13,.15],True))
        self.assertFalse(same_target([.5,.2,.2,.3],[.53,.26,.13,.15],False))
    def fixture(self, dx=0, book_dx=0):
        source=cv2.imread(str(ROOT/'test-fixtures/objects/phone-and-book.jpg'))
        # Actual phone/hand and book pixels from the source; each patch moves
        # independently. A fixed textured face area never moves with the phone.
        image=np.full((480,640,3),210,np.uint8)
        image[40:200,40:200]=cv2.resize(source[90:170,165:245],(160,160))
        image[120:213,380+dx:524+dx]=cv2.resize(source[276:307,428:476],(144,93))
        image[320:392,100+book_dx:241+book_dx]=cv2.resize(source[215:263,242:336],(141,72))
        # Source annotation class 67: xc=.706648,yc=.595662,w=.0547031,h=.0379633.
        phone=[(380+dx+(.706648-.0547031/2)*640*3-428*3)/640,
               (120+(.595662-.0379633/2)*491*3-276*3)/480,
               .0547031*640*3/640,.0379633*491*3/480]
        book=[(100+book_dx+(.451359-.135063/2)*640*1.5-242*1.5)/640,
              (320+(.488106-.0762118/2)*491*1.5-215*1.5)/480,
              .135063*640*1.5/640,.0762118*491*1.5/480]
        return image,phone,book

    def detections(self, at, phone, book):
        return dict(at=at,objects=[dict(kind=kind,box=dict(zip(('x','y','width','height'),box)),
            confidence=.9,observedAt=at,interaction=False) for kind,box in [('phone',phone),('book',book)]])

    def wait_prepared(self, tracker):
        deadline=time.monotonic()+8
        while tracker.completed is None and time.monotonic()<deadline:
            if tracker.error:self.fail(tracker.error)
            time.sleep(.01)
        self.assertIsNotNone(tracker.completed,'native templates did not finish')

    def test_phone_and_book_have_separate_ids_and_follow_independent_pixel_motion_without_faces(self):
        tracker=ObjectVisualTracker()
        try:
            image,phone,book=self.fixture()
            tracker.update(image,1000);tracker.remember_source(image,1000)
            tracker.update(image,1100,self.detections(1000,phone,book))
            self.wait_prepared(tracker)
            initial=tracker.update(image,1200)
            self.assertEqual({item['kind'] for item in initial},{'phone','book'})
            ids={item['kind']:item['id'] for item in initial}
            for index in range(1,7):
                image,phone,book=self.fixture(index*8,-index*5)
                output=tracker.update(image,1200+index*100)
                self.assertEqual(len(output),2)
                for item in output:
                    box=[item['box'][key] for key in ('x','y','width','height')]
                    target=phone if item['kind']=='phone' else book
                    self.assertEqual(item['id'],ids[item['kind']])
                    self.assertGreater(overlap(box,target),.5,(item, target))
                    self.assertEqual(item['trackedAt'],1200+index*100)
                    self.assertEqual(item['observedAt'],1000,'pixel tracking must not fabricate new detector evidence')
            tracker.update(image,2000,dict(at=1900,objects=[]))
            self.assertEqual(tracker.update(image,2100),[],'negative YOLO scan must clear background tracking')
        finally:tracker.close()

    def test_delayed_detector_seeds_on_its_source_then_catches_up_to_the_current_pixels(self):
        tracker=ObjectVisualTracker()
        try:
            initial,phone,book=self.fixture()
            tracker.update(initial,1000);tracker.remember_source(initial,1000)
            for index in range(1,9):
                image,_,_=self.fixture(index*6,0)
                tracker.update(image,1000+index*200)
                tracker.remember_source(image,1000+index*200)
            tracker.update(image,2800,self.detections(1000,phone,book))
            self.wait_prepared(tracker)
            output=tracker.update(image,2900)
            actual=next(item for item in output if item['kind']=='phone')
            _,expected,_=self.fixture(48,0)
            self.assertGreater(overlap([actual['box'][key] for key in ('x','y','width','height')],expected),.5)
            self.assertEqual(actual['trackedAt'],2900)
            self.assertEqual(actual['observedAt'],1000)
            continued=tracker.update(image,6001)
            self.assertTrue(continued,'a live pixel measurement may bridge a slow dense-scene detector')
            self.assertTrue(all(item['observedAt']==1000 for item in continued),'tracking cannot renew detector evidence')
            self.assertEqual(tracker.update(image,9001),[],'visual tracking cannot outlive bounded detector support')
        finally:tracker.close()


if __name__=='__main__':unittest.main()
