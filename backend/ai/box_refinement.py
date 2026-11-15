"""Causal detector correction in the coordinate system carried by optical flow.

Speed-dependent bandwidth follows the 1 Euro filter's principle (Casiez et al.,
CHI 2012, https://gery.casiez.net/1euro/). A critically damped second-order
response additionally preserves correction velocity across detector arrivals.
This is not a learned tracker or a prediction of the next camera frame: the
caller must first measure and carry both boxes through the current image.
"""
import math


def _center(box, axis, dim):
    return box[axis] + box[dim] / 2


def _spring(value, target, velocity, omega, dt):
    # Exact critically damped solution for a constant target over this step.
    offset = value - target
    impulse = velocity + omega * offset
    decay = math.exp(-omega * dt)
    return (target + (offset + impulse * dt) * decay,
            (velocity - omega * impulse * dt) * decay)


class OneEuro:
    """Adaptive first-order filter; inputs are accumulated measured log scale."""
    def __init__(self):
        self.raw = self.value = self.derivative = 0.

    def update(self, value, dt):
        if dt <= 0:
            return self.value
        rate = (value - self.raw) / dt
        alpha = 2 * math.pi * dt / (1 + 2 * math.pi * dt)
        self.derivative += alpha * (rate - self.derivative)
        cutoff = 1.5 + 2 * abs(self.derivative)
        alpha = 2 * math.pi * cutoff * dt / (1 + 2 * math.pi * cutoff * dt)
        self.value += alpha * (value - self.value)
        self.raw = value
        return self.value


class BoxRefinement:
    def __init__(self, kind, now):
        self.kind = kind
        self.seeded_at = now
        self.velocity = [0.] * 4  # center x/y, log width/height
        self.speed = [0.] * 4
        self.scale_filters = [OneEuro(), OneEuro()]

    def motion(self, before, measured, dt):
        # Optical-flow scale has its own noise; smoothing only detector targets
        # cannot remove it. Filter accumulated log scale, not absolute position:
        # current-image translation, starts, stops and reversals remain direct.
        result = dict(measured)
        for dim, axis, filtered in zip(('width', 'height'), ('x', 'y'), self.scale_filters):
            raw = filtered.raw + math.log(measured[dim] / before[dim])
            previous = filtered.value
            scale = math.exp(filtered.update(raw, dt) - previous)
            result[dim] = min(1., before[dim] * scale)
            result[axis] = max(0., min(1 - result[dim], _center(measured, axis, dim) - result[dim] / 2))
        return result

    def observe(self, before, target, now):
        dt = max(1 / 240, now - self.seeded_at)
        alpha = 2 * math.pi * dt / (1 + 2 * math.pi * dt)
        changes = [(_center(target, axis, dim) - _center(before, axis, dim)) /
                   max(before[dim], target[dim])
                   for axis, dim in (('x', 'width'), ('y', 'height'))]
        changes += [math.log(target[dim] / before[dim]) for dim in ('width', 'height')]
        for i, change in enumerate(changes):
            self.speed[i] += alpha * (change / dt - self.speed[i])
        self.seeded_at = now

    def carry(self, before, after):
        self.velocity[0] *= after['width'] / before['width']
        self.velocity[1] *= after['height'] / before['height']

    def update(self, box, target, dt):
        if dt <= 0:
            return dict(box)
        body = self.kind == 'person'
        centers = []
        dims = []
        for i, (axis, dim) in enumerate((('x', 'width'), ('y', 'height'))):
            value = _center(box, axis, dim)
            error = _center(target, axis, dim) - value
            # Soft dead zone: the correction tends continuously to zero.
            noise = box[dim] * (.012 if body else .006)
            desired = value + math.copysign(max(0., abs(error) - noise), error)
            cutoff = min(4., (1.5 if body else 2.) + 1.5 * abs(self.speed[i]))
            center, velocity = _spring(value, desired, self.velocity[i], 2 * math.pi * cutoff, dt)
            limit = max(box[dim], target[dim]) * (1. if body else 2.)
            step = max(-limit * dt, min(limit * dt, center - value))
            self.velocity[i] = max(-limit, min(limit, velocity))
            centers.append(value + step)

            j = i + 2
            value = math.log(box[dim])
            error = math.log(target[dim]) - value
            desired = value + math.copysign(max(0., abs(error) - (.02 if body else .01)), error)
            cutoff = min(3.5, (1.1 if body else 1.7) + 1.5 * abs(self.speed[j]))
            size, velocity = _spring(value, desired, self.velocity[j], 2 * math.pi * cutoff, dt)
            limit = (.75 if error > 0 else .6) if body else 1.2
            step = max(-limit * dt, min(limit * dt, size - value))
            self.velocity[j] = max(-limit, min(limit, velocity))
            dims.append(min(1., math.exp(value + step)))
        width, height = dims
        return dict(x=max(0., min(1 - width, centers[0] - width / 2)),
                    y=max(0., min(1 - height, centers[1] - height / 2)),
                    width=width, height=height)
