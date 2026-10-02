"""Build-time download only. The packaged app never downloads models."""
from pathlib import Path
import hashlib, json, urllib.request
import rapidocr, yaml

root = Path(__file__).resolve().parent
dest = root / 'models'
dest.mkdir(exist_ok=True)
catalog = yaml.safe_load((Path(rapidocr.__file__).parent / 'default_models.yaml').read_text(encoding='utf-8'))
names = {'det':'ch_PP-OCRv5_det_mobile', 'rec':'ch_PP-OCRv5_rec_mobile', 'cls':'ch_PP-LCNet_x0_25_textline_ori_cls_mobile'}
manifest = {}
for task, name in names.items():
    item = catalog['onnxruntime']['PP-OCRv5'][task][name]
    target = dest / (name + '.onnx')
    expected = item['SHA256']
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        request = urllib.request.Request(item['model_dir'], headers={'User-Agent':'PortableTextOCR-Build/1.0'})
        with urllib.request.urlopen(request, timeout=120) as response, target.with_suffix('.part').open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
        assert hashlib.sha256(target.with_suffix('.part').read_bytes()).hexdigest() == expected, name
        target.with_suffix('.part').replace(target)
    manifest[task] = {'file':target.name, 'sha256':expected, 'source':item['model_dir'], 'bytes':target.stat().st_size}
    print(name, target.stat().st_size, flush=True)
(dest / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
