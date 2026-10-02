"""Portable, local PPTX export: native text, tables, charts, shapes and photo crops.

Semantic boxes are (x, y, width, height) in original-image pixels. LayoutPage
text positions are points. Unrecognized artwork remains raster artwork; it is
never described as an editable chart or as editable text.
"""
from pathlib import Path
from io import BytesIO
from statistics import median
from xml.sax.saxutils import quoteattr
import math, os, re, tempfile, zipfile
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw
from word_export import clean, rgb_image
from excel_export import TableData, write_xlsx, _column

A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
EMU = 914400
NS = f'xmlns:a="{A}" xmlns:p="{P}" xmlns:r="{R}"'
HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'


def _color(value, default='000000'):
    if value is None: return default
    if isinstance(value, (tuple, list)) and len(value) == 3:
        if any(not isinstance(channel, int) or not 0 <= channel <= 255 for channel in value):
            raise ValueError('PPT 色彩資料無效。')
        return ''.join(f'{channel:02X}' for channel in value)
    value = str(value).lstrip('#').upper()
    if not re.fullmatch('[0-9A-F]{6}', value): raise ValueError('PPT 色彩資料無效。')
    return value


def _box(value):
    try: values = tuple(float(number) for number in value)
    except (TypeError, ValueError): raise ValueError('PPT 物件位置無效。')
    if len(values) != 4 or not all(math.isfinite(number) for number in values) or min(values[2:]) < 0:
        raise ValueError('PPT 物件位置無效。')
    return values


def _inside(box, region):
    x, y, w, h = box
    left, top, width, height = region
    return left <= x+w/2 <= left+width and top <= y+h/2 <= top+height


def _rel(items):
    return HEADER+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="{key}" Type="{R}/{kind}" Target={quoteattr(target)}/>' for key, kind, target in items)+'</Relationships>'


def _xfrm(rect, tag='a:xfrm'):
    x, y, w, h = rect
    return f'<{tag}><a:off x="{round(x)}" y="{round(y)}"/><a:ext cx="{max(1,round(w))}" cy="{max(1,round(h))}"/></{tag}>'


def _run(text, size, color='000000', font='Microsoft JhengHei', bold=False):
    size = max(100, min(40000, round(float(size)*100)))
    return f'<a:r><a:rPr lang="zh-TW" sz="{size}" b="{int(bold)}"><a:solidFill><a:srgbClr val="{_color(color)}"/></a:solidFill><a:latin typeface={quoteattr(str(font))}/><a:ea typeface={quoteattr(str(font))}/><a:cs typeface="Arial"/></a:rPr><a:t xml:space="preserve">{clean(text)}</a:t></a:r>'


def _paragraphs(text, size, color='000000', font='Microsoft JhengHei', bold=False, align='l'):
    return ''.join('<a:p>'+f'<a:pPr algn="{align}"><a:buNone/></a:pPr>'+_run(line,size,color,font,bold)+f'<a:endParaRPr lang="zh-TW" sz="{max(100,min(40000,round(size*100)))}"/></a:p>' for line in str(text).split('\n'))


def _text(ident, rect, text, size, color='000000', font='Microsoft JhengHei', bold=False):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="辨識文字 {ident}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>'+_xfrm(rect)+'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>'+_paragraphs(text,size,color,font,bold)+'</p:txBody></p:sp>'


def _picture(ident, rect, relation, name):
    return f'<p:pic><p:nvPicPr><p:cNvPr id="{ident}" name={quoteattr(name)}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{relation}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>'+_xfrm(rect)+'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'


def _shape(ident, rect, data, point_scale, pixel_to_point):
    kind = data.get('kind','rect')
    if kind not in ('rect','diamond','roundRect','rightArrow','line'): raise ValueError('PPT 圖形種類不支援。')
    fill = '<a:noFill/>' if data.get('fill') is None or kind == 'line' else f'<a:solidFill><a:srgbClr val="{_color(data["fill"])}"/></a:solidFill>'
    width = float(data.get('width',1))
    if not math.isfinite(width) or not 0 <= width <= 50: raise ValueError('PPT 圖形線寬無效。')
    arrow = '<a:tailEnd type="triangle"/>' if kind=='line' and data.get('arrow') else ''
    line = f'<a:ln w="{max(1,round(width*pixel_to_point*point_scale*12700))}"><a:solidFill><a:srgbClr val="{_color(data.get("stroke"),"000000")}"/></a:solidFill><a:prstDash val="solid"/>'+arrow+'</a:ln>'
    text = ''
    if data.get('text'):
        text = '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>'+_paragraphs(data['text'],float(data.get('font_size',12))*pixel_to_point*point_scale,_color(data.get('text_color'),'000000'),bold=bool(data.get('bold')),align='ctr')+'</p:txBody>'
    return f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="可編輯圖形 {ident}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>'+_xfrm(rect)+f'<a:prstGeom prst="{kind}"><a:avLst/></a:prstGeom>'+fill+line+'</p:spPr>'+text+'</p:sp>'


def _table(ident, rect, data, page, image_size, pixel_box, point_scale):
    rows, widths, heights, fills = data.rows, data.column_widths_px, data.row_heights_px, data.fills
    columns = len(widths)
    if not rows or not columns or len(rows)!=len(heights) or len(rows)!=len(fills) or any(len(row)!=columns for row in rows+fills):
        raise ValueError('PPT 表格行列資料不完整。')
    if any(not isinstance(n,(int,float)) or not math.isfinite(n) or n<=0 for n in widths+heights): raise ValueError('PPT 表格尺寸無效。')
    if any(len(str(value)) > 32767 for row in rows for value in row): raise ValueError('PPT 表格儲存格文字過長。')
    merges = {}
    for r1,c1,r2,c2 in data.merges:
        if not 0<=r1<=r2<len(rows) or not 0<=c1<=c2<columns: raise ValueError('PPT 合併儲存格超出範圍。')
        for r in range(r1,r2+1):
            for c in range(c1,c2+1):
                if (r,c) in merges: raise ValueError('PPT 合併儲存格重疊。')
                merges[r,c]=(r1,c1,r2,c2)
    table_width, table_height = rect[2:]
    col_px=[pixel_box[0]]
    row_px=[pixel_box[1]]
    for value in widths: col_px.append(col_px[-1]+value/sum(widths)*pixel_box[2])
    for value in heights: row_px.append(row_px[-1]+value/sum(heights)*pixel_box[3])
    grid=''.join(f'<a:gridCol w="{max(1,round(value/sum(widths)*table_width))}"/>' for value in widths)
    body=[]
    for r, values in enumerate(rows):
        cells=[]
        for c,value in enumerate(values):
            merge=merges.get((r,c))
            attributes=[]
            if merge:
                r1,c1,r2,c2=merge
                if r==r1 and r2>r1: attributes.append(f'rowSpan="{r2-r1+1}"')
                if c==c1 and c2>c1: attributes.append(f'gridSpan="{c2-c1+1}"')
                if c>c1: attributes.append('hMerge="1"')
                if r>r1: attributes.append('vMerge="1"')
                if r!=r1 or c!=c1: value=''
            fill=_color(fills[r][c],'FFFFFF')
            rgb=tuple(int(fill[index:index+2],16) for index in (0,2,4))
            foreground='FFFFFF' if 299*rgb[0]+587*rgb[1]+114*rgb[2]<128000 else '000000'
            cell_box=(col_px[c],row_px[r],col_px[c+1]-col_px[c],row_px[r+1]-row_px[r])
            sizes=[line.size for line in page.lines if _inside((line.box[0]*image_size[0]/page.width,line.box[1]*image_size[1]/page.height,line.box[2]*image_size[0]/page.width,line.box[3]*image_size[1]/page.height),cell_box)]
            size=(median(sizes) if sizes else 10)*point_scale
            borders=''.join(f'<a:ln{edge} w="9525"><a:solidFill><a:srgbClr val="808080"/></a:solidFill><a:prstDash val="solid"/></a:ln{edge}>' for edge in ('L','R','T','B'))
            cell=f'<a:tc {" ".join(attributes)}><a:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>'+_paragraphs(value,size,foreground,bold=(r==0))+'</a:txBody><a:tcPr marL="25400" marR="25400" marT="12700" marB="12700">'+borders+f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill></a:tcPr></a:tc>'
            cells.append(cell)
        body.append(f'<a:tr h="{max(1,round(heights[r]/sum(heights)*table_height))}">'+''.join(cells)+'</a:tr>')
    return f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{ident}" name="可編輯表格 {ident}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'+_xfrm(rect,'p:xfrm')+'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>'+grid+'</a:tblGrid>'+''.join(body)+'</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'


def _numeric(value):
    if value is None: return None
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value): raise ValueError('PPT 圖表只能使用辨識到的明確數值。')
    return float(value)


def _workbook(chart, folder):
    """Reuse the literal-string XLSX writer; only explicit chart values become numbers."""
    categories=chart['categories']; series=chart['series']
    rows=[['類別']+[str(s.get('name','')) for s in series]]
    rows += [[str(category)]+['' if s['values'][r] is None else str(s['values'][r]) for s in series] for r,category in enumerate(categories)]
    columns=len(series)+1
    path=Path(folder)/'chart.xlsx'
    write_xlsx(path,[TableData(rows,[140]*columns,[24]*len(rows),[[(255,255,255)]*columns for _ in rows])])
    with zipfile.ZipFile(path) as archive: parts={name:archive.read(name) for name in archive.namelist()}
    sheet=ET.fromstring(parts['xl/worksheets/sheet1.xml']);styles=ET.fromstring(parts['xl/styles.xml'])
    xfs=styles.find(f'{{{S}}}cellXfs'); general=len(xfs)
    for fmt in ('0','10'):
        xf=ET.fromstring(ET.tostring(xfs[0]));xf.set('numFmtId',fmt);xfs.append(xf)
    xfs.set('count',str(len(xfs)))
    for row in sheet.findall(f'{{{S}}}sheetData/{{{S}}}row'):
        r=int(row.get('r'))
        if r==1: continue
        for cell in row:
            column=re.match('[A-Z]+',cell.get('r')).group()
            if column=='A': continue
            index=next(i for i in range(len(series)) if _column(i+2)==column)
            value=_numeric(series[index]['values'][r-2])
            for child in list(cell):cell.remove(child)
            cell.set('s',str(general+int(bool(series[index].get('percent')))))
            cell.set('t','n')
            if value is not None: ET.SubElement(cell,f'{{{S}}}v').text=format(value,'.15g')
    parts['xl/worksheets/sheet1.xml']=ET.tostring(sheet,encoding='utf-8',xml_declaration=True)
    parts['xl/styles.xml']=ET.tostring(styles,encoding='utf-8',xml_declaration=True)
    output=BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in parts.items():archive.writestr(name,data)
    return output.getvalue()


def _cache(values, numeric=False, fmt='General'):
    tag='numCache' if numeric else 'strCache'
    points=''.join(f'<c:pt idx="{i}"><c:v>{clean(format(_numeric(value),".15g") if numeric else value)}</c:v></c:pt>' for i,value in enumerate(values) if value is not None)
    return f'<c:{tag}>'+ (f'<c:formatCode>{fmt}</c:formatCode>' if numeric else '')+f'<c:ptCount val="{len(values)}"/>'+points+f'</c:{tag}>'


def _chart(data):
    categories=data.get('categories',[]);series=data.get('series',[])
    if not categories or not series: raise ValueError('PPT 圖表缺少類別或明確數值。')
    for item in series:
        if item.get('type','bar') not in ('bar','line') or len(item.get('values',[]))!=len(categories): raise ValueError('PPT 圖表資料不完整。')
        for value in item['values']:_numeric(value)
        if not any(value is not None for value in item['values']): raise ValueError('PPT 圖表系列沒有明確數值。')
    groups={}
    for index,item in enumerate(series):groups.setdefault((item.get('type','bar'),bool(item.get('secondary'))),[]).append((index,item))
    plot=[]
    for (kind,secondary),members in groups.items():
        chunks=[]
        for index,item in members:
            column=_column(index+2);color=_color(item.get('color'),'4472C4');fmt='0.0%' if item.get('percent') else 'General'
            name='<c:tx><c:strRef>'+f'<c:f>\'表格1\'!${column}$1</c:f>'+_cache([item.get('name','')])+'</c:strRef></c:tx>'
            cat='<c:cat><c:strRef>'+f'<c:f>\'表格1\'!$A$2:$A${len(categories)+1}</c:f>'+_cache(categories)+'</c:strRef></c:cat>'
            val='<c:val><c:numRef>'+f'<c:f>\'表格1\'!${column}$2:${column}${len(categories)+1}</c:f>'+_cache(item['values'],True,fmt)+'</c:numRef></c:val>'
            style=f'<c:spPr><a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln></c:spPr>'
            marker='<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' if kind=='line' else ''
            chunks.append(f'<c:ser><c:idx val="{index}"/><c:order val="{index}"/>'+name+style+marker+cat+val+('<c:smooth val="0"/>' if kind=='line' else '')+'</c:ser>')
        label_fmt='0.0%' if all(item.get('percent') for _,item in members) else 'General'
        labels=f'<c:dLbls><c:numFmt formatCode="{label_fmt}" sourceLinked="0"/><c:dLblPos val="t"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'
        axes=(201,202) if secondary else (101,102)
        if kind=='bar':plot.append('<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'+''.join(chunks)+labels.replace('val="t"','val="outEnd"')+'<c:gapWidth val="80"/><c:overlap val="0"/>'+''.join(f'<c:axId val="{axis}"/>' for axis in axes)+'</c:barChart>')
        else:plot.append('<c:lineChart><c:grouping val="standard"/>'+''.join(chunks)+labels+'<c:marker val="1"/><c:smooth val="0"/>'+''.join(f'<c:axId val="{axis}"/>' for axis in axes)+'</c:lineChart>')
    for secondary in (False,True):
        members=[item for item in series if bool(item.get('secondary'))==secondary]
        if not members:continue
        cat,val=(201,202) if secondary else (101,102)
        percent=all(item.get('percent') for item in members)
        bounds=''
        if percent and all(0<=value<=1 for item in members for value in item['values'] if value is not None):bounds='<c:max val="1"/><c:min val="0"/>'
        plot.append(f'<c:catAx><c:axId val="{cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="{int(secondary)}"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="{val}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>')
        plot.append(f'<c:valAx><c:axId val="{val}"/><c:scaling><c:orientation val="minMax"/>'+bounds+f'</c:scaling><c:delete val="0"/><c:axPos val="{"r" if secondary else "l"}"/>'+('' if secondary else '<c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>')+f'<c:numFmt formatCode="{"0%" if percent else "General"}" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="{cat}"/><c:crosses val="{"max" if secondary else "autoZero"}"/><c:crossBetween val="between"/></c:valAx>')
    title=''
    if data.get('title'):title='<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>'+_paragraphs(data['title'],14,bold=True)+'</c:rich></c:tx><c:overlay val="0"/></c:title>'
    font='<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="222222"/></a:solidFill><a:latin typeface="Calibri"/><a:ea typeface="Microsoft JhengHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-TW"/></a:p></c:txPr>'
    return HEADER+f'<c:chartSpace xmlns:c="{C}" xmlns:a="{A}" xmlns:r="{R}"><c:date1904 val="0"/><c:lang val="zh-TW"/><c:roundedCorners val="0"/><c:chart>'+title+'<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>'+''.join(plot)+'</c:plotArea><c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>'+font+'<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'


def _theme():
    colors={'dk1':'000000','lt1':'FFFFFF','dk2':'202020','lt2':'F3F4F6','accent1':'4472C4','accent2':'ED7D31','accent3':'A5A5A5','accent4':'FFC000','accent5':'5B9BD5','accent6':'70AD47','hlink':'0563C1','folHlink':'954F72'}
    color_xml=''.join(f'<a:{name}><a:srgbClr val="{value}"/></a:{name}>' for name,value in colors.items())
    fonts=''.join(f'<a:{kind}Font><a:latin typeface="Calibri"/><a:ea typeface="Microsoft JhengHei"/><a:cs typeface="Arial"/></a:{kind}Font>' for kind in ('major','minor'))
    solid='<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    lines=''.join(f'<a:ln w="{width}" cap="flat" cmpd="sng" algn="ctr">'+solid+'<a:prstDash val="solid"/></a:ln>' for width in (9525,25400,38100))
    return HEADER+f'<a:theme xmlns:a="{A}" name="TextOCR"><a:themeElements><a:clrScheme name="TextOCR">'+color_xml+'</a:clrScheme><a:fontScheme name="TextOCR">'+fonts+'</a:fontScheme><a:fmtScheme name="TextOCR"><a:fillStyleLst>'+solid*3+'</a:fillStyleLst><a:lnStyleLst>'+lines+'</a:lnStyleLst><a:effectStyleLst>'+'<a:effectStyle><a:effectLst/></a:effectStyle>'*3+'</a:effectStyleLst><a:bgFillStyleLst>'+solid*3+'</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'


def _png(image):
    output=BytesIO();image.save(output,format='PNG');return output.getvalue()


def _erase(image, box):
    x,y,w,h=box;left=max(0,math.floor(x)-1);top=max(0,math.floor(y)-1);right=min(image.width,math.ceil(x+w)+1);bottom=min(image.height,math.ceil(y+h)+1)
    if right<=left or bottom<=top:return
    points=[(max(0,left-2),top),(min(image.width-1,right+1),top),(left,max(0,top-2)),(left,min(image.height-1,bottom+1)),(max(0,left-2),min(image.height-1,bottom-1)),(min(image.width-1,right+1),min(image.height-1,bottom-1))]
    samples=[image.getpixel(point) for point in points]
    color=max(set(samples),key=samples.count)
    ImageDraw.Draw(image).rectangle((left,top,right-1,bottom-1),fill=color)


def write_pptx(path, pages, analyses=None):
    """Create one slide per LayoutPage, preserving first-page aspect and batch order."""
    path=Path(path);pages=list(pages)
    if path.suffix.lower()!='.pptx' or not path.parent.is_dir() or path.is_dir():raise ValueError('請選擇存在的資料夾，並使用 .pptx 副檔名。')
    if not pages:raise ValueError('請先辨識圖片或 PDF，再匯出 PowerPoint。')
    analyses=[{} for _ in pages] if analyses is None else list(analyses)
    if len(analyses)!=len(pages) or any(not isinstance(value,dict) for value in analyses):raise ValueError('PPT 分頁資料不完整。')
    for page in pages:
        if not all(isinstance(value,(int,float)) and math.isfinite(value) and value>0 for value in (page.width,page.height)):raise ValueError('PPT 頁面尺寸無效。')
    aspect=pages[0].height/pages[0].width;canvas_w=round(min(13.333333,56/aspect)*EMU);canvas_h=round(canvas_w*aspect)
    if min(canvas_w,canvas_h)<EMU or max(canvas_w,canvas_h)>56*EMU:raise ValueError('圖片頁面比例太極端，請先裁切再匯出 PowerPoint。')
    parts={};overrides=[];chart_count=0
    parts['ppt/theme/theme1.xml']=_theme()
    color_map='<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    parts['ppt/slideMasters/slideMaster1.xml']=HEADER+f'<p:sldMaster {NS}><p:cSld><p:spTree>'+GROUP+'</p:spTree></p:cSld>'+color_map+'<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'
    parts['ppt/slideMasters/_rels/slideMaster1.xml.rels']=_rel([('rId1','slideLayout','../slideLayouts/slideLayout1.xml'),('rId2','theme','../theme/theme1.xml')])
    parts['ppt/slideLayouts/slideLayout1.xml']=HEADER+f'<p:sldLayout {NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>'+GROUP+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels']=_rel([('rId1','slideMaster','../slideMasters/slideMaster1.xml')])
    with tempfile.TemporaryDirectory(prefix='TextOCR-PPT-') as working:
        for slide_index,(page,analysis) in enumerate(zip(pages,analyses),1):
            with Image.open(page.original) as source:original=rgb_image(source)
            try:
                with Image.open(page.background) as source:background=rgb_image(source)
                try:
                    if background.size!=original.size:raise ValueError('PPT 頁面圖片尺寸不一致。')
                    point_scale=min(canvas_w/page.width,canvas_h/page.height);ox=(canvas_w-page.width*point_scale)/2;oy=(canvas_h-page.height*point_scale)/2
                    def point_rect(box):
                        x,y,w,h=_box(box);return (ox+x*point_scale,oy+y*point_scale,w*point_scale,h*point_scale)
                    def pixel_rect(box):
                        x,y,w,h=_box(box);return point_rect((x*page.width/original.width,y*page.height/original.height,w*page.width/original.width,h*page.height/original.height))
                    photos=[_box(item['box']) for item in analysis.get('pictures',[])]
                    tables=analysis.get('tables',[]);charts=analysis.get('charts',[]);shapes=analysis.get('shapes',[])
                    regions=[_box(item['box']) for item in tables+charts+shapes]+photos
                    for region in [_box(box) for box in analysis.get('erase_regions',[])]+regions:_erase(background,region)
                    bg_name=f'ppt/media/background{slide_index}.png';parts[bg_name]=_png(background)
                    relationships=[('rId1','slideLayout','../slideLayouts/slideLayout1.xml'),('rId2','image',f'../media/background{slide_index}.png')]
                    objects=[_picture(2,point_rect((0,0,page.width,page.height)),'rId2','原稿圖形背景')];ident=3;native=0
                    for index,box in enumerate(photos,1):
                        x,y,w,h=box;bounds=(max(0,round(x)),max(0,round(y)),min(original.width,round(x+w)),min(original.height,round(y+h)))
                        if bounds[2]<=bounds[0] or bounds[3]<=bounds[1]:raise ValueError('PPT 照片區域無效。')
                        clipped=(bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1])
                        with original.crop(bounds) as crop:parts[f'ppt/media/photo{slide_index}-{index}.png']=_png(crop)
                        key=f'rId{len(relationships)+1}';relationships.append((key,'image',f'../media/photo{slide_index}-{index}.png'))
                        objects.append(_picture(ident,pixel_rect(clipped),key,f'原圖照片 {index}'));ident+=1;native+=1
                    for item in shapes:
                        objects.append(_shape(ident,pixel_rect(item['box']),item,point_scale/12700,page.width/original.width));ident+=1;native+=1
                    for item in tables:
                        objects.append(_table(ident,pixel_rect(item['box']),item['data'],page,original.size,_box(item['box']),point_scale/12700));ident+=1;native+=1
                    for item in charts:
                        chart_count+=1;xml=_chart(item)
                        parts[f'ppt/charts/chart{chart_count}.xml']=xml
                        parts[f'ppt/embeddings/chart{chart_count}.xlsx']=_workbook(item,working)
                        parts[f'ppt/charts/_rels/chart{chart_count}.xml.rels']=_rel([('rId1','package',f'../embeddings/chart{chart_count}.xlsx')])
                        overrides.append((f'/ppt/charts/chart{chart_count}.xml','application/vnd.openxmlformats-officedocument.drawingml.chart+xml'))
                        key=f'rId{len(relationships)+1}';relationships.append((key,'chart',f'../charts/chart{chart_count}.xml'))
                        objects.append(f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{ident}" name="可編輯圖表 {ident}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'+_xfrm(pixel_rect(item['box']),'p:xfrm')+f'<a:graphic><a:graphicData uri="{C}"><c:chart xmlns:c="{C}" r:id="{key}"/></a:graphicData></a:graphic></p:graphicFrame>');ident+=1;native+=1
                    excluded=[_box(item['box']) for item in tables+charts]+photos
                    excluded += [_box(item['box']) for item in shapes if item.get('text')]
                    for line in page.lines:
                        if not str(line.text).strip():continue
                        pixel_box=(line.box[0]*original.width/page.width,line.box[1]*original.height/page.height,line.box[2]*original.width/page.width,line.box[3]*original.height/page.height)
                        if any(_inside(pixel_box,box) for box in excluded):continue
                        x,y,w,h=_box(line.box);rect=point_rect((x,y-line.size*.15,w,max(h+line.size*.3,line.size*1.1)))
                        objects.append(_text(ident,rect,line.text,line.size*point_scale/12700,line.color,line.font,line.bold));ident+=1;native+=1
                    if not native:raise ValueError('此頁沒有可編輯文字或物件；不會把整張圖片宣稱為可編輯 PPT。')
                    parts[f'ppt/slides/slide{slide_index}.xml']=HEADER+f'<p:sld {NS}><p:cSld><p:spTree>'+GROUP+''.join(objects)+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
                    parts[f'ppt/slides/_rels/slide{slide_index}.xml.rels']=_rel(relationships)
                    overrides.append((f'/ppt/slides/slide{slide_index}.xml','application/vnd.openxmlformats-officedocument.presentationml.slide+xml'))
                finally:background.close()
            finally:original.close()
    parts['ppt/presentation.xml']=HEADER+f'<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>'+''.join(f'<p:sldId id="{255+i}" r:id="rId{i+1}"/>' for i in range(1,len(pages)+1))+f'</p:sldIdLst><p:sldSz cx="{canvas_w}" cy="{canvas_h}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>'
    parts['ppt/_rels/presentation.xml.rels']=_rel([('rId1','slideMaster','slideMasters/slideMaster1.xml')]+[(f'rId{i+1}','slide',f'slides/slide{i}.xml') for i in range(1,len(pages)+1)])
    parts['_rels/.rels']=_rel([('rId1','officeDocument','ppt/presentation.xml')])
    overrides += [('/ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),('/ppt/slideMasters/slideMaster1.xml','application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'),('/ppt/slideLayouts/slideLayout1.xml','application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'),('/ppt/theme/theme1.xml','application/vnd.openxmlformats-officedocument.theme+xml')]
    parts['[Content_Types].xml']=HEADER+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'+''.join(f'<Override PartName="{name}" ContentType="{content}"/>' for name,content in overrides)+'</Types>'
    handle,temporary=tempfile.mkstemp(prefix='.ppt-',suffix='.pptx',dir=path.parent);os.close(handle)
    try:
        with zipfile.ZipFile(temporary,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,data in parts.items():archive.writestr(name,data)
        os.replace(temporary,path)
    finally:
        Path(temporary).unlink(missing_ok=True)
