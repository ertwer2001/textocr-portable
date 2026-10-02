"""Conservative local recovery of editable slide objects from OCR screenshots."""
from pathlib import Path
from dataclasses import replace
import re, tempfile, unicodedata
from PIL import Image
from word_export import rgb_image
from excel_export import extract_table, TableData


def _inside(point, box):
    x, y, w, h = box
    return x <= point[0] <= x+w and y <= point[1] <= y+h


def _hex(color):
    return ''.join(f'{int(c):02X}' for c in color)


def _lines(layout, width, height):
    sx, sy = width/layout.width, height/layout.height
    return [dict(index=index, text=line.text, box=(line.box[0]*sx, line.box[1]*sy, line.box[2]*sx, line.box[3]*sy)) for index, line in enumerate(layout.lines)]


def _runs(indices):
    import numpy as np
    return np.split(indices, np.flatnonzero(np.diff(indices) > 1)+1) if len(indices) else []


def _grid_table(layout, image, lines, recognize):
    """Require three contiguous closed-cell rows; plot bars and flow boxes fail this."""
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 20, 60)
    contours,_ = cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    cells=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        polygon=cv2.approxPolyDP(contour,cv2.arcLength(contour,True)*.02,True)
        if len(polygon)==4 and 18<h<image.height*.2 and 18<w<image.width*.5 and cv2.contourArea(contour)/(w*h)>.84:
            cells.append((x,y,w,h))
    candidates=[]
    for height in sorted(set(round(cell[3]/3)*3 for cell in cells)):
        similar=[cell for cell in cells if abs(cell[3]-height)<=3]
        ys=[]
        for y in sorted(set(cell[1] for cell in similar)):
            if not ys or y-ys[-1]>4:ys.append(y)
        runs=[]
        for y in ys:
            if not runs or abs(y-runs[-1][-1]-height)>6:runs.append([y])
            else:runs[-1].append(y)
        for rows in runs:
            if len(rows)<3:continue
            top,bottom=rows[0],rows[-1]+height
            members=[cell for cell in similar if top-3<=cell[1]<bottom]
            if len(members)<len(rows)*3:continue
            candidates.append((len(members),top,bottom,height,members))
    for _,top,bottom,height,members in sorted(candidates,reverse=True)[:4]:
        header=[cell for cell in cells if height*1.3<cell[3]<height*3 and abs(cell[1]+cell[3]-top)<5 and cell[2]>=np.median([c[2] for c in members])*.7]
        if header:top=min(cell[1] for cell in header)
        top,bottom=max(0,top-3),min(image.height,bottom+4)
        vertical=cv2.morphologyEx(edges[top:bottom],cv2.MORPH_OPEN,np.ones((max(10,height//2),1),np.uint8))
        columns=np.flatnonzero((vertical>0).sum(axis=0)>(bottom-top)*.55)
        extent=members+header
        minimum=min(cell[0] for cell in extent)-5
        maximum=max(cell[0]+cell[2] for cell in extent)+5
        columns=columns[(columns>=minimum)&(columns<=maximum)]
        if len(columns)<6:continue
        left,right=max(0,int(columns[0])-4),min(image.width,int(columns[-1])+5)
        with tempfile.TemporaryDirectory(prefix='slide-grid-') as directory:
            original = Path(directory)/'grid.png'
            image.crop((left, top, right, bottom)).save(original)
            shifted = [replace(layout.lines[line['index']], box=(line['box'][0]-left, line['box'][1]-top, line['box'][2], line['box'][3])) for line in lines if _inside((line['box'][0]+line['box'][2]/2, line['box'][1]+line['box'][3]/2), (left, top, right-left, bottom-top))]
            clipped = replace(layout, width=right-left, height=bottom-top, original=original, lines=shifted)
            for threshold in (140, 245):
                try:
                    table = extract_table(clipped, recognize, threshold=threshold)
                except ValueError:
                    continue
                x, y, w, h = table.bounds
                table.bounds = (x+left, y+top, w, h)
                if len(table.rows)<3 or len(table.rows[0])<3:continue
                return table
    return None


def _number(text):
    value = unicodedata.normalize('NFKC', str(text)).strip().replace(' ', '').replace(',', '')
    if not re.fullmatch(r'[-+]?\d+(?:\.\d+)?%?', value):
        return None
    return float(value[:-1])/100 if value.endswith('%') else float(value)


def _refresh_chart_table(table,image,recognize):
    if not recognize or len(table.rows)<3 or len(table.rows[0])<5 or sum('%' in value for row in table.rows for value in row)<5:return
    x,y,_,_=table.bounds
    ys=[y]
    for height in table.row_heights_px:ys.append(ys[-1]+height)
    xs=[x]
    for width in table.column_widths_px:xs.append(xs[-1]+width)
    for r,row in enumerate(table.rows):
        for c,value in enumerate(row):
            if r==0 and c==0:continue
            with image.crop((xs[c]+3,ys[r]+3,xs[c+1]-2,ys[r+1]-2)) as crop:
                with crop.resize((crop.width*3,crop.height*3),Image.Resampling.LANCZOS) as enlarged:result=recognize(enlarged)
            text=str(result[0] if isinstance(result,tuple) else result).replace('\n',' ').strip()
            if text:table.rows[r][c]=text


def _unruled_table(image,lines):
    """Aligned columns plus repeated pale row bands provide a borderless table grid."""
    import cv2,numpy as np,bisect
    pixels=np.array(image)
    low=pixels.min(axis=2);high=pixels.max(axis=2)
    mask=((low>210)&(low<253)&(high-low<30)).astype('uint8')*255
    mask=cv2.morphologyEx(cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((5,5),np.uint8)),cv2.MORPH_CLOSE,np.ones((15,15),np.uint8))
    _,_,stats,_=cv2.connectedComponentsWithStats(mask)
    bands=[tuple(int(v)for v in row[:4])for row in stats[1:] if row[2]>image.width*.65 and 25<row[3]<image.height*.2 and row[4]/(row[2]*row[3])>.65]
    if len(bands)<3:return None
    step=int(np.median([b[3]for b in bands]));body=[b for b in bands if abs(b[3]-step)<8]
    joined=[b for b in bands if step*1.5<b[3]<step*3]
    if len(body)<2 or (len(body)<3 and not joined):return None
    x=min(b[0]for b in bands);right=max(b[0]+b[2]for b in bands);top=min(b[1]for b in bands);first=min([b[1]for b in body]+[b[1]+b[3]-step for b in joined])
    bottom=min(image.height,max(b[1]for b in body)+step*2)
    members=[line for line in lines if _inside((line['box'][0]+line['box'][2]/2,line['box'][1]+line['box'][3]/2),(x,top,right-x,bottom-top))]
    clusters=[]
    for left in sorted(l['box'][0]for l in members):
        if not clusters or left-np.median(clusters[-1])>18:clusters.append([left])
        else:clusters[-1].append(left)
    starts=[float(np.median(cluster))for cluster in clusters if len(cluster)>=3]
    if len(starts)<3:return None
    padding=starts[0]-x
    xs=[x]+[int(s-padding)for s in starts[1:]]+[right]
    ys=[top]
    if first-top>20:ys.append(first)
    for value in range(first+step,bottom+1,step):ys.append(value)
    if ys[-1]<bottom-5:ys.append(bottom)
    rows=[[''for _ in range(len(xs)-1)]for _ in range(len(ys)-1)]
    for line in sorted(members,key=lambda l:(l['box'][1],l['box'][0])):
        cx,cy=line['box'][0]+line['box'][2]/2,line['box'][1]+line['box'][3]/2
        r,c=bisect.bisect_right(ys,cy)-1,bisect.bisect_right(xs,cx)-1
        if 0<=r<len(rows)and 0<=c<len(rows[0]):rows[r][c]+=('\n'if rows[r][c]else'')+line['text']
    fills=[[tuple(int(v)for v in np.median(pixels[ys[r]+2:ys[r+1]-2,xs[c]+2:xs[c+1]-2].reshape(-1,3),axis=0))for c in range(len(xs)-1)]for r in range(len(ys)-1)]
    return TableData(rows,[b-a for a,b in zip(xs,xs[1:])],[b-a for a,b in zip(ys,ys[1:])],fills,bounds=(x,top,right-x,ys[-1]-top))


def _chart(table, image):
    if len(table.rows) < 3 or len(table.rows[0]) < 5:
        return None
    categories = table.rows[0][1:]
    if any(not value.strip() or _number(value) is not None for value in categories):
        return None
    series = []
    palette = ['A5A5A5', '5B9BD5', 'ED7D31', 'A64A08']
    for row in table.rows[1:]:
        values = [_number(value) for value in row[1:]]
        if not row[0].strip() or any(value is None for value in values):
            return None
        percent = all('%' in value for value in row[1:])
        series.append(dict(name=row[0], values=values, type='line' if percent else 'bar', percent=percent, secondary=not percent, color=palette[len(series)%len(palette)]))
    x, y, w, h = table.bounds
    if not any(item['percent'] for item in series) or y < image.height*.3:
        return None
    # ponytail: recover chart geometry from the grid above its visible data table, never bar heights.
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
    edges=cv2.morphologyEx(cv2.Canny(gray,20,60),cv2.MORPH_CLOSE,np.ones((1,5),np.uint8))
    horizontal = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones((1, max(15, int(w/50))), np.uint8))
    candidates = np.flatnonzero((horizontal[:y, x:x+w] > 0).sum(axis=1) > w*.5)
    candidates = candidates[candidates > image.height*.16]
    if not len(candidates):
        return None
    top = int(candidates[0])
    if _number(table.rows[0][0]) is not None:table.rows[0][0]=''
    categories=[re.sub(r"(?i)(\d['’]?)0ct",r'\1Oct',value)for value in categories]
    return dict(box=(x, top, w, y-top), categories=categories, series=series)


def _vectors(image, excluded):
    import cv2
    import numpy as np
    pixels = np.array(image)
    gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    contours, _ = cv2.findContours(cv2.Canny(gray, 20, 40), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        area = cv2.contourArea(contour)
        x, y, w, h = cv2.boundingRect(contour)
        if min(w, h) < 22 or area < 400 or w > image.width*.94 or h > image.height*.9:
            continue
        if any(_inside((x+w/2, y+h/2), box) for box in excluded):
            continue
        if any(abs(x-a['box'][0]) < 5 and abs(y-a['box'][1]) < 5 and abs(w-a['box'][2]) < 8 and abs(h-a['box'][3]) < 8 for a in found):
            continue
        polygon = cv2.approxPolyDP(contour, cv2.arcLength(contour, True)*.025, True).reshape(-1, 2)
        ratio = area/(w*h)
        sample = pixels[y+2:y+h-2, x+2:x+w-2]
        quantized = sample.reshape(-1, 3)//16
        _, counts = np.unique(quantized, axis=0, return_counts=True)
        top = sorted(counts, reverse=True)
        uniform = top[0]/len(quantized)
        kind = None
        if len(polygon) == 4 and .38 < ratio < .65:
            kind = 'diamond'
        elif len(polygon) == 4 and ratio > .86 and uniform > .65:
            kind = 'rect'
        elif 6 <= len(polygon) <= 9 and .35 < ratio < .8 and sum(top[:2])/len(quantized) > .88 and w > h*1.1:
            kind = 'rightArrow'
        elif 6 <= len(polygon) <= 12 and ratio > .82 and uniform > .6:
            kind = 'roundRect'
        if not kind:
            continue
        fill = tuple(int(v) for v in np.median(sample.reshape(-1, 3), axis=0))
        mask = np.zeros(gray.shape, np.uint8)
        cv2.drawContours(mask, [contour], -1, 255, 2)
        stroke_pixels = pixels[mask > 0]
        stroke = tuple(int(v) for v in np.percentile(stroke_pixels, 20, axis=0))
        found.append(dict(kind=kind, box=(x, y, w, h), fill=_hex(fill), stroke=_hex(stroke), width=2))
    # A connector attached to a box creates a second, larger contour; keep its rectangle.
    return [shape for shape in found if not (shape['kind']=='roundRect' and any(other['kind']=='rect' and abs(other['box'][0]-shape['box'][0])<5 and abs(other['box'][1]-shape['box'][1])<5 and other['box'][2]*other['box'][3]>shape['box'][2]*shape['box'][3]*.7 for other in found))]


def _pictures(image, excluded, lines):
    import cv2
    import numpy as np
    pixels = np.array(image)
    foreground = (np.min(pixels, axis=2) < 225).astype('uint8')*255
    for x, y, w, h in excluded:
        foreground[max(0,y-2):min(image.height,y+h+2), max(0,x-2):min(image.width,x+w+2)] = 0
    foreground = cv2.morphologyEx(foreground, cv2.MORPH_OPEN, np.ones((3,3),np.uint8))
    mask = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    found = []
    for index in range(1, count):
        x, y, w, h, area = [int(value) for value in stats[index]]
        if min(w,h) < 55 or area/(w*h) < .4 or w > image.width*.7 or h > image.height*.88:
            continue
        sample = pixels[y:y+h, x:x+w].reshape(-1, 3)//16
        _, colors = np.unique(sample, axis=0, return_counts=True)
        if len(colors) < 12 or max(colors)/len(sample) > .8:
            continue
        text_area=sum(max(0,min(x+w,l['box'][0]+l['box'][2])-max(x,l['box'][0]))*max(0,min(y+h,l['box'][1]+l['box'][3])-max(y,l['box'][1])) for l in lines)
        if text_area/(w*h)>.2:continue
        if sum(_inside((l['box'][0]+l['box'][2]/2,l['box'][1]+l['box'][3]/2),(x,y,w,h))for l in lines)>=3 and max(colors)/len(sample)>.25:continue
        found.append(dict(box=(x,y,w,h)))
    colorful=((pixels.max(axis=2)-pixels.min(axis=2))>80).astype('uint8')*255
    colorful=cv2.morphologyEx(colorful,cv2.MORPH_CLOSE,np.ones((7,7),np.uint8))
    count,labels,stats,_=cv2.connectedComponentsWithStats(colorful)
    hsv=cv2.cvtColor(pixels,cv2.COLOR_RGB2HSV)
    for index in range(1,count):
        x,y,w,h,_=[int(v)for v in stats[index]]
        if w<40 or h<12 or y+h>image.height*.22 or not (x+w<image.width*.25 or x>image.width*.8):continue
        hue=hsv[:,:,0][(labels==index)&(hsv[:,:,1]>100)]
        if len(hue)<30 or float(np.std(hue))<15:continue
        if not any(_inside((x+w/2,y+h/2),item['box'])for item in found):found.append(dict(box=(x,y,w,h)))
    return found


def _arrows_and_lines(image,excluded):
    import cv2,numpy as np
    pixels=np.array(image);hsv=cv2.cvtColor(pixels,cv2.COLOR_RGB2HSV)
    output=[]
    for hue in np.unique((hsv[:,:,0]//10)[(hsv[:,:,1]>110)&(hsv[:,:,2]>100)]):
        mask=(((hsv[:,:,0]//10)==hue)&(hsv[:,:,1]>110)&(hsv[:,:,2]>100)).astype('uint8')*255
        for x,y,w,h in excluded:mask[max(0,y-1):min(image.height,y+h+1),max(0,x-1):min(image.width,x+w+1)]=0
        count,labels,stats,_=cv2.connectedComponentsWithStats(mask)
        for index in range(1,count):
            x,y,w,h,area=[int(v)for v in stats[index]]
            if max(w,h)<15:continue
            contour,_=cv2.findContours((labels[y:y+h,x:x+w]==index).astype('uint8'),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            contour=max(contour,key=cv2.contourArea)
            polygon=cv2.approxPolyDP(contour,cv2.arcLength(contour,True)*.025,True)
            color=_hex(np.median(pixels[y:y+h,x:x+w][labels[y:y+h,x:x+w]==index],axis=0))
            if 6<=len(polygon)<=9 and w>h*1.1 and area/(w*h)>.25 and area>300:
                output.append(dict(kind='rightArrow',box=(x,y,w,h),fill=color,stroke=color,width=2,text='',line_indices=[]))
            elif area/(w*h)<.22 and max(w,h)>min(w,h)*1.5 and max(int(color[i:i+2],16)for i in (0,2,4))>=180:
                if w>h:
                    region=labels[y:y+h,x:x+w]==index
                    position=int(np.argmax(region.sum(axis=1)))
                    output.append(dict(kind='line',box=(x,y+position,w,0),fill=None,stroke=color,width=1,arrow=w<image.width*.15,text='',line_indices=[]))
                    if h>4 and w>image.width*.3:
                        for side in (0,w-1):
                            if region[:,max(0,side-1):min(w,side+2)].sum()>h*.5:output.append(dict(kind='line',box=(x+side,y,0,h),fill=None,stroke=color,width=1,arrow=side==0,text='',line_indices=[]))
                else:output.append(dict(kind='line',box=(x+w//2,y,0,h),fill=None,stroke=color,width=1,arrow=True,text='',line_indices=[]))
    return output


def analyze_slide(layout, table=None, recognize=None):
    """Return pixel xywh objects; ambiguous numbers/objects stay in the raster layer."""
    with Image.open(layout.original) as source:
        image = rgb_image(source)
    try:
        lines = _lines(layout, image.width, image.height)
        if table is None or not getattr(table,'bounds',None):
            try:table=extract_table(layout,recognize)
            except ValueError:table=None
        discovered = _grid_table(layout, image, lines, recognize) if table is None or any('%' in line['text'] for line in lines) else None
        if discovered is not None:table=discovered
        if table is not None:
            visible=sum(_inside((line['box'][0]+line['box'][2]/2,line['box'][1]+line['box'][3]/2),table.bounds)for line in lines)
            effective=len(table.rows)*len(table.rows[0])-sum((r2-r1+1)*(c2-c1+1)-1 for r1,c1,r2,c2 in table.merges)
            if visible/max(effective,1)<.2:table=None
        if table is None:table=_unruled_table(image,lines)
        if table is not None:_refresh_chart_table(table,image,recognize)
        tables = [dict(box=table.bounds, data=table)] if table is not None else []
        chart = _chart(table, image) if table is not None else None
        charts = [chart] if chart else []
        excluded = [item['box'] for item in tables+charts]
        shapes = _vectors(image, excluded)
        pictures = _pictures(image, excluded+[item['box'] for item in shapes], lines)
        for shape in shapes:
            members = [line for line in lines if _inside((line['box'][0]+line['box'][2]/2, line['box'][1]+line['box'][3]/2), shape['box']) and not any(_inside((line['box'][0]+line['box'][2]/2, line['box'][1]+line['box'][3]/2), picture['box']) for picture in pictures)]
            shape['text'] = '\n'.join(line['text'] for line in sorted(members, key=lambda line:(line['box'][1], line['box'][0])))
            shape['line_indices'] = [line['index'] for line in members]
            if members:
                shape['font_size']=sum(layout.lines[line['index']].size for line in members)/len(members)*image.width/layout.width
                shape['text_color']=layout.lines[members[0]['index']].color
        shapes=[shape for shape in shapes if shape['text'] or shape['kind']=='rightArrow' or shape['box'][2]>image.width*.65]
        text_boxes=[tuple(int(v)for v in line['box'])for line in lines]
        shapes += _arrows_and_lines(image,excluded+[item['box']for item in shapes]+[item['box']for item in pictures]+text_boxes)
        issues=[]
        if table is not None and sum('%' in value for row in table.rows for value in row)>5 and not charts:
            issues.append('圖表資料表有數字未能可靠辨識；圖形保留原稿，請檢查數字後重試。')
        return dict(source_size=image.size, tables=tables, shapes=shapes, charts=charts, pictures=pictures, erase_regions=excluded+[item['box'] for item in shapes], issues=issues)
    finally:
        image.close()
