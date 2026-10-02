"""Rebuild a ruled screenshot as editable XLSX cells; no pictures or network."""
from dataclasses import dataclass, field
from pathlib import Path
import bisect, os, tempfile, zipfile
from PIL import Image
from word_export import clean, rgb_image

S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


@dataclass
class TableData:
    rows: list
    column_widths_px: list
    row_heights_px: list
    fills: list
    merges: list = field(default_factory=list)  # (top, left, bottom, right), zero-based
    bounds: tuple = None  # x, y, width, height in the source image pixels


def _positions(counts, minimum):
    import numpy as np
    indices = np.flatnonzero(counts >= minimum)
    if not len(indices):
        return []
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 5)+1)
    return [int(round(float(group.mean()))) for group in groups]


def extract_table(layout, recognize=None, threshold=140):
    """Use the dominant ruled grid and OCR positions; optionally retry bad cells."""
    import cv2
    import numpy as np
    with Image.open(layout.original) as source:
        image = rgb_image(source)
    try:
        pixels = np.array(image)
        gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
        ink = (gray < threshold).astype('uint8')*255
        horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(20, image.width//12)), np.uint8))
        vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(20, image.height//12), 1), np.uint8))
        joined = cv2.morphologyEx(horizontal | vertical, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        _, labels, stats, _ = cv2.connectedComponentsWithStats(joined)
        candidates = [(int(row[4]), index, row) for index, row in enumerate(stats[1:], 1) if row[2] >= 60 and row[3] >= 25]
        if not candidates:
            raise ValueError('找不到清楚的表格線，請使用有完整行列邊框的表格截圖。')
        # ponytail: one dominant ruled table; use a layout model for multiple/borderless tables.
        _, index, (left, top, width, height, _) = max(candidates, key=lambda value: value[0])
        member = labels[top:top+height, left:left+width] == index
        xs = [left+x for x in _positions(((vertical[top:top+height, left:left+width] > 0) & member).sum(axis=0), max(20, height*.35))]
        ys = [top+y for y in _positions(((horizontal[top:top+height, left:left+width] > 0) & member).sum(axis=1), max(30, width*.35))]
        # Excel's outer top/left divider can be gray while its internal rules are black.
        if xs and xs[0]-left > 5 and left > 0:
            xs.insert(0, int(left))
        if ys and ys[0]-top > 5 and top > 0:
            ys.insert(0, int(top))
        if len(xs) < 3 or len(ys) < 3 or min(np.diff(xs)) < 5 or min(np.diff(ys)) < 5:
            raise ValueError('表格行列不完整，請重新截取清楚且未遮住邊框的表格。')
        # Only intervals ending at a visible rule are complete: ignore cropped trailing rows.
        columns, row_count = len(xs)-1, len(ys)-1
        parents = list(range(columns*row_count))
        def root(cell):
            while parents[cell] != cell:
                parents[cell] = parents[parents[cell]]
                cell = parents[cell]
            return cell
        def join(a, b):
            a, b = root(a), root(b)
            parents[max(a,b)] = min(a,b)
        for r in range(row_count):
            for c in range(columns):
                if c+1 < columns:
                    strip = ink[ys[r]+3:ys[r+1]-2, max(0,xs[c+1]-1):xs[c+1]+2]
                    if np.mean(np.any(strip > 0, axis=1)) < .3:
                        join(r*columns+c, r*columns+c+1)
                if r+1 < row_count:
                    strip = ink[max(0,ys[r+1]-1):ys[r+1]+2, xs[c]+3:xs[c+1]-2]
                    if np.mean(np.any(strip > 0, axis=0)) < .3:
                        join(r*columns+c, (r+1)*columns+c)
        groups = {}
        for cell in range(columns*row_count):
            groups.setdefault(root(cell), []).append(divmod(cell, columns))
        merges, anchors, extents = [], {}, {}
        for cells in groups.values():
            r1, c1 = min(r for r,c in cells), min(c for r,c in cells)
            r2, c2 = max(r for r,c in cells), max(c for r,c in cells)
            if len(cells) > 1 and len(cells) == (r2-r1+1)*(c2-c1+1):
                merges.append((r1,c1,r2,c2))
                for cell in cells:
                    anchors[cell] = (r1,c1)
                extents[r1,c1] = (r2,c2)
        buckets = [[[] for _ in range(columns)] for _ in range(row_count)]
        retry = set()
        sx, sy = image.width/layout.width, image.height/layout.height
        for line in layout.lines:
            x, y, w, h = line.box
            x, y, w, h = x*sx, y*sy, w*sx, h*sy
            cx, cy = x+w/2, y+h/2
            row, column = bisect.bisect_right(ys, cy)-1, bisect.bisect_right(xs, cx)-1
            if not 0 <= row < row_count:
                continue
            touched = [c for c in range(columns) if min(x+w, xs[c+1])-max(x, xs[c]) > max(3, w*.15)]
            outside = x < xs[0]-3 and x+w > xs[0]+3
            targets = {anchors.get((row,c),(row,c)) for c in touched}
            if len(targets) > 1 or outside:
                retry.update(targets)
                if recognize:
                    continue
            if 0 <= column < columns:
                row, column = anchors.get((row,column),(row,column))
                buckets[row][column].append((y, x, str(line.text)))
        rows = [['\n'.join(text for _, _, text in sorted(cell)) for cell in row] for row in buckets]
        fills = []
        palette = []
        for row in range(row_count):
            fill_row = []
            for column in range(columns):
                x1, x2, y1, y2 = xs[column]+2, xs[column+1]-1, ys[row]+2, ys[row+1]-1
                cell = pixels[y1:y2, x1:x2]
                color = tuple(int(channel) for channel in np.median(cell.reshape(-1, 3), axis=0))
                if min(color) > 240:
                    color = (255, 255, 255)
                color = next((existing for existing in palette if max(abs(a-b) for a, b in zip(color, existing)) <= 8), color)
                if color not in palette:
                    palette.append(color)
                fill_row.append(color)
                contrast = np.max(np.abs(cell.astype(float)-np.array(color)), axis=2)
                if anchors.get((row,column),(row,column)) == (row,column) and not rows[row][column] and np.count_nonzero(contrast > 70) >= max(6, cell.shape[0]*cell.shape[1]*.01):
                    retry.add((row, column))
            fills.append(fill_row)
        if recognize:
            for row, column in sorted(retry):
                last_row,last_column = extents.get((row,column),(row,column))
                with image.crop((xs[column]+2, ys[row]+2, xs[last_column+1]-1, ys[last_row+1]-1)) as crop:
                    # Small screenshot cells need enlargement; never change the original input.
                    with crop.resize((crop.width*3, crop.height*3), Image.Resampling.LANCZOS) as enlarged:
                        result = recognize(enlarged)
                rows[row][column] = str(result[0] if isinstance(result, tuple) else result).strip()
        if not any(value.strip() for row in rows for value in row):
            raise ValueError('表格內沒有辨識到文字，請提供解析度更高的截圖。')
        return TableData(rows, [int(value) for value in np.diff(xs)], [int(value) for value in np.diff(ys)], fills, merges=merges, bounds=(int(xs[0]), int(ys[0]), int(xs[-1]-xs[0]), int(ys[-1]-ys[0])))
    finally:
        image.close()


def _column(index):
    value = ''
    while index:
        index, digit = divmod(index-1, 26)
        value = chr(65+digit)+value
    return value


def write_xlsx(path, tables):
    """Write inline strings to real cells, preserving IDs, zeros and literal '=' text."""
    path = Path(path)
    tables = list(tables)
    if path.suffix.lower() != '.xlsx' or not path.parent.is_dir() or path.is_dir():
        raise ValueError('請選擇存在的資料夾，並使用 .xlsx 副檔名。')
    if not tables:
        raise ValueError('請先辨識表格，再匯出 Excel。')
    colors = [(255, 255, 255)]
    for table in tables:
        count = len(table.column_widths_px)
        if not table.rows or count < 1 or count > 16384 or len(table.rows) > 1048576:
            raise ValueError('表格尺寸不符合 Excel 的行列限制。')
        if len(table.rows) != len(table.row_heights_px) or len(table.rows) != len(table.fills) or any(len(row) != count for row in table.rows+table.fills):
            raise ValueError('表格行列資料不完整。')
        if any(len(str(value)) > 32767 for row in table.rows for value in row):
            raise ValueError('儲存格文字超過 Excel 的 32767 字元限制。')
        if any(not isinstance(value, (int, float)) or not 0 < value < 100000 for value in table.column_widths_px+table.row_heights_px):
            raise ValueError('表格行列尺寸無效。')
        for row in table.fills:
            for color in row:
                if len(color) != 3 or any(not isinstance(channel, int) or not 0 <= channel <= 255 for channel in color):
                    raise ValueError('表格底色資料無效。')
                if tuple(color) not in colors:
                    colors.append(tuple(color))
        for merge in table.merges:
            if len(merge) != 4 or any(not isinstance(value, int) for value in merge):
                raise ValueError('合併儲存格資料無效。')
            r1, c1, r2, c2 = merge
            if not 0 <= r1 <= r2 < len(table.rows) or not 0 <= c1 <= c2 < count:
                raise ValueError('合併儲存格超出表格範圍。')
    fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
    fills += [f'<fill><patternFill patternType="solid"><fgColor rgb="FF{"".join(f"{value:02X}" for value in color)}"/><bgColor indexed="64"/></patternFill></fill>' for color in colors]
    fonts = ''.join(f'<font><sz val="10"/><color rgb="{color}"/><name val="Microsoft JhengHei"/><family val="2"/></font>' for color in ('FF000000', 'FFFFFFFF'))
    styles = f'<styleSheet xmlns="{S}"><fonts count="2">'+fonts+f'</fonts><fills count="{len(fills)}">'+''.join(fills)+'</fills><borders count="1"><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+f'<cellXfs count="{len(colors)}">'+''.join(f'<xf numFmtId="49" fontId="{int(299*color[0]+587*color[1]+114*color[2] < 128000)}" fillId="{index+2}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' for index, color in enumerate(colors))+'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    workbook = f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>'+''.join(f'<sheet name="表格{index}" sheetId="{index}" r:id="rId{index}"/>' for index in range(1, len(tables)+1))+'</sheets></workbook>'
    rels = ''.join(f'<Relationship Id="rId{index}" Type="{R}/worksheet" Target="worksheets/sheet{index}.xml"/>' for index in range(1, len(tables)+1))
    rels += f'<Relationship Id="rId{len(tables)+1}" Type="{R}/styles" Target="styles.xml"/>'
    content = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+''.join(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for index in range(1, len(tables)+1))+'</Types>'
    handle, temporary = tempfile.mkstemp(prefix='.excel-', suffix='.xlsx', dir=path.parent)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('[Content_Types].xml', content)
            archive.writestr('_rels/.rels', f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
            archive.writestr('xl/workbook.xml', workbook)
            archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels+'</Relationships>')
            archive.writestr('xl/styles.xml', styles)
            for index, table in enumerate(tables, 1):
                columns = ''.join(f'<col min="{c}" max="{c}" width="{min(255, max(1, (width-5)/7)):.3f}" customWidth="1"/>' for c, width in enumerate(table.column_widths_px, 1))
                rows = []
                for r, values in enumerate(table.rows, 1):
                    cells = ''.join(f'<c r="{_column(c)}{r}" t="inlineStr" s="{colors.index(tuple(table.fills[r-1][c-1]))}"><is><t xml:space="preserve">{clean(value)}</t></is></c>' for c, value in enumerate(values, 1))
                    rows.append(f'<row r="{r}" ht="{min(409, table.row_heights_px[r-1]*.75):.3f}" customHeight="1">{cells}</row>')
                merges = '<mergeCells count="'+str(len(table.merges))+'">'+''.join(f'<mergeCell ref="{_column(c1+1)}{r1+1}:{_column(c2+1)}{r2+1}"/>' for r1, c1, r2, c2 in table.merges)+'</mergeCells>' if table.merges else ''
                archive.writestr(f'xl/worksheets/sheet{index}.xml', f'<worksheet xmlns="{S}"><dimension ref="A1:{_column(len(table.column_widths_px))}{len(table.rows)}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols>'+columns+'</cols><sheetData>'+''.join(rows)+'</sheetData>'+merges+'</worksheet>')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
