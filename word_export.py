"""Local DOCX export with positioned editable text and the original graphics.

Scan layout is approximate: fonts are estimated and table borders remain images.
The original-page mode keeps the complete image instead of replacing any text.
"""
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
import ctypes, math, os, re, tempfile, uuid, zipfile
from functools import lru_cache
from PIL import Image, ImageOps, ImageFont

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

@dataclass
class Line:
    text: str
    box: tuple  # x, y, width, height, in points from page top-left
    size: float
    font: str = 'Microsoft JhengHei'
    color: str = '000000'
    bold: bool = False

@dataclass
class LayoutPage:
    width: float
    height: float
    original: Path
    background: Path
    lines: list

def clean(text):
    return escape(re.sub('[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]', '', str(text)))

def rgb_image(image):
    image = ImageOps.exif_transpose(image)
    if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
        rgba = image.convert('RGBA')
        result = Image.new('RGBA', rgba.size, 'white')
        result.alpha_composite(rgba)
        return result.convert('RGB')
    return image.convert('RGB')

def page_size(image):
    width = 595.28 if image.height >= image.width else 841.89
    height = width * image.height / image.width
    ratio = min(1, 1584 / height)  # Word page dimensions have a 22-inch ceiling.
    return width * ratio, height * ratio

def bounded_size(size):
    ratio = min(1, 1584 / max(size))
    return size[0]*ratio, size[1]*ratio

@lru_cache(maxsize=1)
def font_meter():
    path = Path(os.environ.get('SystemRoot', 'C:/Windows'))/'Fonts'/'msjh.ttc'
    return ImageFont.truetype(str(path), 100) if path.is_file() else None

def cache_images(original, background, folder, size, lines):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex
    first, second = folder/f'{name}.png', folder/f'{name}-graphics.png'
    original.save(first)
    background.save(second)
    return LayoutPage(*size, first, second, lines)

def scan_layout(image, result, folder, size=None):
    import cv2
    import numpy as np
    image = rgb_image(image)
    size = bounded_size(size or page_size(image))
    sx, sy = size[0]/image.width, size[1]/image.height
    pixels = np.array(image)
    gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    ink = (gray < 185).astype('uint8') * 255
    # Keep long rules, including the grid of forms and tables.
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(80, image.width//20)), np.uint8))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(80, image.height//20), 1), np.uint8))
    solid = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    horizontal[solid > 0] = vertical[solid > 0] = 0
    rules = cv2.dilate(horizontal | vertical, np.ones((3, 3), np.uint8))
    erase = np.zeros(gray.shape, np.uint8)
    lines = []
    for quad, text in zip(result.boxes if result.boxes is not None else [], result.txts or ()):
        quad = np.asarray(quad)
        angle = abs(math.degrees(math.atan2(quad[1,1]-quad[0,1], quad[1,0]-quad[0,0])))
        if angle > 10: continue  # Preserve rotated stamps/graphics as part of the image.
        left, top = np.maximum(quad.min(axis=0).astype(int), 0)
        right, bottom = np.minimum(np.ceil(quad.max(axis=0)).astype(int), (image.width, image.height))
        if right <= left or bottom <= top: continue
        region = pixels[top:bottom, left:right]
        cropgray = gray[top:bottom, left:right]
        # Color contrast also detects white lettering on dark table headers.
        background = np.median(region.reshape(-1, 3), axis=0)
        contrast = np.max(np.abs(region.astype(float)-background), axis=2)
        local = (contrast > 45).astype('uint8')*255
        local[rules[top:bottom,left:right] > 0] = 0
        colors = region[local > 0]
        if not len(colors): continue
        strength = contrast[local > 0]
        colors = colors[strength >= np.percentile(strength, 80)]
        median = np.median(colors, axis=0)
        if max(median)-min(median) < 25: median[:] = 255 if median.mean() > 200 else 0
        color = ''.join(f'{int(c):02X}' for c in median)
        erase[top:bottom,left:right] |= local
        gy, gx = np.where(local > 0)
        x, y = (left+gx.min())*sx, (top+gy.min())*sy
        width, height = (gx.max()-gx.min()+1)*sx, (gy.max()-gy.min()+1)*sy
        meter = font_meter()
        if meter:
            _, mt, _, mb = meter.getbbox(text)
            fontsize = min(width/max(meter.getlength(text),1)*100, height/max(mb-mt,1)*100)
        else:
            fontsize = min(height*1.1, width/max(sum(1 if ord(c)>255 else .55 for c in text),1))
        fontsize = max(4, min(120, fontsize))
        lines.append(Line(text, (x,y,width,height), fontsize, color=color))
    erase = cv2.dilate(erase, np.ones((3, 3), np.uint8))
    erase[rules > 0] = 0
    restored = cv2.inpaint(pixels, erase, 3, cv2.INPAINT_TELEA) if np.any(erase) else pixels
    return cache_images(image, Image.fromarray(restored), folder, size, lines)

def render_page(page):
    width, height = page.get_size()
    bitmap = page.render(scale=min(2.5, 3000/max(width, height)))
    try: return bitmap.to_pil().convert('RGB')
    finally: bitmap.close()

def pdf_layout(page, folder, engine):
    import pypdfium2 as pdfium
    original = render_page(page)
    raw_size = page.get_size()
    size = bounded_size(raw_size)
    ratio = size[0]/raw_size[0]
    with_page = page.get_textpage()
    try:
        objects = list(page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_TEXT], max_depth=1, textpage=with_page))
        if page.get_rotation() or not objects or any(pdfium.raw.FPDFTextObj_GetTextRenderMode(obj) == 3 for obj in objects):
            _, result = engine.recognize(original)
            return scan_layout(original, result, folder, size)
        lines = []
        active = []
        try:
            for obj in objects:
                text = obj.extract().strip()
                if not text: continue
                matrix = obj.get_matrix()
                if abs(matrix.b) > .05 or abs(matrix.c) > .05: continue
                left, bottom, right, top = obj.get_bounds()
                font = obj.get_font().get_base_name().split('+')[-1]
                font = {'Helvetica':'Arial', 'Times-Roman':'Times New Roman', 'Courier':'Courier New'}.get(font, font)
                fontsize = obj.get_font_size()
                channels = [ctypes.c_uint() for _ in range(4)]
                pdfium.raw.FPDFPageObj_GetFillColor(obj, *(ctypes.byref(c) for c in channels))
                color = ''.join(f'{c.value:02X}' for c in channels[:3])
                lines.append(Line(text, (left*ratio, (raw_size[1]-top)*ratio, (right-left)*ratio, (top-bottom)*ratio), fontsize*ratio, font, color, 'Bold' in font))
                was_active = ctypes.c_int()
                if pdfium.raw.FPDFPageObj_GetIsActive(obj, ctypes.byref(was_active)) and was_active.value:
                    if not pdfium.raw.FPDFPageObj_SetIsActive(obj, False): raise ValueError('無法取得 PDF 版面。')
                    active.append(obj)
            background = render_page(page)
        finally:
            for obj in active: pdfium.raw.FPDFPageObj_SetIsActive(obj, True)
        return cache_images(original, background, folder, size, lines)
    finally:
        with_page.close()
        original.close()

def section(width=595.28, height=841.89):
    return f'<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="{round(width*20)}" w:h="{round(height*20)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'

def picture(rel, width, height, ident):
    cx, cy = round(width*12700), round(height*12700)
    return f'''<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{ident}" name="原稿圖形 {ident}" descr="原稿圖片及表格線"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{ident}" name="原稿圖形"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'''

def textbox(line, ident):
    x, y, width, height = line.box
    fontsize = max(4, line.size)
    top = max(0, y-fontsize*.22)
    style = f'position:absolute;margin-left:{x:.3f}pt;margin-top:{top:.3f}pt;width:{max(width,1):.3f}pt;height:{max(height*1.8,fontsize*1.8):.3f}pt;z-index:{ident};mso-position-horizontal-relative:page;mso-position-vertical-relative:page'
    return f'''<w:r><w:pict><v:shape id="text{ident}" type="#_x0000_t202" style="{style}" filled="f" stroked="f"><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:f"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{round(fontsize*24)}" w:lineRule="exact"/><w:jc w:val="left"/><w:wordWrap w:val="0"/><w:snapToGrid w:val="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii={quoteattr(line.font)} w:hAnsi={quoteattr(line.font)} w:eastAsia={quoteattr(line.font)}/><w:sz w:val="{round(fontsize*2)}"/><w:color w:val="{line.color}"/>{'<w:b/>' if line.bold else ''}<w:fitText w:val="{max(20,round(width*20))}" w:id="{ident}"/></w:rPr><w:t xml:space="preserve">{clean(line.text)}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>'''

def write_docx(path, pages=None, mode='editable', text=''):
    path = Path(path)
    pages = pages or []
    if mode not in ('editable', 'original', 'text'): raise ValueError('未知的 Word 匯出模式。')
    if mode != 'text' and not pages: raise ValueError('請先辨識檔案，再匯出 Word。')
    if mode == 'editable' and not any(line.text.strip() for page in pages for line in page.lines):
        raise ValueError('沒有辨識到可編輯文字，請重新辨識清晰的圖片；不會將純圖片當成可編輯 Word 匯出。')
    body, relationships, media = [], [], []
    ident = 1
    if mode == 'text':
        for line in text.splitlines():
            body.append(f'<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft JhengHei"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">{clean(line)}</w:t></w:r></w:p>')
        body.append('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>')
    else:
        for number, page in enumerate(pages, 1):
            rel, name = f'rId{number}', f'page{number}.png'
            relationships.append(f'<Relationship Id="{rel}" Type="{R}/image" Target="media/{name}"/>')
            media.append((name, page.original if mode == 'original' else page.background))
            content = ('<w:r><w:pict><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></w:pict></w:r>' if number == 1 else '') + picture(rel, page.width, page.height, ident)
            ident += 1
            if mode == 'editable':
                for line in page.lines:
                    content += textbox(line, ident)
                    ident += 1
            body.append('<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>'+content+'</w:p>')
            props = section(page.width, page.height)
            body.append(props if number == len(pages) else '<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/>'+props+'</w:pPr></w:p>')
    namespaces = f'xmlns:w="{W}" xmlns:r="{R}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {namespaces}><w:body>'+''.join(body)+'</w:body></w:document>'
    content_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'
    handle, temp = tempfile.mkstemp(prefix='.word-', suffix='.docx', dir=path.parent)
    os.close(handle)
    try:
        with zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('[Content_Types].xml', content_types)
            z.writestr('_rels/.rels', f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>')
            z.writestr('word/document.xml', document)
            z.writestr('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(relationships)+'</Relationships>')
            z.writestr('word/settings.xml', f'<w:settings xmlns:w="{W}"><w:displayBackgroundShape/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>')
            for name, file in media: z.write(file, 'word/media/'+name)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
