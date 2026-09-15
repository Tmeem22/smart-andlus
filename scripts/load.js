/* ============================================================
   load.js — اختبار ضغط (بلا نداءات AI)
   · 200 وليّ أمر يدخلون في اللحظة نفسها ويفتحون بيانات أبنائهم
   · المدير يبحث في السجل بالتوازي
   · 40 اتصال مراسلة فوري
   يقيس: الأخطاء، وزمن الاستجابة (p50/p95)، وسلامة البيانات بعد الضغط.
   التشغيل:  node scripts/load.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4631;
const BASE = 'http://127.0.0.1:' + PORT;
const PARENTS = 200;

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
async function timed(fn){ const t = Date.now(); try{ const r = await fn(); return { ms:Date.now() - t, ok:r }; }catch(e){ return { ms:Date.now() - t, ok:false, err:e.message }; } }
async function post(url, body, token){
  const r = await fetch(BASE + url, { method:'POST', headers:{ 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer ' + token } : {}) }, body:JSON.stringify(body) });
  return { status:r.status, json: await r.json().catch(() => null) };
}
async function get(url, token){
  const r = await fetch(BASE + url, { headers:{ Authorization:'Bearer ' + token } });
  return { status:r.status, json: await r.json().catch(() => null) };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andlus-load-'));
  const dataFile = path.join(__dirname, '..', 'server', 'data.json');
  const bak = dataFile + '.load-bak';
  if(fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bak);
  try{ fs.unlinkSync(dataFile); }catch(_){}
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')],
    { env:{ ...process.env, PORT:String(PORT), MONGODB_URI:'', AI_IMPORT:'off' }, stdio:'ignore' });
  const lines = []; let failed = false;
  try{
    for(let i = 0; i < 60; i++){ try{ await fetch(BASE + '/api/me'); break; }catch(_){ await new Promise(r => setTimeout(r, 300)); } }

    // سجل 300 طالب (عيّنة مؤقتة)
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('السجل');
    ws.columns = ['رقم الطالب','اسم الطالب','الفصل','ولي الأمر','هوية ولي الأمر','نسبة الحضور','الرياضيات','العلوم'].map(h => ({ header:h, key:h }));
    for(let i = 1; i <= 300; i++) ws.addRow({ 'رقم الطالب':'ST'+(1000+i), 'اسم الطالب':'طالب ضغط '+i, 'الفصل':'1/أ',
      'ولي الأمر':'وليّ '+i, 'هوية ولي الأمر':String(1080000000+i), 'نسبة الحضور':80+(i%20), 'الرياضيات':60+(i%40), 'العلوم':70+(i%30) });
    const xf = path.join(TMP, 'load.xlsx'); await wb.xlsx.writeFile(xf);
    const A = (await post('/api/login', { role:'admin', user:'naif', pass:'43321' })).json.token;
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(xf)]), 'load.xlsx'); fd.append('mode', 'replace');
    const imp = await fetch(BASE + '/api/roster/import', { method:'POST', headers:{ Authorization:'Bearer ' + A }, body:fd }).then(r => r.json());
    lines.push(`السجل: ${imp.count} طالب`);

    // 1) 200 دخول متزامن + فتح بيانات الأبناء
    const logins = await Promise.all(Array.from({ length:PARENTS }, (_, k) => timed(async () => {
      const i = k + 1;
      const r = await post('/api/login', { role:'parent', idType: i % 2 ? 'student' : 'guardian', identifier: i % 2 ? 'ST' + (1000 + i) : String(1080000000 + i) });
      if(r.status !== 200) throw new Error('login ' + r.status);
      const kids = await get('/api/children', r.json.token);
      if(kids.status !== 200 || !kids.json.children.length || kids.json.children[0].id !== 'ST' + (1000 + i)) throw new Error('children mismatch');
      return r.json.token;
    })));
    const okLogins = logins.filter(x => x.ok);
    lines.push(`${PARENTS} وليّ أمر بالتوازي: ${okLogins.length} نجح · ${PARENTS - okLogins.length} فشل · p50 ${pct(logins.map(x => x.ms), .5)}ms · p95 ${pct(logins.map(x => x.ms), .95)}ms`);
    if(okLogins.length !== PARENTS){ failed = true; lines.push('  أخطاء: ' + [...new Set(logins.filter(x => !x.ok).map(x => x.err))].join(' | ')); }

    // 1ب) لا حسابان بمعرّف واحد (المولّد القديم كان يكرّر المعرّف تحت الضغط)
    const parents = (await get('/api/students', A)).json.parents;
    const dupIds = parents.length - new Set(parents.map(p => p.id)).size;
    lines.push(`حسابات أولياء الأمور: ${parents.length} · معرّفات مكرّرة: ${dupIds}`);
    if(dupIds || parents.length !== PARENTS) failed = true;

    // 2) كل وليّ أمر يرى ابنه فقط (لا تداخل بين الجلسات تحت الضغط)
    const cross = await Promise.all(okLogins.slice(0, 50).map((x, k) => get('/api/children', x.ok)));
    const leaks = cross.filter((r, k) => r.json.children.length !== 1).length;
    lines.push(`عزل الجلسات تحت الضغط: ${leaks === 0 ? 'سليم' : leaks + ' جلسة ترى أكثر من ابن'}`);
    if(leaks) failed = true;

    // 3) المدير: 100 بحث متزامن في السجل
    const searches = await Promise.all(Array.from({ length:100 }, (_, k) => timed(async () => {
      const r = await get('/api/roster/search?q=' + encodeURIComponent('طالب ضغط ' + (k + 1)), A);
      if(r.status !== 200 || !r.json.rows.length) throw new Error('search ' + r.status);
      return true;
    })));
    const okS = searches.filter(x => x.ok).length;
    lines.push(`100 بحث متزامن للمدير: ${okS} نجح · p50 ${pct(searches.map(x => x.ms), .5)}ms · p95 ${pct(searches.map(x => x.ms), .95)}ms`);
    if(okS !== 100) failed = true;

    // 4) 40 معلّماً متصلون بالمراسلة، المدير يرسل لكل واحد
    const { io } = require('socket.io-client');
    const teachers = [];
    for(let i = 0; i < 40; i++){
      const t = await post('/api/teachers', { name:'معلم ضغط ' + i, user:'load' + i, pass:'load-pass-2026', perms:['messages'] }, A);
      const tok = (await post('/api/login', { role:'teacher', user:'load' + i, pass:'load-pass-2026' })).json.token;
      teachers.push({ id:t.json.teacher.id, tok });
    }
    const sockets = await Promise.all(teachers.map(t => new Promise((res, rej) => {
      const s = io(BASE, { auth:{ token:t.tok }, transports:['websocket'] });
      s.on('connect', () => res({ s, t })); s.on('connect_error', rej); setTimeout(() => rej(new Error('timeout')), 8000);
    })));
    const admin = await new Promise((res, rej) => { const s = io(BASE, { auth:{ token:A }, transports:['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
    const t0 = Date.now();
    const received = Promise.all(sockets.map(({ s }) => new Promise(res => {
      const to = setTimeout(() => res(false), 8000);
      s.on('chat:message', m => { if(!m.self){ clearTimeout(to); res(true); } });
    })));
    sockets.forEach(({ t }) => admin.emit('chat:message', { to:t.id, text:'رسالة ضغط' }));
    const got = (await received).filter(Boolean).length;
    lines.push(`مراسلة فورية لـ40 معلّماً: ${got} استلم خلال ${Date.now() - t0}ms`);
    if(got !== 40) failed = true;
    sockets.forEach(({ s }) => s.close()); admin.close();

    // 5) سلامة البيانات بعد الضغط
    const stats = await get('/api/roster/stats', A);
    const users = (await get('/api/teachers', A)).json.teachers.length;
    lines.push(`بعد الضغط: السجل ${stats.json.count} طالب · المعلمون ${users} · الخادم ${stats.status === 200 ? 'يستجيب' : 'لا يستجيب'}`);
    if(stats.json.count !== 300) failed = true;
  }catch(e){
    failed = true; lines.push('💥 ' + e.message);
  }finally{
    srv.kill();
    await new Promise(r => setTimeout(r, 500));
    try{ fs.unlinkSync(dataFile); }catch(_){}
    if(fs.existsSync(bak)){ fs.copyFileSync(bak, dataFile); fs.unlinkSync(bak); }
    console.log('\n=== اختبار الضغط ===\n' + lines.map(l => '  ' + l).join('\n') + `\n\nالنتيجة: ${failed ? 'فيه مشاكل ❌' : 'كل شيء سليم ✅'}\n`);
    process.exit(failed ? 1 : 0);
  }
})();
