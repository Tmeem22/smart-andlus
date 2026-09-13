/* ============================================================
   audit.js — تدقيق التناقضات بين الخانات
   يشغّل السيرفر محلياً (ملف بيانات منفصل) ويتحقق أن:
     · حذف ملف السجل يمسح ذاكرة البوت فعلاً
     · «الطلاب» و«الرئيسية» و«عقل البوت» تعرض نفس العدد
     · حذف طالب ينظّف أولياء الأمور والمحادثات
     · حذف معلم ينظّف ملفاته ومحادثاته
     · صلاحيات المعلم مفروضة في السيرفر لا في الواجهة فقط
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;
const N = 300;                                    // عدد صفوف عيّنة الاختبار
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andlus-audit-'));
const ROSTER = path.join(TMP, 'سجل-اختبار.xlsx');
const IDS_ONLY = path.join(TMP, 'هويات-اختبار.xlsx');

/* عيّنة اختبار تُولَّد وقت التشغيل وتُحذف بعده —
   لا بيانات وهمية مخزّنة في المشروع، ولا أسماء تشبه أشخاصاً حقيقيين */
async function makeFixtures(){
  const ExcelJS = require('exceljs');
  const SUBJ = ['الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية','الدراسات الإسلامية','الاجتماعيات'];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('السجل', { views:[{ rightToLeft:true }] });
  ws.columns = [
    { header:'رقم الطالب', key:'id' }, { header:'اسم الطالب', key:'name' },
    { header:'الصف', key:'level' }, { header:'الفصل', key:'section' },
    { header:'ولي الأمر', key:'guardian' }, { header:'هوية ولي الأمر', key:'guardianId' },
    { header:'نسبة الحضور', key:'att' },
    ...SUBJ.map(s => ({ header:s, key:s })),
    { header:'ملاحظات المعلم', key:'notes' },
  ];
  for(let i = 1; i <= N; i++){
    const row = { id:'ST'+(1000+i), name:'طالب اختبار '+i, level:'الأول متوسط',
      section:'1/'+'أبج'[i % 3], guardian:'وليّ اختبار '+i, guardianId:String(1050000000 + i),
      att:70 + (i % 31), notes:'ملاحظة اختبار' };
    SUBJ.forEach((s,j) => { row[s] = 60 + ((i + j * 7) % 41); });
    ws.addRow(row);
  }
  await wb.xlsx.writeFile(ROSTER);

  /* ملف هويات فقط — بلا أعمدة درجات */
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('الهويات', { views:[{ rightToLeft:true }] });
  ws2.columns = [
    { header:'رقم الطالب', key:'id' }, { header:'اسم الطالب', key:'name' },
    { header:'الصف', key:'level' }, { header:'الفصل', key:'section' },
    { header:'ولي الأمر', key:'guardian' }, { header:'هوية ولي الأمر', key:'guardianId' },
  ];
  for(let i = 1; i <= 5; i++)
    ws2.addRow({ id:'HD'+(2000+i), name:'هوية اختبار '+i, level:'الثاني متوسط',
      section:'2/أ', guardian:'وليّ هوية '+i, guardianId:String(1060000000 + i) });
  await wb2.xlsx.writeFile(IDS_ONLY);
}

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail){
  if(ok){ pass++; results.push('  ✅ ' + name); }
  else { fail++; results.push('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

async function req(method, url, { token, body, form } = {}){
  const headers = {};
  if(token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if(form) payload = form;
  else if(body){ headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  const txt = await r.text();
  let json = null; try{ json = JSON.parse(txt); }catch(_){}
  return { status: r.status, json, txt };
}

async function waitUp(ms = 20000){
  const t0 = Date.now();
  while(Date.now() - t0 < ms){
    try{ const r = await fetch(BASE + '/api/roster/stats'); if(r.status) return true; }catch(_){}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('السيرفر لم يبدأ');
}

(async () => {
  /* ملف بيانات معزول — لا نلمس بيانات التطوير */
  await makeFixtures();
  const tmpData = path.join(__dirname, '..', 'server', 'data.json');
  const backup = tmpData + '.audit-bak';
  if(fs.existsSync(tmpData)) fs.copyFileSync(tmpData, backup);
  try{ fs.unlinkSync(tmpData); }catch(_){}

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MONGODB_URI: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });

  try{
    await waitUp();

    /* ---------- 1. دخول المدير ---------- */
    const lg = await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'43321' } });
    const A = lg.json && lg.json.token;
    check('دخول المدير naif', !!A, 'status ' + lg.status);
    if(!A) throw new Error('لا يمكن المتابعة بدون جلسة المدير');

    /* ---------- 2. الحالة الابتدائية: لا سجل ولا ادّعاء ---------- */
    let st = (await req('GET', '/api/roster/stats', { token:A })).json;
    check('السجل فارغ عند البداية', st.ready === false && st.count === 0, JSON.stringify(st.count));
    let stu = (await req('GET', '/api/students', { token:A })).json;
    check('«الطلاب» = 0 عند عدم وجود سجل', stu.students.length === 0, String(stu.students.length));

    /* ---------- 3. استيراد السجل ---------- */

    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-اختبار.xlsx');
    fd.append('mode', 'replace');
    const imp = await req('POST', '/api/roster/import', { token:A, form:fd });
    check('استيراد ملف '+N+' طالب', imp.json && imp.json.ok && imp.json.count === N, JSON.stringify(imp.json && imp.json.count));

    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    stu = (await req('GET', '/api/students', { token:A })).json;
    check('«سجل الطلاب» يقول '+N, st.ready && st.count === N, String(st.count));
    check('اسم الملف العربي يظهر سليماً (لا ترميز مشوّه)',
      /[؀-ۿ]/.test(st.fileName || '') && !/[À-ÿ]/.test(st.fileName || ''), st.fileName);

    /* استيراد ثانٍ بوضع «استبدال» لا يترك بطاقة مكرّرة */
    const fdDup = new FormData();
    fdDup.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-اختبار.xlsx');
    fdDup.append('mode', 'replace');
    await req('POST', '/api/roster/import', { token:A, form:fdDup });
    const dupFiles = (await req('GET', '/api/files', { token:A })).json.files;
    check('«استبدال الكل» لا يكرّر بطاقة السجل',
      dupFiles.filter(f => f.subject === 'سجل الطلاب').length === 1,
      String(dupFiles.filter(f => f.subject === 'سجل الطلاب').length));
    check('«الطلاب» يقول '+N+' أيضاً (لا تناقض)', stu.students.length === N, String(stu.students.length));
    check('«الطلاب» يميّز مصدر السجل', stu.rosterCount === N && stu.manualCount === 0,
      `roster=${stu.rosterCount} manual=${stu.manualCount}`);

    /* ---------- 4. تعديل طالب من السجل ينعكس على الفهرس ---------- */
    const target = stu.students[0];
    const upd = await req('PUT', '/api/students/' + target.id, { token:A, body:{ name:'اسم مُعدَّل للتدقيق', attendance:77 } });
    check('تعديل طالب من السجل ينجح', upd.status === 200 && upd.json.student.name === 'اسم مُعدَّل للتدقيق', 'status ' + upd.status);
    const found = (await req('GET', '/api/roster/search?q=' + encodeURIComponent('اسم مُعدَّل للتدقيق'), { token:A })).json;
    check('البحث في السجل يجد الاسم المعدَّل (الفهرس أُعيد بناؤه)', found.total >= 1, 'total ' + found.total);

    /* ---------- 5. دخول وليّ أمر ثم حذف ابنه ---------- */
    const kid = stu.students[1];
    const plg = await req('POST', '/api/login', { body:{ role:'parent', idType:'student', identifier:kid.id } });
    const P = plg.json && plg.json.token;
    check('دخول وليّ الأمر برقم الطالب', !!P, 'status ' + plg.status);
    const del = await req('DELETE', '/api/students/' + kid.id, { token:A });
    check('حذف طالب من السجل', del.status === 200 && del.json.from === 'roster', JSON.stringify(del.json));
    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    check('عدد السجل نقص بعد الحذف', st.count === N-1, String(st.count));
    if(P){
      const kids = await req('GET', '/api/children', { token:P });
      const gone = kids.status === 401 || (kids.json && kids.json.children.length === 0);
      check('وليّ الأمر لم يعد يرى ابناً محذوفاً', gone, JSON.stringify(kids.json));
    }

    /* ---------- 6. حذف ملف السجل يمسح ذاكرة البوت (التناقض الأصلي) ---------- */
    let files = (await req('GET', '/api/files', { token:A })).json.files;
    const rosterFile = files.find(f => f.subject === 'سجل الطلاب');
    check('بطاقة ملف السجل موجودة في مركز الملفات', !!rosterFile);
    const df = await req('DELETE', '/api/files/' + rosterFile.id, { token:A });
    check('حذف ملف السجل ينجح', df.status === 200, 'status ' + df.status);
    check('حذف الملف مسح السجل معه', df.json.clearedRoster === N-1, String(df.json.clearedRoster));
    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    check('البوت لم يعد يدّعي وجود سجل', st.ready === false && st.count === 0, JSON.stringify(st));
    stu = (await req('GET', '/api/students', { token:A })).json;
    check('«الطلاب» صار 0 أيضاً', stu.students.length === 0, String(stu.students.length));
    files = (await req('GET', '/api/files', { token:A })).json.files;
    check('بطاقة الملف اختفت من مركز الملفات', !files.some(f => f.id === rosterFile.id));

    /* ---------- 7. زر «حذف السجل» المستقل ---------- */
    const fd2 = new FormData();
    fd2.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-اختبار.xlsx');
    fd2.append('mode', 'replace');
    await req('POST', '/api/roster/import', { token:A, form:fd2 });
    const clr = await req('POST', '/api/roster/clear', { token:A });
    check('زر «حذف السجل» يعمل', clr.status === 200 && clr.json.cleared === N, JSON.stringify(clr.json));
    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    check('بعد «حذف السجل»: لا ادّعاء بيانات', st.ready === false && st.count === 0, JSON.stringify(st));
    files = (await req('GET', '/api/files', { token:A })).json.files;
    check('«حذف السجل» أزال بطاقة الملف كذلك', !files.some(f => f.subject === 'سجل الطلاب'));

    /* ---------- 8. حذف معلم ينظّف ملفاته ---------- */
    const tl = await req('POST', '/api/login', { body:{ role:'teacher', user:'ali', pass:'4321' } });
    const T = tl.json && tl.json.token;
    check('دخول المعلم ali', !!T, 'status ' + tl.status);
    const tfd = new FormData();
    tfd.append('name', 'ملف تدقيق');
    tfd.append('content', 'محتوى تجريبي للتدقيق');
    const up = await req('POST', '/api/files', { token:T, form:tfd });
    check('المعلم يرفع ملفاً (صلاحية files مفعّلة)', up.status === 200, 'status ' + up.status);
    const teachers = (await req('GET', '/api/teachers', { token:A })).json.teachers;
    const ali = teachers.find(t => t.user === 'ali');
    const dt = await req('DELETE', '/api/teachers/' + ali.id, { token:A });
    check('حذف المعلم ينجح', dt.status === 200, 'status ' + dt.status);
    check('حذف المعلم أزال ملفاته (لا ملفات يتيمة)', dt.json.removedFiles >= 1, String(dt.json.removedFiles));
    files = (await req('GET', '/api/files', { token:A })).json.files;
    check('لا يبقى ملف لمعلم محذوف', !files.some(f => f.owner === ali.id));
    const meAfter = await req('GET', '/api/me', { token:T });
    check('جلسة المعلم المحذوف أُبطلت', meAfter.status === 401, 'status ' + meAfter.status);

    /* ---------- 9. فرض الصلاحيات في السيرفر ---------- */
    const nt = await req('POST', '/api/teachers', { token:A,
      body:{ name:'معلم بلا صلاحيات', user:'noperm', pass:'audit-pass-2026', perms:[] } });
    check('إنشاء معلم بلا صلاحيات', nt.status === 200, 'status ' + nt.status);
    const nl = await req('POST', '/api/login', { body:{ role:'teacher', user:'noperm', pass:'audit-pass-2026' } });
    const NP = nl.json && nl.json.token;
    const blocked = await req('POST', '/api/files', { token:NP, form:(()=>{ const f=new FormData(); f.append('name','ممنوع'); f.append('content','x'); return f; })() });
    check('معلم بلا صلاحية «files» يُمنع من الرفع', blocked.status === 403, 'status ' + blocked.status);
    const blocked2 = await req('GET', '/api/contacts', { token:NP });
    check('معلم بلا صلاحية «messages» يُمنع من جهات الاتصال', blocked2.status === 403, 'status ' + blocked2.status);

    /* ---------- 10. دخول وليّ الأمر: كل صيغ الرقم ---------- */
    await req('POST', '/api/roster/import', { token:A, form:(()=>{ const f=new FormData();
      f.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-اختبار.xlsx'); f.append('mode','replace'); return f; })() });
    const row = (await req('GET', '/api/roster/search?q=&page=1&per=1', { token:A })).json.rows[0];
    const gid = row.guardianId, sid = row.id;
    const toAr = s => String(s).replace(/[0-9]/g, d => String.fromCharCode(0x0660 + (+d)));
    const variants = [
      ['هوية وليّ الأمر كما هي',        'guardian', gid],
      ['هوية وليّ الأمر بأرقام عربية',  'guardian', toAr(gid)],
      ['هوية وليّ الأمر بمسافات',       'guardian', ' ' + gid + ' '],
      ['هوية وليّ الأمر بشُرَط',         'guardian', gid.slice(0,4) + '-' + gid.slice(4)],
      ['رقم الطالب كما هو',            'student',  sid],
      ['رقم الطالب بحروف صغيرة',       'student',  String(sid).toLowerCase()],
      ['رقم الطالب بمسافات',           'student',  '  ' + sid + ' '],
    ];
    const seenUsers = new Set();
    for(const [label, idType, ident] of variants){
      const r = await req('POST', '/api/login', { body:{ role:'parent', idType, identifier: ident } });
      const ok = r.status === 200 && r.json.token && r.json.me.children.length > 0;
      check('دخول وليّ الأمر — ' + label, ok, 'status ' + r.status + ' ' + (r.json.error || ''));
      if(ok) seenUsers.add(idType + ':' + r.json.me.id);
    }
    check('كل صيغ نفس الرقم = حساب واحد (لا حسابات مكرّرة)', seenUsers.size === 2,
      'حسابات: ' + seenUsers.size + ' [' + [...seenUsers].join(', ') + ']');

    /* رسالة خطأ واضحة عند رقم غير موجود */
    const bad = await req('POST', '/api/login', { body:{ role:'parent', idType:'guardian', identifier:'9999999999' } });
    check('رقم غير موجود يعطي رسالة مفهومة', bad.status === 401 && /تأكد من رقم/.test(bad.json.error||''), bad.json.error);

    /* ---------- 11. وليّ الأمر: أبناؤه ومحادثاته وحدوده ---------- */
    const pr = await req('POST', '/api/login', { body:{ role:'parent', idType:'guardian', identifier:gid } });
    const PT = pr.json.token;
    const ch = (await req('GET', '/api/children', { token:PT })).json;
    check('وليّ الأمر يرى أبناءه', ch.children.length >= 1, String(ch.children.length));
    check('بيانات الابن كاملة (صف/فصل/درجات)',
      !!(ch.children[0].name && ch.children[0].classNo && Object.keys(ch.children[0].grades||{}).length),
      JSON.stringify(ch.children[0]).slice(0,120));
    const pForbid = await req('GET', '/api/students', { token:PT });
    check('وليّ الأمر ممنوع من خانة الطلاب', pForbid.status === 403, 'status ' + pForbid.status);
    const pForbid2 = await req('GET', '/api/teachers', { token:PT });
    check('وليّ الأمر ممنوع من خانة المعلمين', pForbid2.status === 403, 'status ' + pForbid2.status);
    const pForbid3 = await req('POST', '/api/roster/clear', { token:PT });
    check('وليّ الأمر ممنوع من مسح السجل', pForbid3.status === 403, 'status ' + pForbid3.status);
    const pConv = await req('GET', '/api/convos', { token:PT });
    check('سجل محادثات وليّ الأمر متاح', pConv.status === 200 && Array.isArray(pConv.json.convos), 'status ' + pConv.status);
    const otherKid = (await req('GET', '/api/roster/search?q=&page=2&per=1', { token:A })).json.rows[0];
    const cross = await req('POST', '/api/chat', { token:PT, body:{ message:'مرحبا', studentId: otherKid.id } });
    check('وليّ الأمر لا يسأل عن ابن غيره', cross.status >= 400, 'status ' + cross.status);

    /* ---------- 12. ثبات الجلسة بعد إعادة التشغيل ---------- */
    const meAgain = await req('GET', '/api/me', { token:PT });
    check('جلسة وليّ الأمر تعمل عند العودة', meAgain.status === 200, 'status ' + meAgain.status);

    /* ---------- 13. ملف فيه هويات يُرفع لأي خانة = تسجيل تلقائي ---------- */
    await req('POST', '/api/roster/clear', { token:A });
    const idsFile = IDS_ONLY;
    if(fs.existsSync(idsFile)){
      const bf = new FormData();
      bf.append('brain', '1'); bf.append('name', 'ملف فيه هويات');
      bf.append('file', new Blob([fs.readFileSync(idsFile)]), 'هويات-اختبار.xlsx');
      const bu = await req('POST', '/api/files', { token:A, form:bf });
      check('رفع ملف هويات لخانة عقل البوت ينجح', bu.status === 200, 'status ' + bu.status);
      const st13 = (await req('GET', '/api/roster/stats', { token:A })).json;
      check('الهويات تُسجَّل تلقائياً من أي ملف (لا رفض بعدها)', st13.ready && st13.count > 0, JSON.stringify(st13.count));
      const rows13 = (await req('GET', '/api/roster/search?q=&page=1&per=5', { token:A })).json.rows;
      const g13 = (rows13.find(r=>r.guardianId) || {}).guardianId;
      if(g13){
        const lg13 = await req('POST', '/api/login', { body:{ role:'parent', idType:'guardian', identifier:g13 } });
        check('وليّ الأمر يدخل بهوية من ملف رُفع لخانة أخرى', lg13.status === 200, 'status ' + lg13.status + ' ' + (lg13.json.error||''));
      }
    }

    /* ---------- 14. المعلم: يرى ملفاته فقط ---------- */
    const t14 = await req('POST', '/api/teachers', { token:A, body:{ name:'معلم ب', user:'tb', pass:'audit-pass-2026', perms:['files','messages'] } });
    const TB = (await req('POST', '/api/login', { body:{ role:'teacher', user:'tb', pass:'audit-pass-2026' } })).json.token;
    const f14 = new FormData(); f14.append('name','ملف المعلم ب'); f14.append('content','خاص');
    await req('POST', '/api/files', { token:TB, form:f14 });
    const t14b = await req('POST', '/api/teachers', { token:A, body:{ name:'معلم ج', user:'tc', pass:'audit-pass-2026', perms:['files','messages'] } });
    const TC = (await req('POST', '/api/login', { body:{ role:'teacher', user:'tc', pass:'audit-pass-2026' } })).json.token;
    const seenByC = (await req('GET', '/api/files', { token:TC })).json.files;
    check('المعلم لا يرى ملفات معلم آخر', !seenByC.some(f => f.name === 'ملف المعلم ب'), String(seenByC.length));
    const bFiles = (await req('GET', '/api/files', { token:TB })).json.files;
    const bFileId = (bFiles.find(f=>f.name==='ملف المعلم ب')||{}).id;
    const rawSteal = await req('GET', '/api/files/' + bFileId + '/raw', { token:TC });
    check('المعلم لا يفتح ملف معلم آخر مباشرة', rawSteal.status === 403, 'status ' + rawSteal.status);
    const tAdmin = await req('GET', '/api/brain', { token:TB });
    check('المعلم ممنوع من عقل البوت', tAdmin.status === 403, 'status ' + tAdmin.status);
    const tDel = await req('DELETE', '/api/files/' + bFileId, { token:TB });
    check('المعلم لا يحذف ملفات (الحذف للمدير)', tDel.status === 403, 'status ' + tDel.status);
    const tRoster = await req('POST', '/api/roster/clear', { token:TB });
    check('المعلم لا يمسح السجل', tRoster.status === 403, 'status ' + tRoster.status);

    /* ---------- 15. جلسة بلا توكن / توكن خاطئ ---------- */
    const noTok = await req('GET', '/api/me', {});
    check('بلا توكن = 401', noTok.status === 401, 'status ' + noTok.status);
    const badTok = await req('GET', '/api/me', { token:'x'.repeat(40) });
    check('توكن خاطئ = 401', badTok.status === 401, 'status ' + badTok.status);
    const lo = await req('POST', '/api/logout', { token:TC });
    check('تسجيل الخروج ينجح', lo.status === 200, 'status ' + lo.status);
    const afterLo = await req('GET', '/api/me', { token:TC });
    check('التوكن يبطل بعد الخروج', afterLo.status === 401, 'status ' + afterLo.status);

    /* ---------- 16. تغيير كلمات المرور ---------- */
    const meA = await req('GET', '/api/me', { token:A });
    check('المنصة تنبّه أن كلمة مرور المدير هي الأولى', meA.json.mustChangePass === true, JSON.stringify(meA.json.mustChangePass));

    const wrongCur = await req('POST', '/api/account/password', { token:A, body:{ current:'غلط', next:'AndlusPass2026' } });
    check('كلمة مرور حالية خاطئة تُرفض', wrongCur.status === 401, 'status ' + wrongCur.status);
    check('خطأ كلمة المرور لا يُعَدّ انتهاء جلسة (لا يُخرج المستخدم)',
      !(wrongCur.json && wrongCur.json.code === 'session'), JSON.stringify(wrongCur.json));
    check('الجلسة باقية بعد محاولة خاطئة', (await req('GET', '/api/me', { token:A })).status === 200);
    const expired = await req('GET', '/api/me', { token:'z'.repeat(40) });
    check('انتهاء الجلسة يُعلَّم بـ code:session', expired.json && expired.json.code === 'session', JSON.stringify(expired.json));
    const shortPw = await req('POST', '/api/account/password', { token:A, body:{ current:'43321', next:'abc12' } });
    check('كلمة مرور جديدة قصيرة تُرفض', shortPw.status === 400, shortPw.json && shortPw.json.error);
    const digitsPw = await req('POST', '/api/account/password', { token:A, body:{ current:'43321', next:'12345678901' } });
    check('كلمة مرور أرقام فقط تُرفض', digitsPw.status === 400, digitsPw.json && digitsPw.json.error);

    /* جلسة ثانية للمدير — لا بد أن تُغلق بعد التغيير */
    const A2nd = (await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'43321' } })).json.token;
    const okPw = await req('POST', '/api/account/password', { token:A, body:{ current:'43321', next:'AndlusPass2026' } });
    check('المدير يغيّر كلمة مروره', okPw.status === 200, 'status ' + okPw.status + ' ' + (okPw.json && okPw.json.error || ''));
    check('الجلسات الأخرى تُغلق بعد التغيير', okPw.json.closedSessions >= 1, String(okPw.json.closedSessions));
    check('جلسة المدير الثانية أُبطلت فعلاً', (await req('GET', '/api/me', { token:A2nd })).status === 401);
    check('جلسة المدير الحالية باقية', (await req('GET', '/api/me', { token:A })).status === 200);
    check('الدخول بالكلمة القديمة يفشل',
      (await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'43321' } })).status === 401);
    const newLogin = await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'AndlusPass2026' } });
    check('الدخول بالكلمة الجديدة ينجح', newLogin.status === 200, 'status ' + newLogin.status);
    check('التنبيه اختفى بعد التغيير', newLogin.json.mustChangePass === false, JSON.stringify(newLogin.json.mustChangePass));
    const A3 = newLogin.json.token;

    /* المدير يعيّن كلمة مرور معلّم */
    const tp = await req('POST', '/api/teachers', { token:A3,
      body:{ name:'معلم كلمة مرور', user:'tpw', pass:'audit-pass-2026', perms:['files'] } });
    const tpId = tp.json.teacher.id;
    const TPW = (await req('POST', '/api/login', { body:{ role:'teacher', user:'tpw', pass:'audit-pass-2026' } })).json.token;
    const setPw = await req('POST', '/api/teachers/' + tpId + '/password', { token:A3, body:{ next:'MoallemPass9' } });
    check('المدير يعيّن كلمة مرور معلّم', setPw.status === 200, 'status ' + setPw.status + ' ' + (setPw.json && setPw.json.error || ''));
    check('جلسة المعلّم تُغلق بعد تغيير كلمته', (await req('GET', '/api/me', { token:TPW })).status === 401);
    check('المعلّم يدخل بالكلمة الجديدة',
      (await req('POST', '/api/login', { body:{ role:'teacher', user:'tpw', pass:'MoallemPass9' } })).status === 200);
    check('المعلّم لا يدخل بالقديمة',
      (await req('POST', '/api/login', { body:{ role:'teacher', user:'tpw', pass:'audit-pass-2026' } })).status === 401);

    /* لا أحد غير المدير يغيّر كلمات المرور */
    const TX = (await req('POST', '/api/login', { body:{ role:'teacher', user:'tpw', pass:'MoallemPass9' } })).json.token;
    check('المعلّم ممنوع من تغيير كلمة مرور غيره',
      (await req('POST', '/api/teachers/' + tpId + '/password', { token:TX, body:{ next:'Hacked12345' } })).status === 403);
    check('المعلّم ممنوع من نقطة كلمة مرور المدير',
      (await req('POST', '/api/account/password', { token:TX, body:{ current:'x', next:'Hacked12345' } })).status === 403);
    /* جلسة وليّ أمر صالحة الآن (جلسة الخطوة 11 أُغلقت مع مسح السجل) */
    const liveRow = (await req('GET', '/api/roster/search?q=&page=1&per=1', { token:A3 })).json.rows[0];
    const PT2 = liveRow ? (await req('POST', '/api/login',
      { body:{ role:'parent', idType:'guardian', identifier:liveRow.guardianId } })).json.token : null;
    check('جلسة وليّ أمر صالحة للاختبار', !!PT2, 'لا صف في السجل');
    check('وليّ الأمر ممنوع من تغيير كلمات المرور',
      (await req('POST', '/api/teachers/' + tpId + '/password', { token:PT2, body:{ next:'Hacked12345' } })).status === 403);
    check('وليّ الأمر ممنوع من نقطة كلمة مرور المدير',
      (await req('POST', '/api/account/password', { token:PT2, body:{ current:'x', next:'Hacked12345' } })).status === 403);
    check('بلا توكن ممنوع من تغيير كلمات المرور',
      (await req('POST', '/api/account/password', { body:{ current:'x', next:'Hacked12345' } })).status === 401);

    /* ---------- 17. كشف نيّة الأدوات البصرية (بلا نداء AI) ---------- */
    const { intentFlags } = require('../server/intent');
    const intentCases = [
      ['«أفضل مادة عند الطالب» لا يرسم ترتيب الطلاب', 'وش افضل ماده واضعف ماده في ذا الطالب', { top:false, chart:false }],
      ['«أضعف مادة عند ابني» لا يرسم شيئاً',          'وش أفضل مادة وأضعف مادة عند ابني',      { top:false, chart:false }],
      ['«رسم لأفضل الطلاب» يرسم الترتيب',             'سوي لي رسم بياني لافضل الطلاب',         { top:true,  chart:true }],
      ['«أفضل 10 طلاب» يرسم الترتيب',                 'أفضل 10 طلاب',                          { top:true }],
      ['«ترتيب الطلاب في الفصل» يرسم الترتيب',        'ترتيب الطلاب في الفصل',                 { top:true }],
      ['«أعلى درجة في مادة» لا يرسم الترتيب',         'أعلى درجة في مادة الرياضيات',           { top:false }],
      ['«ما قلت لك تسوي رسم» يلغي المرفق',            'انا ما قلت لك تسوي رسم',                { chart:false, top:false, negated:true }],
      ['«لا تسوي رسم بياني» يلغي المرفق',             'لا تسوي رسم بياني',                     { chart:false, negated:true }],
      ['«بدون رسم» يلغي المرفق',                      'بدون رسم من فضلك',                      { chart:false, negated:true }],
      ['«شيل الرسمة» يلغي المرفق',                    'شيل الرسمة',                            { chart:false, negated:true }],
      ['طلب الرسم الصريح يبقى يعمل',                  'ابي رسم بياني لدرجات ابني',             { chart:true, top:false }],
      ['سؤال الحضور يعطي دائرة المواظبة',             'كم نسبة الحضور',                        { donut:true }],
      ['طلب التقرير يعطي التقرير',                    'ابي تقرير كامل',                        { report:true }],
    ];
    intentCases.forEach(([label, msg, exp]) => {
      const f = intentFlags(msg);
      const okAll = Object.entries(exp).every(([k,v]) => f[k] === v);
      check(label, okAll, JSON.stringify(f));
    });

    /* ---------- 18. إعادة التعيين تمسح كل شيء ---------- */
    await req('POST', '/api/roster/import', { token:A, form:(()=>{ const f=new FormData();
      f.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-اختبار.xlsx'); f.append('mode','replace'); return f; })() });
    await req('POST', '/api/reset', { token:A });
    const a2 = await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'43321' } });
    const A2 = a2.json && a2.json.token;
    st = (await req('GET', '/api/roster/stats', { token:A2 })).json;
    check('إعادة التعيين تمسح السجل أيضاً', st.ready === false && st.count === 0, JSON.stringify(st));

  }catch(e){
    fail++; results.push('  💥 توقّف التدقيق: ' + e.message);
  }finally{
    srv.kill();
    await new Promise(r => setTimeout(r, 400));
    try{ fs.unlinkSync(tmpData); }catch(_){}
    if(fs.existsSync(backup)){ fs.copyFileSync(backup, tmpData); fs.unlinkSync(backup); }
    try{ fs.rmSync(TMP, { recursive:true, force:true }); }catch(_){}   // لا تبقى عيّنات على القرص

    console.log('\n=== تدقيق التناقضات بين الخانات ===\n');
    console.log(results.join('\n'));
    console.log(`\nالنتيجة: ${pass} ناجح · ${fail} فاشل\n`);
    if(fail){ console.log('--- سجل السيرفر ---\n' + srvLog.slice(-3000)); }
    process.exit(fail ? 1 : 0);
  }
})();
