import unittest
from memory_budget import MemoryBudget,select_people

class MemoryBudgetTests(unittest.TestCase):
    def test_eight_and_sixteen_gb_profiles_still_use_available_ram(self):
        self.assertEqual(MemoryBudget(lambda:(8192,5000)).limit,20)
        self.assertEqual(MemoryBudget(lambda:(16384,7000)).limit,40)
        self.assertEqual(MemoryBudget(lambda:(16384,1700)).limit,1)

    def test_admission_never_fully_stops_and_recovery_is_gradual(self):
        now=[0.];available=[5000.]
        budget=MemoryBudget(lambda:(8192,available[0]),lambda:now[0])
        self.assertEqual(budget.limit,20)
        now[0]=2.;available[0]=100
        self.assertEqual(budget.update(20),8) # keep the largest remaining safety budget
        now[0]=4.;self.assertEqual(budget.update(8),1)
        available[0]=5000;now[0]=6.;self.assertEqual(budget.update(1),1)
        now[0]=14.;self.assertEqual(budget.update(1),3)
        now[0]=16.;self.assertEqual(budget.update(3),3)
        now[0]=24.;self.assertEqual(budget.update(3),5)

    def test_warning_requires_exceeding_capacity_not_a_missing_face(self):
        budget=MemoryBudget(lambda:(8192,5000))
        self.assertFalse(budget.status(2,1)['limited'])
        self.assertTrue(budget.status(21,20)['limited'])
        for _ in range(8):budget.reduce()
        self.assertEqual(budget.limit,1)

    def test_selects_established_people_then_quality_and_releases_excess_templates(self):
        from person_tracking import PersonTracking
        values=[dict(id=1,confidence=.4),dict(id=2,confidence=.8),dict(id=3,confidence=.9)]
        self.assertEqual([v['id'] for v in select_people(values,2,[1])],[1,3])
        self.assertEqual(select_people(values,3),values)
        tracker=PersonTracking();tracker.tracks=values;tracker.visual.items={v['id']:object() for v in values}
        tracker.allowed={1,2,3};tracker.set_limit(1)
        self.assertEqual(len(tracker.tracks),1);self.assertEqual(list(tracker.visual.items),[1]);self.assertEqual(tracker.allowed,{1})
        tracker.close()

if __name__=='__main__':unittest.main()
