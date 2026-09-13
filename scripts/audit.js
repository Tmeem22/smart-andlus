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
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;
const ROSTER = path.join(__dirname, '..', 'data', 'سجل-الطلاب-300.xlsx');

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
    if(!fs.existsSync(ROSTER)) throw new Error('ملف السجل غير موجود: ' + ROSTER);
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-الطلاب-300.xlsx');
    fd.append('mode', 'replace');
    const imp = await req('POST', '/api/roster/import', { token:A, form:fd });
    check('استيراد ملف 300 طالب', imp.json && imp.json.ok && imp.json.count === 300, JSON.stringify(imp.json && imp.json.count));

    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    stu = (await req('GET', '/api/students', { token:A })).json;
    check('«سجل الطلاب» يقول 300', st.ready && st.count === 300, String(st.count));
    check('«الطلاب» يقول 300 أيضاً (لا تناقض)', stu.students.length === 300, String(stu.students.length));
    check('«الطلاب» يميّز مصدر السجل', stu.rosterCount === 300 && stu.manualCount === 0,
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
    check('عدد السجل نقص بعد الحذف', st.count === 299, String(st.count));
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
    check('حذف الملف مسح السجل معه', df.json.clearedRoster === 299, String(df.json.clearedRoster));
    st = (await req('GET', '/api/roster/stats', { token:A })).json;
    check('البوت لم يعد يدّعي وجود سجل', st.ready === false && st.count === 0, JSON.stringify(st));
    stu = (await req('GET', '/api/students', { token:A })).json;
    check('«الطلاب» صار 0 أيضاً', stu.students.length === 0, String(stu.students.length));
    files = (await req('GET', '/api/files', { token:A })).json.files;
    check('بطاقة الملف اختفت من مركز الملفات', !files.some(f => f.id === rosterFile.id));

    /* ---------- 7. زر «حذف السجل» المستقل ---------- */
    const fd2 = new FormData();
    fd2.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-الطلاب-300.xlsx');
    fd2.append('mode', 'replace');
    await req('POST', '/api/roster/import', { token:A, form:fd2 });
    const clr = await req('POST', '/api/roster/clear', { token:A });
    check('زر «حذف السجل» يعمل', clr.status === 200 && clr.json.cleared === 300, JSON.stringify(clr.json));
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
      body:{ name:'معلم بلا صلاحيات', user:'noperm', pass:'1234', perms:[] } });
    check('إنشاء معلم بلا صلاحيات', nt.status === 200, 'status ' + nt.status);
    const nl = await req('POST', '/api/login', { body:{ role:'teacher', user:'noperm', pass:'1234' } });
    const N = nl.json && nl.json.token;
    const blocked = await req('POST', '/api/files', { token:N, form:(()=>{ const f=new FormData(); f.append('name','ممنوع'); f.append('content','x'); return f; })() });
    check('معلم بلا صلاحية «files» يُمنع من الرفع', blocked.status === 403, 'status ' + blocked.status);
    const blocked2 = await req('GET', '/api/contacts', { token:N });
    check('معلم بلا صلاحية «messages» يُمنع من جهات الاتصال', blocked2.status === 403, 'status ' + blocked2.status);

    /* ---------- 10. إعادة التعيين تمسح كل شيء ---------- */
    await req('POST', '/api/roster/import', { token:A, form:(()=>{ const f=new FormData();
      f.append('file', new Blob([fs.readFileSync(ROSTER)]), 'سجل-الطلاب-300.xlsx'); f.append('mode','replace'); return f; })() });
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

    console.log('\n=== تدقيق التناقضات بين الخانات ===\n');
    console.log(results.join('\n'));
    console.log(`\nالنتيجة: ${pass} ناجح · ${fail} فاشل\n`);
    if(fail){ console.log('--- سجل السيرفر ---\n' + srvLog.slice(-3000)); }
    process.exit(fail ? 1 : 0);
  }
})();
