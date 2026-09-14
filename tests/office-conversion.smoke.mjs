// Opt-in acceptance test: requires a real LibreOffice installation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createDocumentConverter } from "../bridge/document-converter.mjs";

test("real LibreOffice converts DOCX/PPTX and legacy DOC/PPT into readable two-page PDFs", { timeout: 180_000 }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "PaperLens Office 验收 with spaces-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const converter = await createDocumentConverter({ temporaryDirectory, timeoutMs: 40_000 });
  assert.equal(converter.available, true, "Install LibreOffice or set PAPERLENS_SOFFICE_PATH before running test:office-smoke");
  for (const [name, marker] of [["word-sample.docx", "Word page"], ["slides-sample.pptx", "PowerPoint slide"], ["word-sample.doc", "Word page"], ["slides-sample.ppt", "PowerPoint slide"]]) {
    await t.test(name, async () => {
      const bytes = await readFile(new URL(`./fixtures/office/${name}`, import.meta.url));
      const extension = name.slice(name.lastIndexOf("."));
      const signature = bytes.subarray(0, 8).toString("hex");
      if ([".doc", ".ppt"].includes(extension)) assert.equal(signature, "d0cf11e0a1b11ae1", "legacy samples must be binary Office files");
      else assert.ok(signature.startsWith("504b0304"), "modern samples must be OOXML archives");
      const result = await converter.convert(bytes, `课程 notes & sample${extension}`);
      assert.equal(result.fileName, "课程 notes & sample.pdf");
      const loading = getDocument({ data: new Uint8Array(result.pdf), useSystemFonts: true });
      try {
        const pdf = await loading.promise;
        assert.equal(pdf.numPages, 2);
        const pages = [];
        for (let page = 1; page <= pdf.numPages; page += 1) {
          pages.push((await (await pdf.getPage(page)).getTextContent()).items.map((item) => item.str || "").join(" "));
        }
        assert.ok(pages[0].includes(`${marker} one marker`));
        assert.ok(pages[1].includes(`${marker} two marker`));
        assert.ok(pages.join("").replaceAll(" ", "").includes("中文课程资料"));
        assert.deepEqual(await readdir(temporaryDirectory), []);
      } finally {
        await loading.destroy();
      }
    });
  }
});
