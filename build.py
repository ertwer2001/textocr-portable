"""Build the Windows x64 folder and zip from this isolated Python environment."""
from pathlib import Path
import importlib.metadata as metadata
import hashlib, json, shutil, subprocess, sys, urllib.request
import rapidocr, tkinterdnd2

root = Path(__file__).resolve().parent
subprocess.run([sys.executable, '-m', 'pip', 'freeze'], stdout=(root/'requirements-lock.txt').open('w', encoding='utf-8'), check=True)
licenses = root/'licenses'
licenses.mkdir(exist_ok=True)
for file in licenses.rglob('*'):
    if file.is_file() and file.suffix.lower() in ('.py', '.pyc'):
        file.unlink()
for dist in metadata.distributions():
    name = dist.metadata['Name']
    for file in dist.files or []:
        if file.suffix.lower() not in ('.py', '.pyc', '.pyd', '.dll') and (any(part.lower() in ('licenses', 'license') for part in file.parts) or any(word in file.name.lower() for word in ('license', 'notice', 'copying', 'copyright'))):
            source = Path(dist.locate_file(file))
            if source.is_file():
                target = licenses/name/str(file).replace('..', '_')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
for source in (Path(sys.base_prefix)/'LICENSE.txt', Path(sys.base_prefix)/'LICENSE'):
    if source.exists(): shutil.copy2(source, licenses/'Python-LICENSE.txt')
for source in (Path(sys.base_prefix)/'tcl').rglob('license.terms'):
    target = licenses/'Tcl-Tk'/source.relative_to(Path(sys.base_prefix)/'tcl')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
extra = {
    'PaddleOCR-models-APACHE-2.0.txt': 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/LICENSE',
    'RapidOCR-APACHE-2.0.txt': 'https://raw.githubusercontent.com/RapidAI/RapidOCR/main/LICENSE',
    'ANTLR-4.9.3-BSD.txt': 'https://raw.githubusercontent.com/antlr/antlr4/4.9.3/LICENSE.txt',
    'TkDND-license.terms': 'https://raw.githubusercontent.com/petasis/tkdnd/master/license.terms',
    'GEOS-3.13.1-source.tar.bz2': 'https://download.osgeo.org/geos/geos-3.13.1.tar.bz2',
}
for name, url in extra.items():
    target = licenses/name
    if not target.exists(): urllib.request.urlretrieve(url, target)
rapid = Path(rapidocr.__file__).parent
tkdnd = Path(tkinterdnd2.__file__).parent/'tkdnd'/'win-x64'
args = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--windowed', '--name', 'TextOCR', '--noupx', '--distpath', str(root/'dist_final'), '--workpath', str(root/'build_final'),
        '--add-data', f'{root/"models"};models', '--add-data', f'{root/"examples"};examples',
        '--add-data', f'{rapid/"config.yaml"};rapidocr', '--add-data', f'{rapid/"default_models.yaml"};rapidocr',
        '--add-data', f'{tkdnd};tkinterdnd2/tkdnd/win-x64',
        '--hidden-import', 'rapidocr.main', '--hidden-import', 'rapidocr.inference_engine.onnxruntime',
        '--collect-binaries', 'onnxruntime', str(root/'app.py')]
subprocess.run(args, cwd=root, check=True)
bundle = root/'dist_final'/'TextOCR'
shutil.copy2(root/'使用說明.txt', bundle/'使用說明.txt')
shutil.copy2(root/'操作手冊.html', bundle/'操作手冊.html')
shutil.copy2(root/'LICENSE.txt', bundle/'LICENSE.txt')
shutil.copytree(licenses, bundle/'licenses', dirs_exist_ok=True)
source = bundle/'source'
source.mkdir(exist_ok=True)
for name in ('app.py', 'engine.py', 'word_export.py', 'excel_export.py', 'ppt_analysis.py', 'ppt_export.py', 'selftest.py', 'build.py', 'prepare_models.py', 'make_examples.py', 'requirements-lock.txt', 'LICENSE.txt'):
    shutil.copy2(root/name, source/name)
shutil.copytree(root/'models', source/'models', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.onnx'))
# Rebuild source reuses the already bundled models/examples to avoid duplicate weights.
(source/'重建說明.txt').write_text('開發重建：Windows x64 + Python 3.12；建立虛擬環境並安裝 requirements-lock.txt。\n將 ../_internal/models 與 ../_internal/examples 複製到此 source 資料夾。\n將 ../使用說明.txt、../操作手冊.html、../licenses 複製到此資料夾，再執行 python build.py。\n下載缺少的模型時，可執行 python prepare_models.py（此開發步驟需要網路）。\nApp 本身執行不需要 Python 或網路。\n', encoding='utf-8-sig')
checksums = {str(p.relative_to(bundle)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.rglob('*') if p.is_file()}
(bundle/'SHA256.json').write_text(json.dumps(checksums, ensure_ascii=False, indent=2), encoding='utf-8')
print('BUILT', bundle, flush=True)
