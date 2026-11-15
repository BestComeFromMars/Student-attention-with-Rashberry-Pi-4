import math
import unittest
from types import SimpleNamespace
import numpy as np
from mouth_geometry import measure_mouth


class MouthGeometryTests(unittest.TestCase):
    def points(self, yaw=0, roll=0, scale=1):
        points = [SimpleNamespace(x=.5, y=.5, z=0) for _ in range(478)]
        yaw, roll = math.radians(yaw), math.radians(roll)
        rotate_y = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
        rotate_z = np.array([[math.cos(roll), -math.sin(roll), 0], [math.sin(roll), math.cos(roll), 0], [0, 0, 1]])
        for index, position in [(61, [-40, 0, 0]), (291, [40, 0, 0]), (13, [0, -6, 0]), (14, [0, 6, 0])]:
            x, y, z = rotate_z @ rotate_y @ (np.array(position)*scale)
            # Non-square crop: x and z use width, y uses height.
            points[index] = SimpleNamespace(x=.5+x/300, y=.5+y/150, z=z/300)
        return points

    def test_3d_ratio_is_stable_when_a_side_view_compresses_projected_width(self):
        for yaw in [0, 30, 60, 75]:
            value = measure_mouth(self.points(yaw), 300, 150)
            self.assertAlmostEqual(value['mouthOpenRatio'], .15, places=5)
        self.assertGreater(measure_mouth(self.points(75), 300, 150)['mouthOpenRatio2d'], .55)

    def test_ratio_does_not_change_with_scale_or_roll(self):
        for scale in [.5, 1, 2]:
            value = measure_mouth(self.points(yaw=60, roll=35, scale=scale), 300, 150)
            self.assertAlmostEqual(value['mouthOpenRatio'], .15, places=5)

    def test_old_landmarks_without_depth_can_still_supply_a_2d_ratio(self):
        points = self.points()
        for point in points:
            del point.z
        value = measure_mouth(points, 300, 150)
        self.assertAlmostEqual(value['mouthOpenRatio'], .15, places=5)

    def test_degenerate_or_nonfinite_lips_do_not_create_a_mouth_signal(self):
        points = self.points()
        points[291] = points[61]
        self.assertIsNone(measure_mouth(points, 300, 150)['mouthOpenRatio'])
        points = self.points()
        points[13].x = float('nan')
        self.assertIsNone(measure_mouth(points, 300, 150)['mouthOpenRatio'])


if __name__ == '__main__':
    unittest.main()
