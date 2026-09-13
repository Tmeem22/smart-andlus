/* ============================================================
   extract.js — استخراج نص قابل للقراءة من الملفات المرفوعة
   يدعم: نص/CSV/JSON/Markdown + Excel (xlsx) عبر exceljs
   الهدف: يقدر البوت «يشوف» محتوى أي ملف يُضاف له.
   ============================================================ */
const fs = require('fs');

const MAX_CHARS = 25000;   // سقف نص الملف الواحد

function isTextLike(name = '', mime = ''){
  return /text\/|json|csv|markdown/.test(mime) || /\.(txt|csv|md|json|tsv|log)$/i.test(name);
}
function isExcel(name = '', mime = ''){
  return /spreadsheet|excel/.test(mime) || /\.(xlsx|xlsm)$/i.test(name);
}
function isPdf(name = '', mime = ''){ return /pdf/.test(mime) || /\.pdf$/i.test(name); }
function isWord(name = '', mime = ''){ return /wordprocessing|msword/.test(mime) || /\.(docx)$/i.test(name); }

/* تحويل ورقة إكسل إلى نص مقروء: ترويسة + صفوف */
async function excelToText(filePath){
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out = [];
  wb.worksheets.forEach(ws => {
    if(!ws || !ws.rowCount) return;
    out.push(`## ورقة: ${ws.name} (${ws.rowCount} صف)`);
    const headers = [];
    ws.getRow(1).eachCell((c, i) => { headers[i] = String(c.value == null ? '' : (c.value.text || c.value)).trim(); });
    out.push('الأعمدة: ' + headers.filter(Boolean).join(' | '));
    const limit = Math.min(ws.rowCount, 400);          // لا نغرق السياق
    for(let r = 2; r <= limit; r++){
      const row = ws.getRow(r); const parts = [];
      row.eachCell((c, i) => {
        const v = c.value == null ? '' : (c.value.text || c.value);
        if(v !== '' && headers[i]) parts.push(`${headers[i]}: ${v}`);
      });
      if(parts.length) out.push(parts.join(' · '));
    }
    if(ws.rowCount > limit) out.push(`… (${ws.rowCount - limit} صف إضافي غير معروض)`);
  });
  return out.join('\n');
}

async function pdfToText(filePath){
  const mod = require('pdf-parse');
  const pdf = typeof mod === 'function' ? mod : (mod.default || mod.pdf);
  const data = await pdf(fs.readFileSync(filePath));
  return String((data && data.text) || '').replace(/\n{3,}/g, '\n\n').trim();
}
async function wordToText(filePath){
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ path: filePath });
  return String((r && r.value) || '').replace(/\n{3,}/g, '\n\n').trim();
}

/* يُرجع نصاً أو '' إن تعذّر */
async function extractText(filePath, name = '', mime = ''){
  try{
    if(isExcel(name, mime))    return (await excelToText(filePath)).slice(0, MAX_CHARS);
    if(isPdf(name, mime))      return (await pdfToText(filePath)).slice(0, MAX_CHARS);
    if(isWord(name, mime))     return (await wordToText(filePath)).slice(0, MAX_CHARS);
    if(isTextLike(name, mime)) return fs.readFileSync(filePath, 'utf8').slice(0, MAX_CHARS);
  }catch(e){ console.error('extract فشل:', e.message); }
  return '';
}

module.exports = { extractText, isExcel, isPdf, isWord, isTextLike, MAX_CHARS };
