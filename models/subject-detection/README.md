# Subject detection model

`yolo11s-seg-v1.onnx` is converted from the official Ultralytics YOLO11s-seg weights. It is used by LabelStudio-auto-compose.user.js 2.8.0 to detect subjects and inspect visible head, hand, and foot boundaries locally in the browser.

- Official weights: https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s-seg.pt
- Source: https://github.com/ultralytics/ultralytics
- License: AGPL-3.0; see LICENSE-AGPL-3.0.txt.
- Export settings and source/output SHA256: model-manifest.json.
- Runtime: onnxruntime-web 1.22.0 (MIT), downloaded from the npm CDN by the userscript.

The model accepts a 640 x 640 RGB tensor with aspect-preserving padding. Detection and instance mask tensors remain inside the browser. The userscript does not send image pixels to a detection service or submit annotations.

To export from the official weights using the listed environment:

```python
from ultralytics import YOLO
YOLO('yolo11s-seg.pt').export(format='onnx', imgsz=640, opset=12,
    simplify=False, dynamic=False, half=False, nms=False, batch=1, device='cpu')
```

No claim of perfect detection: tiny, hidden or unusual subjects can need manual correction. The script retains manual annotations and supplies an undo action for new subjects.

The userscript retains detection bounds and expands only using the connected instance outline and a matched local recheck. For people, a strong mask component seeds bounded lower-confidence edge growth; disconnected weak noise and excessively broad growth are ignored. No unseen body parts are synthesized.

The ONNX file is about 40.6 MB. It is downloaded on demand, checked against the manifest, and reused within the current page. Runtime initialization and model downloads have timeouts and can be retried.

The corresponding export recipe is provided in `export-model.py`; the original weights are available at the official source URL above, and their SHA256 is recorded in the manifest. Export environment: Python 3.11.15, Ultralytics 8.4.218, PyTorch 2.15.0, ONNX 1.23.2 on Apple M4 CPU.
