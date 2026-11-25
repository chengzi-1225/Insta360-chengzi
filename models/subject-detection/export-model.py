"""Export the official subject model using the companion model-manifest.json.

Requires ultralytics==8.4.218, torch==2.15.0 and onnx==1.23.2.
The original weights are downloaded from Ultralytics and checked before use.
"""
from pathlib import Path
import hashlib
import json
import urllib.request
from ultralytics import YOLO

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'model-manifest.json').read_text())
weights = root / 'yolo11s-seg.pt'
if not weights.exists():
    urllib.request.urlretrieve(manifest['sourceWeights'], weights)
if hashlib.sha256(weights.read_bytes()).hexdigest() != manifest['sourceWeightsSha256']:
    raise RuntimeError('Source weight SHA256 does not match the manifest')
exported = Path(YOLO(str(weights)).export(**manifest['exportArguments']))
print('Exported:', exported)
print('SHA256:', hashlib.sha256(exported.read_bytes()).hexdigest())
print('Published SHA256:', manifest['sha256'])
