"""Local image/PDF text extraction; no network or Codex dependencies."""
from pathlib import Path
from dataclasses import dataclass
from contextlib import closing
import hashlib, json, os, sys
from PIL import Image, ImageOps, ImageSequence
import pypdfium2 as pdfium

EXTENSIONS = {'.pdf','.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff'}

class Cancelled(Exception):
    pass

@dataclass
class PageText:
    page: int
    text: str
    method: str
    layout: object = None

def resources():
    return Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))

class TextEngine:
    def __init__(self, model_dir=None):
        self.model_dir = Path(model_dir) if model_dir else resources() / 'models'
        self.ocr = None

    def load(self):
        if self.ocr is not None:
            return
        manifest = json.loads((self.model_dir/'manifest.json').read_text(encoding='utf-8'))
        for item in manifest.values():
            file = self.model_dir/item['file']
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:
                raise ValueError('辨識模型不完整，請重新解壓整個 App 資料夾。')
        from rapidocr import RapidOCR, OCRVersion, ModelType
        params = {
            'Global.log_level':'error',
            'Global.max_side_len':3000,
            'Det.ocr_version':OCRVersion.PPOCRV5,'Det.model_type':ModelType.MOBILE,
            'Rec.ocr_version':OCRVersion.PPOCRV5,'Rec.model_type':ModelType.MOBILE,
            'Cls.ocr_version':OCRVersion.PPOCRV5,'Cls.model_type':ModelType.MOBILE,
            'EngineConfig.onnxruntime.intra_op_num_threads':min(4,os.cpu_count() or 1),
            'EngineConfig.onnxruntime.inter_op_num_threads':1,
            # RapidOCR 3.9 defaults to v6; v5 requires its own normalization.
            'Det.limit_type':'max', 'Det.limit_side_len':960,
            'Det.mean':[0.485,0.456,0.406], 'Det.std':[0.229,0.224,0.225],
        }
        for task, title in [('det','Det'),('rec','Rec'),('cls','Cls')]:
            params[title+'.model_path']=str(self.model_dir/manifest[task]['file'])
        self.ocr = RapidOCR(params=params)

    def recognize(self, image):
        self.load()
        image = ImageOps.exif_transpose(image)
        if image.mode in ('RGBA','LA') or 'transparency' in image.info:
            rgba=image.convert('RGBA')
            background=Image.new('RGBA',rgba.size,'white')
            image=Image.alpha_composite(background,rgba).convert('RGB')
        else:
            image=image.convert('RGB')
        result=self.ocr(image)
        return '\n'.join(result.txts or ()), result

    def image_text(self, image):
        return self.recognize(image)[0]

    def extract(self, source, force_ocr=False, cancelled=None, progress=None, cache_dir=None):
        from word_export import scan_layout, pdf_layout
        def check():
            if cancelled and cancelled.is_set():
                raise Cancelled()
        if isinstance(source,Image.Image):
            check()
            if progress: progress(1,1)
            text, result = self.recognize(source)
            layout = scan_layout(source, result, cache_dir) if cache_dir else None
            yield PageText(1,text,'圖片辨識',layout)
            return
        path=Path(source)
        if not path.is_file():
            raise ValueError('找不到檔案，請確認檔案沒有被移動。')
        if path.suffix.lower() not in EXTENSIONS:
            raise ValueError('請加入 PDF、PNG、JPG、WEBP、BMP 或 TIFF 檔案。')
        if path.suffix.lower()=='.pdf':
            try:
                document=pdfium.PdfDocument(str(path))
            except Exception as exc:
                raise ValueError('無法開啟 PDF；請確認檔案完整且已解除密碼保護。') from exc
            with closing(document):
                for index in range(len(document)):
                    check()
                    if progress: progress(index+1,len(document))
                    with closing(document[index]) as page:
                        text=''
                        if not force_ocr:
                            with closing(page.get_textpage()) as textpage:
                                text=textpage.get_text_bounded().strip()
                        if text and (text.count('\ufffd')+text.count('\x00'))/len(text)<0.02:
                            layout = pdf_layout(page, cache_dir, self) if cache_dir else None
                            yield PageText(index+1,text,'PDF原有文字',layout)
                        else:
                            width,height=page.get_size()
                            scale=min(2.5,3000/max(width,height))
                            bitmap=page.render(scale=scale)
                            try:
                                image=bitmap.to_pil().copy()
                            finally:
                                bitmap.close()
                            try:
                                check()
                                text, result = self.recognize(image)
                                layout = scan_layout(image, result, cache_dir, (width,height)) if cache_dir else None
                                yield PageText(index+1,text,'掃描頁辨識',layout)
                            finally:
                                image.close()
        else:
            with Image.open(path) as image:
                for index,frame in enumerate(ImageSequence.Iterator(image)):
                    check()
                    if progress: progress(index+1,getattr(image,'n_frames',1))
                    with frame.copy() as copy:
                        text, result = self.recognize(copy)
                        layout = scan_layout(copy, result, cache_dir) if cache_dir else None
                        yield PageText(index+1,text,'圖片辨識',layout)
