"""Reserve capacity for video geometry on small CPU-only camera hosts."""
import psutil


def camera_cpu(geometry=False):
    try:
        process=psutil.Process()
        allowed=process.cpu_affinity()
        physical=psutil.cpu_count(logical=False) or len(allowed)
        # Windows exposes sibling logical CPUs consecutively. Leave one physical
        # core to the cheap frame loop; perception children inherit this budget.
        reserve=2 if len(allowed)>=2*physical else 1
        if physical>=4 and len(allowed)>=8:
            process.cpu_affinity(allowed[-reserve:] if geometry else allowed[:-reserve])
    except (AttributeError,psutil.Error,ValueError):
        pass
