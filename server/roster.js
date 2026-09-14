/* ============================================================
   roster.js — «عقل البوت» المفهرس
   يقرأ ملف الإكسل مرّة واحدة فقط عند الاستيراد، ثم يبني:
     · فهرس byId / byName / byClass   (بحث فوري O(1))
     · ملخّص إحصائي محسوب مسبقاً      (يجيب بدون مسح 300 صف)
   بعدها أي سؤال يُجاب من الفهرس مباشرة — لا إعادة قراءة للملف.
   ============================================================ */
const ExcelJS = require('exceljs');
const db = require('./db');

/* الفهارس المقيمة في الذاكرة */
let IDX = { byId:new Map(), byName:new Map(), byClass:new Map(), list:[], stats:null, ready:false };

/* ---------- تطبيع النص العربي للبحث ---------- */
/* الأرقام العربية (٠١٢) والفارسية (۰۱۲) تُحوَّل إلى 012 —
   وليّ الأمر يكتب الهوية بلوحة مفاتيح عربية فتفشل المطابقة بدون هذا */
function arabicDigits(s){
  return s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
          .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}
function norm(s){
  return arabicDigits(String(s == null ? '' : s))
    .replace(/[ً-ْٰ]/g,'')      // تشكيل
    .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/ؤ/g,'و').replace(/ئ/g,'ي')
    .replace(/\s+/g,' ').trim().toLowerCase();
}
/* تطبيع أرقام الهوية: أرقام عربية + إزالة المسافات والشُرَط وأي فاصل */
function normId(s){
  const t = arabicDigits(String(s == null ? '' : s)).trim().toLowerCase();
  const stripped = t.replace(/[\s\-_.،,/\\]/g, '');
  // رقم بحت جاء من إكسل كعدد (1.05e9) أو بأصفار بادئة — نوحّده كنص أرقام
  return stripped;
}

/* ---------- قراءة الإكسل (مرة واحدة) ----------
   خريطة الأعمدة يحدّدها الوكيل الذكي (agent.js) لأنه يفهم أي صياغة للترويسة.
   قائمة HEAD أدناه احتياط فقط حين يتعذّر الوصول للذكاء — لا تُستعمل للفهم. */
const HEAD = {
  id:['رقم الطالب','الرقم','id','رقم'],
  name:['اسم الطالب','الاسم','name'],
  level:['الصف','المرحلة','level'],
  section:['الفصل','الشعبة','section'],
  guardian:['ولي الأمر','ولي الامر','guardian'],
  guardianId:['هوية ولي الأمر','هوية ولي الامر','guardianId'],
  attendance:['نسبة الحضور','الحضور','attendance'],
  avg:['المعدل','المتوسط','avg'],
  notes:['ملاحظات المعلم','ملاحظات','notes'],
};
const KNOWN = new Set(Object.values(HEAD).flat().map(norm));

async function parseWorkbook(filePath, mapping){
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if(!ws) throw new Error('لا توجد ورقة عمل في الملف');

  /* خريطة الأعمدة: من الوكيل الذكي إن وُجدت، وإلا مطابقة الترويسة المعروفة */
  const headers = {};
  const subjectCols = [];
  const useAgent = mapping && typeof mapping === 'object';
  const subjSet = new Set((useAgent && Array.isArray(mapping.subjects) ? mapping.subjects : []).map(norm));
  const roleByHeader = {};
  if(useAgent) ['id','name','level','section','guardian','guardianId','attendance','notes','avg']
    .forEach(k => { if(mapping[k]) roleByHeader[norm(mapping[k])] = k; });

  ws.getRow(1).eachCell((cell, col) => {
    const raw = String(cell.value == null ? '' : cell.value).trim();
    const n = norm(raw);
    if(useAgent){
      if(roleByHeader[n]) headers[roleByHeader[n]] = col;
      else if(subjSet.has(n)) subjectCols.push({ col, name:raw });
      return;
    }
    let matched = null;
    for(const [key, names] of Object.entries(HEAD)){ if(names.map(norm).includes(n)){ matched = key; break; } }
    if(matched) headers[matched] = col;
    else if(raw && !KNOWN.has(n)) subjectCols.push({ col, name:raw });   // أي عمود غير معروف = مادة
  });
  if(!headers.name && !headers.id) throw new Error('لا يوجد عمود «اسم الطالب» ولا «رقم الطالب» في الترويسة');

  const students = [];
  let generatedIds = 0;   // صفوف بلا رقم طالب في الملف — نعطيها رقماً داخلياً، وليست هوية
  ws.eachRow((row, i) => {
    if(i === 1) return;
    const val = c => c ? row.getCell(c).value : null;
    const txt = c => { const v = val(c); return v == null ? '' : String(typeof v === 'object' && v.text ? v.text : v).trim(); };
    const idTxt = txt(headers.id);
    const name = txt(headers.name) || idTxt;   // ملف هويات قد لا يحوي اسماً مع الرقم
    if(!name && !idTxt) return;
    const grades = {};
    subjectCols.forEach(({ col, name:sub }) => {
      const n = Number(val(col));
      if(!isNaN(n) && val(col) !== null && val(col) !== '') grades[sub] = n;
    });
    const gv = Object.values(grades);
    if(!idTxt) generatedIds++;
    students.push({
      id: idTxt || 'ST' + (1000 + i),
      name,
      level: txt(headers.level),
      section: txt(headers.section),
      guardian: txt(headers.guardian),
      guardianId: txt(headers.guardianId),
      attendance: Number(val(headers.attendance)) || 0,
      grades,
      avg: Number(val(headers.avg)) || (gv.length ? Math.round(gv.reduce((a,b)=>a+b,0)/gv.length) : 0),
      notes: txt(headers.notes),
    });
  });
  return { students, subjects: subjectCols.map(s => s.name), generatedIds };
}

/* ---------- بناء الفهارس + الإحصاءات (مرة واحدة) ---------- */
function buildIndex(students, subjects){
  const byId = new Map(), byName = new Map(), byClass = new Map();
  students.forEach(s => {
    byId.set(norm(s.id), s);
    if(normId(s.id) !== norm(s.id)) byId.set(normId(s.id), s);   // نسخة بلا فواصل
    byName.set(norm(s.name), s);
    // فهرسة جزئية: كل كلمة من الاسم تشير للطالب (بحث بالاسم الأول أو العائلة)
    norm(s.name).split(' ').forEach(w => {
      if(w.length < 2) return;
      if(!byName.has('~'+w)) byName.set('~'+w, []);
      byName.get('~'+w).push(s);
    });
    const cls = norm(s.section || s.level);
    if(!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(s);
  });

  /* إحصاءات محسوبة مسبقاً — تُجيب أسئلة عامة بلا مسح */
  const n = students.length || 1;
  const subjAvg = {};
  subjects.forEach(sub => {
    const vals = students.map(s => s.grades[sub]).filter(v => typeof v === 'number');
    subjAvg[sub] = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
  });
  const sorted = [...students].sort((a,b) => b.avg - a.avg);
  const classes = {};
  byClass.forEach((arr, k) => {
    if(!arr.length || !arr[0].section) return;
    classes[arr[0].section] = { عدد:arr.length, معدل:Math.round(arr.reduce((a,b)=>a+b.avg,0)/arr.length) };
  });
  const stats = {
    عدد_الطلاب: students.length,
    المواد: subjects,
    المعدل_العام: Math.round(students.reduce((a,b)=>a+b.avg,0)/n),
    متوسط_الحضور: Math.round(students.reduce((a,b)=>a+b.attendance,0)/n),
    متوسط_كل_مادة: subjAvg,
    الفصول: classes,
    أعلى_10: sorted.slice(0,10).map(s => ({ الاسم:s.name, الفصل:s.section, المعدل:s.avg })),
    أدنى_10: sorted.slice(-10).reverse().map(s => ({ الاسم:s.name, الفصل:s.section, المعدل:s.avg })),
    عدد_المتفوقين_90: students.filter(s => s.avg >= 90).length,
    عدد_تحت_70: students.filter(s => s.avg < 70).length,
  };
  return { byId, byName, byClass, list:students, subjects, stats, ready:true };
}

/* ---------- الاستيراد: القراءة الوحيدة ---------- */
/* دمج طلاب واردين مع الموجودين (مطابقة بالرقم ثم الاسم) — يمكّن ملف هويات + ملفات مواد */
function mergeStudents(existing, incoming){
  const byId = new Map(existing.map(s => [norm(s.id), s]));
  const byName = new Map(existing.map(s => [norm(s.name), s]));
  incoming.forEach(n => {
    const cur = byId.get(norm(n.id)) || byName.get(norm(n.name));
    if(cur){
      ['level','section','guardian','guardianId','notes'].forEach(k => { if(n[k]) cur[k] = n[k]; });
      if(n.attendance) cur.attendance = n.attendance;
      cur.grades = Object.assign(cur.grades || {}, n.grades || {});   // دمج الدرجات
    } else {
      existing.push(n); byId.set(norm(n.id), n); byName.set(norm(n.name), n);
    }
  });
  return existing;
}

async function importFile(filePath, fileName, mode = 'replace', mapping = null){
  const t0 = Date.now();
  const { students: incoming, subjects: incSubjects } = await parseWorkbook(filePath, mapping);
  if(!incoming.length) throw new Error('الملف لا يحتوي على صفوف');
  let students, subjects;
  const prev = db.DB.roster;
  if(mode === 'merge' && prev && Array.isArray(prev.students) && prev.students.length){
    students = mergeStudents(prev.students, incoming);
    subjects = Array.from(new Set([...(prev.subjects || []), ...incSubjects]));
  } else {
    students = incoming; subjects = incSubjects;
  }
  // إعادة حساب المعدّل بعد الدمج
  students.forEach(s => { const g = Object.values(s.grades || {}).filter(v => typeof v === 'number');
    s.avg = g.length ? Math.round(g.reduce((a,b)=>a+b,0)/g.length) : (s.avg || 0); });
  IDX = buildIndex(students, subjects);
  db.DB.roster = { fileName, importedAt:Date.now(), count:students.length, subjects, students, stats:IDX.stats };
  db.saveNow();
  return { count:students.length, subjects, ms:Date.now()-t0, mode, stats:IDX.stats };
}

/* أي ملف إكسل يُرفع لأي خانة: إن كان فيه أعمدة هوية، سجّلها في السجل تلقائياً.
   بدون هذا يرفع المدير ملفاً «فيه الهوية» ثم يُرفض دخول وليّ الأمر — وهو تناقض. */
async function tryAutoIdentities(filePath, fileName, mapping = null){
  let parsed;
  try{ parsed = await parseWorkbook(filePath, mapping); }catch(_){ return null; }
  const { students: incoming } = parsed;
  if(!incoming.length) return null;
  // لا نسجّل إلا إذا وُجدت هوية فعلية: رقم طالب من الملف نفسه أو هوية وليّ أمر
  const withGuardian = incoming.filter(s => s.guardianId).length;
  const withRealId   = incoming.length - parsed.generatedIds;
  if(!withGuardian && !withRealId) return null;
  const prev = db.DB.roster;
  const before = prev && Array.isArray(prev.students) ? prev.students.length : 0;
  const students = (prev && Array.isArray(prev.students) && prev.students.length)
    ? mergeStudents(prev.students, incoming) : incoming;
  const subjects = Array.from(new Set([...((prev && prev.subjects) || []), ...parsed.subjects]));
  students.forEach(s => { const g = Object.values(s.grades || {}).filter(v => typeof v === 'number');
    s.avg = g.length ? Math.round(g.reduce((a,b)=>a+b,0)/g.length) : (s.avg || 0); });
  IDX = buildIndex(students, subjects);
  db.DB.roster = { fileName:(prev && prev.fileName) || fileName, importedAt:Date.now(),
    count:students.length, subjects, students, stats:IDX.stats };
  db.saveNow();
  return { added: students.length - before, total: students.length, guardians: withGuardian };
}

/* مسح السجل والفهرس نهائياً (يحافظ على اتساق ما يقوله البوت) */
function clear(){
  IDX = { byId:new Map(), byName:new Map(), byClass:new Map(), list:[], subjects:[], stats:null, ready:false };
  delete db.DB.roster;
  db.saveNow();
  return true;
}

/* إعادة بناء الفهرس والإحصاءات بعد أي تعديل على الطلاب + حفظ */
function rebuild(){
  const r = db.DB.roster;
  if(!r || !Array.isArray(r.students) || !r.students.length){ return clear(); }
  IDX = buildIndex(r.students, r.subjects || []);
  r.count = r.students.length;
  r.stats = IDX.stats;
  db.saveNow();
  return true;
}

/* تعديل طالب داخل السجل (يبقى الفهرس والإحصاءات متّسقين) */
function updateStudent(id, patch){
  const r = db.DB.roster;
  if(!r || !Array.isArray(r.students)) return null;
  const s = r.students.find(x => norm(x.id) === norm(id));
  if(!s) return null;
  ['name','level','section','guardian','guardianId','notes'].forEach(k => { if(patch[k] != null) s[k] = patch[k]; });
  if(patch.attendance != null) s.attendance = Number(patch.attendance) || 0;
  if(patch.grades && typeof patch.grades === 'object'){
    s.grades = Object.assign(s.grades || {}, patch.grades);
    Object.keys(patch.grades).forEach(k => { if(!r.subjects.includes(k)) r.subjects.push(k); });
  }
  const g = Object.values(s.grades || {}).filter(v => typeof v === 'number');
  s.avg = g.length ? Math.round(g.reduce((a,b)=>a+b,0)/g.length) : 0;
  rebuild();
  return s;
}

/* حذف طالب من السجل */
function removeStudent(id){
  const r = db.DB.roster;
  if(!r || !Array.isArray(r.students)) return false;
  const before = r.students.length;
  r.students = r.students.filter(x => norm(x.id) !== norm(id));
  if(r.students.length === before) return false;
  rebuild();
  return true;
}

/* إعادة بناء الفهرس من data.json عند إقلاع السيرفر (بدون قراءة الإكسل) */
function hydrate(){
  const r = db.DB.roster;
  if(r && Array.isArray(r.students) && r.students.length){
    IDX = buildIndex(r.students, r.subjects || []);
    console.log(`الفهرس جاهز: ${r.count} طالب من «${r.fileName}» (بدون إعادة قراءة الإكسل)`);
  }
}

/* ---------- بحث فوري ---------- */
function findStudents(query, limit = 3){
  if(!IDX.ready) return [];
  const q = norm(query);
  if(!q) return [];
  // مطابقة كاملة مباشرة (اسم أو رقم كامل)
  const exact = IDX.byId.get(q) || IDX.byName.get(q);
  if(exact) return [exact];
  const words = q.split(' ').filter(w => w.length >= 2);
  // مطابقة رمز/كلمة مفردة داخل الجملة (مثل «...الطالب st1001»)
  for(const w of words){
    const byIdHit = IDX.byId.get(w);
    if(byIdHit) return [byIdHit];
    const byNameHit = IDX.byName.get(w);
    if(byNameHit && !Array.isArray(byNameHit)) return [byNameHit];
  }
  const out = new Map();
  // تجميع عبر الكلمات المفهرسة من الاسم
  words.forEach(w => (IDX.byName.get('~'+w) || []).forEach(s => out.set(s.id, s)));
  if(out.size) return [...out.values()].slice(0, limit);
  // احتياط: مطابقة جزئية لكل كلمة على حدة (وليس الجملة كاملة)
  const partial = IDX.list.filter(s => {
    const n = norm(s.name), id = norm(s.id);
    return words.some(w => id.includes(w) || n.includes(w));
  });
  return partial.slice(0, limit);
}
function classOf(name){
  if(!IDX.ready) return null;
  const k = norm(name);
  for(const [key, arr] of IDX.byClass) if(key === k || key.includes(k)) return arr;
  return null;
}
function search(q, page = 1, per = 25){
  const list = q ? findStudents(q, 1000) : IDX.list;
  const start = (page-1)*per;
  return { total:list.length, page, per, rows:list.slice(start, start+per) };
}
const stats = () => IDX.stats;
const ready = () => IDX.ready;
const count = () => IDX.list.length;
const list = () => IDX.list;
/* جلب طالب بالرقم (id) — بحث فوري، يتحمّل الأرقام العربية والفواصل */
const get = (id) => IDX.byId.get(norm(id)) || IDX.byId.get(normId(id)) || null;
/* طلاب وليّ أمر برقم هويته — مطابقة متسامحة مع صيغة الرقم */
const byGuardian = (gid) => {
  const g = normId(gid);
  if(!g) return [];
  return IDX.list.filter(s => normId(s.guardianId) === g);
};

/* اسم الملف الذي بُني منه السجل (لربط حذف الملف بحذف السجل) */
const sourceFile = () => (db.DB.roster && db.DB.roster.fileName) || null;

module.exports = { importFile, hydrate, findStudents, classOf, search, stats, ready, count, norm, normId, list, get,
  byGuardian, clear, rebuild, updateStudent, removeStudent, sourceFile, tryAutoIdentities };
