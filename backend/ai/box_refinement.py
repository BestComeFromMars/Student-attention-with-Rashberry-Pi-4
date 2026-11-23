"""Direct, zero-overshoot causal detector correction on top of optical flow.

Uses adaptive first-order convergence (no second-order spring inertia/overshoot)
with a small dead zone to suppress 1-2 px detector jitter while keeping boxes
tightly locked to moving people and faces.
"""
import math


def _center(box, axis, dim):
    return box[axis] + box[dim] / 2


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
        self.scale_filters = [OneEuro(), OneEuro()]

    def motion(self, before, measured, dt):
        # Filter optical-flow scale noise while preserving direct translation.
        result = dict(measured)
        for dim, axis, filtered in zip(('width', 'height'), ('x', 'y'), self.scale_filters):
            raw = filtered.raw + math.log(measured[dim] / before[dim])
            previous = filtered.value
            scale = math.exp(filtered.update(raw, dt) - previous)
            result[dim] = min(1., before[dim] * scale)
            result[axis] = max(0., min(1 - result[dim], _center(measured, axis, dim) - result[dim] / 2))
        return result

    def observe(self, before, target, now):
        self.seeded_at = now

    def carry(self, before, after):
        pass

    def update(self, box, target, dt):
        if dt <= 0:
            return dict(box)
        body = self.kind == 'person'
        pos_tau = .035 if body else .025
        size_tau = .090 if body else .060
        pos_alpha = 1. - math.exp(-dt / pos_tau)
        size_alpha = 1. - math.exp(-dt / size_tau)

        centers = []
        dims = []
        for axis, dim in (('x', 'width'), ('y', 'height')):
            value = _center(box, axis, dim)
            target_c = _center(target, axis, dim)
            error = target_c - value
            noise = box[dim] * (.010 if body else .005)
            if abs(error) <= noise:
                centers.append(value)
            elif abs(error) >= box[dim] * .25:
                # Large real displacement: catch up immediately without lag.
                centers.append(target_c)
            else:
                desired = value + math.copysign(abs(error) - noise, error)
                centers.append(value + (desired - value) * pos_alpha)

            log_val = math.log(box[dim])
            log_err = math.log(target[dim]) - log_val
            size_noise = .018 if body else .010
            if abs(log_err) <= size_noise:
                dims.append(box[dim])
            else:
                desired_log = log_val + math.copysign(abs(log_err) - size_noise, log_err)
                delta_log = (desired_log - log_val) * size_alpha
                max_step = (1.8 if body else 2.8) * dt
                delta_log = max(-max_step, min(max_step, delta_log))
                dims.append(min(1., math.exp(log_val + delta_log)))

        width, height = dims
        return dict(x=max(0., min(1 - width, centers[0] - width / 2)),
                    y=max(0., min(1 - height, centers[1] - height / 2)),
                    width=width, height=height)
