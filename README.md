# 中英文文字辨識 TextOCR Portable

把截圖、照片與 PDF 轉成可編輯的中英文字，並匯出 Word、Excel、PPT 或 TXT。這是 Windows x64 免安裝工具，辨識在電腦本機完成，執行時不需要網路、帳號、API 金鑰或 Python，也不扣 Codex 額度。

介面版權標示為「模塊 © CJ Chen 版權所有」。App 原始碼依 MIT 授權公開；第三方程式與模型依各自授權使用。

## 免 EXE 網頁本機辨識

直接開啟 [TextOCR 網頁版](https://ertwer2001.github.io/textocr-portable/)，以新版 Chrome／Edge 貼上截圖或加入 PDF，選擇頁面並匯出 Word、Excel、PPT 或文字，免安裝、免執行 EXE。辨識與版面分析在瀏覽器本機完成，圖片及 PDF 不送至 OCR 伺服器。

首次需要下載網站與辨識模型，約 54 MB；點「準備離線使用」並完成下載後，可在同一瀏覽器離線使用。清除瀏覽器快取後需重新準備。操作與版面限制見 [網頁版說明](docs/README.md)。

## 下載與開啟

到 [GitHub Releases](https://github.com/ertwer2001/textocr-portable/releases/latest) 下載 **TextOCR_Windows_x64.zip**。GitHub 自動產生的 **Source code (zip)** 與 **Source code (tar.gz)** 只有來源碼，不能直接當成 App 執行。

1. 把 ZIP **完整解壓**到電腦或隨身碟中可寫入的資料夾。
2. 雙擊 `TextOCR.exe`。請保留同資料夾的 `_internal`、模型及其他附帶檔案，不要只複製 EXE，也不要直接從 ZIP 內執行。
3. 每次截圖後，在 App 按 `Ctrl+V`；可連續加入多張圖片，或用「加入檔案」一次選多個 PDF、圖片，也可拖入檔案。
4. 按「開始辨識」，選擇匯出範圍與格式，再確認儲存位置。
5. 按「操作手冊」開啟離線網頁說明；閱讀手冊不需要 Office。產生 Office 格式檔案也不需要先安裝 Office，但要開啟或編輯它們，電腦需有支援該格式的程式。

適用 Windows 10／11 64 位元 x64。速度與可處理的檔案量取決於 CPU、記憶體及輸入大小；其他電腦仍需確認相容性。

## Windows 未知發行者提示

目前版本**沒有程式碼簽章**，Windows SmartScreen 可能顯示未知發行者。本專案沒有宣稱已通過安全掃描；SHA256 用來核對檔案是否一致，不能代替安全判斷。

只有在確認下載來源可信、檔案符合預期，且你的電腦或公司政策允許時，才考慮使用提示中的「其他資訊／More info」及「仍要執行」。也可在下載的 ZIP 檔案「內容／Properties」查看是否有「解除封鎖／Unblock」，再完整解壓。公司電腦請依 IT 政策處理；若政策阻擋，請交由 IT 核准，不要停用防護或繞過公司的限制。

## 主要功能

- 辨識繁體中文、簡體中文及英文原文；此工具不會翻譯。
- `Ctrl+V` 貼圖後立即預覽。每截一張就貼上一次，讀取目前剪貼簿，不會批次讀取剪貼簿歷史。
- PDF 優先讀取既有文字，掃描頁使用 OCR；可勾選「PDF 每頁重新辨識」處理亂碼或少量文字的掃描檔。
- 可匯出全部圖片／頁面、選取的來源檔案，或以「選擇頁面…」挑選 PDF 個別頁面及指定截圖。
- Word 提供可編輯的文字框保留位置模式，以及使用修改後文字的一般段落模式。「原圖 Word（不可編輯）」另有獨立按鈕。
- Excel 重建真正的可編輯儲存格，嘗試保留欄寬、列高、底色、框線及可確認的合併。每頁主要表格放在不同工作表；不推測公式或截圖以外的資料。
- PPT 重建文字框、可判定的表格與流程圖。具有完整可見分類及數值的圖表才重建為原生圖表；照片、Logo、複雜示意圖及沒有完整數據的圖表保留圖片。
- Word、Excel、PPT、TXT 共用輸出位置設定，可另存新檔並一鍵開啟最新檔案或資料夾。

OCR 可能辨識錯字或數字，版面是近似還原，不能保證與原稿百分之百相同。請在使用或分享前核對原圖，尤其是編號、數字、圖表與箭頭方向。右側文字修改只套用到 TXT 與一般段落 Word。

## 操作手冊與資料保存

完整操作說明見 [操作手冊.html](操作手冊.html) 和 [使用說明.txt](使用說明.txt)。HTML 可下載後雙擊離線閱讀；GitHub 檔案頁本身顯示的是來源內容。

初次輸出位置是 App 同資料夾的「輸出結果」。設定存於 `settings.json`，目前辨識結果要匯出後才會保存成文件。「清空檔案」及「清除結果」不會刪除輸入原檔或已匯出的文件。本公開倉庫不包含個人設定、使用者文件、公司範例或辨識輸出。

## 從來源碼重建

需要 **Windows x64、Python 3.12** 及開發階段網路連線。先取得本倉庫，在根目錄開啟 PowerShell：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\.venv\Scripts\python.exe prepare_models.py
.\.venv\Scripts\python.exe build.py
```

`prepare_models.py` 下載需要的 ONNX 模型並核對其 SHA256。模型權重沒有放進 Git；Release ZIP 內已包含它們。也可從已下載的 Release 將 `_internal/models` 中的模型複製到本倉庫的 `models` 資料夾，再重建。通用測試圖片與 PDF 已放在 `examples`。

`build.py` 使用 PyInstaller 產生 `dist_final/TextOCR` 可攜式資料夾，附帶模型、範例、來源碼、手冊及授權檔，並產生 `SHA256.json`。開發環境若更換套件，`build.py` 會重新記錄當前版本到 `requirements-lock.txt`；請核對相依版本再發布。

如需執行內建測試，可在重建後的 App 資料夾執行：

```powershell
.\TextOCR.exe --self-test 檢查結果.json
```

測試涵蓋本機辨識、PDF、貼圖及匯出流程；測試結果不等同安全掃描或所有電腦的相容性保證。

## 授權與第三方來源

本 App 的 MIT 授權與原有 `Copyright (c) 2026 TextOCR contributors` 標示保留在 [LICENSE.txt](LICENSE.txt)。介面「模塊 © CJ Chen 版權所有」是作者標示，使用原始碼仍依 MIT 條款。

[licenses](licenses) 保留第三方授權、通知及 GEOS 原始碼封存檔。第三方程式及模型的授權不會因本 App 使用 MIT 而改變；重新散布時，請保留相應授權與通知，並遵守各元件的原始碼提供等要求。不要省略 `licenses` 或擅自改寫其內容。

主要來源：[RapidOCR](https://github.com/RapidAI/RapidOCR)、[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[ONNX Runtime](https://github.com/onnx/onnxruntime)、[pypdfium2](https://github.com/pypdfium2-team/pypdfium2)、[tkinterdnd2](https://github.com/Eliav2/tkinterdnd2)。
