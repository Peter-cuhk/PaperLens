# Office 转换验收样例

这四份文件是为 PaperLens 原创的合成测试资料，按仓库 MIT 许可证提供，未使用个人论文或课程文件。

| 文件 | 内容 | 预期 PDF |
| --- | --- | --- |
| `word-sample.docx` | 中英文段落、表格、显式分页 | 2 页；`Word page one marker` / `Word page two marker` |
| `slides-sample.pptx` | 中英文文字、表格 | 2 页；`PowerPoint slide one marker` / `PowerPoint slide two marker` |
| `word-sample.doc` | DOCX 样例导出为 Word 97 二进制格式 | 同 DOCX |
| `slides-sample.ppt` | PPTX 样例导出为 PowerPoint 97 二进制格式 | 同 PPTX |

DOCX/PPTX 由 `python-docx` / `python-pptx` 创建；DOC/PPT 通过 LibreOffice 26.8.0.3 的 `--headless --convert-to doc` / `--headless --convert-to ppt` 导出。旧格式文件有实际 OLE/CFB 文件头，并非仅修改扩展名。所有样例均包含 `中文课程资料`，便于检查中文字层。

安装 LibreOffice 后，在项目根目录运行：

```powershell
$env:PAPERLENS_SOFFICE_PATH = 'C:\Program Files\LibreOffice\program\soffice.com'
npm run test:office-smoke
```

验收测试使用含中文／空格的临时目录，以含中文、空格、`&` 的文件名调用真实转换器，再用 PDF.js 校验内容。需要人工复核时，可在 PaperLens 依次导入四份样例，检查两页中的文字、表格和分页。此样例集验证基本兼容性，不代表所有 Office 排版均能无损转换。
