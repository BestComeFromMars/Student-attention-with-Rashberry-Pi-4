import unittest
from types import SimpleNamespace
import numpy as np
from object_scene import SceneObjects


class Model:
    def __init__(self,rows):self.rows=rows
    def predict(self,*args,**kwargs):
        value=np.asarray(self.rows,dtype=np.float32).reshape(-1,6)
        return [SimpleNamespace(boxes=SimpleNamespace(data=SimpleNamespace(cpu=lambda:SimpleNamespace(numpy=lambda:value))))]


class SceneObjectTests(unittest.TestCase):
    def test_busy_classroom_does_not_start_an_unbounded_heavy_verifier_chain(self):
        class Counted(Model):
            calls=0
            def predict(self,*args,**kwargs):
                self.calls+=1;return super().predict(*args,**kwargs)
        model=Counted([[20,20,80,80,.5,63]])
        SceneObjects(model).predict(np.zeros((600,800,3),np.uint8))
        self.assertEqual(model.calls,2,'one full scene and one bounded crop per update')
    def test_moderate_paper_laptop_score_is_not_a_confirmed_laptop(self):
        scene=SceneObjects(Model([[20,20,80,80,.5,63]]))
        self.assertEqual(len(scene.predict(np.zeros((120,120,3),np.uint8))),0)

    def test_corroborated_laptop_and_separate_phone_on_book_remain(self):
        rows=[[10,10,60,60,.8,63],[70,10,110,70,.8,73],[75,25,95,50,.8,67]]
        scene=SceneObjects(Model(rows))
        output=scene.predict(np.zeros((120,120,3),np.uint8))
        self.assertEqual(set(output[:,5]),{63,67,73})

    def test_competing_book_measurement_does_not_become_a_second_laptop_box(self):
        scene=SceneObjects(Model([[20,20,80,80,.5,63],[21,21,79,79,.8,73]]))
        output=scene.predict(np.zeros((120,120,3),np.uint8))
        self.assertEqual(len(output),1);self.assertEqual(output[0,5],73)

    def test_crop_coordinates_return_to_the_original_frame(self):
        class Cropped(Model):
            def predict(self,image,**kwargs):
                self.rows=[] if image.shape[0]==400 else [[20,30,60,80,.9,67]]
                return super().predict(image,**kwargs)
        scene=SceneObjects(Cropped([]));output=scene.predict(np.zeros((400,600,3),np.uint8),3)
        np.testing.assert_allclose(output[0,:4],[260,190,300,240]);self.assertEqual(output[0,5],67)

if __name__=='__main__':unittest.main()
