/* ============================================================
   index.js — Express + Socket.IO + REST API
   ذكاء الأندلس / Smart Andlus  (Backend)
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

/* ---------- تحميل .env يدوياً (بدون حزم) ---------- */
(function loadEnv(){
  const p = path.join(__dirname, '..', '.env');
  if(!fs.existsSync(p)) return;
  fs.readFileSync(p,'utf8').split('\n').forEach(line=>{
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if(m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
  });
})();

const db = require('./db');
const roster = require('./roster');
const extract = require('./extract');
const agent = require('./agent');
const llm = require('./llm');
const { DB, saveDB, resetDB, verifyPw, hashPw, SUBJECTS, PERMS } = db;

const PORT = process.env.PORT || 8731;
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive:true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:'*' } });

app.use(express.json({ limit:'2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if(p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

/* رفع الملفات (يُعرَّف مبكراً لأن عدة مسارات تستخدمه) */
const storage = multer.diskStorage({
  destination:(req,file,cb)=> cb(null, UPLOAD_DIR),
  filename:(req,file,cb)=> cb(null, Date.now()+'-'+Math.random().toString(16).slice(2,8)+path.extname(file.originalname||'')),
});
const upload = multer({ storage, limits:{ fileSize:10*1024*1024 } });

/* ---------- المصادقة ---------- */
function newToken(uid){ const t = crypto.randomBytes(24).toString('hex'); db.DB.tokens[t] = uid; db.saveNow(); return t; }
function userFromToken(t){ const uid = t && db.DB.tokens[t]; return uid ? db.DB.users.find(u=>u.id===uid) : null; }
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query.t || '');
  const u = userFromToken(t);
  // code:'session' يميّز «انتهت الجلسة» عن 401 لسبب آخر (كلمة مرور حالية خاطئة مثلاً)
  // بدونه كانت الواجهة تُخرج المستخدم من الموقع عند أي 401
  if(!u) return res.status(401).json({ error:'غير مصرّح', code:'session' });
  req.user = u; req.token = t; next();
}
function requireRole(...roles){ return (req,res,next)=> roles.includes(req.user.role) ? next() : res.status(403).json({ error:'ممنوع' }); }
/* صلاحيات المعلم يحدّدها المدير — نفرضها في السيرفر لا في الواجهة فقط */
function requirePerm(perm){
  return (req,res,next)=>{
    if(req.user.role !== 'teacher') return next();
    if((req.user.perms||[]).includes(perm)) return next();
    res.status(403).json({ error:'هذه الصلاحية غير مفعّلة لحسابك — راجع إدارة المدرسة.' });
  };
}
const hasPerm = (u, p)=> u.role !== 'teacher' || (u.perms||[]).includes(p);
function publicUser(u){ const { pass, ...rest } = u; return rest; }

/* ---------- إشعارات + مساعدات ---------- */
function pushNotif(uid, text, sub){
  if(!uid || !db.DB.users.some(u=>u.id===uid)) return null;   // لا إشعارات لحساب محذوف
  db.DB.notifs[uid] = db.DB.notifs[uid] || [];
  const n = { id:'n'+Date.now()+Math.random().toString(16).slice(2,6), text, sub, ts:Date.now(), read:false };
  db.DB.notifs[uid].unshift(n); saveDB();
  io.to('u:'+uid).emit('notif', n);
  return n;
}
const tkey = (a,b)=> [a,b].sort().join('|');
/* إزالة حسابات أولياء الأمور المؤقتة التي لم يبقَ لها أبناء (وجلساتها ومحادثاتها) */
function pruneParents(){
  const dead = db.DB.users.filter(u=> u.role==='parent' && u.virtual && !(u.children||[]).length).map(u=>u.id);
  if(!dead.length) return 0;
  const gone = new Set(dead);
  db.DB.users = db.DB.users.filter(u=> !gone.has(u.id));
  dead.forEach(id=>{ delete db.DB.convos[id]; delete db.DB.notifs[id]; });
  Object.entries(db.DB.tokens).forEach(([tok,uid])=>{ if(gone.has(uid)) delete db.DB.tokens[tok]; });
  return dead.length;
}
const avgOf = s => { const g = Object.values((s && s.grades) || {}).filter(v=>typeof v==='number');
  return g.length ? Math.round(g.reduce((a,b)=>a+b,0)/g.length) : 0; };
/* اسم الملف العربي يصل من multer مفكوكاً بـ latin1 → نعيده UTF-8 */
function fixName(s){
  const t = String(s == null ? '' : s);
  if(!t || /[؀-ۿ]/.test(t)) return t;          // فيه عربي سليم أصلاً
  if(!/[À-ÿ]/.test(t)) return t;               // لا يبدو مشوّهاً
  try{
    const fixed = Buffer.from(t, 'latin1').toString('utf8');
    if(/[؀-ۿ]/.test(fixed)) return fixed;
  }catch(_){}
  return t;
}
/* إصلاح لمرّة واحدة للأسماء المخزَّنة مشوّهة قبل هذا التصحيح */
function repairNames(){
  let n = 0;
  (db.DB.files||[]).forEach(f=>{ const v = fixName(f.name); if(v !== f.name){ f.name = v; n++; } });
  if(db.DB.roster && db.DB.roster.fileName){
    const v = fixName(db.DB.roster.fileName);
    if(v !== db.DB.roster.fileName){ db.DB.roster.fileName = v; n++; }
  }
  if(n) db.saveNow();
  return n;
}
/* حذف نسخة الملف من القرص (بهدوء) — كي لا تتضخّم uploads بملفات بلا سجل */
function rmUpload(p){
  if(!p) return;
  try{ fs.unlinkSync(path.join(__dirname,'..','public', p)); }catch(_){}
}
function contactsFor(u){
  if(u.role==='admin')   return db.DB.users.filter(x=>x.role==='teacher').map(publicUser);
  if(u.role==='teacher') return db.DB.users.filter(x=>x.role==='admin'||(x.role==='teacher'&&x.id!==u.id)).map(publicUser);
  return [];
}

/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/login', (req,res)=>{
  const { role, user, pass, idType, identifier } = req.body || {};

  // دخول وليّ الأمر بالهوية: رقم الطالب أو رقم هوية وليّ الأمر
  if(role === 'parent' && identifier){
    const idv = String(identifier).trim();
    if(!idv) return res.status(400).json({ error:'أدخل رقم الهوية.' });
    let kids = [];
    if(idType === 'guardian') kids = roster.ready() ? roster.byGuardian(idv) : [];
    else { const s = findStudentAny(idv); if(s) kids = [s]; }
    if(!kids.length){
      // نفرّق بين «لا يوجد سجل أصلاً» و«الرقم غير مسجّل» — الرسالة الغامضة كانت تربك
      if(!roster.ready() && !db.DB.students.length)
        return res.status(401).json({ error:'لم تُسجَّل بيانات الطلاب في المنصة بعد — يرجى مراجعة إدارة المدرسة.' });
      return res.status(401).json({ error: idType==='guardian'
        ? 'لم نعثر على أبناء مسجّلين بهذا الرقم. تأكد من رقم هوية وليّ الأمر، أو ادخل برقم الطالب.'
        : 'لم نعثر على طالب بهذا الرقم في السجل. تأكد من رقم الطالب، أو ادخل برقم هوية وليّ الأمر.' });
    }
    const childIds = kids.map(k => k.id);
    const gname = kids[0].guardian || 'ولي الأمر';
    // المفتاح مُطبَّع: ST1001 و st1001 و ١٠٥١ و 1051 = حساب واحد لا حسابات متفرّقة
    const key = 'parent:' + idType + ':' + roster.normId(idv);
    let pu = db.DB.users.find(u => u.role==='parent' && u.idKey===key)
      || db.DB.users.find(u => u.role==='parent' && u.idKey && u.idKey.startsWith('parent:'+idType+':')
           && roster.normId(u.idKey.split(':').slice(2).join(':')) === roster.normId(idv));
    if(pu) pu.idKey = key;   // توحيد المفاتيح القديمة
    if(!pu){ pu = { id:'pv'+Date.now().toString(36)+Math.random().toString(16).slice(2,5), role:'parent',
      name: idType==='guardian' ? ('ولي أمر — '+gname) : ('ولي أمر — '+(kids[0].name||'')),
      idKey:key, children:childIds, virtual:true }; db.DB.users.push(pu); }
    else pu.children = childIds;
    const token = newToken(pu.id); saveDB();
    return res.json({ token, me: publicUser(pu) });
  }

  const u = db.DB.users.find(x=>x.user===user && x.role===role);
  if(!u || !verifyPw(pass, u.pass)) return res.status(401).json({ error:'بيانات الدخول غير صحيحة لهذا الدور.' });
  const token = newToken(u.id);
  res.json({ token, me: publicUser(u), mustChangePass: usingDefaultPass(u) });
});
app.get('/api/me', auth, (req,res)=> res.json({ me: publicUser(req.user), mustChangePass: usingDefaultPass(req.user) }));
app.post('/api/logout', auth, (req,res)=>{ delete db.DB.tokens[req.token]; saveDB(); res.json({ ok:true }); });

/* ============================================================
   PARENT — children + chat
   ============================================================ */
/* طالب من قائمة النظام أو من سجل الإكسل المفهرس */
function findStudentAny(id){ return db.DB.students.find(s=>s.id===id) || roster.get(id); }

app.get('/api/children', auth, requireRole('parent'), (req,res)=>{
  const kids = (req.user.children||[]).map(id=> findStudentAny(id)).filter(Boolean).map(clientStudent);
  res.json({ children: kids });
});

const chatHist = {}; // "userId:scope" -> transcript
/* الذاكرة محدودة: نحتفظ بآخر MEM_TURNS دورة فقط لكل محادثة */
function trimHist(h){ const max = llm.MEM_MSGS + 2; if(h.length > max) h.splice(0, h.length - max); return h; }

/* تحويل سجل الفهرس إلى الشكل الذي ترسمه الواجهة */
function clientStudent(s){
  if(!s) return null;
  return { id:s.id, name:s.name, grade:s.level || s.grade || '', classNo:s.section || s.classNo || '',
    attendance:s.attendance || 0, grades:s.grades || {}, notes:s.notes || '' };
}
/* يحدّد سياق السؤال: وليّ أمر = ابنه · إدارة = السجل المفهرس */
function resolveChat(user, body){
  const message = String((body && body.message) || '').trim();
  if(user.role === 'parent'){
    const sid = body.studentId;
    const s = findStudentAny(sid);
    if(!s || !(user.children||[]).includes(sid)) return { error:'الطالب غير موجود' };
    const avg = avgOf(s);
    return { message, role:user.role, key:user.id+':'+sid, system:llm.promptForParent(clientStudent(s), avg, message), student:clientStudent(s), avg };
  }
  // مدير / معلم: بحث فوري في الفهرس
  const hit = roster.ready() ? roster.findStudents(message, 1)[0] : null;
  return { message, role:user.role, key:user.id+':school', system:llm.promptForSchool(message),
    student:clientStudent(hit), avg: hit ? hit.avg : null };
}

/* كشف نيّة الطلب — في server/intent.js ليُختبر وحده */
const { intentFlags } = require('./intent');

/* يمنع تفعيل أداة بصرية بلا بيانات تسندها + يجبرها عند طلب السائل صراحةً */
function buildDone(full, ctx){
  const f = llm.toolFlags(full);
  const w = intentFlags(ctx.message);
  const hasGrades = !!(ctx.student && ctx.student.grades && Object.keys(ctx.student.grades).length);
  const st = roster.stats();
  // نفى السائل الأداة صراحةً؟ لا نرسم شيئاً — ولو أصدر النموذج الرمز
  const want = w.negated
    ? { chart:false, donut:false, report:false, top:false }
    : { chart:f.chart || w.chart, donut:f.donut || w.donut, report:f.report || w.report, top:f.top || w.top };
  // ترتيب طلاب المدرسة بيانات طلاب آخرين — لا يُعرض لوليّ أمر أبداً
  const mayRank = ctx.role === 'admin' || ctx.role === 'teacher';
  const out = {
    text: llm.stripTools(full),
    chart: want.chart && hasGrades,
    donut: want.donut && !!(ctx.student && ctx.student.attendance),
    report: want.report && hasGrades,
    top: want.top && mayRank && !!(st && st.أعلى_10 && st.أعلى_10.length),
    student: ctx.student, avg: ctx.avg,
  };
  if(out.top) out.topData = st.أعلى_10;
  if(out.chart || out.report) out.subjects = Object.keys(ctx.student.grades);
  return out;
}

/* حفظ دورة محادثة في سجل وليّ الأمر + توليد عنوان AI للمحادثة الجديدة */
function saveConvoTurn(user, convoId, sid, userText, botOut){
  if(user.role !== 'parent') return {};
  const list = db.DB.convos[user.id] = db.DB.convos[user.id] || [];
  let convo = convoId && list.find(c=>c.id===convoId);
  let isNew = false;
  if(!convo){
    convo = { id:'c'+Date.now().toString(36)+Math.random().toString(16).slice(2,5),
      sid, title:String(userText).slice(0,32), msgs:[], upd:Date.now() };
    list.unshift(convo); isNew = true;
  }
  if(sid) convo.sid = sid;
  convo.msgs.push({ role:'user', text:userText });
  convo.msgs.push({ role:'bot', text:botOut.text||'', chart:!!botOut.chart, donut:!!botOut.donut,
    report:!!botOut.report, top:!!botOut.top, topData:botOut.topData||null, student:botOut.student||null, avg:botOut.avg });
  if(convo.msgs.length > 80) convo.msgs.splice(0, convo.msgs.length - 80);
  convo.upd = Date.now();
  if(list.length > 40) list.length = 40;
  saveDB();
  if(isNew) llm.titleFor(userText).then(t=>{ if(t){ convo.title = t; saveDB(); } }).catch(()=>{});
  return { convoId: convo.id, title: convo.title, isNew };
}

/* ---- محادثات وليّ الأمر المحفوظة ---- */
app.get('/api/convos', auth, requireRole('parent'), (req,res)=>{
  const list = (db.DB.convos[req.user.id] || []).slice()
    .sort((a,b)=> b.upd - a.upd)
    .map(c=>({ id:c.id, title:c.title, sid:c.sid, upd:c.upd, count:c.msgs.length }));
  res.json({ convos:list });
});
app.get('/api/convos/:id', auth, requireRole('parent'), (req,res)=>{
  const c = (db.DB.convos[req.user.id] || []).find(x=>x.id===req.params.id);
  if(!c) return res.status(404).json({ error:'غير موجودة' });
  res.json({ convo:c });
});
app.delete('/api/convos/:id', auth, requireRole('parent'), (req,res)=>{
  db.DB.convos[req.user.id] = (db.DB.convos[req.user.id] || []).filter(x=>x.id!==req.params.id);
  saveDB(); res.json({ ok:true });
});

app.post('/api/chat', auth, async (req,res)=>{
  const ctx = resolveChat(req.user, req.body);
  if(ctx.error) return res.status(404).json({ error:ctx.error });
  if(!ctx.message) return res.status(400).json({ error:'رسالة فارغة' });
  const hist = chatHist[ctx.key] = chatHist[ctx.key] || [];
  hist.push({ role:'user', content:ctx.message });
  try {
    const out = await llm.chat(ctx.system, hist);
    hist.push({ role:'assistant', content: out.text }); trimHist(hist);
    const w = intentFlags(ctx.message);
    const hasGrades = !!(ctx.student && ctx.student.grades && Object.keys(ctx.student.grades).length);
    out.chart  = (out.chart  || w.chart)  && hasGrades;
    out.donut  = (out.donut  || w.donut)  && !!(ctx.student && ctx.student.attendance);
    out.report = (out.report || w.report) && hasGrades;
    const cv = saveConvoTurn(req.user, req.body.convoId, req.body.studentId, ctx.message,
      { ...out, student:ctx.student, avg:ctx.avg });
    res.json({ ...out, student:ctx.student, avg:ctx.avg, convoId:cv.convoId, convoTitle:cv.title, source:'ai' });
  } catch(e){
    hist.pop();
    res.json({ text:'', fallback:true, error:String(e.message||e), student:ctx.student, avg:ctx.avg, source:'local' });
  }
});

/* بثّ حي (SSE فوق POST) — الواجهة تقرأ الأحرف أولاً بأول */
app.post('/api/chat/stream', auth, async (req,res)=>{
  const ctx = resolveChat(req.user, req.body);
  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  if(res.flushHeaders) res.flushHeaders();
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  if(ctx.error || !ctx.message){ send('error', { error: ctx.error || 'رسالة فارغة' }); return res.end(); }

  const hist = chatHist[ctx.key] = chatHist[ctx.key] || [];
  hist.push({ role:'user', content:ctx.message });
  const messages = llm.buildMessages(ctx.system, hist);
  let closed = false;
  res.on('close', ()=> { closed = true; });   // انقطاع العميل (req يُغلق فور اكتمال الجسم)
  try{
    let thinkN = 0;
    const full = await llm.streamLLM(messages,
      d => { if(!closed) send('token', { d }); },
      () => { if(!closed && (++thinkN % 8 === 0)) send('think', { n:thinkN }); });
    hist.push({ role:'assistant', content: llm.stripTools(full) }); trimHist(hist);
    const out = buildDone(full, ctx);
    const cv = saveConvoTurn(req.user, req.body.convoId, req.body.studentId, ctx.message, out);
    out.convoId = cv.convoId; out.convoTitle = cv.title;
    send('done', out);
  }catch(e){
    hist.pop();
    send('error', { error:String(e.message||e), student:ctx.student, avg:ctx.avg });
  }
  res.end();
});

/* ============================================================
   ROSTER — استيراد الإكسل مرّة واحدة + بحث فوري
   ============================================================ */
app.get('/api/roster/stats', auth, (req,res)=>{
  const r = db.DB.roster;
  res.json({ ready:roster.ready(), count:roster.count(),
    fileName:r && r.fileName, importedAt:r && r.importedAt, stats:roster.stats() });
});
app.get('/api/roster/search', auth, (req,res)=>{
  if(!roster.ready()) return res.json({ total:0, rows:[], ready:false });
  const { q = '', page = '1', per = '25' } = req.query;
  res.json({ ready:true, ...roster.search(String(q).trim(), +page || 1, Math.min(+per || 25, 100)) });
});
/* نموذج ملف الهويات الجاهز (تحميل) */
app.get('/api/roster/template', auth, requireRole('admin'), async (req,res)=>{
  try{
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('الهويات', { views:[{ rightToLeft:true, state:'frozen', ySplit:1 }] });
    ws.columns = [
      { header:'رقم الطالب', key:'id', width:14 },
      { header:'اسم الطالب', key:'name', width:28 },
      { header:'الصف', key:'level', width:16 },
      { header:'الفصل', key:'section', width:10 },
      { header:'ولي الأمر', key:'guardian', width:22 },
      { header:'هوية ولي الأمر', key:'guardianId', width:18 },
    ];
    // صفّا مثال بصيغة واضحة أنها تعبئة توضيحية — تُستبدل ببيانات المدرسة
    ws.addRow({ id:'(رقم الطالب)', name:'(اسم الطالب رباعي)', level:'(الصف)', section:'(الفصل)',
      guardian:'(اسم وليّ الأمر)', guardianId:'(هوية وليّ الأمر — بها يسجّل الدخول)' });
    ws.addRow({ id:'(احذف صفّي المثال قبل الرفع)', name:'', level:'', section:'', guardian:'', guardianId:'' });
    ws.getRow(1).eachCell(c=>{ c.font={bold:true,color:{argb:'FFFFFFFF'}}; c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C46'}}; c.alignment={horizontal:'center'}; });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="identities-template.xlsx"');
    res.send(Buffer.from(buf));
  }catch(e){ res.status(500).json({ error:'تعذّر توليد النموذج: '+e.message }); }
});

/* مسح السجل نهائياً — يمسح الفهرس وملف السجل معاً (لا تناقض بعدها) */
app.post('/api/roster/clear', auth, requireRole('admin'), (req,res)=>{
  const had = roster.count();
  const src = roster.sourceFile();
  roster.clear();
  // أولياء الأمور المؤقتون كانوا مرتبطين بطلاب السجل — لا معنى لبقائهم
  db.DB.users.forEach(u=>{ if(u.role==='parent' && u.virtual) u.children = []; });
  pruneParents();
  // احذف بطاقة ملف السجل من مركز الملفات حتى لا تبقى إشارة لسجل ممسوح
  db.DB.files = db.DB.files.filter(f=>{
    const isRoster = f.subject === 'سجل الطلاب' || (src && f.name === src);
    if(isRoster) rmUpload(f.path);
    return !isRoster;
  });
  db.saveNow();
  res.json({ ok:true, cleared:had });
});

/* الوكيل الذكي: يحلّل ملفاً ويقترح خريطة الأعمدة (وقد يسأل بخيارات) */
app.post('/api/roster/analyze', auth, requireRole('admin'), upload.single('file'), async (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'اختر ملف إكسل (.xlsx)' });
  const full = path.join(UPLOAD_DIR, req.file.filename);
  try{
    const out = await agent.analyzeSheet(full);
    res.json({ ok:true, ...out, tmp:req.file.filename, fileName:fixName(req.file.originalname) });
  }catch(e){
    try{ fs.unlinkSync(full); }catch(_){}
    res.status(400).json({ error:'تعذّر تحليل الملف: ' + e.message });
  }
});

app.post('/api/roster/import', auth, requireRole('admin'), upload.single('file'), async (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'اختر ملف إكسل (.xlsx)' });
  const full = path.join(UPLOAD_DIR, req.file.filename);
  const mode = (req.body && req.body.mode === 'merge') ? 'merge' : 'replace';
  let mapping = null;
  try{ if(req.body && req.body.mapping) mapping = JSON.parse(req.body.mapping); }catch(_){}
  const origName = fixName(req.file.originalname);
  try{
    const out = await roster.importFile(full, origName, mode, mapping);
    // «استبدال الكل» يستبدل بطاقة السجل أيضاً — لا نترك بطاقات لسجلات لم تعد قائمة
    if(mode === 'replace'){
      db.DB.files = db.DB.files.filter(f=>{
        if(f.subject !== 'سجل الطلاب') return true;
        rmUpload(f.path); return false;
      });
    }
    db.DB.files.push({ id:'f'+Date.now(), owner:req.user.id, ownerName:req.user.name, subject:'سجل الطلاب',
      name:origName, status:'approved', mime:req.file.mimetype, path:'uploads/'+req.file.filename,
      content:`سجل طلاب مفهرس: ${out.count} طالب — تمت القراءة مرة واحدة عند الاستيراد.`, ts:Date.now() });
    db.saveNow();
    res.json({ ok:true, ...out });
  }catch(e){
    try{ fs.unlinkSync(full); }catch(_){}
    res.status(400).json({ error:'تعذّر قراءة الملف: ' + e.message });
  }
});

/* ============================================================
   TEACHERS  (admin)
   ============================================================ */
app.get('/api/teachers', auth, requireRole('admin'), (req,res)=>{
  res.json({ teachers: db.DB.users.filter(u=>u.role==='teacher').map(publicUser), subjects:SUBJECTS, perms:PERMS });
});
app.post('/api/teachers', auth, requireRole('admin'), (req,res)=>{
  const { name, user, subject, nid, pass, perms } = req.body || {};
  if(!name || !user) return res.status(400).json({ error:'الاسم واسم الدخول مطلوبان' });
  if(db.DB.users.some(u=>u.user===user)) return res.status(409).json({ error:'اسم الدخول مستخدم' });
  // لا كلمة مرور افتراضية — حساب بكلمة معروفة مسبقاً = باب مفتوح
  if(!pass || String(pass).length < 6)
    return res.status(400).json({ error:'اختر كلمة مرور للمعلم لا تقل عن 6 خانات.' });
  const t = { id:'t'+Date.now(), role:'teacher', name, user, subject:subject||SUBJECTS[0], nid:nid||'', pass:hashPw(pass), perms:Array.isArray(perms)?perms:['files','messages'] };
  db.DB.users.push(t); saveDB(); res.json({ teacher: publicUser(t) });
});
app.put('/api/teachers/:id', auth, requireRole('admin'), (req,res)=>{
  const t = db.DB.users.find(u=>u.id===req.params.id && u.role==='teacher');
  if(!t) return res.status(404).json({ error:'غير موجود' });
  const { name, user, subject, nid, pass, perms } = req.body || {};
  if(user && user!==t.user && db.DB.users.some(u=>u.user===user)) return res.status(409).json({ error:'اسم الدخول مستخدم' });
  Object.assign(t, {
    name: name??t.name, user: user??t.user, subject: subject??t.subject,
    nid: nid??t.nid, perms: Array.isArray(perms)?perms:t.perms,
  });
  if(pass){
    if(String(pass).length < 6) return res.status(400).json({ error:'كلمة المرور الجديدة قصيرة — 6 خانات فأكثر.' });
    t.pass = hashPw(pass);
  }
  saveDB(); res.json({ teacher: publicUser(t) });
});
app.delete('/api/teachers/:id', auth, requireRole('admin'), (req,res)=>{
  const id = req.params.id;
  const t = db.DB.users.find(u=>u.id===id && u.role==='teacher');
  if(!t) return res.status(404).json({ error:'غير موجود' });
  db.DB.users = db.DB.users.filter(u=>u.id!==id);
  // تنظيف ما يخلّفه المعلم: ملفاته، محادثاته، إشعاراته، وجلساته
  const myFiles = db.DB.files.filter(f=>f.owner===id);
  myFiles.forEach(f=> rmUpload(f.path));
  db.DB.files = db.DB.files.filter(f=>f.owner!==id);
  Object.keys(db.DB.threads).forEach(k=>{ if(k.split('|').includes(id)) delete db.DB.threads[k]; });
  delete db.DB.notifs[id];
  Object.entries(db.DB.tokens).forEach(([tok,uid])=>{ if(uid===id) delete db.DB.tokens[tok]; });
  db.saveNow();
  res.json({ ok:true, removedFiles:myFiles.length });
});

/* ============================================================
   STUDENTS  (admin)
   ============================================================ */
/* عرض موحَّد: طلاب السجل المستورد + الطلاب المضافون يدوياً (مصدر واحد للحقيقة) */
function rosterAsStudent(s){
  return { id:s.id, name:s.name, grade:s.level||'', classNo:s.section||'', attendance:s.attendance||0,
    grades:s.grades||{}, notes:s.notes||'', parent:'', guardian:s.guardian||'', guardianId:s.guardianId||'', source:'roster' };
}
app.get('/api/students', auth, requireRole('admin'), (req,res)=>{
  const manual = db.DB.students.map(s=> Object.assign({}, s, { grades:s.grades||{}, source:'manual' }));
  const fromRoster = roster.ready() ? roster.list().map(rosterAsStudent) : [];
  const seen = new Set(manual.map(s=>s.id));
  const students = manual.concat(fromRoster.filter(s=>!seen.has(s.id)));
  const subjects = Array.from(new Set([...(roster.ready() ? (db.DB.roster.subjects||[]) : []), ...SUBJECTS]));
  res.json({ students, subjects, rosterCount:roster.count(), manualCount:manual.length,
    parents: db.DB.users.filter(u=>u.role==='parent').map(publicUser) });
});
app.post('/api/students', auth, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  if(!b.name) return res.status(400).json({ error:'اسم الطالب مطلوب' });
  const s = { id:'s'+Date.now(), name:b.name, grade:b.grade||'', classNo:b.classNo||'', attendance:+b.attendance||95,
    parent:b.parent||'', grades:b.grades||{}, notes:b.notes||'' };
  db.DB.students.push(s);
  const par = db.DB.users.find(u=>u.id===s.parent);
  if(par){ par.children = par.children||[]; par.children.push(s.id); }
  saveDB(); res.json({ student:s });
});
app.put('/api/students/:id', auth, requireRole('admin'), (req,res)=>{
  const b = req.body || {};
  const s = db.DB.students.find(x=>x.id===req.params.id);
  if(s){
    Object.assign(s, {
      name:b.name??s.name, grade:b.grade??s.grade, classNo:b.classNo??s.classNo,
      attendance:b.attendance!=null?+b.attendance:s.attendance, parent:b.parent??s.parent,
      grades:b.grades||s.grades, notes:b.notes??s.notes,
    });
    saveDB(); return res.json({ student:s });
  }
  // طالب من السجل المستورد: نعدّله داخل السجل ونعيد بناء الفهرس والإحصاءات
  const r = roster.updateStudent(req.params.id, {
    name:b.name, level:b.grade, section:b.classNo, attendance:b.attendance,
    grades:b.grades, notes:b.notes, guardian:b.guardian, guardianId:b.guardianId,
  });
  if(!r) return res.status(404).json({ error:'غير موجود' });
  res.json({ student: rosterAsStudent(r) });
});
app.delete('/api/students/:id', auth, requireRole('admin'), (req,res)=>{
  const id = req.params.id;
  const wasManual = db.DB.students.some(x=>x.id===id);
  db.DB.students = db.DB.students.filter(x=>x.id!==id);
  const wasRoster = roster.removeStudent(id);
  if(!wasManual && !wasRoster) return res.status(404).json({ error:'غير موجود' });
  // نظّف إشارات الطالب من حسابات أولياء الأمور والمحادثات المحفوظة
  db.DB.users.forEach(u=>{
    if(u.role!=='parent' || !Array.isArray(u.children)) return;
    u.children = u.children.filter(c=>c!==id);
  });
  Object.keys(db.DB.convos).forEach(uid=>{
    db.DB.convos[uid] = (db.DB.convos[uid]||[]).filter(c=>c.sid!==id);
  });
  pruneParents();
  db.saveNow();
  res.json({ ok:true, from: wasManual ? 'manual' : 'roster' });
});

/* ============================================================
   FILES  (upload / review / view)
   ============================================================ */
app.get('/api/files', auth, (req,res)=>{
  let list = db.DB.files;
  if(req.user.role==='teacher') list = list.filter(f=>f.owner===req.user.id);
  res.json({ files:list, subjects:SUBJECTS });
});
app.get('/api/brain', auth, requireRole('admin'), (req,res)=>{
  res.json({ files: db.DB.files.filter(f=>f.status==='approved') });
});

app.post('/api/files', auth, requireRole('teacher','admin'), requirePerm('files'), upload.single('file'), async (req,res)=>{
  const b = req.body || {};
  const isBrain = b.brain === '1';
  const subject = req.user.role==='teacher' ? req.user.subject : (b.subject || (isBrain?'عقل البوت':SUBJECTS[0]));
  const orig = req.file ? fixName(req.file.originalname) : '';
  let name = b.name || orig || 'ملف';
  let content = b.content || '';
  let mime = 'text/plain', filePath = null;
  if(req.file){
    mime = req.file.mimetype || 'application/octet-stream';
    filePath = 'uploads/' + req.file.filename;
    name = b.name || orig;
    // استخراج النص (نصوص + إكسل + PDF + Word) ليقرأه البوت
    // نستخدم اسم الملف الأصلي (فيه الامتداد) لا الاسم المعروض
    const got = await extract.extractText(path.join(UPLOAD_DIR, req.file.filename), orig || name, mime);
    if(got) content = got;
  }
  const f = {
    id:'f'+Date.now(), owner:req.user.id, ownerName:req.user.name, subject,
    name, status: (req.user.role==='admin' && isBrain) ? 'approved' : 'pending',
    mime, path:filePath, content, ts:Date.now(),
  };
  db.DB.files.push(f); saveDB();
  // إكسل فيه أعمدة هوية؟ سجّله في السجل فوراً — وإلا رُفض دخول وليّ الأمر
  // رغم أن «الملف فيه الهوية»
  if(req.file && /\.xlsx?$/i.test(orig)){
    try{
      const auto = await roster.tryAutoIdentities(path.join(UPLOAD_DIR, req.file.filename), orig);
      if(auto){ f.autoIdentities = auto; db.saveNow(); }
    }catch(e){ console.error('تعذّر تسجيل الهويات تلقائياً:', e.message); }
  }
  if(req.user.role==='teacher'){
    const admin = db.DB.users.find(u=>u.role==='admin');
    if(admin) pushNotif(admin.id, 'ملف جديد من '+req.user.name, name+' — بانتظار مراجعتك');
  }
  res.json({ file:f });
});

app.put('/api/files/:id', auth, requireRole('admin'), (req,res)=>{
  const f = db.DB.files.find(x=>x.id===req.params.id);
  if(!f) return res.status(404).json({ error:'غير موجود' });
  const b = req.body || {};
  const prev = f.status;
  if(b.name!=null) f.name = b.name;
  if(b.content!=null) f.content = b.content;
  if(b.status && ['pending','approved','rejected'].includes(b.status)) f.status = b.status;
  saveDB();
  if(f.owner!==req.user.id){
    const msg = { approved:'تم قبول ملفك', rejected:'تم رفض ملفك — يرجى المراجعة', pending:'ملفك قيد المراجعة' }[f.status] || 'تحديث على ملفك';
    if(b.status && b.status!==prev) pushNotif(f.owner, msg, f.name);
    if(b.content!=null && !b.status) pushNotif(f.owner, 'عدّل المدير ملفك', f.name);
  }
  res.json({ file:f });
});

/* حذف ملف نهائياً — وإن كان هو مصدر سجل الطلاب فيُمسح السجل معه (منع التناقض) */
app.delete('/api/files/:id', auth, requireRole('admin'), (req,res)=>{
  const i = db.DB.files.findIndex(x=>x.id===req.params.id);
  if(i < 0) return res.status(404).json({ error:'غير موجود' });
  const f = db.DB.files[i];
  const src = roster.sourceFile();
  const isRosterSource = f.subject === 'سجل الطلاب' || (src && f.name === src);
  db.DB.files.splice(i,1);
  rmUpload(f.path);
  let clearedRoster = 0;
  if(isRosterSource && roster.ready()){ clearedRoster = roster.count(); roster.clear(); }
  db.saveNow();
  if(f.owner !== req.user.id) pushNotif(f.owner, 'حذف المدير ملفك', f.name);
  res.json({ ok:true, clearedRoster });
});

// عرض الملف داخل المتصفح (inline) بدون تنزيل
app.get('/api/files/:id/raw', auth, (req,res)=>{
  const f = db.DB.files.find(x=>x.id===req.params.id);
  if(!f) return res.status(404).send('غير موجود');
  if(req.user.role==='teacher' && f.owner!==req.user.id) return res.status(403).send('ممنوع');
  const isText = /text\/|json|csv/.test(f.mime||'') || /\.(txt|csv|md|json)$/i.test(f.name||'');
  // الملفات النصية: نعرض المحتوى المخزَّن (قد يكون المدير عدّله) بدل نسخة القرص
  if(f.path && !isText){
    res.setHeader('Content-Disposition','inline');
    return res.sendFile(path.join(__dirname,'..','public', f.path));
  }
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.send(f.content || '(بدون محتوى)');
});

/* ============================================================
   MESSAGING + NOTIFICATIONS  (REST history)
   ============================================================ */
app.get('/api/contacts', auth, requireRole('admin','teacher'), requirePerm('messages'), (req,res)=> res.json({ contacts: contactsFor(req.user) }));
app.get('/api/threads', auth, (req,res)=>{
  const me = req.user.id; const out = [];
  Object.entries(db.DB.threads).forEach(([k,arr])=>{
    const ids = k.split('|'); if(!ids.includes(me)) return;
    const peer = ids[0]===me ? ids[1] : ids[0];
    const pu = db.DB.users.find(u=>u.id===peer);
    if(!pu) return;   // محادثة مع حساب محذوف — لا نعرضها
    out.push({ peer, peerName:pu.name, peerRole:pu.role,
      last: arr[arr.length-1] || null, unread: arr.filter(m=>m.from===peer && !m.read).length });
  });
  res.json({ threads: out });
});
app.get('/api/thread/:otherId', auth, (req,res)=>{
  const key = tkey(req.user.id, req.params.otherId);
  const th = db.DB.threads[key] || [];
  // علّم كمقروء
  let changed=false; th.forEach(m=>{ if(m.from===req.params.otherId && !m.read){ m.read=true; changed=true; } });
  if(changed) saveDB();
  res.json({ messages: th });
});
app.get('/api/notifs', auth, (req,res)=> res.json({ notifs: db.DB.notifs[req.user.id] || [] }));
app.post('/api/notifs/read', auth, (req,res)=>{ (db.DB.notifs[req.user.id]||[]).forEach(n=>n.read=true); saveDB(); res.json({ ok:true }); });
app.post('/api/notifs/clear', auth, (req,res)=>{ db.DB.notifs[req.user.id]=[]; saveDB(); res.json({ ok:true }); });
// المدير: مسح كل المحادثات والإشعارات (تنظيف سريع)
app.post('/api/messages/clear', auth, requireRole('admin'), (req,res)=>{
  const n = Object.keys(db.DB.threads||{}).length;
  db.DB.threads = {}; db.DB.notifs = {};
  db.saveNow();
  res.json({ ok:true, cleared:n });
});

/* ============================================================
   الأمان — المدير يغيّر كلمة مروره (وكلمات المعلمين عبر /api/teachers)
   ============================================================ */
const DEFAULT_ADMIN_PASS = '43321';
/* هل ما زال المدير على كلمة المرور الأولى؟ (لتنبيهه في اللوحة) */
function usingDefaultPass(u){
  return !!(u && u.role === 'admin' && verifyPw(DEFAULT_ADMIN_PASS, u.pass));
}
/* قواعد واحدة لكل كلمات المرور في المنصة */
function passProblem(p, { min = 8 } = {}){
  const s = String(p == null ? '' : p);
  if(s.length < min) return `كلمة المرور قصيرة — ${min} خانات فأكثر.`;
  if(/^\d+$/.test(s)) return 'أرقام فقط سهلة التخمين — أضف حروفاً.';
  if(s === DEFAULT_ADMIN_PASS) return 'هذه هي كلمة المرور الأولى — اختر غيرها.';
  return null;
}

app.post('/api/account/password', auth, requireRole('admin'), (req,res)=>{
  const { current, next } = req.body || {};
  const u = db.DB.users.find(x=>x.id===req.user.id);
  if(!u) return res.status(404).json({ error:'الحساب غير موجود' });
  if(!verifyPw(String(current || ''), u.pass))
    return res.status(401).json({ error:'كلمة المرور الحالية غير صحيحة.' });
  const bad = passProblem(next);
  if(bad) return res.status(400).json({ error:bad });
  if(verifyPw(String(next), u.pass))
    return res.status(400).json({ error:'الجديدة مطابقة للحالية.' });
  u.pass = hashPw(String(next));
  // أي جلسة أخرى لهذا الحساب تُغلق — لو كان أحد داخلاً بالقديمة يخرج فوراً
  let closed = 0;
  Object.entries(db.DB.tokens).forEach(([tok,uid])=>{
    if(uid === u.id && tok !== req.token){ delete db.DB.tokens[tok]; closed++; }
  });
  db.saveNow();
  res.json({ ok:true, closedSessions:closed });
});

/* المدير يعيّن كلمة مرور معلّم (بدون معرفة القديمة) ويُخرج جلساته */
app.post('/api/teachers/:id/password', auth, requireRole('admin'), (req,res)=>{
  const t = db.DB.users.find(u=>u.id===req.params.id && u.role==='teacher');
  if(!t) return res.status(404).json({ error:'المعلّم غير موجود' });
  const bad = passProblem(req.body && req.body.next, { min:6 });
  if(bad) return res.status(400).json({ error:bad });
  t.pass = hashPw(String(req.body.next));
  let closed = 0;
  Object.entries(db.DB.tokens).forEach(([tok,uid])=>{
    if(uid === t.id){ delete db.DB.tokens[tok]; closed++; }
  });
  db.saveNow();
  pushNotif(t.id, 'غيّر المدير كلمة مرورك', 'سجّل الدخول بالكلمة الجديدة');
  res.json({ ok:true, closedSessions:closed });
});

/* إعادة تعيين كاملة: البيانات + السجل المفهرس + ملفات القرص (لا يبقى أثر متناقض) */
app.post('/api/reset', auth, requireRole('admin'), (req,res)=>{
  (db.DB.files||[]).forEach(f=> rmUpload(f.path));
  roster.clear();
  resetDB();
  roster.clear();   // بعد البذرة الجديدة أيضاً
  res.json({ ok:true });
});

/* SPA fallback */
app.get('*', (req,res)=>{ res.setHeader('Cache-Control','no-cache'); res.sendFile(path.join(__dirname,'..','public','index.html')); });

/* ============================================================
   SOCKET.IO — realtime chat + calls signaling
   ============================================================ */
io.use((socket,next)=>{
  const u = userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if(!u) return next(new Error('unauthorized'));
  socket.user = u; next();
});
io.on('connection', (socket)=>{
  const uid = socket.user.id;
  socket.join('u:'+uid);

  socket.on('chat:message', ({ to, text })=>{
    if(!to || !text || !text.trim()) return;
    // نعيد قراءة الحساب في كل رسالة: قد يحذفه المدير أو يسحب صلاحية المراسلة
    const me = db.DB.users.find(u=>u.id===uid);
    if(!me) return socket.emit('chat:error', 'حسابك لم يعد موجوداً.');
    if(!hasPerm(me, 'messages')) return socket.emit('chat:error', 'صلاحية المراسلة غير مفعّلة لحسابك.');
    const peer = db.DB.users.find(u=>u.id===to);
    if(!peer) return socket.emit('chat:error', 'المستلم غير موجود — ربما حُذف حسابه.');
    const key = tkey(uid, to);
    db.DB.threads[key] = db.DB.threads[key] || [];
    const msg = { from:uid, text:String(text).slice(0,2000), ts:Date.now(), read:false };
    db.DB.threads[key].push(msg); saveDB();
    io.to('u:'+to).emit('chat:message', { ...msg, peer:uid });
    io.to('u:'+uid).emit('chat:message', { ...msg, peer:to, self:true });
    pushNotif(to, 'رسالة جديدة من '+me.name, String(text).slice(0,40));
  });
});

(async () => {
  try { await db.init(); }               // Mongo (دائم) أو ملف محلي
  catch(e){ console.error('فشل الاتصال بقاعدة البيانات:', e.message); process.exit(1); }
  const fixedN = repairNames();            // إصلاح أسماء الملفات العربية المخزَّنة مشوّهة
  if(fixedN) console.log('أُصلح اسم '+fixedN+' ملف (ترميز عربي)');
  roster.hydrate();                        // إعادة بناء الفهرس من الحالة المحمّلة
  server.listen(PORT, ()=>{
    console.log('ذكاء الأندلس يعمل: http://localhost:'+PORT);
    console.log('النموذج: '+llm.MODEL+'  | المفتاح: '+(process.env.FIREWORKS_API_KEY?'موجود ✓':'مفقود ✗'));
  });
})();
