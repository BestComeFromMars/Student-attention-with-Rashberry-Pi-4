import io
import unittest
import torch
from torch import nn
from cavt import int8_structure


class CachedWeightsTests(unittest.TestCase):
    def test_int8_state_roundtrip_preserves_outputs_without_float_linear_weights(self):
        torch.set_num_threads(1)
        original=nn.Sequential(nn.Linear(4,8),nn.LayerNorm(8),nn.ReLU(),nn.Linear(8,1)).eval()
        expected=torch.ao.quantization.quantize_dynamic(original,{nn.Linear},dtype=torch.qint8)
        memory=io.BytesIO()
        torch.save(expected.state_dict(),memory)
        memory.seek(0)
        state=torch.load(memory,weights_only=True)
        with torch.device('meta'):
            restored=nn.Sequential(nn.Linear(4,8),nn.LayerNorm(8),nn.ReLU(),nn.Linear(8,1))
        int8_structure(restored)
        restored.to_empty(device='cpu')
        restored.load_state_dict(state,strict=True)
        restored.eval()
        self.assertFalse(any(isinstance(module,nn.Linear) for module in restored.modules()))
        sample=torch.tensor([[.1,.2,.3,.4]])
        with torch.inference_mode():
            torch.testing.assert_close(restored(sample),expected(sample),rtol=0,atol=0)


if __name__=='__main__':
    unittest.main()
