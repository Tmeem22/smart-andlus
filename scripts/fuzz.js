/* ============================================================
   fuzz.js — بيانات مشوّهة على كل مسارات الـAPI من كل الأدوار
   ينجح إذا: الخادم لم يسقط، ولم يعلّق أي طلب، ولم يُرجع 500.
   (لا نداءات AI: رسائل الشات هنا فارغة أو غير صالحة)
   التشغيل:  node scripts/fuzz.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4641;
const BASE = 'http://127.0.0.1:' + PORT;

const BODIES = [undefined, '[]', '"نص"', 'null', '{"a":{"b":[1,{"c":null}]}}', '{bad json', JSON.stringify({ name:'x'.repeat(50000) }),
  JSON.stringify({ role:['admin'], user:{ $ne:1 }, pass:{ $gt:'' }, identifier:{}, idType:[] }),
  JSON.stringify({ status:{}, content:123, forParents:'yes', perms:'all', grades:'x', attendance:'abc', next:[], current:{} }),
  JSON.stringify({ message:'', studentId:{}, convoId:[] })];
const IDS = ['x', '..%2F..%2Fserver%2Fdata.json', '%00', 'ف'.repeat(300), '1e999', '__proto__', 'constructor'];

async function once(method, url, token, body){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try{
    const r = await fetch(BASE + url, { method, signal:ctrl.signal,
      headers:{ ...(token ? { Authorization:'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type':'application/json' } : {}) },
      body: method === 'GET' ? undefined : body });
    await r.text();
    return r.status;
  }catch(e){ return e.name === 'AbortError' ? 'hang' : 'neterr'; }
  finally{ clearTimeout(timer); }
}
/* خطأ شبكة عابر على ويندوز ≠ سقوط الخادم: نعيد المحاولة، ثم نتحقق أن الخادم حيّ فعلاً */
async function call(method, url, token, body){
  let last;
  for(let i = 0; i < 3; i++){
    last = await once(method, url, token, body);
    if(last !== 'neterr' && last !== 'hang') return last;   // تعليق واحد عابر لا يكفي للحكم — يُعاد
    await new Promise(r => setTimeout(r, 300));
  }
  if(last === 'hang') return 'hang';                       // ثلاث مرات متتالية = تعليق حقيقي
  const alive = await once('GET', '/api/me');
  return alive === 'neterr' ? 'down' : 'neterr-only';
}

(async () => {
  const dataFile = path.join(__dirname, '..', 'server', 'data.json');
  const bak = dataFile + '.fuzz-bak';
  if(fs.existsSync(dataFile)) fs.copyFileSync(dataFile, bak);
  try{ fs.unlinkSync(dataFile); }catch(_){}
  let log = '';
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')],
    { env:{ ...process.env, PORT:String(PORT), MONGODB_URI:'', AI_IMPORT:'off', FIREWORKS_API_KEY:'' }, stdio:['ignore','pipe','pipe'] });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  const problems = []; let calls = 0;
  try{
    // ويندوز قد يُسقط أول اتصالات أثناء إقلاع الخادم (ETIMEDOUT) — نعيد المحاولة في التجهيز فقط
    const retry = async fn => { for(let i = 0; ; i++){ try{ return await fn(); }catch(e){ if(i > 40) throw e; await new Promise(r => setTimeout(r, 400)); } } };
    await retry(() => fetch(BASE + '/api/me'));
    const login = b => retry(async () => { const r = await fetch(BASE + '/api/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(b) }); return (await r.json()).token; });
    const A = await login({ role:'admin', user:'naif', pass:'43321' });
    const T = await login({ role:'teacher', user:'ali', pass:'4321' });
    // وليّ أمر: طالب يدوي
    const st = await retry(() => fetch(BASE + '/api/students', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + A }, body:JSON.stringify({ name:'فحص' }) }).then(r => r.json()));
    const P = await login({ role:'parent', idType:'student', identifier:st.student.id });

    // كل المسارات من الخادم نفسه
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const routes = [...src.matchAll(/^app\.(get|post|put|delete)\('([^']+)'/gm)].map(m => [m[1].toUpperCase(), m[2]])
      .filter(([, p]) => p !== '*' && p !== '/api/reset');   // إعادة التعيين تُختبر في audit.js
    const roles = { مجهول:null, مدير:A, معلّم:T, وليّ_أمر:P };

    for(const [method, route] of routes){
      const urls = route.includes(':') ? IDS.map(id => route.replace(/:[a-zA-Z]+/g, id)) : [route];
      for(const [role, tok] of Object.entries(roles)){
        for(const url of urls){
          const bodies = method === 'GET' ? [undefined] : BODIES;
          for(const body of bodies){
            // لا نمسح بيانات الفحص بمسارات الحذف الشامل
            if(method === 'POST' && /\/(clear|logout)$/.test(route) && role !== 'مجهول') continue;
            const s = await call(method, url, tok, body);
            calls++;
            if(s === 'hang' || s === 'down' || (typeof s === 'number' && s >= 500)) problems.push(`${role} ${method} ${url.slice(0, 60)} ${body ? body.slice(0, 30) : ''} => ${s}`);
            if(s === 'down') throw new Error('سقط الخادم');
          }
        }
      }
    }
    // الأسرار لا تتسرّب في أي رد
    const users = await fetch(BASE + '/api/teachers', { headers:{ Authorization:'Bearer ' + A } }).then(r => r.text());
    if(/"pass"/.test(users)) problems.push('كلمات مرور مشفّرة تظهر في /api/teachers');
    const me = await fetch(BASE + '/api/me', { headers:{ Authorization:'Bearer ' + P } }).then(r => r.text());
    if(/"pass"|tokens/.test(me)) problems.push('أسرار في /api/me');
    const html = await fetch(BASE + '/').then(r => r.text());
    if(/fw_[A-Za-z0-9]{8,}/.test(html) || /FIREWORKS/.test(html)) problems.push('مفتاح الذكاء في الصفحة');
    const js = await fetch(BASE + '/js/app.js').then(r => r.text());
    if(/fw_[A-Za-z0-9]{8,}/.test(js)) problems.push('مفتاح الذكاء في app.js');
    for(const p of ['/server/data.json', '/../server/data.json', '/.env', '/%2e%2e/.env', '/uploads/']){
      const r = await fetch(BASE + p); const t = await r.text();
      if(/"users"|FIREWORKS_API_KEY|MONGODB/.test(t)) problems.push('ملف حسّاس يُنزَّل: ' + p);
    }
  }catch(e){ problems.push('💥 ' + e.message + ' ' + (e.cause ? (e.cause.code || e.cause.message) : '') + ' @ ' + String(e.stack || '').split(/\r?\n/).slice(1, 3).join(' | ')); }
  finally{
    srv.kill();
    await new Promise(r => setTimeout(r, 500));
    try{ fs.unlinkSync(dataFile); }catch(_){}
    try{ fs.unlinkSync(dataFile + '.tmp'); }catch(_){}
    if(fs.existsSync(bak)){ fs.copyFileSync(bak, dataFile); fs.unlinkSync(bak); }
    const crashes = (log.match(/استثناء غير ملتقَط|خطأ غير معالَج/g) || []).length;
    console.log(`\n=== فحص البيانات المشوّهة ===\n  ${calls} طلب على كل المسارات × 4 أدوار`);
    console.log(problems.length ? problems.slice(0, 40).map(p => '  ❌ ' + p).join('\n') : '  ✅ لا سقوط، لا تعليق، لا خطأ 500');
    console.log(`  أخطاء داخلية التقطتها شبكة الأمان: ${crashes}`);
    if(!calls) console.log('--- سجل الخادم ---\n' + log.slice(-2000));
    if(crashes) console.log(log.split('\n').filter(l => /Error|at /.test(l)).slice(0, 12).join('\n'));
    process.exit(problems.length || crashes ? 1 : 0);
  }
})();
