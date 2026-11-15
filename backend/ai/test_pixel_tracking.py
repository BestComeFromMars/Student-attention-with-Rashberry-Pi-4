import unittest
from unittest.mock import patch
import cv2
import numpy as np
from pixel_tracking import PixelTracking, transform
from box_refinement import BoxRefinement


class PixelTrackingTests(unittest.TestCase):
    def setUp(self):
        rng=np.random.default_rng(23)
        self.texture=rng.integers(0,255,(90,70,3),dtype=np.uint8)
        self.box=dict(x=50/320,y=50/240,width=70/320,height=90/240)

    def image(self,i):
        frame=np.full((240,320,3),45,dtype=np.uint8)
        frame[50:140,50+i*2:120+i*2]=self.texture
        return frame

    def test_late_detection_is_projected_to_current_pixels(self):
        tracker=PixelTracking()
        for i in range(40):tracker.update(self.image(i),i)
        tracker.seed([dict(key='person:A',frameId=0,box=self.box)])
        boxes=tracker.update(self.image(40),40)
        self.assertEqual(len(boxes),1)
        self.assertAlmostEqual(boxes[0]['box']['x']*320,130,delta=1.3)
        # Subsequent frames follow current pixels, with no semantic response.
        for i in range(41,65):
            boxes=tracker.update(self.image(i),i)
            self.assertAlmostEqual(boxes[0]['box']['x']*320,50+i*2,delta=1.5)

    def test_three_independent_geometry_layers(self):
        tracker=PixelTracking();tracker.update(self.image(0),0)
        tracker.seed([dict(key=kind+':A',frameId=0,box=self.box) for kind in ['person','face','object']])
        boxes=tracker.update(self.image(1),1)
        self.assertEqual({b['key'] for b in boxes},{'person:A','face:A','object:A'})
        for b in boxes:self.assertAlmostEqual(b['box']['x']*320,52,delta=1)

    def test_new_detector_result_cannot_teleport_any_display_layer(self):
        now=[0.]
        tracker=PixelTracking(clock=lambda:now[0]);tracker.update(self.image(0),0)
        for kind in ('person','face','object'):
            tracker.seed([dict(key=kind+':A',frameId=0,box=self.box)])
        now[0]=1/30;tracker.update(self.image(0),1)
        before={key:dict(value['box']) for key,value in tracker.boxes.items()}
        changed=dict(self.box,x=self.box['x']+.03,width=self.box['width']*.8)
        tracker.seed([dict(key=kind+':A',frameId=1,box=changed) for kind in ('person','face','object')])
        self.assertEqual({key:value['box'] for key,value in tracker.boxes.items()},before)

    def test_unknown_or_future_image_cannot_create_current_box(self):
        tracker=PixelTracking();tracker.update(self.image(0),10)
        tracker.seed([dict(key='face:A',frameId=i,box=self.box) for i in [9,11]])
        self.assertEqual(tracker.update(self.image(1),11),[])

    def test_out_of_order_frames_rejected(self):
        tracker=PixelTracking();tracker.update(self.image(0),10)
        with self.assertRaises(ValueError):tracker.update(self.image(0),9)

    def test_no_indefinite_ghost_after_evidence_expires(self):
        tracker=PixelTracking();tracker.update(self.image(0),0)
        with patch('pixel_tracking.time.monotonic',return_value=100):
            tracker.seed([dict(key='face:A',frameId=0,box=self.box)])
        with patch('pixel_tracking.time.monotonic',return_value=104):
            self.assertEqual(tracker.update(self.image(1),1),[])

    def test_body_reseed_cannot_snap_size_or_position(self):
        now=[0.]
        tracker=PixelTracking(clock=lambda:now[0]);tracker.update(self.image(0),0)
        tracker.seed([dict(key='person:A',frameId=0,box=self.box)])
        now[0]=1/30;tracker.update(self.image(1),1)
        before=dict(tracker.boxes['person:A']['box'])
        # A detector sees the arms folded in. The body's center has not moved.
        target=dict(before,width=before['width']*.65)
        target['x']=before['x']+(before['width']-target['width'])/2
        tracker.seed([dict(key='person:A',frameId=1,box=target)])
        self.assertEqual(tracker.boxes['person:A']['box'],before)
        previous=before
        for index in range(2,42):
            now[0]=index/30
            box=tracker.update(self.image(index),index)[0]['box']
            self.assertGreaterEqual(box['width']/previous['width'],.978)
            # Shape damping must never damp actual current-frame translation.
            self.assertAlmostEqual((box['x']+box['width']/2-previous['x']-previous['width']/2)*320,2,delta=.3)
            previous=dict(box)
        self.assertAlmostEqual(previous['width'],target['width'],delta=target['width']*.04)

    def test_capture_intervals_keep_shape_identical_when_cpu_delivery_is_bursty(self):
        outputs=[]
        for bursty in (False,True):
            now=[0.]
            tracker=PixelTracking(clock=lambda:now[0])
            tracker.update(self.image(0),0,captured_at=0.)
            tracker.seed([dict(key='person:A',frameId=0,box=self.box)])
            now[0]=1/30
            tracker.update(self.image(0),1,captured_at=1/30)
            target=dict(self.box,width=self.box['width']*.65)
            target['x']+=(self.box['width']-target['width'])/2
            tracker.seed([dict(key='person:A',frameId=1,box=target)])
            values=[]
            for i in range(2,50):
                now[0]=(i//4*4+3+.1*(i%4))/30 if bursty else i/30
                values.append(tracker.update(self.image(0),i,captured_at=i/30)[0]['box']['width'])
            outputs.append(values)
        np.testing.assert_allclose(outputs[0],outputs[1],rtol=0,atol=1e-12)

    def test_capture_timestamp_does_not_extend_server_evidence_expiry(self):
        now=[0.]
        tracker=PixelTracking(clock=lambda:now[0])
        tracker.update(self.image(0),0,captured_at=100.)
        tracker.seed([dict(key='face:A',frameId=0,box=self.box)])
        now[0]=3.1
        self.assertEqual(tracker.update(self.image(0),1,captured_at=100.01),[])

    def test_invalid_capture_time_cannot_change_tracker_state(self):
        tracker=PixelTracking();tracker.update(self.image(0),0,captured_at=1.)
        for captured_at in (float('inf'),float('nan'),-1.,.9):
            with self.assertRaises(ValueError):tracker.update(self.image(0),1,captured_at=captured_at)
            self.assertEqual(tracker.frame_id,0)

    def test_small_alternating_detector_noise_does_not_make_body_breathe(self):
        now=[0.]
        tracker=PixelTracking(clock=lambda:now[0]);tracker.update(self.image(0),0)
        tracker.seed([dict(key='person:A',frameId=0,box=self.box)])
        for index in range(1,50):
            now[0]=index/30;tracker.update(self.image(0),index)
            noise=1.012 if index%2 else .988
            measured=dict(self.box,width=self.box['width']*noise,height=self.box['height']*noise)
            measured['x']+= (self.box['width']-measured['width'])/2
            measured['y']+= (self.box['height']-measured['height'])/2
            tracker.seed([dict(key='person:A',frameId=index,box=measured)])
            self.assertAlmostEqual(tracker.boxes['person:A']['box']['width'],self.box['width'],delta=.0001)
            self.assertAlmostEqual(tracker.boxes['person:A']['box']['height'],self.box['height'],delta=.0001)

    def test_shape_adaptation_is_time_based_at_different_camera_rates(self):
        target=dict(x=.25,y=.25,width=.2,height=.3)
        widths=[]
        for fps in (15,30,60):
            box=dict(x=.2,y=.2,width=.3,height=.4)
            refinement=BoxRefinement('person',0.)
            for _ in range(fps):
                box=refinement.update(box,target,1/fps)
            widths.append(box['width'])
        self.assertLess(max(widths)-min(widths),.002)
        self.assertLess(max(widths),target['width']*1.04)

    def test_distance_scale_follows_current_pixels_without_new_ai(self):
        now=[0.]
        tracker=PixelTracking(clock=lambda:now[0]);tracker.update(self.image(0),0)
        tracker.seed([dict(key='person:A',frameId=0,box=self.box)])
        for index in range(1,41):
            now[0]=index/30
            # Approach, then retreat, with no new detector output.
            scale=1.007**(index if index<=20 else 40-index)
            matrix=cv2.getRotationMatrix2D((85,95),0,scale)
            image=cv2.warpAffine(self.image(0),matrix,(320,240),borderValue=(45,45,45))
            box=tracker.update(image,index)[0]['box']
            self.assertAlmostEqual(box['width']/self.box['width'],scale,delta=.065)
            self.assertAlmostEqual((box['x']+box['width']/2)*320,85,delta=1.5)
            self.assertAlmostEqual((box['y']+box['height']/2)*240,95,delta=1.5)

    def test_moving_arms_do_not_set_torso_motion(self):
        box=dict(x=.1,y=.1,width=.6,height=.8)
        core=np.array([(x,y) for x in (36,44,52,60) for y in (25,38,50,60)],np.float32)
        arms=np.array([(x,y) for x in (18,22,76,80) for y in (20,30,40,50,60)],np.float32)
        before=np.concatenate([core,arms]);after=before+np.array([2.,1.],np.float32)
        after[len(core):]+=np.array([-1.7,1.8],np.float32)
        moved=transform(box,before,after,(100,100),affine=False,body=True)
        self.assertAlmostEqual(moved['width'],box['width'],places=5)
        self.assertAlmostEqual(moved['height'],box['height'],places=5)
        self.assertAlmostEqual(moved['x']-box['x'],.02,places=5)
        self.assertAlmostEqual(moved['y']-box['y'],.01,places=5)


if __name__=='__main__':unittest.main()
