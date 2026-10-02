"""One runnable offline check: OCR, PDF routes, cancellation and GUI file flow."""
from pathlib import Path
import socket, tempfile, threading, time
import io, zipfile, xml.etree.ElementTree as ET
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, ImageDraw, ImageFont
from engine import TextEngine, Cancelled, resources


def run():
    start = time.perf_counter()
    attempts = []
    def no_network(*args, **kwargs):
        attempts.append(str(args[1:] or args))
        raise AssertionError('The portable app tried to access the network')
    with patch.object(socket.socket, 'connect', no_network), patch.object(socket, 'create_connection', no_network):
        import requests
        with patch.object(requests.sessions.Session, 'request', no_network):
            engine = TextEngine()
            samples = resources() / 'examples'
            expected = ('繁體中文辨識測試', '简体中文识别测试', 'QualityReportABC123', '合格數量123')
            def check_text(text):
                compact = ''.join(text.split())
                for phrase in expected: assert phrase in compact, (phrase, text)
            image_pages = list(engine.extract(samples / '中英測試.png'))
            check_text(image_pages[0].text)
            scan_pages = list(engine.extract(samples / '掃描測試.pdf'))
            assert scan_pages[0].method == '掃描頁辨識'
            check_text(scan_pages[0].text)
            mixed = list(engine.extract(samples / '文字與掃描混合.pdf'))
            assert len(mixed) == 2 and [p.method for p in mixed] == ['PDF原有文字', '掃描頁辨識']
            assert 'Native PDF Quality Report ABC 123' in mixed[0].text
            check_text(mixed[1].text)
            forced = list(engine.extract(samples / '文字與掃描混合.pdf', force_ocr=True))
            assert all(p.method == '掃描頁辨識' for p in forced)
            assert 'QualityReportABC123' in ''.join(forced[0].text.split())
            with Image.new('RGBA', (360, 200), (255, 255, 255, 0)) as blank:
                assert list(engine.extract(blank))[0].text == ''
            cancel = threading.Event()
            cancel.set()
            try:
                list(engine.extract(samples / '中英測試.png', cancelled=cancel))
                raise AssertionError('Cancellation failed')
            except Cancelled:
                pass
            with tempfile.TemporaryDirectory() as folder:
                from word_export import scan_layout
                with Image.new('RGB', (300, 80), '#990000') as header:
                    draw = ImageDraw.Draw(header)
                    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 32)
                    box = draw.textbbox((10,10), 'WHITE ABC', font=font)
                    draw.text((10,10), 'WHITE ABC', fill='white', font=font)
                    x1,y1,x2,y2 = box
                    fake = SimpleNamespace(boxes=[[(x1-2,y1-2),(x2+2,y1-2),(x2+2,y2+2),(x1-2,y2+2)]], txts=['WHITE ABC'])
                    colored = scan_layout(header, fake, folder)
                    assert len(colored.lines) == 1 and colored.lines[0].color == 'FFFFFF'
                    with Image.open(colored.background) as erased:
                        before = sum(min(p) > 230 for p in header.getdata())
                        after = sum(min(p) > 230 for p in erased.getdata())
                        assert after < before/4, 'White header text was not removed from the picture background'
                invalid = Path(folder) / 'invalid.pdf'
                invalid.write_bytes(b'broken PDF')
                try:
                    list(engine.extract(invalid))
                    raise AssertionError('Invalid PDF accepted')
                except ValueError:
                    pass
                from excel_export import extract_table, write_xlsx, TableData, S
                try:
                    extract_table(colored)
                    raise AssertionError('A text image without grid lines was treated as a table')
                except ValueError: pass
                literal_file = Path(folder)/'literal.xlsx'
                table = TableData([['=1+1','001'],['','X']], [140,100], [35,35], [[(153,0,0),(255,255,255)],[(255,255,255),(255,255,0)]])
                write_xlsx(literal_file, [table])
                original_bytes = literal_file.read_bytes()
                ns = {'s':S}
                with zipfile.ZipFile(literal_file) as z:
                    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
                    cells = sheet.findall('.//s:c',ns)
                    assert [''.join(cell.itertext()) for cell in cells] == ['=1+1','001','','X']
                    assert not sheet.findall('.//s:f',ns)
                    styles = ET.fromstring(z.read('xl/styles.xml'))
                    style = styles.find('s:cellXfs',ns)[int(cells[0].attrib['s'])]
                    font = styles.find('s:fonts',ns)[int(style.attrib['fontId'])]
                    assert font.find('s:color',ns).attrib['rgb'] == 'FFFFFFFF'
                with patch('excel_export.zipfile.ZipFile.writestr', side_effect=OSError('write failed')):
                    try:
                        write_xlsx(literal_file,[table])
                        raise AssertionError('Forced XLSX writer failure accepted')
                    except OSError: pass
                assert literal_file.read_bytes() == original_bytes and not list(Path(folder).glob('.excel-*'))
                from ppt_export import write_pptx
                chart_file = Path(folder)/'native-chart.pptx'
                chart = {'box':(140,10,150,50), 'categories':['Jan','=category'], 'series':[
                    {'name':'Output','values':[100,120],'type':'bar','secondary':True,'color':'5B9BD5'},
                    {'name':'Yield','values':[.92,.96],'type':'line','percent':True,'color':'A64A08'}]}
                analysis = {'tables':[{'box':(10,10,100,50),'data':table}], 'charts':[chart],
                            'shapes':[{'kind':'diamond','box':(115,10,20,30),'fill':'FFFFFF','stroke':'005C7E','text':'NODE'}], 'pictures':[{'box':(290,0,10,10)}]}
                write_pptx(chart_file,[colored],[analysis])
                with zipfile.ZipFile(chart_file) as z:
                    slide = ET.fromstring(z.read('ppt/slides/slide1.xml'))
                    ans = {'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
                    assert any(node.attrib.get('uri') == 'http://schemas.openxmlformats.org/drawingml/2006/table' and node.find('a:tbl',ans) is not None for node in slide.findall('.//a:graphicData',ans))
                    chart_xml = ET.fromstring(z.read('ppt/charts/chart1.xml'))
                    cns = {'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
                    assert chart_xml.find('.//c:barChart',cns) is not None and chart_xml.find('.//c:lineChart',cns) is not None
                    assert len(chart_xml.findall('.//c:valAx',cns)) == 2
                    with Image.open(colored.original) as original, Image.open(io.BytesIO(z.read('ppt/media/photo1-1.png'))) as photo:
                        assert photo.tobytes() == original.crop((290,0,300,10)).tobytes()
                    with zipfile.ZipFile(io.BytesIO(z.read('ppt/embeddings/chart1.xlsx'))) as embedded:
                        sheet = ET.fromstring(embedded.read('xl/worksheets/sheet1.xml'))
                        cells = {cell.attrib['r']:cell for cell in sheet.findall('.//s:c',ns)}
                        assert float(cells['B2'].find('s:v',ns).text) == 100 and float(cells['C2'].find('s:v',ns).text) == .92
                        assert '=category' in ''.join(cells['A3'].itertext()) and not sheet.findall('.//s:f',ns)
                original_bytes = chart_file.read_bytes()
                original_write = zipfile.ZipFile.writestr
                def fail_ppt(archive, name, *args, **kwargs):
                    if name == 'ppt/presentation.xml': raise OSError('write failed')
                    return original_write(archive, name, *args, **kwargs)
                with patch('ppt_export.zipfile.ZipFile.writestr', new=fail_ppt):
                    try:
                        write_pptx(chart_file,[colored],[analysis])
                        raise AssertionError('Forced PPT writer failure accepted')
                    except OSError: pass
                assert chart_file.read_bytes() == original_bytes and not list(Path(folder).glob('.ppt-*'))
                from tkinterdnd2 import TkinterDnD
                from app import App
                root = TkinterDnD.Tk()
                root.attributes('-alpha', 0)
                try:
                    app_dir = Path(folder)/'程式'
                    app_dir.mkdir()
                    app = App(root, app_dir)
                    assert app.choose_pages() is None and '請先辨識' in app.status.get()
                    app.open_manual()
                    assert '找不到操作手冊' in app.status.get()
                    manual = app_dir/'操作手冊.html'
                    manual.write_text('<!doctype html><meta charset="utf-8"><title>操作手冊測試</title><p>離線手冊</p>', encoding='utf-8')
                    with patch('app.os.startfile') as opened: app.open_manual()
                    opened.assert_called_once_with(str(app.app_dir/'操作手冊.html'))
                    with patch('app.os.startfile', side_effect=OSError('no associated app')): app.open_manual()
                    assert '無法開啟操作手冊' in app.status.get()
                    app.output_folder.set(str(app_dir/('中文輸出資料夾'*20)))
                    app.status.set('已匯出：C:\\'+('輸出路徑很長\\'*30)+'批次.xlsx')
                    app.add_files([samples/'中英測試.png'])
                    preview_key = app.files.get_children()[0]
                    app.items[preview_key]['name'] = '品質管理文件_Z-KY3-QA-010_MRB物料評審管理規定_修訂日期2026年10月2日_A版.png'
                    app.preview_token = None
                    app.select_item(preview_key)
                    assert '…' in app.preview_info.get() and '修訂日期2026' in app.items[preview_key]['name']
                    for geometry in ('1040x760', '900x620'):
                        root.geometry(geometry)
                        root.update()
                        assert app.word_button.winfo_height() >= app.word_button.winfo_reqheight()
                        assert app.scope_box.winfo_height() >= app.scope_box.winfo_reqheight()
                        assert 0 <= app.word_button.winfo_rooty()-root.winfo_rooty() < root.winfo_height()-app.word_button.winfo_height()
                        assert app.preview_canvas.winfo_width() > 50 and app.preview_canvas.winfo_height() > 30
                        assert app.open_file_button.winfo_height() > 10
                        assert app.open_file_button.winfo_rooty()-root.winfo_rooty()+app.open_file_button.winfo_height() < root.winfo_height()
                        assert app.excel_button.winfo_height() > 10 and app.scope_box.winfo_width() > 60
                        assert app.presentation_button.winfo_height() >= app.presentation_button.winfo_reqheight()
                        assert app.export_note.winfo_height() >= app.export_note.winfo_reqheight()
                        assert app.export_note.winfo_ismapped()
                        assert app.original_button.winfo_rootx()+app.original_button.winfo_width() <= root.winfo_rootx()+root.winfo_width()
                        for widget in (app.page_button, app.scope_box, app.original_button):
                            assert widget.winfo_ismapped() and widget.winfo_rootx()-root.winfo_rootx()+widget.winfo_width() <= root.winfo_width()
                            assert widget.winfo_rooty()-root.winfo_rooty()+widget.winfo_height() < root.winfo_height()
                    root.geometry('1040x760')
                    app.clear_files()
                    app.engine = engine
                    data = root.tk.call('list', str(samples / '中英測試.png'), str(samples / '文字與掃描混合.pdf'))
                    app.drop(SimpleNamespace(data=data, action='copy'))
                    assert len(app.items) == 2
                    image_key, pdf_key = app.files.get_children()
                    with patch('app.ImageGrab.grabclipboard', return_value=[str(samples / '中英測試.png')]):
                        app.paste()
                    assert len(app.items) == 2 and app.preview_image.size == (1100, 340)
                    root.update()
                    assert app.preview_photo is not None and app.preview_canvas.find_all()
                    before = app.result.get('1.0', 'end-1c')
                    with Image.open(samples / '中英測試.png') as clip, patch('app.ImageGrab.grabclipboard', return_value=clip):
                        app.result.focus_force()
                        root.update()
                        app.result.event_generate('<Control-v>')
                        root.update()
                    assert len(app.items) == 3
                    assert app.result.get('1.0', 'end-1c') == before
                    assert app.preview_image.size == (1100, 340) and app.preview_photo is not None
                    clip_key = app.files.get_children()[-1]
                    assert app.items[clip_key]['source'].size == (1100, 340)
                    assert app.preview_photo.width() <= app.preview_canvas.winfo_width()
                    app.select_item(image_key)
                    assert app.preview_token[0] == image_key
                    app.select_item(clip_key)
                    with patch('app.ImageGrab.grabclipboard', return_value=None):
                        assert app.paste(SimpleNamespace(widget=app.result)) is None
                    grid = Image.new('RGB', (640, 260), 'white')
                    draw = ImageDraw.Draw(grid)
                    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 24)
                    values = [['ITEM','CODE','STATUS'], ['Widget','001','OK'], ['Gadget','002','NO']]
                    colors = ['white','#ffff00','#fce4d6']
                    for r, row in enumerate(values):
                        draw.rectangle((20,20+r*70,620,90+r*70), fill=colors[r])
                        for c, value in enumerate(row): draw.text((30+c*200,40+r*70), value, fill='black', font=font)
                    for x in (20,220,420,620): draw.line((x,20,x,230), fill='black', width=1)
                    for y in (20,90,160,230): draw.line((20,y,620,y), fill='black', width=1)
                    for _ in range(2):
                        with patch('app.ImageGrab.grabclipboard', return_value=grid): app.paste()
                    grid.close()
                    assert len(app.items) == 5, 'Consecutive pasted screenshots must accumulate'
                    grid_keys = app.files.get_children()[-2:]
                    root.withdraw()
                    app.start()
                    deadline = time.monotonic() + 90
                    while app.busy and time.monotonic() < deadline:
                        root.update()
                        time.sleep(.04)
                    assert not app.busy, 'GUI worker did not finish'
                    assert all(v['state'] == '完成' for v in app.items.values()), app.status.get()
                    app.select_item(pdf_key)
                    assert app.preview_image is not None and app.items[pdf_key]['preview_path'].is_file()
                    text = app.result.get('1.0', 'end-1c')
                    check_text(text)
                    assert 'Native PDF Quality Report ABC 123' in text
                    chosen = Path(folder).resolve()/'集中輸出 位置'
                    chosen.mkdir()
                    preserved = chosen/'原有文件.txt'
                    preserved.write_text('保留舊資料', encoding='utf-8')
                    with patch('app.filedialog.askdirectory', return_value=str(chosen)):
                        app.choose_output_folder()
                    assert Path(app.output_folder.get()) == chosen
                    with patch('app.filedialog.askdirectory', return_value=''):
                        app.choose_output_folder()
                    assert Path(app.output_folder.get()) == chosen
                    output = chosen / '匯出文字.txt'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(output)) as dialog:
                        app.save_text()
                    assert Path(dialog.call_args.kwargs['initialdir']) == chosen
                    assert output.read_text(encoding='utf-8-sig') == text
                    with patch.object(root, 'clipboard_clear') as clear, patch.object(root, 'clipboard_append') as append:
                        app.copy_text()
                        clear.assert_called_once()
                        append.assert_called_once_with(text)
                    assert len(app.pages) == 6
                    assert len(app.page_info) == len(app.page_ends) == 6
                    assert app.page_info[1] == ('文字與掃描混合.pdf', 1) and app.page_info[2] == ('文字與掃描混合.pdf', 2)
                    assert len(app.tables) == 6 and sum(table is not None for table in app.tables) == 2
                    sheet_ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                    excel = chosen/'批次表格.xlsx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(excel)) as dialog:
                        app.save_excel()
                    assert Path(dialog.call_args.kwargs['initialdir']) == chosen
                    assert '略過 4 頁' in app.status.get()
                    with zipfile.ZipFile(excel) as z:
                        assert z.testzip() is None
                        sheets = sorted(name for name in z.namelist() if name.startswith('xl/worksheets/sheet'))
                        assert len(sheets) == 2 and not any('/media/' in name or '/drawings/' in name for name in z.namelist())
                        for name in sheets:
                            xml = ET.fromstring(z.read(name))
                            cells = {cell.attrib['r']: ''.join(cell.itertext()) for cell in xml.findall('.//s:sheetData/s:row/s:c', sheet_ns)}
                            assert {key:value.casefold() for key,value in cells.items()} == {f'{chr(65+c)}{r+1}': value.casefold() for r,row in enumerate(values) for c,value in enumerate(row)}, cells
                        styles = z.read('xl/styles.xml').decode()
                        assert 'FFFFFF00' in styles and 'FFFCE4D6' in styles
                    with patch('app.os.startfile') as opened:
                        app.open_output()
                    opened.assert_called_once_with(str(excel))
                    excel_last = app.last_output
                    with patch('app.filedialog.asksaveasfilename', return_value=''):
                        app.save_excel()
                    assert app.last_output == excel_last
                    with patch('app.filedialog.asksaveasfilename', return_value=str(chosen/'失敗.xlsx')), patch('app.write_xlsx', side_effect=OSError('locked')), patch('app.messagebox.showerror'):
                        app.save_excel()
                    assert app.last_output == excel_last
                    restored_root = TkinterDnD.Tk()
                    restored_root.withdraw()
                    try:
                        restored = App(restored_root, app_dir)
                        assert restored.last_output == excel
                        restored.layout_cache.cleanup()
                    finally: restored_root.destroy()
                    app.export_scope.set('只匯出選取圖片')
                    app.files.selection_set(grid_keys[0], pdf_key)
                    assert app.export_indices() == [1,2,4]
                    single_excel = chosen/'選取表格.xlsx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(single_excel)):
                        app.save_excel()
                    with zipfile.ZipFile(single_excel) as z:
                        assert len(ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', sheet_ns)) == 1
                    assert '略過 2 頁' in app.status.get()
                    app.files.selection_set(grid_keys[0])
                    app.result.insert(app.page_marks[4], 'EDITED_SELECTED_PAGE\n')
                    app.word_mode.set('文字可編輯（一般段落）')
                    selected_text_word = chosen/'選取修改文字.docx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(selected_text_word)):
                        app.save_word()
                    with zipfile.ZipFile(selected_text_word) as z:
                        content = ''.join(ET.fromstring(z.read('word/document.xml')).itertext())
                        assert 'EDITED_SELECTED_PAGE' in content and 'Widget' in content and 'Native PDF' not in content
                    app.word_mode.set('文字可編輯（保留位置）')
                    app.files.selection_set(grid_keys[0], pdf_key)
                    selected_word = chosen/'選取圖片.docx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(selected_word)):
                        app.save_word()
                    with zipfile.ZipFile(selected_word) as z:
                        assert len([n for n in z.namelist() if n.startswith('word/media/')]) == 3
                        assert 'Native PDF Quality Report ABC 123' in ''.join(ET.fromstring(z.read('word/document.xml')).itertext())
                    slides_ns = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
                    selected_ppt = chosen/'選取簡報.pptx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(selected_ppt)) as dialog:
                        app.save_presentation()
                    assert Path(dialog.call_args.kwargs['initialdir']) == chosen
                    with zipfile.ZipFile(selected_ppt) as z:
                        assert z.testzip() is None
                        names = sorted(name for name in z.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml'))
                        assert len(names) == 3
                        text_nodes = [node.text or '' for name in names for node in ET.fromstring(z.read(name)).findall('.//a:t',slides_ns)]
                        assert 'Widget' in ''.join(text_nodes) and 'Native PDF Quality Report ABC 123' in ''.join(text_nodes)
                        assert sum(len(ET.fromstring(z.read(name)).findall('.//a:tbl',slides_ns)) for name in names) >= 1
                    restored_root = TkinterDnD.Tk()
                    restored_root.withdraw()
                    try:
                        restored = App(restored_root, app_dir)
                        assert restored.last_output == selected_ppt
                        restored.layout_cache.cleanup()
                    finally: restored_root.destroy()
                    ppt_previous = app.last_output
                    with patch('app.os.startfile') as opened: app.open_output()
                    opened.assert_called_once_with(str(selected_ppt))
                    with patch('app.filedialog.asksaveasfilename', return_value=''): app.save_presentation()
                    assert app.last_output == ppt_previous
                    with patch('app.filedialog.asksaveasfilename', return_value=str(chosen/'失敗.pptx')), patch('app.write_pptx', side_effect=OSError('locked')), patch('app.messagebox.showerror'):
                        app.save_presentation()
                    assert app.last_output == ppt_previous
                    app.files.selection_set(image_key)
                    with patch('app.filedialog.asksaveasfilename') as dialog:
                        app.save_excel()
                    dialog.assert_not_called()
                    app.export_scope.set('全部圖片／頁面')
                    picker = app.choose_pages()
                    picker.attributes('-alpha',0)
                    tree = picker.nametowidget('page_list.pages')
                    assert len(tree.get_children()) == 6 and tree.item('2','values')[1:] == ('文字與掃描混合.pdf','第 2 頁')
                    tree.selection_set('2','4')
                    picker.nametowidget('actions.apply').invoke()
                    assert app.export_scope.get() == '只匯出選取頁面' and app.export_indices() == [2,4]
                    picker = app.choose_pages()
                    picker.attributes('-alpha',0)
                    tree = picker.nametowidget('page_list.pages')
                    assert set(tree.selection()) == {'2','4'}
                    controls = {button.cget('text'):button for button in picker.nametowidget('actions').winfo_children()}
                    controls['全選'].invoke()
                    assert len(tree.selection()) == 6
                    controls['取消全選'].invoke()
                    assert not tree.selection()
                    tree.selection_set('1')
                    controls['取消'].invoke()
                    assert app.export_indices() == [2,4], 'Cancelled picker changed the chosen pages'
                    app.selected_pages.add(999)
                    assert app.export_indices() == [2,4] and 999 not in app.selected_pages
                    picked_text = app.export_text([2,4])
                    assert 'EDITED_SELECTED_PAGE' in picked_text and 'Widget' in picked_text and 'Native PDF' not in picked_text
                    for mode in ('editable','original','text'):
                        app.word_mode.set('文字可編輯（一般段落）' if mode=='text' else '文字可編輯（保留位置）')
                        page_word = chosen/f'選取頁面_{mode}.docx'
                        with patch('app.filedialog.asksaveasfilename', return_value=str(page_word)):
                            app.save_word('original' if mode=='original' else None)
                        with zipfile.ZipFile(page_word) as z:
                            content = ''.join(ET.fromstring(z.read('word/document.xml')).itertext())
                            assert 'Native PDF Quality Report' not in content
                            if mode=='text': assert 'EDITED_SELECTED_PAGE' in content
                            else: assert len([n for n in z.namelist() if n.startswith('word/media/')])==2
                    picked_txt = chosen/'選取頁面.txt'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(picked_txt)): app.save_text()
                    assert picked_txt.read_text(encoding='utf-8-sig') == picked_text
                    picked_xlsx = chosen/'選取頁面.xlsx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(picked_xlsx)): app.save_excel()
                    with zipfile.ZipFile(picked_xlsx) as z:
                        assert len(ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', sheet_ns))==1
                    picked_ppt = chosen/'選取頁面.pptx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(picked_ppt)): app.save_presentation()
                    with zipfile.ZipFile(picked_ppt) as z:
                        names = [n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')]
                        assert len(names)==2 and 'Native PDF Quality Report' not in ''.join(''.join(ET.fromstring(z.read(n)).itertext()) for n in names)
                    picker = app.choose_pages()
                    picker.attributes('-alpha',0)
                    tree = picker.nametowidget('page_list.pages')
                    tree.selection_remove(*tree.selection())
                    picker.nametowidget('actions.apply').invoke()
                    assert app.export_indices()==[]
                    for save in (app.save_word,app.save_excel,app.save_presentation,app.save_text):
                        with patch('app.filedialog.asksaveasfilename') as dialog: save()
                        dialog.assert_not_called()
                        assert '選擇頁面' in app.status.get()
                    app.selected_pages = {2,4}
                    app.word_mode.set('文字可編輯（保留位置）')
                    app.export_scope.set('全部圖片／頁面')
                    assert app.export_indices()==list(range(6)) and app.export_text(app.export_indices())==app.result.get('1.0','end-1c')
                    batch_ppt = chosen/'批次簡報.pptx'
                    with patch('app.filedialog.asksaveasfilename', return_value=str(batch_ppt)):
                        app.save_presentation()
                    with zipfile.ZipFile(batch_ppt) as z:
                        names = [name for name in z.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml')]
                        assert len(names) == 6
                    app.result.insert('end', '\n使用者修改 & < > \x01')
                    text = app.result.get('1.0', 'end-1c')
                    assert app.word_mode.get() == '文字可編輯（保留位置）'
                    for label, kind in (('文字可編輯（保留位置）', 'editable'), ('', 'original'), ('文字可編輯（一般段落）', 'text')):
                        if label: app.word_mode.set(label)
                        word = chosen/f'{kind}.docx'
                        with patch('app.filedialog.asksaveasfilename', return_value=str(word)) as dialog:
                            app.save_word('original' if kind == 'original' else None)
                        assert ('不可編輯' in dialog.call_args.kwargs['title']) == (kind == 'original')
                        assert Path(dialog.call_args.kwargs['initialdir']) == chosen
                        with zipfile.ZipFile(word) as z:
                            assert z.testzip() is None
                            xml = ET.fromstring(z.read('word/document.xml'))
                            ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                            content = ''.join(xml.itertext())
                            if kind != 'original': check_text(content)
                            if kind == 'text': assert '使用者修改 & < >' in content and '\x01' not in content
                            else: assert '使用者修改' not in content
                            if kind == 'editable':
                                assert len(xml.findall('.//w:txbxContent', ns)) >= 13
                                assert 'Native PDF Quality Report ABC 123' in content
                            if kind == 'original': assert not xml.findall('.//w:txbxContent', ns)
                            if kind != 'text': assert len([n for n in z.namelist() if n.startswith('word/media/')]) == 6
                    assert app.last_output == word
                    with patch('app.os.startfile') as opened:
                        app.open_output()
                        app.open_output(True)
                    assert [call.args[0] for call in opened.call_args_list] == [str(word),str(chosen)]
                    previous = app.last_output
                    with patch('app.filedialog.asksaveasfilename', return_value=str(chosen/'失敗.docx')), patch('app.write_docx', side_effect=OSError('locked')), patch('app.messagebox.showerror'):
                        app.save_word()
                    assert app.last_output == previous
                    with patch.object(app, 'save_output_settings', side_effect=OSError('read only')):
                        assert '無法記住' in app.remember_output(word)
                    assert preserved.read_text(encoding='utf-8') == '保留舊資料'
                    assert output.is_file() and (chosen/'editable.docx').is_file() and (chosen/'original.docx').is_file()
                    restored_root = TkinterDnD.Tk()
                    restored_root.withdraw()
                    try:
                        restored = App(restored_root, app_dir)
                        assert Path(restored.output_folder.get()) == chosen and restored.last_output == previous
                        restored.layout_cache.cleanup()
                    finally: restored_root.destroy()
                    from word_export import write_docx
                    for kind in ('editable', 'invalid'):
                        try:
                            write_docx(Path(folder)/'must-not-export.docx', [SimpleNamespace(lines=[])], kind)
                            raise AssertionError('Image-only or invalid editable export accepted')
                        except ValueError:
                            pass
                    assert not (Path(folder)/'must-not-export.docx').exists()
                    app.clear_files()
                    assert not app.items and app.result.get('1.0', 'end-1c') == text
                    assert app.preview_image is None and app.preview_photo is None
                    assert len(app.pages) == 6 and len(app.tables) == 6
                    picker = app.choose_pages()
                    picker.attributes('-alpha',0)
                    assert picker.nametowidget('page_list.pages').item('2','values')[1]=='文字與掃描混合.pdf'
                    picker.nametowidget('actions.cancel').invoke()
                    app.export_scope.set('只匯出選取頁面')
                    assert app.export_indices()==[2,4], 'Clearing input files lost recognized page selection'
                    app.messages.put(('text','APPENDED_PAGE\n',colored,'later',1,None,{}))
                    app.poll()
                    assert len(app.pages)==7 and app.export_indices()==[2,4], 'New page was added to an existing chosen subset'
                    app.export_scope.set('全部圖片／頁面')
                    assert app.export_indices()==list(range(7))
                    app.clear_text()
                    assert not app.pages and not app.tables and not app.page_keys and not app.page_marks and not app.page_ends and not app.page_info and not app.slide_analyses and not app.selected_pages
                    for message in [('text','PAGE_FIRST\n',colored,'first',1,None,{}),('text','FAILED_SOURCE_DIAGNOSTIC\n'),('text','UNSELECTED_MIDDLE\n',colored,'first',2,None,{}),('text','PAGE_LAST\n',colored,'last',1,None,{})]:
                        app.messages.put(message)
                    app.poll()
                    app.export_scope.set('只匯出選取頁面')
                    app.selected_pages={0,2}
                    assert app.export_text(app.export_indices())=='PAGE_FIRST\nPAGE_LAST\n'
                    app.result.insert('end','LAST_PAGE_USER_EDIT\n')
                    assert 'LAST_PAGE_USER_EDIT' in app.export_text(app.export_indices())
                    isolated_txt=chosen/'不連續頁面.txt'
                    with patch('app.filedialog.asksaveasfilename',return_value=str(isolated_txt)):app.save_text()
                    assert isolated_txt.read_text(encoding='utf-8-sig')==app.export_text([0,2])
                    app.word_mode.set('文字可編輯（一般段落）')
                    isolated_word=chosen/'不連續頁面.docx'
                    with patch('app.filedialog.asksaveasfilename',return_value=str(isolated_word)):app.save_word()
                    with zipfile.ZipFile(isolated_word)as z:
                        content=''.join(ET.fromstring(z.read('word/document.xml')).itertext())
                        assert 'PAGE_FIRST' in content and 'PAGE_LAST' in content and 'LAST_PAGE_USER_EDIT' in content and 'FAILED_SOURCE_DIAGNOSTIC' not in content and 'UNSELECTED_MIDDLE' not in content
                    app.clear_text()
                    app.export_scope.set('只匯出選取頁面')
                    assert app.export_indices()==[]
                    with patch.object(app.engine, 'extract', return_value=iter([SimpleNamespace(page=1, text='OCR_SUCCESS', layout=colored)])), patch('app.extract_table', side_effect=RuntimeError('table failure')):
                        app.worker([('test', {'name':'test', 'source':invalid})], False)
                    messages = []
                    while not app.messages.empty(): messages.append(app.messages.get_nowait())
                    assert any(msg[0] == 'text' and 'OCR_SUCCESS' in msg[1] and msg[2] is colored for msg in messages)
                    assert ('done', 1, 0, False, 1) in messages
                finally:
                    app.layout_cache.cleanup()
                    root.destroy()
            assert not attempts, attempts
    return {'page_selection_checks': ['native picker with source filename and original PDF page', 'Ctrl or Shift selection, all, clear, apply and cancel', 'chosen mixed PDF page and another file share Word Excel PPT TXT scope', 'empty choice prevents all export dialogs', 'clear input preserves labels, append preserves chosen subset, clear results resets choice', 'TXT and plain Word preserve edits and exclude unselected pages and failed-source messages', 'manual open, missing manual and OS open failure', 'scope row and complete footer fit 900x620 with long paths'], 'ppt_checks': ['batch six-slide native PPT', 'selected three-slide PPT', 'native editable tables and exact table URI', 'two-axis bar/line native chart', 'numeric embedded XLSX and literal categories', 'photo crop pixels unchanged', 'selected plain Word keeps inline edits', 'atomic XLSX/PPT write failure preserves previous files', 'Excel analysis failure preserves successful OCR'], 'output_checks': ['shared Word/Excel/PPT/TXT output folder', 'folder picker and saved location after restart', 'one-click latest PPTX, XLSX, DOCX and folder opening', 'cancel and failure preserve existing outputs', 'settings write failure reported'], 'ok': True, 'checks': ['Traditional Chinese, Simplified Chinese and English image OCR', 'scanned PDF OCR', 'mixed PDF native text and scan OCR', 'force PDF OCR', 'transparent blank image', 'cancel before processing', 'invalid PDF rejected', 'Tk/TkDnD drag and drop', 'Ctrl+V event in result box adds image exactly once', 'consecutive screenshot pastes accumulate', 'clipboard copied file selects image preview', 'visible thumbnail retains full-resolution source', 'preview switches with file selection', 'normal text paste preserved', 'preview and export buttons fit minimum window size', 'PDF first-page preview after recognition', 'GUI background batch', 'TXT export', 'copy text', 'Word editable layout with positioned text', 'Word original-page image layout', 'Word editable plain text', 'six-page DOCX batch', 'two-sheet XLSX with real cells, zeros, fills, no images', 'selected images and PDF pages export to Word/Excel', 'non-table pages skipped, with count', 'clear files preserves results; clear results clears tables', 'network calls blocked; zero attempts'], 'seconds': round(time.perf_counter() - start, 2), 'image_text': image_pages[0].text, 'pdf_methods': [p.method for p in mixed], 'network_attempts': len(attempts)}


if __name__ == '__main__':
    import json
    print(json.dumps(run(), ensure_ascii=False, indent=2))
