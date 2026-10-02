"""Build small public test samples, never include users' documents in the app."""
from pathlib import Path
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent / 'examples'
root.mkdir(exist_ok=True)
image = Image.new('RGB', (1100, 340), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/msjh.ttc', 46)
for i, line in enumerate(('繁體中文辨識測試', '简体中文识别测试', 'Quality Report ABC 123', '品質週報：合格數量 123')):
    draw.text((38, 22 + i * 76), line, fill='black', font=font)
image.save(root / '中英測試.png')
image.save(root / '掃描測試.pdf', 'PDF', resolution=150)
# A native text page followed by an image-only page verifies both PDF routes.
jpeg = BytesIO()
image.save(jpeg, format='JPEG', quality=95)
pixels = jpeg.getvalue()
native = b'BT /F1 20 Tf 40 760 Td (Native PDF Quality Report ABC 123) Tj ET'
scan = b'q 550 0 0 170 20 550 cm /I1 Do Q'
objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /I1 8 0 R >> >> /Contents 7 0 R >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    b'<< /Length '+str(len(native)).encode()+b' >>\nstream\n'+native+b'\nendstream',
    b'<< /Length '+str(len(scan)).encode()+b' >>\nstream\n'+scan+b'\nendstream',
    b'<< /Type /XObject /Subtype /Image /Width 1100 /Height 340 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+str(len(pixels)).encode()+b' >>\nstream\n'+pixels+b'\nendstream',
]
pdf = bytearray(b'%PDF-1.4\n')
offsets = [0]
for n, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f'{n} 0 obj\n'.encode()+obj+b'\nendobj\n')
xref = len(pdf)
pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]: pdf.extend(f'{offset:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
(root / '文字與掃描混合.pdf').write_bytes(pdf)
print('examples ready')
