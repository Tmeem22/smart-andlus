/* ============================================================
   test-all.js — اختبار شامل لكل ميزات «ذكاء الأندلس»
   · ينشئ 200 حساب معلّم ويتحقق من تسجيل دخولها
   · يختبر: الاستيراد/الفهرسة · الملفات · الطلاب · عقل البوت
     · شات وليّ الأمر (AI) · شات الإدارة (AI) · المراسلة (Socket) · الإشعارات
   التشغيل:  node scripts/test-all.js
   ============================================================ */
const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8731';
const RUN = Date.now().toString(36);
const results = [];
let passN = 0, failN = 0;
function ok(name, extra){ passN++; results.push('  ✓ ' + name + (extra ? '  — ' + extra : '')); }
function bad(name, err){ failN++; results.push('  ✗ ' + name + '  — ' + (err && err.message || err)); }
async function step(name, fn){ try{ const r = await fn(); ok(name, typeof r === 'string' ? r : ''); return r; } catch(e){ bad(name, e); return null; } }

async function api(method, p, { token, body, form } = {}){
  const headers = {};
  if(token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if(form) payload = form;
  else if(body){ headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const txt = await res.text();
  let j; try{ j = JSON.parse(txt); }catch(_){ j = { raw: txt }; }
  if(!res.ok) throw new Error(`HTTP ${res.status} ${p} :: ${(j.error||txt).slice(0,120)}`);
  return j;
}
/* بثّ SSE وتجميع الرد */
async function chatStream(token, body){
  const res = await fetch(BASE + '/api/chat/stream', { method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token }, body: JSON.stringify(body) });
  if(!res.ok || !res.body) throw new Error('stream HTTP ' + res.status);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', thinks = 0, tokens = 0, done = null, err = null;
  while(true){
    const { done:d, value } = await reader.read(); if(d) break;
    buf += dec.decode(value, { stream:true });
    const blocks = buf.split('\n\n'); buf = blocks.pop();
    for(const blk of blocks){
      const ev = (blk.match(/^event: (.+)$/m)||[])[1];
      const dl = (blk.match(/^data: (.+)$/m)||[])[1]; if(!ev||!dl) continue;
      let data; try{ data = JSON.parse(dl); }catch(_){ continue; }
      if(ev==='think') thinks++; else if(ev==='token'){ tokens++; text += data.d; }
      else if(ev==='done') done = data; else if(ev==='error') err = data;
    }
  }
  if(err) throw new Error(err.error || 'stream error');
  return { text: (done && done.text) || text, thinks, tokens, done };
}
/* تنفيذ متوازٍ محدود */
async function pool(items, n, fn){
  let i = 0, done = 0, okc = 0; const errs = [];
  await Promise.all(Array.from({ length:n }, async () => {
    while(i < items.length){ const idx = i++; try{ await fn(items[idx], idx); okc++; }catch(e){ errs.push(e.message); } done++; }
  }));
  return { okc, errs };
}
const SUBJECTS = ['الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية','الدراسات الإسلامية','الاجتماعيات'];
const sleep = ms => new Promise(r=>setTimeout(r,ms));

(async function main(){
  console.log('\n=== اختبار شامل — ذكاء الأندلس ===  (' + BASE + ')\n');

  /* 1) صحة الخادم + دخول المدير */
  const admin = await step('دخول المدير', async () => {
    const r = await api('POST','/api/login',{ body:{ role:'admin', user:'admin', pass:'1234' } });
    if(!r.token) throw new Error('لا يوجد توكن'); return 'token ok';
  });
  const adminTok = admin ? (await api('POST','/api/login',{ body:{ role:'admin', user:'admin', pass:'1234' } })).token : null;

  /* 2) دخول خاطئ يُرفض */
  await step('رفض دخول بكلمة مرور خاطئة', async () => {
    try{ await api('POST','/api/login',{ body:{ role:'admin', user:'admin', pass:'wrong' } }); throw new Error('قُبل الدخول الخاطئ!'); }
    catch(e){ if(/HTTP 401/.test(e.message)) return '401 كما هو متوقّع'; throw e; }
  });

  /* 3) استيراد الإكسل + الفهرسة */
  await step('استيراد سجل 300 طالب وفهرسته', async () => {
    let st = await api('GET','/api/roster/stats',{ token:adminTok });
    if(!st.ready || st.count < 300){
      const file = path.join(__dirname,'..','data','سجل-الطلاب-300.xlsx');
      if(!fs.existsSync(file)) throw new Error('ملف الإكسل غير موجود — شغّل generate-roster.js');
      const buf = fs.readFileSync(file);
      const fd = new FormData();
      fd.append('file', new Blob([buf],{ type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'سجل-الطلاب-300.xlsx');
      const r = await api('POST','/api/roster/import',{ token:adminTok, form:fd });
      return `استُورد ${r.count} في ${r.ms}ms`;
    }
    return `مفهرس مسبقاً: ${st.count} طالب`;
  });

  /* 4) البحث الفوري في الفهرس */
  await step('بحث فوري بالرقم ST1001', async () => {
    const r = await api('GET','/api/roster/search?q=ST1001',{ token:adminTok });
    if(!r.rows.length) throw new Error('لم يُعثر'); return r.rows[0].name;
  });
  await step('بحث فوري بالاسم', async () => {
    const any = (await api('GET','/api/roster/search?q=&per=1',{ token:adminTok })).rows[0];
    const first = any.name.split(' ')[0];
    const r = await api('GET','/api/roster/search?q='+encodeURIComponent(first),{ token:adminTok });
    if(!r.rows.length) throw new Error('فشل البحث بالاسم'); return `«${first}» ${r.total} نتيجة`;
  });
  await step('إحصاءات محفوظة مسبقاً', async () => {
    const st = (await api('GET','/api/roster/stats',{ token:adminTok })).stats;
    if(!st || !st.عدد_الطلاب) throw new Error('لا إحصاءات');
    return `معدل عام ${st.المعدل_العام}% · متفوقون ${st.عدد_المتفوقين_90}`;
  });

  /* 5) إنشاء 200 حساب معلّم */
  const created = [];
  await step('إنشاء 200 حساب معلّم', async () => {
    const list = Array.from({ length:200 }, (_,i)=>i);
    const { okc, errs } = await pool(list, 25, async (i) => {
      const user = `t_${RUN}_${i}`;
      const r = await api('POST','/api/teachers',{ token:adminTok, body:{
        name:`أ. معلّم اختبار ${i+1}`, user, subject:SUBJECTS[i%SUBJECTS.length],
        nid:'20'+String(10000000+i), pass:'1234', perms:['files','messages'] } });
      created.push({ id:r.teacher.id, user, pass:'1234' });
    });
    if(okc < 200) throw new Error(`أُنشئ ${okc}/200 فقط (${errs.slice(0,2).join('; ')})`);
    return `200/200 حساب`;
  });

  /* 6) تسجيل دخول كل الـ200 */
  await step('تسجيل دخول 200 معلّم', async () => {
    const { okc, errs } = await pool(created, 25, async (t) => {
      const r = await api('POST','/api/login',{ body:{ role:'teacher', user:t.user, pass:t.pass } });
      if(!r.token) throw new Error('no token'); t.token = r.token;
    });
    if(okc < 200) throw new Error(`نجح ${okc}/200 (${errs.slice(0,2).join('; ')})`);
    return `200/200 دخول ناجح`;
  });

  /* 7) قائمة المعلمين تعكس العدد */
  await step('قائمة المعلمين تحوي الحسابات الجديدة', async () => {
    const r = await api('GET','/api/teachers',{ token:adminTok });
    const mine = r.teachers.filter(t=>String(t.user).startsWith('t_'+RUN)).length;
    if(mine < 200) throw new Error(`ظهر ${mine}/200`); return `${r.teachers.length} معلّم إجمالاً`;
  });

  /* 8) تعديل + حذف معلّم */
  await step('تعديل بيانات معلّم', async () => {
    const t = created[0];
    const r = await api('PUT','/api/teachers/'+t.id,{ token:adminTok, body:{ name:'أ. معلّم معدّل', subject:'العلوم' } });
    if(r.teacher.name !== 'أ. معلّم معدّل') throw new Error('لم يُحفظ'); return 'تم';
  });
  await step('حذف معلّم', async () => {
    const t = created.pop();
    await api('DELETE','/api/teachers/'+t.id,{ token:adminTok });
    const r = await api('GET','/api/teachers',{ token:adminTok });
    if(r.teachers.some(x=>x.id===t.id)) throw new Error('لم يُحذف'); return 'تم';
  });

  /* 9) رفع ملف من معلّم (multipart) */
  let teacherFileId = null;
  const teacher0 = created[0];
  await step('رفع ملف من معلّم', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['كشف درجات تجريبي\nطالب أ: 90\nطالب ب: 85'],{ type:'text/plain' }), 'كشف.txt');
    fd.append('name','كشف اختبار آلي');
    const r = await api('POST','/api/files',{ token:teacher0.token, form:fd });
    teacherFileId = r.file.id;
    if(r.file.status !== 'pending') throw new Error('الحالة ليست pending'); return 'pending';
  });
  await step('المعلّم يرى ملفه فقط', async () => {
    const r = await api('GET','/api/files',{ token:teacher0.token });
    if(!r.files.every(f=>f.owner===teacher0.id)) throw new Error('يرى ملفات غيره!'); return `${r.files.length} ملف`;
  });

  /* 10) المدير: قبول/رفض/تعديل + إشعار للمعلّم */
  await step('المدير يقبل ملف المعلّم', async () => {
    const r = await api('PUT','/api/files/'+teacherFileId,{ token:adminTok, body:{ status:'approved' } });
    if(r.file.status !== 'approved') throw new Error('لم يُقبل'); return 'approved';
  });
  await step('المعلّم يستلم إشعار القبول', async () => {
    const r = await api('GET','/api/notifs',{ token:teacher0.token });
    if(!r.notifs.length) throw new Error('لا إشعار'); return r.notifs[0].text;
  });
  await step('المدير يعدّل محتوى ملف', async () => {
    const r = await api('PUT','/api/files/'+teacherFileId,{ token:adminTok, body:{ content:'محتوى معدّل من المدير' } });
    if(r.file.content !== 'محتوى معدّل من المدير') throw new Error('لم يُحفظ'); return 'تم';
  });
  await step('فتح الملف داخل الصفحة (raw)', async () => {
    const res = await fetch(BASE+'/api/files/'+teacherFileId+'/raw?t='+adminTok);
    if(!res.ok) throw new Error('HTTP '+res.status); const t = await res.text();
    if(!t.includes('معدّل')) throw new Error('محتوى غير متطابق'); return 'inline ok';
  });

  /* 11) عقل البوت: تغذية + ظهور */
  await step('تغذية عقل البوت بملف', async () => {
    const fd = new FormData();
    fd.append('brain','1'); fd.append('name','مصدر معرفي آلي');
    fd.append('content','معلومة اختبارية: مدير النشاط هو الأستاذ سعد.');
    const r = await api('POST','/api/files',{ token:adminTok, form:fd });
    if(r.file.status !== 'approved') throw new Error('لم يُعتمد'); return 'approved';
  });
  await step('الملف يظهر في عقل البوت', async () => {
    const r = await api('GET','/api/brain',{ token:adminTok });
    if(!r.files.some(f=>f.name==='مصدر معرفي آلي')) throw new Error('غير موجود'); return `${r.files.length} مصدر`;
  });

  /* 12) الطلاب (النظام القديم): إضافة + تعديل */
  let stuId = null;
  await step('إضافة طالب', async () => {
    const r = await api('POST','/api/students',{ token:adminTok, body:{
      name:'طالب اختبار', grade:'الأول متوسط', classNo:'1/أ', attendance:93, parent:'p1',
      grades:Object.fromEntries(SUBJECTS.map(s=>[s,88])), notes:'اختبار آلي' } });
    stuId = r.student.id; return r.student.id;
  });
  await step('تعديل درجات الطالب', async () => {
    const r = await api('PUT','/api/students/'+stuId,{ token:adminTok, body:{ attendance:99 } });
    if(r.student.attendance !== 99) throw new Error('لم يُحفظ'); return 'تم';
  });

  /* 13) شات وليّ الأمر (AI حقيقي) */
  const parent = await step('دخول وليّ الأمر', async () => {
    const r = await api('POST','/api/login',{ body:{ role:'parent', user:'parent', pass:'1234' } });
    return r.token;
  });
  await step('شات وليّ الأمر: تقرير + رسم (AI)', async () => {
    const kids = await api('GET','/api/children',{ token:parent });
    const sid = kids.children[0].id;
    const r = await chatStream(parent,{ studentId:sid, message:'أعطني تقرير كامل ورسم بياني لدرجات ابني' });
    if(!r.text || r.text.length < 40) throw new Error('رد قصير/فارغ');
    if(!r.done || (!r.done.report && !r.done.chart)) throw new Error('لم تُفعّل أداة بصرية');
    return `${r.text.length} حرف · thinks ${r.thinks} · tools[${r.done.report?'report ':''}${r.done.chart?'chart':''}]`;
  });

  /* 14) شات الإدارة على السجل المفهرس (AI) */
  await step('شات الإدارة: سؤال إحصائي (AI)', async () => {
    const r = await chatStream(adminTok,{ message:'كم عدد الطلاب في المدرسة وما المعدل العام؟' });
    if(!r.text || r.text.length < 20) throw new Error('رد فارغ');
    if(!/300|٣٠٠/.test(r.text)) results.push('    (ملاحظة: لم يُصرّح بالرقم 300 نصّاً)');
    return `${r.text.length} حرف`;
  });
  await step('شات الإدارة: طالب محدّد من السجل (AI)', async () => {
    const r = await chatStream(adminTok,{ message:'أعطني رسم بياني لدرجات الطالب ST1001' });
    if(!r.done || !r.done.student) throw new Error('لم يُطابق طالباً'); return r.done.student.name;
  });

  /* 15) المراسلة اللحظية عبر Socket + الإشعار */
  await step('مراسلة لحظية (Socket) مدير ⇄ معلّم', async () => {
    const t = created[1];
    const sockT = io(BASE, { auth:{ token:t.token }, transports:['websocket'] });
    const sockA = io(BASE, { auth:{ token:adminTok }, transports:['websocket'] });
    await Promise.all([
      new Promise((res,rej)=>{ sockT.on('connect',res); sockT.on('connect_error',rej); setTimeout(()=>rej(new Error('timeout معلّم')),4000); }),
      new Promise((res,rej)=>{ sockA.on('connect',res); sockA.on('connect_error',rej); setTimeout(()=>rej(new Error('timeout مدير')),4000); }),
    ]);
    const got = new Promise((res,rej)=>{ sockT.on('chat:message', m=>{ if(m.text==='رسالة اختبار آلي') res(m); }); setTimeout(()=>rej(new Error('لم تصل الرسالة')),4000); });
    sockA.emit('chat:message',{ to:t.id, text:'رسالة اختبار آلي' });
    const m = await got;
    await sleep(200);
    const nf = await api('GET','/api/notifs',{ token:t.token });
    sockT.close(); sockA.close();
    if(!nf.notifs.some(n=>/رسالة/.test(n.text))) throw new Error('لم يصل إشعار الرسالة');
    return 'وصلت الرسالة + الإشعار';
  });
  await step('سجلّ المحادثة محفوظ (REST)', async () => {
    const t = created[1];
    const r = await api('GET','/api/thread/'+'admin1',{ token:t.token });
    if(!r.messages.length) throw new Error('السجل فارغ'); return `${r.messages.length} رسالة`;
  });
  await step('جهات الاتصال للمدير', async () => {
    const r = await api('GET','/api/contacts',{ token:adminTok });
    if(r.contacts.length < 200) throw new Error(`${r.contacts.length} فقط`); return `${r.contacts.length} جهة`;
  });

  /* 16) الأذونات: معلّم يُمنع من مسارات المدير */
  await step('منع المعلّم من مسار المدير (403)', async () => {
    try{ await api('GET','/api/teachers',{ token:teacher0.token }); throw new Error('لم يُمنع!'); }
    catch(e){ if(/HTTP 403/.test(e.message)) return '403 كما هو متوقّع'; throw e; }
  });
  await step('رفض بلا توكن (401)', async () => {
    try{ await api('GET','/api/students',{}); throw new Error('لم يُرفض!'); }
    catch(e){ if(/HTTP 401/.test(e.message)) return '401'; throw e; }
  });

  /* التقرير النهائي */
  console.log(results.join('\n'));
  console.log('\n----------------------------------------');
  console.log(`النتيجة: ${passN} ناجح · ${failN} فاشل · إجمالي ${passN+failN}`);
  console.log('----------------------------------------\n');
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('\n[[ تعذّر تشغيل الاختبار ]]', e); process.exit(2); });
