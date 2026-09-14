/* ============================================================
   agent.js — «وكيل الملفات» الذكي
   يقرأ ترويسة أي ملف إكسل + عيّنة صفوف، ويقرّر بنفسه:
   أي عمود = رقم الطالب / الاسم / هوية وليّ الأمر / الصف / الفصل / الحضور،
   وأي أعمدة = مواد ودرجات. لا يسأل إلا عند غموض حقيقي، والسؤال بخيارات.
   يستخدم نفس نموذج ومفتاح البوت.
   ============================================================ */
const llm = require('./llm');

const ROLES = ['id','name','level','section','guardian','guardianId','attendance','notes','subject','ignore'];

/* عيّنة من الملف: الترويسة + أول صفوف */
async function sampleSheet(filePath, maxRows = 6){
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if(!ws) throw new Error('لا توجد ورقة عمل في الملف');
  const headers = [];
  ws.getRow(1).eachCell((c, i) => { headers[i-1] = String(c.value == null ? '' : (c.value.text || c.value)).trim(); });
  const rows = [];
  const limit = Math.min(ws.rowCount, maxRows + 1);
  for(let r = 2; r <= limit; r++){
    const row = ws.getRow(r); const vals = [];
    headers.forEach((_, i) => { const v = row.getCell(i+1).value; vals[i] = v == null ? '' : String(v.text || v).trim(); });
    rows.push(vals);
  }
  return { headers: headers.filter(h => h !== undefined), rows, totalRows: Math.max(0, ws.rowCount - 1), sheet: ws.name };
}

const SYS = `أنت «وكيل ملفات» في منصة مدرسية. مهمتك تحليل ترويسة ملف إكسل وتحديد دور كل عمود.

الأدوار المتاحة:
- "id": رقم/معرّف الطالب
- "name": اسم الطالب
- "level": الصف الدراسي (مثل: الثاني متوسط)
- "section": الفصل/الشعبة (مثل: 2/أ)
- "guardian": اسم وليّ الأمر
- "guardianId": رقم هوية وليّ الأمر
- "attendance": نسبة الحضور
- "notes": ملاحظات
- "subject": عمود مادة دراسية فيه درجات
- "ignore": عمود لا يلزم (مثل المعدل المحسوب أو ترقيم تسلسلي)

قواعد صارمة:
1. أعد **JSON فقط** بلا أي شرح أو أسوار كود.
2. الشكل بالضبط:
{"columns":[{"header":"...","role":"..."}],"kind":"identities|grades|mixed","confidence":0.0-1.0,"question":null}
3. "kind": "identities" إذا الملف هويات/تسجيل فقط (بلا درجات)، "grades" إذا درجات مواد أساساً، "mixed" إذا الاثنين.
4. إن كان هناك **غموض حقيقي** يمنع الاستيراد (مثل: لا يتضح أي عمود هو رقم الطالب، أو عمودان يصلحان للاسم)، اجعل:
   "question": {"text":"سؤال قصير بالعربية","options":["خيار 1","خيار 2","خيار 3"]}
   وإلا اجعل "question": null. لا تسأل إن كان بإمكانك الاستنتاج بثقة.
5. كل عمود في الترويسة يجب أن يظهر مرة واحدة في "columns".`;

/* يحلّل الملف ويُرجع خريطة الأعمدة (وربما سؤال بخيارات) */
async function analyzeSheet(filePath, clarify = null){
  const s = await sampleSheet(filePath);
  const preview = s.headers.map((h, i) => `${h || '(بلا عنوان)'} => ${s.rows.map(r => r[i]).filter(v => v !== '').slice(0,3).join(' , ') || '—'}`).join('\n');
  let user = `اسم الورقة: ${s.sheet}\nعدد الصفوف: ${s.totalRows}\n\nالأعمدة وعيّنات قيمها:\n${preview}`;
  // جواب المستخدم عن سؤال سابق — يفهمه الوكيل ويبني الخريطة عليه
  if(clarify && clarify.answer){
    user += `\n\nتوضيح من المستخدم عن سؤالك السابق:\nالسؤال: ${String(clarify.question || '').slice(0, 300)}\nالجواب: ${String(clarify.answer).slice(0, 300)}\nابنِ الخريطة على هذا الجواب، ولا تكرّر السؤال نفسه.`;
  }
  let parsed = null;
  try{
    const raw = await llm.askLLM([{ role:'system', content:SYS }, { role:'user', content:user }]);
    const m = String(raw).match(/\{[\s\S]*\}/);          // انتزع JSON حتى لو أحاطه نص
    if(m) parsed = JSON.parse(m[0]);
  }catch(e){ /* fallback أدناه */ }

  const mapping = { subjects: [] };
  if(parsed && Array.isArray(parsed.columns)){
    parsed.columns.forEach(c => {
      const h = String(c.header || '').trim();
      if(!h || !ROLES.includes(c.role)) return;
      if(c.role === 'subject') mapping.subjects.push(h);
      else if(c.role !== 'ignore' && !mapping[c.role]) mapping[c.role] = h;
    });
  }
  return {
    ok: !!parsed,
    kind: (parsed && parsed.kind) || 'mixed',
    confidence: (parsed && parsed.confidence) || 0,
    question: (parsed && parsed.question && parsed.question.text) ? parsed.question : null,
    mapping,
    headers: s.headers,
    totalRows: s.totalRows,
  };
}

module.exports = { analyzeSheet, sampleSheet, ROLES };
