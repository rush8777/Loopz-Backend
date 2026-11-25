import { spawn } from "node:child_process";
import { KnowledgeError } from "./contracts.js";
const MAX_TEXT = 120_000;
const pdfModule = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const parser = `
const { getDocument, VerbosityLevel } = await import(${JSON.stringify(pdfModule)});
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const task = getDocument({
  data: new Uint8Array(Buffer.concat(chunks)), stopAtErrors: true,
  isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
  useWasm: false, isOffscreenCanvasSupported: false, verbosity: VerbosityLevel.ERRORS,
});
let text = "";
try {
  const pdf = await task.promise;
  if (pdf.numPages > 150) throw new Error("pdf_page_limit");
  for (let number = 1; number <= pdf.numPages && text.length < ${MAX_TEXT}; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str.slice(0, ${MAX_TEXT} - text.length) + (item.hasEOL ? "\\n" : " ");
      if (text.length >= ${MAX_TEXT}) break;
    }
    text += "\\n\\n";
    page.cleanup();
  }
} finally { await task.destroy(); }
process.stdout.write(JSON.stringify(text.slice(0, ${MAX_TEXT})));
`;
export function extractPdf(data, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--max-old-space-size=112", "--input-type=module", "-e", parser], {
            env: {},
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            killSignal: "SIGKILL",
            stdio: ["pipe", "pipe", "ignore"],
        });
        const output = [];
        let size = 0;
        child.stdout.on("data", (bytes) => {
            size += bytes.length;
            if (size > MAX_TEXT * 8)
                child.kill("SIGKILL");
            else
                output.push(bytes);
        });
        child.stdin.on("error", () => { });
        child.on("error", () => reject(new KnowledgeError("pdf_extraction_failed")));
        child.on("close", code => {
            if (code !== 0) {
                reject(new KnowledgeError("pdf_extraction_failed"));
                return;
            }
            try {
                const text = JSON.parse(Buffer.concat(output).toString("utf8"));
                if (typeof text !== "string")
                    throw new Error();
                resolve(text);
            }
            catch {
                reject(new KnowledgeError("pdf_extraction_failed"));
            }
        });
        child.stdin.end(data);
    });
}
//# sourceMappingURL=pdf.js.map