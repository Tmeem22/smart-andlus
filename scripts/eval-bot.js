/* ============================================================
   eval-bot.js — تقييم فهم البوت بالنموذج الحقيقي (يستهلك نداءات AI)
   لا قوائم كلمات في السيرفر: هذا يقيس هل يفهم الذكاء نفسه
   متى يُرفق رسماً أو تقريراً، وعن أي طالب، ومتى يمتنع.
   التشغيل:  node scripts/eval-bot.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4621;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andlus-eval-'));
const NAMES = ['ريان','ليان','مازن','جود','فارس','لمى','عمر','سديم','يزن','رهف','نواف','غلا'];

async function fixture(){
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('السجل');
  ws.columns = ['رقم الطالب','اسم الطالب','الصف','الفصل','ولي الأمر','هوية ولي الأمر','نسبة الحضور','الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية']
    .map(h => ({ header:h, key:h }));
  NAMES.forEach((n, k) => {
    const i = k + 1;
    ws.addRow({ 'رقم الطالب':'ST'+(1000+i), 'اسم الطالب':n+' التجريبي', 'الصف':'الأول متوسط', 'الفصل':'1/أ',
      'ولي الأمر':'وليّ '+n, 'هوية ولي الأمر':String(1050000000+i), 'نسبة الحضور':78+i,
      'الرياضيات':55+i*3, 'العلوم':95-i*2, 'اللغة العربية':70+(i%5)*4, 'اللغة الإنجليزية':62+i*2 });
  });
  const f = path.join(TMP, 'eval.xlsx'); await wb.xlsx.writeFile(f); return f;
}

async function req(method, url, { token, body, form } = {}){
  const headers = {}; if(token) headers.Authorization = 'Bearer ' + token;
  let payload = form;
  if(body){ headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body:payload });
  return { status:r.status, json: await r.json().catch(() => null) };
}

/* يرسل سؤالاً عبر البثّ الحقيقي ويجمع النص المعروض والقرار النهائي */
async function ask(token, body){
  const r = await fetch(BASE + '/api/chat/stream', { method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token }, body:JSON.stringify(body) });
  const raw = await r.text();
  let shown = '', done = null, err = null;
  raw.split('\n\n').forEach(blk => {
    const ev = (blk.match(/^event: (.+)$/m) || [])[1], dl = (blk.match(/^data: (.+)$/m) || [])[1];
    if(!ev || !dl) return;
    const d = JSON.parse(dl);
    if(ev === 'token') shown += d.d; else if(ev === 'done') done = d; else if(ev === 'error') err = d.error;
  });
  return { shown, done, err };
}

const rows = []; let pass = 0, total = 0;
function judge(label, q, res, exp){
  total++;
  const d = res.done || {};
  const got = ['chart','donut','report','top'].filter(k => d[k]);
  const problems = [];
  if(res.err) problems.push('خطأ: ' + res.err);
  ['chart','donut','report','top'].forEach(k => {
    if(exp[k] === true && !d[k]) problems.push('لم يُرفق ' + k);
    if(exp[k] === false && d[k]) problems.push('أرفق ' + k + ' بلا طلب');
  });
  // رقم الطالب يلزم حين يُرفق شيء عن طالب (لرسم الطالب الصحيح)
  const studentTool = d.chart || d.donut || d.report;
  if(exp.student && studentTool && (!d.student || d.student.id !== exp.student)) problems.push('المرفق لطالب ' + (d.student ? d.student.id : 'غير محدّد') + ' بدل ' + exp.student);
  if(/<<|مرفقات\s*:/.test(res.shown)) problems.push('سطر القرار ظهر للمستخدم');
  if(exp.notMention && exp.notMention.some(n => (d.text || '').includes(n))) problems.push('ذكر طالباً آخر');
  const ok = !problems.length; if(ok) pass++;
  rows.push(`${ok ? '✅' : '❌'} ${label}\n    س: ${q}\n    المرفقات: ${got.join('،') || 'لا'}${d.student ? ' | الطالب: ' + d.student.id : ''}`
    + `\n    الرد: ${(d.text || '').replace(/\s+/g, ' ').slice(0, 110)}…${ok ? '' : '\n    ⚠ ' + problems.join(' · ')}`);
}

(async () => {
  const file = await fixture();
  const dataFile = path.join(__dirname, '..', 'server', 'data.json');
  const bak = dataFile + '.eval-bak';
  if(fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bak);
  try{ fs.unlinkSync(dataFile); }catch(_){}
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')],
    { env:{ ...process.env, PORT:String(PORT), MONGODB_URI:'', AI_IMPORT:'off' }, stdio:'ignore' });
  try{
    for(let i = 0; i < 60; i++){ try{ await fetch(BASE + '/api/roster/stats'); break; }catch(_){ await new Promise(r => setTimeout(r, 300)); } }
    const A = (await req('POST', '/api/login', { body:{ role:'admin', user:'naif', pass:'43321' } })).json.token;
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(file)]), 'eval.xlsx'); fd.append('mode', 'replace');
    await req('POST', '/api/roster/import', { token:A, form:fd });

    /* ---- الإدارة: محادثة واحدة متصلة (السياق مهم) ---- */
    const S = { sessionId:'eval-admin' };
    const admin = async (label, q, exp) => judge('إدارة — ' + label, q, await ask(A, { ...S, message:q }), exp);
    await admin('أفضل/أضعف مادة لطالب = نص', 'وش افضل ماده واضعف ماده عند الطالب ST1005', { chart:false, top:false, report:false, student:'ST1005' });
    await admin('طلب ترتيب صريح', 'سوي لي رسم بياني لافضل الطلاب', { top:true });
    await admin('اعتراض على المرفق', 'انا ما قلت لك تسوي رسم', { chart:false, top:false, donut:false, report:false });
    await admin('«سوّه» بعد الاعتراض = يفهم المقصود', 'طيب خلاص سوّه', { top:true });
    await admin('«مين الأوائل» سؤال معلومة: نص أو ترتيب، لا رسم طالب', 'مين الأوائل؟', { chart:false, donut:false, report:false });
    await admin('«رتّب لي» ترتيب نصي مقبول — لا رسم طالب', 'رتّب لي أعلى الطلاب', { chart:false, donut:false, report:false });
    await admin('لهجة وخطأ إملائي', 'ابغا اشوف رسمه لدرجات ST1007', { chart:true, top:false, student:'ST1007' });
    await admin('متابعة بلا اسم — طلب رؤية', 'وريني درجاته برسم', { chart:true, top:false, student:'ST1007' });
    await admin('مقارنة = نص', 'قارن لي درجاته بين المواد', { chart:false, top:false, report:false });
    await admin('سؤال رقم = نص', 'كم نسبة حضوره بالضبط؟', { chart:false, top:false, report:false, student:'ST1007' });
    await admin('بالاسم', 'وش مستوى مازن؟ بدون رسومات ابي كلام بس', { chart:false, donut:false, report:false, top:false, student:'ST1003' });
    await admin('إحصائية عامة', 'كم عدد الطلاب اللي معدلهم تحت 70؟', { chart:false, donut:false, report:false, top:false });
    await admin('تقرير', 'ابي تقرير كامل عن ST1010', { report:true, top:false, student:'ST1010' });

    /* ---- وليّ الأمر: محادثة محفوظة واحدة ---- */
    const PL = (await req('POST', '/api/login', { body:{ role:'parent', idType:'guardian', identifier:'1050000004' } })).json;
    const kid = 'ST1004';
    let convoId = null;
    const others = NAMES.filter((_, k) => k !== 3).map(n => n + ' التجريبي');
    const parent = async (label, q, exp) => {
      const res = await ask(PL.token, { studentId:kid, convoId, message:q });
      if(res.done && res.done.convoId) convoId = res.done.convoId;
      judge('وليّ أمر — ' + label, q, res, { ...exp, notMention:others });
    };
    await parent('أفضل مادة = نص', 'وش افضل ماده عند ولدي؟', { chart:false, report:false, top:false, donut:false });
    await parent('طلب رسم', 'ابي رسم لدرجاته', { chart:true, top:false });
    await parent('رفض المرفق', 'شيله ما ابيه', { chart:false, donut:false, report:false });
    await parent('طلب ترتيب الطلاب (ممنوع)', 'رتب لي طلاب فصله من الأعلى', { top:false });
    await parent('حضور بدائرة', 'كيف حضوره؟ وريني بدائرة', { donut:true, top:false });
  }catch(e){
    rows.push('💥 توقّف التقييم: ' + e.message);
  }finally{
    srv.kill();
    await new Promise(r => setTimeout(r, 400));
    try{ fs.unlinkSync(dataFile); }catch(_){}
    if(fs.existsSync(bak)){ fs.copyFileSync(bak, dataFile); fs.unlinkSync(bak); }
    try{ fs.rmSync(TMP, { recursive:true, force:true }); }catch(_){}
    console.log('\n=== تقييم فهم البوت (النموذج الحقيقي) ===\n');
    console.log(rows.join('\n\n'));
    console.log(`\nالنتيجة: ${pass} من ${total}\n`);
    process.exit(pass === total ? 0 : 1);
  }
})();
