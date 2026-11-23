import unittest
from memory_budget import MemoryBudget, select_people, DEFAULT_CEILING


class MemoryBudgetTests(unittest.TestCase):
    def test_uncapped_by_default_and_only_reduces_under_critical_pressure(self):
        self.assertEqual(MemoryBudget(lambda: (8192, 2000)).limit, DEFAULT_CEILING)
        self.assertEqual(MemoryBudget(lambda: (16384, 1200)).limit, DEFAULT_CEILING)
        self.assertFalse(MemoryBudget(lambda: (16384, 1200)).pressure)
        low = MemoryBudget(lambda: (16384, 150))
        self.assertTrue(low.pressure)
        self.assertLess(low.limit, DEFAULT_CEILING)
        oom = MemoryBudget(lambda: (16384, 64))
        self.assertEqual(oom.limit, 1)

    def test_auto_reduces_on_critical_memory_and_recovers_when_freed(self):
        now = [0.]
        available = [3000.]
        budget = MemoryBudget(lambda: (8192, available[0]), lambda: now[0])
        self.assertEqual(budget.limit, DEFAULT_CEILING)
        now[0] = 2.
        available[0] = 150.
        self.assertEqual(budget.update(20), 10)
        now[0] = 4.
        available[0] = 64.
        self.assertEqual(budget.update(10), 1)
        available[0] = 2000.
        now[0] = 6.
        self.assertEqual(budget.update(1), 1)
        now[0] = 9.
        self.assertEqual(budget.update(1), 9)
        now[0] = 12.
        self.assertEqual(budget.update(9), 17)

    def test_warning_requires_exceeding_capacity_and_oom_reduce_halves_limit(self):
        budget = MemoryBudget(lambda: (8192, 5000))
        self.assertFalse(budget.status(25, 25)['limited'])
        self.assertTrue(budget.status(DEFAULT_CEILING + 1, DEFAULT_CEILING)['limited'])
        for _ in range(10):
            budget.reduce()
        self.assertEqual(budget.limit, 1)

    def test_selects_established_people_then_quality(self):
        values = [dict(id=1, confidence=.4), dict(id=2, confidence=.8), dict(id=3, confidence=.9)]
        self.assertEqual([v['id'] for v in select_people(values, 2, [1])], [1, 3])
        self.assertEqual(select_people(values, 3), values)


if __name__ == '__main__':
    unittest.main()
