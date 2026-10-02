"""Portable Windows GUI. Start with --self-test <report.json> for an offline check."""
from pathlib import Path
import json, os, queue, sys, threading, traceback, tempfile
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from tkinter.scrolledtext import ScrolledText
from tkinterdnd2 import TkinterDnD, DND_FILES
from PIL import Image, ImageGrab, ImageTk
from engine import TextEngine, Cancelled, EXTENSIONS
from word_export import write_docx, rgb_image
from excel_export import extract_table, write_xlsx
from ppt_analysis import analyze_slide
from ppt_export import write_pptx


class App:
    def __init__(self, root, app_dir=None):
        self.root = root
        root.title('中英文文字辨識 — 批次 Word／Excel／PPT 版')
        root.geometry('1040x760')
        root.minsize(900, 620)
        style = ttk.Style(root)
        if 'vista' in style.theme_names(): style.theme_use('vista')
        style.configure('.', font=('Microsoft JhengHei UI', 10))
        self.items = {}
        self.messages = queue.Queue()
        self.cancelled = threading.Event()
        self.busy = False
        self.engine = TextEngine()
        self.layout_cache = tempfile.TemporaryDirectory(prefix='TextOCR-')
        self.pages = []
        self.page_keys = []
        self.page_marks = []
        self.page_ends = []
        self.page_info = []
        self.selected_pages = set()
        self.tables = []
        self.slide_analyses = []
        self.preview_image = None
        self.preview_photo = None
        self.preview_token = None
        self.preview_info = tk.StringVar(value='貼上或選取圖片，即可在這裡預覽。')
        self.word_mode = tk.StringVar(value='文字可編輯（保留位置）')
        self.export_scope = tk.StringVar(value='全部圖片／頁面')
        self.page_selection_info = tk.StringVar(value='頁面選取：0／0')
        self.force_ocr = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value='加入檔案或貼上截圖，再按「開始辨識」。')
        self.app_dir = Path(app_dir or (Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).parent)).resolve()
        self.settings_path = self.app_dir/'settings.json'
        try:
            settings = json.loads(self.settings_path.read_text(encoding='utf-8'))
            if not isinstance(settings, dict): settings = {}
        except (OSError, ValueError): settings = {}
        def location(key, default):
            value = settings.get(key, default)
            try:
                path = Path(value if isinstance(value, str) and value else default)
                return (path if path.is_absolute() else self.app_dir/path).resolve()
            except (OSError, ValueError): return self.app_dir/default
        self.output_folder = tk.StringVar(value=str(location('output_folder', '輸出結果')))
        saved = location('last_output', '輸出結果')
        self.last_output = saved if saved.suffix.lower() in ('.docx', '.xlsx', '.pptx', '.txt') and saved.is_file() else None
        self.copyright_label = ttk.Label(root, text='模塊 © CJ Chen 版權所有', anchor='e')
        self.copyright_label.pack(side='bottom', fill='x', padx=12, pady=(0,4))
        outer = ttk.Frame(root, padding=12)
        outer.pack(fill='both', expand=True)
        ttk.Label(outer, text='把截圖、照片或 PDF 轉成文字', font=('Microsoft JhengHei UI', 17, 'bold')).pack(anchor='w')
        ttk.Label(outer, text='可一次拖入多個檔案，或連續截圖後逐張 Ctrl+V 貼上，再一次辨識。中英文字可混合辨識。').pack(anchor='w', pady=(4, 8))
        toolbar = ttk.Frame(outer)
        toolbar.pack(fill='x')
        self.add_button = ttk.Button(toolbar, text='加入檔案', command=self.choose_files)
        self.add_button.pack(side='left')
        self.paste_button = ttk.Button(toolbar, text='貼上截圖  Ctrl+V', command=self.paste)
        self.paste_button.pack(side='left', padx=6)
        self.start_button = ttk.Button(toolbar, text='開始辨識', command=self.start)
        self.start_button.pack(side='left')
        self.cancel_button = ttk.Button(toolbar, text='取消', command=self.cancel, state='disabled')
        self.cancel_button.pack(side='left', padx=6)
        self.clear_button = ttk.Button(toolbar, text='清空檔案', command=self.clear_files)
        self.clear_button.pack(side='right')
        ttk.Button(toolbar, text='操作手冊', command=self.open_manual).pack(side='right', padx=6)
        self.files = ttk.Treeview(outer, columns=('name', 'state'), show='headings', height=3)
        self.files.heading('name', text='待辨識檔案（可直接拖到這裡）')
        self.files.heading('state', text='狀態')
        self.files.column('name', width=710)
        self.files.column('state', width=125, stretch=False)
        self.files.pack(fill='x', pady=(8, 4))
        self.files.bind('<<TreeviewSelect>>', self.show_selected)
        self.files.drop_target_register(DND_FILES)
        self.files.dnd_bind('<<Drop>>', self.drop)
        root.drop_target_register(DND_FILES)
        root.dnd_bind('<<Drop>>', self.drop)
        self.ocr_check = ttk.Checkbutton(outer, text='PDF 每頁重新辨識（掃描頁已有少量文字、或原有文字亂碼時使用）', variable=self.force_ocr)
        self.ocr_check.pack(anchor='w', pady=2)
        self.progress = ttk.Progressbar(outer, mode='determinate')
        self.progress.pack(fill='x', pady=2)
        ttk.Label(outer, textvariable=self.status, anchor='w').pack(fill='x', pady=(2, 4))
        output_bar = ttk.Frame(outer)
        output_bar.pack(fill='x', pady=(0, 4))
        ttk.Label(output_bar, text='輸出位置：').pack(side='left')
        self.output_entry = ttk.Entry(output_bar, textvariable=self.output_folder, state='readonly')
        self.output_entry.pack(side='left', fill='x', expand=True, padx=(0,6))
        self.output_entry.bind('<Double-Button-1>', lambda event: self.open_output(True))
        ttk.Button(output_bar, text='選擇位置', command=self.choose_output_folder).pack(side='left')
        ttk.Button(output_bar, text='開啟資料夾', command=lambda: self.open_output(True)).pack(side='left', padx=6)
        self.open_file_button = ttk.Button(output_bar, text='開啟最新檔案', command=self.open_output, state='normal' if self.last_output else 'disabled')
        self.open_file_button.pack(side='left')
        self.panes = ttk.Panedwindow(outer, orient='horizontal')
        self.panes.pack(fill='both', expand=True, pady=(3, 5))
        preview_frame = ttk.Frame(self.panes)
        result_frame = ttk.Frame(self.panes)
        self.panes.add(preview_frame, weight=1)
        self.panes.add(result_frame, weight=2)
        ttk.Label(preview_frame, text='圖片預覽').pack(anchor='w')
        self.preview_canvas = tk.Canvas(preview_frame, width=300, height=74, background='#f3f4f6', highlightthickness=1, highlightbackground='#d1d5db')
        self.preview_canvas.pack(fill='both', expand=True, pady=(5, 3))
        self.preview_canvas.bind('<Configure>', self.draw_preview)
        self.preview_canvas.bind('<Button-1>', lambda event: self.preview_canvas.focus_set())
        ttk.Label(preview_frame, textvariable=self.preview_info, wraplength=230).pack(anchor='w')
        ttk.Label(result_frame, text='辨識結果（可以直接編輯）').pack(anchor='w')
        self.result = ScrolledText(result_frame, wrap='word', undo=True, height=5, font=('Microsoft JhengHei UI', 11), padx=10, pady=10)
        self.result.pack(fill='both', expand=True, pady=(5, 0))
        scope_actions = ttk.Frame(outer)
        scope_actions.pack(fill='x', pady=(0,5))
        ttk.Label(scope_actions, text='輸出範圍：').pack(side='left')
        self.scope_box = ttk.Combobox(scope_actions, textvariable=self.export_scope, state='readonly', width=16, values=('全部圖片／頁面', '只匯出選取圖片', '只匯出選取頁面'))
        self.scope_box.pack(side='left', padx=(0,6))
        self.page_button = ttk.Button(scope_actions, text='選擇頁面…', command=self.choose_pages)
        self.page_button.pack(side='left', padx=(0,6))
        ttk.Label(scope_actions, textvariable=self.page_selection_info).pack(side='left')
        actions = ttk.Frame(outer)
        actions.pack(fill='x')
        ttk.Button(actions, text='複製全部文字', command=self.copy_text).pack(side='left')
        ttk.Button(actions, text='匯出 TXT', command=self.save_text).pack(side='left', padx=6)
        self.excel_button = ttk.Button(actions, text='匯出 Excel', command=self.save_excel)
        self.excel_button.pack(side='left', padx=(0,6))
        self.presentation_button = ttk.Button(actions, text='匯出 PPT', command=self.save_presentation)
        self.presentation_button.pack(side='left', padx=(0,6))
        ttk.Button(actions, text='清除結果', command=self.clear_text).pack(side='left')
        ttk.Label(actions, text='本機辨識 · 不需帳號或連線').pack(side='right')
        word_actions = ttk.Frame(outer)
        word_actions.pack(fill='x', pady=(6, 0))
        ttk.Combobox(word_actions, textvariable=self.word_mode, state='readonly', width=29, values=('文字可編輯（保留位置）', '文字可編輯（一般段落）')).pack(side='left')
        self.word_button = ttk.Button(word_actions, text='匯出可編輯 Word', command=self.save_word)
        self.word_button.pack(side='left', padx=6)
        self.original_button = ttk.Button(word_actions, text='原圖 Word（不可編輯）', command=lambda: self.save_word('original'))
        self.original_button.pack(side='right')
        self.export_note = ttk.Label(outer, text='Word 保留位置：文字框可編輯，表格線為圖片。一般段落使用右側文字。Excel：儲存格可編輯。', wraplength=860)
        self.export_note.pack(anchor='w', pady=(3,0))
        for shortcut in ('<Control-v>', '<Control-V>'):
            root.bind(shortcut, self.paste)
            self.result.bind(shortcut, self.paste)
            self.output_entry.bind(shortcut, self.paste)
        root.protocol('WM_DELETE_WINDOW', self.close)
        root.after(80, self.poll)

    def choose_files(self):
        paths = filedialog.askopenfilenames(parent=self.root, title='選擇圖片或 PDF', filetypes=[('圖片與 PDF', '*.pdf *.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff'), ('所有檔案', '*.*')])
        self.add_files(paths)

    def open_manual(self):
        path = self.app_dir/'操作手冊.html'
        if not path.is_file():
            self.status.set('找不到操作手冊，請確認整個 App 資料夾已完整解壓。')
            return
        try: os.startfile(str(path))
        except OSError:
            self.status.set('無法開啟操作手冊，請確認電腦已設定預設瀏覽器。')

    def choose_pages(self):
        if self.busy: return
        if not self.pages:
            self.status.set('請先辨識圖片或 PDF，再選擇要匯出的頁面。')
            return
        self.selected_pages.intersection_update(range(len(self.pages)))
        dialog = tk.Toplevel(self.root)
        dialog.title('選擇匯出頁面')
        dialog.geometry('720x440')
        dialog.minsize(600, 320)
        dialog.transient(self.root)
        ttk.Label(dialog, text=f'共 {len(self.pages)} 頁。按 Ctrl 或 Shift 可多選不同檔案中的頁面。', wraplength=560).pack(anchor='w', padx=12, pady=12)
        frame = ttk.Frame(dialog, name='page_list')
        frame.pack(fill='both', expand=True, padx=12)
        tree = ttk.Treeview(frame, name='pages', columns=('number','source','page'), show='headings', selectmode='extended')
        for key, title, width in (('number','序號',55), ('source','來源圖片／檔案',460), ('page','原檔頁次',110)):
            tree.heading(key, text=title)
            tree.column(key, width=width, stretch=key=='source')
        scroll = ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right', fill='y')
        tree.pack(side='left', fill='both', expand=True)
        for index, (name, number) in enumerate(self.page_info):
            tree.insert('', 'end', iid=str(index), values=(index+1, name, f'第 {number} 頁'))
        tree.selection_set(*(str(index) for index in sorted(self.selected_pages)))
        actions = ttk.Frame(dialog, name='actions')
        actions.pack(fill='x', padx=12, pady=12)
        ttk.Button(actions, text='全選', command=lambda: tree.selection_set(*tree.get_children())).pack(side='left')
        ttk.Button(actions, text='取消全選', command=lambda: tree.selection_remove(*tree.selection())).pack(side='left', padx=6)
        def apply():
            self.selected_pages = {int(index) for index in tree.selection()} & set(range(len(self.pages)))
            self.export_scope.set('只匯出選取頁面')
            self.page_selection_info.set(f'頁面選取：{len(self.selected_pages)}／{len(self.pages)}')
            self.status.set(f'已選取 {len(self.selected_pages)} 頁；Word、Excel、PPT、TXT 都依此範圍匯出。' if self.selected_pages else '尚未選取頁面，請按「選擇頁面…」選取要匯出的內容。')
            dialog.destroy()
        ttk.Button(actions, name='apply', text='套用', command=apply).pack(side='right')
        ttk.Button(actions, name='cancel', text='取消', command=dialog.destroy).pack(side='right', padx=6)
        dialog.grab_set()
        tree.focus_set()
        return dialog

    def save_output_settings(self):
        def portable(path):
            try: return str(path.relative_to(self.app_dir))
            except ValueError: return str(path)
        data = {'output_folder': portable(Path(self.output_folder.get()))}
        if self.last_output: data['last_output'] = portable(self.last_output)
        handle, temporary = tempfile.mkstemp(prefix='.settings-', dir=self.app_dir)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
            Path(temporary).replace(self.settings_path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def choose_output_folder(self):
        current = Path(self.output_folder.get())
        selected = filedialog.askdirectory(parent=self.root, title='選擇輸出資料夾', initialdir=str(current if current.is_dir() else self.app_dir), mustexist=True)
        if not selected: return
        self.output_folder.set(str(Path(selected).resolve()))
        try:
            self.save_output_settings()
            self.status.set('輸出位置已更新，Word、Excel、PPT 與 TXT 都會預設存到這裡。')
        except OSError:
            self.status.set('本次輸出位置已更新；App 資料夾無法寫入，關閉後無法記住設定。')

    def export_directory(self):
        folder = Path(self.output_folder.get())
        folder.mkdir(parents=True, exist_ok=True)
        return str(folder)

    def remember_output(self, path):
        self.last_output = Path(path).resolve()
        self.output_folder.set(str(self.last_output.parent))
        self.open_file_button.configure(state='normal')
        try:
            self.save_output_settings()
            return ''
        except OSError:
            return '（檔案已儲存，但無法記住位置設定。）'

    def open_output(self, folder=False):
        path = Path(self.output_folder.get()) if folder else self.last_output
        if path is None or (not folder and (path.suffix.lower() not in ('.docx', '.xlsx', '.pptx', '.txt') or not path.is_file())):
            self.status.set('請先匯出檔案，再按「開啟最新檔案」。')
            return
        try:
            if folder: path.mkdir(parents=True, exist_ok=True)
            os.startfile(str(path))
        except OSError:
            self.status.set('無法開啟，請確認路徑可用，且電腦有可開啟此檔案的程式。')

    def add_files(self, paths):
        if self.busy: return
        existing = {str(v['source']).casefold(): key for key, v in self.items.items() if isinstance(v['source'], Path)}
        rejected = []
        for value in paths:
            path = Path(value).resolve()
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                rejected.append(path.name)
            elif str(path).casefold() not in existing:
                existing[str(path).casefold()] = self.add_item(path.name, path)
            else:
                self.select_item(existing[str(path).casefold()])
        self.status.set(f'已加入 {len(self.items)} 個項目。' + (f' 略過不支援的檔案：{", ".join(rejected[:3])}' if rejected else ''))

    def add_item(self, name, source):
        key = self.files.insert('', 'end', values=(name, '待辨識'))
        self.items[key] = {'name': name, 'source': source, 'state': '待辨識'}
        self.select_item(key)
        return key

    def select_item(self, key):
        self.files.selection_set(key)
        self.files.focus(key)
        self.files.see(key)
        self.show_selected()

    def show_selected(self, event=None):
        selected = self.files.selection()
        if not selected or selected[0] not in self.items: return
        key = selected[0]
        item = self.items[key]
        token = (key, item.get('preview_path'))
        if token == self.preview_token: return
        self.reset_preview()
        self.preview_token = token
        source = item.get('preview_path', item['source'])
        name = item['name']
        if len(name) > 18: name = name[:9] + '…' + name[-8:]
        if isinstance(source, Path) and source.suffix.lower() == '.pdf':
            self.preview_info.set(name + ' · 辨識完成後顯示第一頁')
            self.draw_preview()
            return
        try:
            if isinstance(source, Image.Image):
                self.preview_image = rgb_image(source)
            else:
                with Image.open(source) as image:
                    self.preview_image = rgb_image(image)
            self.preview_info.set(f'{name} · {self.preview_image.width} × {self.preview_image.height} 像素')
        except (OSError, ValueError):
            self.preview_info.set(name + ' · 無法預覽，請確認圖片格式正確。')
        self.draw_preview()

    def reset_preview(self):
        if self.preview_image is not None: self.preview_image.close()
        self.preview_image = self.preview_photo = self.preview_token = None
        self.preview_info.set('貼上或選取圖片，即可在這裡預覽。')
        self.preview_canvas.delete('all')

    def draw_preview(self, event=None):
        self.preview_canvas.delete('all')
        width, height = self.preview_canvas.winfo_width(), self.preview_canvas.winfo_height()
        if self.preview_image is None:
            self.preview_canvas.create_text(width/2, height/2, text='按 Ctrl+V 貼上圖片\n或選取左上方的檔案', fill='#6b7280', font=('Microsoft JhengHei UI', 10), justify='center')
        elif width > 2 and height > 2:
            thumbnail = self.preview_image.copy()
            thumbnail.thumbnail((max(1,width-16),max(1,height-16)), Image.Resampling.LANCZOS)
            self.preview_photo = ImageTk.PhotoImage(thumbnail, master=self.root)
            self.preview_canvas.create_image(width/2, height/2, image=self.preview_photo, anchor='center')
            thumbnail.close()

    def drop(self, event):
        self.add_files(self.root.tk.splitlist(event.data))
        return event.action

    def paste(self, event=None):
        if self.busy: return 'break'
        try:
            content = ImageGrab.grabclipboard()
            if isinstance(content, Image.Image):
                self.add_item(f'剪貼簿截圖 {sum(isinstance(v["source"], Image.Image) for v in self.items.values()) + 1}', content.copy())
                self.status.set('圖片已貼上並顯示預覽，按「開始辨識」即可。')
            elif isinstance(content, list):
                self.add_files(content)
            elif event is not None and event.widget is self.result:
                return None  # Keep normal text pasting in the editable result box.
            else:
                self.status.set('剪貼簿沒有圖片。請先按 Win + Shift + S 截圖，再按「貼上截圖」。')
        except Exception:
            self.status.set('無法讀取剪貼簿，請重新截圖，或將圖片存檔後加入。')
        return 'break'

    def clear_files(self):
        if self.busy: return
        for item in self.items.values():
            if isinstance(item['source'], Image.Image): item['source'].close()
        self.items.clear()
        for key in self.files.get_children(): self.files.delete(key)
        self.reset_preview()
        self.draw_preview()
        self.status.set('檔案已清空，辨識結果保留。')

    def set_busy(self, busy):
        self.busy = busy
        for widget in (self.add_button, self.paste_button, self.start_button, self.clear_button, self.ocr_check, self.word_button, self.original_button, self.excel_button, self.presentation_button, self.page_button):
            widget.configure(state='disabled' if busy else 'normal')
        self.scope_box.configure(state='disabled' if busy else 'readonly')
        self.cancel_button.configure(state='normal' if busy else 'disabled')

    def start(self):
        if self.busy: return
        pending = [(key, item.copy()) for key, item in self.items.items() if item['state'] != '完成']
        if not pending:
            self.status.set('請加入新的檔案；重做已完成的檔案時，先清空檔案再加入。')
            return
        self.cancelled.clear()
        self.set_busy(True)
        self.status.set('準備辨識，首次載入模型需稍候…')
        threading.Thread(target=self.worker, args=(pending, self.force_ocr.get()), daemon=True).start()

    def worker(self, pending, force_ocr):
        done = errors = table_errors = 0
        try:
            for number, (key, item) in enumerate(pending, 1):
                if self.cancelled.is_set(): break
                self.messages.put(('state', key, '辨識中'))
                progress = lambda page, total, n=number, name=item['name']: self.messages.put(('progress', n, len(pending), name, page, total))
                try:
                    for page in self.engine.extract(item['source'], force_ocr, self.cancelled, progress, self.layout_cache.name):
                        table = None
                        analysis = None
                        if page.layout:
                            try: table = extract_table(page.layout, self.engine.recognize)
                            except ValueError: pass  # Non-table pages still export to Word/TXT.
                            except Exception: table_errors += 1  # Keep successful OCR even if table reconstruction fails.
                            try: analysis = analyze_slide(page.layout, table, self.engine.recognize)
                            except Exception: analysis = {'issues':['此頁圖形無法重建，保留為圖片。']}
                            if analysis.get('tables'): table = analysis['tables'][0]['data']
                        self.messages.put(('text', f'【{item["name"]}｜第 {page.page} 頁】\n{page.text or "（未辨識到文字）"}\n\n', page.layout, key, page.page, table, analysis))
                    self.messages.put(('state', key, '完成'))
                    done += 1
                except Cancelled:
                    self.messages.put(('state', key, '已取消'))
                    break
                except Exception as exc:
                    self.messages.put(('state', key, '失敗'))
                    hint = str(exc) if isinstance(exc, ValueError) else '無法辨識此檔案，請確認內容清晰、格式正確且檔案完整。'
                    self.messages.put(('text', f'【{item["name"]}】\n辨識失敗：{hint}\n\n'))
                    errors += 1
        finally:
            self.messages.put(('done', done, errors, self.cancelled.is_set(), table_errors))

    def poll(self):
        try:
            while True:
                message = self.messages.get_nowait()
                if message[0] == 'state':
                    _, key, state = message
                    self.items[key]['state'] = state
                    self.files.set(key, 'state', state)
                elif message[0] == 'text':
                    if self.page_ends: self.result.mark_gravity(self.page_ends[-1], 'left')
                    if len(message) > 2 and message[2]:
                        mark = f'page_start_{len(self.pages)}'
                        self.result.mark_set(mark, 'end-1c')
                        self.result.mark_gravity(mark, 'left')
                        self.page_marks.append(mark)
                    self.result.insert('end', message[1])
                    self.result.see('end')
                    if len(message) > 2 and message[2]:
                        end = f'page_end_{len(self.pages)}'
                        self.result.mark_set(end, 'end-1c')
                        self.result.mark_gravity(end, 'right')
                        self.page_ends.append(end)
                        self.pages.append(message[2])
                        self.page_keys.append(message[3])
                        self.page_info.append((self.items.get(message[3], {}).get('name', f'項目 {len(self.pages)}'), message[4]))
                        self.selected_pages.intersection_update(range(len(self.pages)))
                        self.page_selection_info.set(f'頁面選取：{len(self.selected_pages)}／{len(self.pages)}')
                        self.tables.append(message[5])
                        self.slide_analyses.append(message[6])
                    if len(message) > 4 and message[2] and message[4] == 1 and message[3] in self.items:
                        key = message[3]
                        if isinstance(self.items[key]['source'], Path) and self.items[key]['source'].suffix.lower() == '.pdf':
                            self.items[key]['preview_path'] = message[2].original
                            if key in self.files.selection(): self.show_selected()
                elif message[0] == 'progress':
                    _, number, count, name, page, total = message
                    self.progress.configure(maximum=count, value=number - 1 + (page - 1) / max(total, 1))
                    self.status.set(f'檔案 {number}/{count} · {name} · 第 {page}/{total} 頁')
                elif message[0] == 'done':
                    _, done, errors, cancelled, table_errors = message
                    self.set_busy(False)
                    if not cancelled: self.progress['value'] = self.progress['maximum']
                    hint = f' {table_errors} 頁表格無法重建，文字仍可匯出 Word。' if table_errors else ''
                    self.status.set(f'{"已取消，完成的結果保留。" if cancelled else "辨識結束。"} 完成 {done} 個，失敗 {errors} 個。{hint}')
        except queue.Empty:
            pass
        self.root.after(80, self.poll)

    def cancel(self):
        self.cancelled.set()
        self.status.set('正在取消，會在目前頁面辨識結束後停止。')

    def copy_text(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.result.get('1.0', 'end-1c'))
        self.status.set('文字已複製。')

    def save_text(self):
        if self.busy: return
        indices = self.export_indices()
        if self.export_scope.get() != '全部圖片／頁面' and not indices: return
        try: folder = self.export_directory()
        except OSError:
            self.status.set('無法寫入輸出資料夾，請按「選擇位置」換一個資料夾。')
            return
        path = filedialog.asksaveasfilename(parent=self.root, title='匯出辨識文字', initialdir=folder, defaultextension='.txt', initialfile='辨識結果.txt', filetypes=[('文字檔', '*.txt')])
        if path:
            try:
                Path(path).write_text(self.export_text(indices), encoding='utf-8-sig')
                note = self.remember_output(path)
                self.status.set(f'已匯出：{path}{note}')
            except OSError:
                messagebox.showerror('無法匯出', '請選擇可寫入的資料夾，並確認檔案沒有被其他程式鎖定。', parent=self.root)

    def clear_text(self):
        if self.busy:
            self.status.set('請等待辨識結束，再清除結果。')
            return
        self.result.delete('1.0', 'end')
        self.pages.clear()
        self.page_keys.clear()
        if self.page_marks: self.result.mark_unset(*self.page_marks)
        if self.page_ends: self.result.mark_unset(*self.page_ends)
        self.page_marks.clear()
        self.page_ends.clear()
        self.page_info.clear()
        self.selected_pages.clear()
        self.page_selection_info.set('頁面選取：0／0')
        self.tables.clear()
        self.slide_analyses.clear()
        for item in self.items.values(): item.pop('preview_path', None)
        self.preview_token = None
        self.show_selected()
        self.layout_cache.cleanup()
        self.layout_cache = tempfile.TemporaryDirectory(prefix='TextOCR-')

    def export_indices(self):
        self.selected_pages.intersection_update(range(len(self.pages)))
        self.page_selection_info.set(f'頁面選取：{len(self.selected_pages)}／{len(self.pages)}')
        if self.export_scope.get() == '全部圖片／頁面': return list(range(len(self.pages)))
        if self.export_scope.get() == '只匯出選取頁面':
            indices = sorted(self.selected_pages)
            if not indices: self.status.set('請按「選擇頁面…」選取已辨識的頁面；按 Ctrl 或 Shift 可多選。')
            return indices
        selected = set(self.files.selection())
        indices = [index for index, key in enumerate(self.page_keys) if key in selected]
        if not indices: self.status.set('請在上方清單選取已辨識的圖片；按 Ctrl 或 Shift 可多選。')
        return indices

    def export_text(self, indices):
        if self.export_scope.get() == '全部圖片／頁面': return self.result.get('1.0', 'end-1c')
        return ''.join(self.result.get(self.page_marks[index], self.page_ends[index]) for index in indices)

    def save_excel(self):
        if self.busy: return
        indices = self.export_indices()
        if self.export_scope.get() != '全部圖片／頁面' and not indices: return
        tables = [self.tables[index] for index in indices if self.tables[index] is not None]
        if not tables:
            self.status.set('請先辨識含完整表格線的圖片或 PDF，再匯出 Excel。')
            return
        try: folder = self.export_directory()
        except OSError:
            self.status.set('無法寫入輸出資料夾，請按「選擇位置」換一個資料夾。')
            return
        path = filedialog.asksaveasfilename(parent=self.root, title='匯出可編輯 Excel（每張表格一個工作表）', initialdir=folder, defaultextension='.xlsx', initialfile='辨識結果.xlsx', filetypes=[('Excel 活頁簿', '*.xlsx')])
        if path:
            try:
                write_xlsx(path, tables)
                note = self.remember_output(path)
                skipped = len(indices)-len(tables)
                hint = f'；略過 {skipped} 頁沒有清楚表格的內容' if skipped else ''
                self.status.set(f'已匯出 {len(tables)} 個可編輯工作表{hint}：{path}{note}')
            except (OSError, ValueError) as exc:
                messagebox.showerror('無法匯出 Excel', str(exc) or '請確認資料夾可寫入，並先關閉已開啟的 Excel 檔案。', parent=self.root)

    def save_presentation(self):
        if self.busy: return
        indices = self.export_indices()
        if not indices:
            if self.export_scope.get() == '全部圖片／頁面': self.status.set('請先辨識圖片或 PDF，再匯出 PPT。')
            return
        try: folder = self.export_directory()
        except OSError:
            self.status.set('無法寫入輸出資料夾，請按「選擇位置」換一個資料夾。')
            return
        path = filedialog.asksaveasfilename(parent=self.root, title='匯出可編輯 PPT（每張圖片／PDF 頁面一張投影片）', initialdir=folder, defaultextension='.pptx', initialfile='辨識結果_可編輯.pptx', filetypes=[('PowerPoint 簡報', '*.pptx')])
        if path:
            try:
                analyses = [self.slide_analyses[index] for index in indices]
                write_pptx(path, [self.pages[index] for index in indices], analyses)
                note = self.remember_output(path)
                charts = sum(len((analysis or {}).get('charts', [])) for analysis in analyses)
                hint = '；部分未判定圖形保留圖片，請核對原圖' if any((analysis or {}).get('issues') for analysis in analyses) else ''
                self.status.set(f'已匯出 {len(indices)} 張可編輯投影片、{charts} 個原生圖表{hint}：{path}{note}')
            except (OSError, ValueError) as exc:
                messagebox.showerror('無法匯出 PPT', str(exc) or '請確認資料夾可寫入，並先關閉已開啟的 PPT 檔案。', parent=self.root)

    def save_word(self, mode=None):
        if self.busy: return
        modes = {'文字可編輯（保留位置）':'editable', '文字可編輯（一般段落）':'text'}
        mode = mode or modes[self.word_mode.get()]
        indices = self.export_indices()
        if self.export_scope.get() != '全部圖片／頁面' and not indices: return
        pages = [self.pages[index] for index in indices]
        if mode != 'text' and not self.pages:
            self.status.set('請先辨識檔案，再匯出 Word。')
            return
        title = '匯出原圖 Word（只有圖片，文字不可編輯）' if mode == 'original' else '匯出可編輯 Word'
        name = '原圖_不可編輯.docx' if mode == 'original' else '辨識結果_可編輯.docx'
        try: folder = self.export_directory()
        except OSError:
            self.status.set('無法寫入輸出資料夾，請按「選擇位置」換一個資料夾。')
            return
        path = filedialog.asksaveasfilename(parent=self.root, title=title, initialdir=folder, defaultextension='.docx', initialfile=name, filetypes=[('Word 文件', '*.docx')])
        if path:
            try:
                text = self.export_text(indices)
                write_docx(path, pages, mode, text)
                note = self.remember_output(path)
                label = '原圖 Word 已匯出（只有圖片，文字不可編輯）' if mode == 'original' else '可編輯 Word 已匯出'
                self.status.set(f'{label}：{path}{note}')
            except (OSError, ValueError) as exc:
                messagebox.showerror('無法匯出 Word', str(exc) or '請確認資料夾可寫入，並先關閉已開啟的 Word 檔案。', parent=self.root)

    def close(self):
        if self.busy and not messagebox.askyesno('關閉', '仍在辨識中。關閉將停止辨識，尚未匯出的結果會遺失。', parent=self.root): return
        self.cancelled.set()
        self.reset_preview()
        if not self.busy: self.layout_cache.cleanup()
        self.root.destroy()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
        from selftest import run
        report = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.cwd() / 'self-test.json'
        try:
            report.write_text(json.dumps(run(), ensure_ascii=False, indent=2), encoding='utf-8')
        except Exception:
            report.write_text(json.dumps({'ok': False, 'error': traceback.format_exc()}, ensure_ascii=False, indent=2), encoding='utf-8')
            sys.exit(1)
        return
    root = TkinterDnD.Tk()
    app = App(root)
    if len(sys.argv) > 1: app.add_files(sys.argv[1:])
    root.mainloop()


if __name__ == '__main__':
    main()
