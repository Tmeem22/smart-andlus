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

/* قيمة خلية إكسل كنص — exceljs يُرجع كائنات للمعادلات والنص المنسّق والروابط والتواريخ.
   تحويلها بـ String() كان يعطي «[object Object]» فيظنّ البوت أن الملف تالف. */
function cellText(v){
  if(v == null) return '';
  if(v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  if(typeof v !== 'object') return String(v).trim();
  if(Array.isArray(v.richText)) return v.richText.map(p => p.text || '').join('').trim();
  if('result' in v) return cellText(v.result);             // معادلة: نأخذ ناتجها
  if('formula' in v || 'sharedFormula' in v) return '';     // معادلة بلا ناتج محفوظ
  if('text' in v) return cellText(v.text);                  // رابط
  if('error' in v) return '';
  return '';
}
const isNum = s => s !== '' && !isNaN(Number(String(s).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))));
const toNum = s => Number(String(s).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)));
const fmtN  = n => Number.isInteger(n) ? String(n) : n.toFixed(1);

/* ورقة إكسل إلى نص يفهمه البوت:
   ترويسة (قد لا تكون في السطر الأول) + ملخص محسوب على كل الصفوف + الصفوف نفسها.
   الملخص أولاً: حتى لو اقتُطع الباقي تبقى «أعلى/أدنى» صحيحة لكل الملف. */
function sheetToText(ws){
  const grid = [];
  ws.eachRow({ includeEmpty:false }, row => {
    const vals = [];
    row.eachCell({ includeEmpty:true }, (c, i) => { vals[i - 1] = cellText(c.value); });
    grid.push(vals.map(v => v == null ? '' : v));
  });
  const filled = r => r.filter(v => v !== '').length;
  if(!grid.length) return '';

  // الترويسة: أول صف فيه خليتان نصيتان على الأقل ويليه صف بيانات (ضمن أول 15 صفاً)
  let h = grid.findIndex((r, i) => i < 15 && r.filter(v => v !== '' && !isNum(v)).length >= 2 && grid[i + 1] && filled(grid[i + 1]) >= 2);
  if(h < 0){
    // ورقة غير جدولية (غلاف، تعليمات): نصها فقط باختصار
    const txt = grid.map(r => r.filter(Boolean).join(' · ')).filter(Boolean).join('\n').slice(0, 1200);
    return txt ? `## ورقة: ${ws.name}\n${txt}` : '';
  }
  const width = Math.max(...grid.slice(h).map(r => r.length));
  const headers = Array.from({ length:width }, (_, i) => grid[h][i] || `عمود ${i + 1}`);
  const rows = grid.slice(h + 1).filter(r => filled(r) > 0);
  if(!rows.length) return `## ورقة: ${ws.name}\nالأعمدة: ${headers.join(' | ')}\n(بلا صفوف بيانات)`;

  // تصنيف الأعمدة بنوع قيمها (أرقام أم نص) — لا بأسمائها
  const colVals = i => rows.map(r => r[i] || '').filter(v => v !== '');
  const kind = headers.map((_, i) => {
    const vs = colVals(i);
    if(!vs.length) return 'empty';
    return vs.filter(isNum).length / vs.length >= 0.7 ? 'num' : 'text';
  });
  // عمود التسمية: أكثر عمود نصي تنوّعاً (غالباً اسم الطالب)
  let label = -1, best = 0;
  kind.forEach((k, i) => { if(k !== 'text') return; const u = new Set(colVals(i)).size; if(u > best){ best = u; label = i; } });

  const out = [`## ورقة: ${ws.name} — ${rows.length} صف`, `الأعمدة: ${headers.join(' | ')}`];
  const numCols = kind.map((k, i) => k === 'num' ? i : -1).filter(i => i >= 0);
  if(numCols.length){
    out.push(`### ملخص محسوب على كل الصفوف (${rows.length}):`);
    numCols.forEach(i => {
      const clean = rows.filter(r => r[i] !== '' && isNum(r[i]) && (label < 0 || r[label]))
        .map(r => ({ n:toNum(r[i]), who: label >= 0 ? r[label] : '' }));
      if(!clean.length) return;
      const ns = clean.map(p => p.n);
      const avg = ns.reduce((a, b) => a + b, 0) / ns.length;
      let line = `- ${headers[i]}: المتوسط ${fmtN(avg)} · الأعلى ${fmtN(Math.max(...ns))} · الأدنى ${fmtN(Math.min(...ns))} (${ns.length} قيمة)`;
      if(label >= 0){
        const sorted = [...clean].sort((a, b) => b.n - a.n);
        line += `\n  الأعلى: ${sorted.slice(0, 10).map(p => `${p.who} (${fmtN(p.n)})`).join('، ')}`;
        line += `\n  الأدنى: ${sorted.slice(-5).reverse().map(p => `${p.who} (${fmtN(p.n)})`).join('، ')}`;
      }
      out.push(line);
    });
  }
  out.push('### الصفوف:');
  out.push(headers.join(' | '));
  rows.forEach(r => out.push(headers.map((_, i) => r[i] || '').join(' | ')));
  return out.join('\n');
}

async function excelToText(filePath){
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  // الأوراق الجدولية أولاً (فيها البيانات)، ثم أوراق الغلاف والتعليمات
  const parts = wb.worksheets.map(ws => sheetToText(ws)).filter(Boolean);
  parts.sort((a, b) => (b.includes('### الصفوف:') ? 1 : 0) - (a.includes('### الصفوف:') ? 1 : 0));
  return parts.join('\n\n');
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
