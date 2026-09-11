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
  if(!u) return res.status(401).json({ error:'غير مصرّح' });
  req.user = u; req.token = t; next();
}
function requireRole(...roles){ return (req,res,next)=> roles.includes(req.user.role) ? next() : res.status(403).json({ error:'ممنوع' }); }
function publicUser(u){ const { pass, ...rest } = u; return rest; }

/* ---------- إشعارات + مساعدات ---------- */
function pushNotif(uid, text, sub){
  db.DB.notifs[uid] = db.DB.notifs[uid] || [];
  const n = { id:'n'+Date.now()+Math.random().toString(16).slice(2,6), text, sub, ts:Date.now(), read:false };
  db.DB.notifs[uid].unshift(n); saveDB();
  io.to('u:'+uid).emit('notif', n);
  return n;
}
const tkey = (a,b)=> [a,b].sort().join('|');
const avgOf = s => Math.round(Object.values(s.grades).reduce((a,b)=>a+b,0)/Object.values(s.grades).length);
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
    if(!kids.length) return res.status(401).json({ error: idType==='guardian'
      ? 'لم نعثر على أبناء مسجّلين بهذا الرقم.' : 'لم نعثر على طالب بهذا الرقم في السجل.' });
    const childIds = kids.map(k => k.id);
    const gname = kids[0].guardian || 'ولي الأمر';
    const key = 'parent:' + idType + ':' + idv;
    let pu = db.DB.users.find(u => u.role==='parent' && u.idKey===key);
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
  res.json({ token, me: publicUser(u) });
});
app.get('/api/me', auth, (req,res)=> res.json({ me: publicUser(req.user) }));
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
    return { message, key:user.id+':'+sid, system:llm.promptForParent(clientStudent(s), avg), student:clientStudent(s), avg };
  }
  // مدير / معلم: بحث فوري في الفهرس
  const hit = roster.ready() ? roster.findStudents(message, 1)[0] : null;
  return { message, key:user.id+':school', system:llm.promptForSchool(message),
    student:clientStudent(hit), avg: hit ? hit.avg : null };
}

/* كشف نيّة الطلب من نصّ السائل — يجبر الأداة حتى لو لم يُصدر النموذج الرمز */
function intentFlags(msg){
  const t = String(msg||'');
  return {
    chart:  /رسم|بياني|بيان|مخطط|رسمه|رسمة|chart|graph|قارن|مقارنة/i.test(t),
    donut:  /حضور|غياب|مواظبة|دوام|attendance/i.test(t),
    report: /تقرير|كشف\s*كامل|كشف\s*شامل|report/i.test(t),
    top:    /أفضل|افضل|أعلى|اعلى|ترتيب|متفوق|أوائل|اوائل/i.test(t),
  };
}

/* يمنع تفعيل أداة بصرية بلا بيانات تسندها + يجبرها عند طلب السائل صراحةً */
function buildDone(full, ctx){
  const f = llm.toolFlags(full);
  const w = intentFlags(ctx.message);
  const hasGrades = !!(ctx.student && ctx.student.grades && Object.keys(ctx.student.grades).length);
  const st = roster.stats();
  const out = {
    text: llm.stripTools(full),
    chart: (f.chart || w.chart) && hasGrades,
    donut: (f.donut || w.donut) && !!(ctx.student && ctx.student.attendance),
    report: (f.report || w.report) && hasGrades,
    top: (f.top || w.top) && !!(st && st.أعلى_10 && st.أعلى_10.length),
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
app.post('/api/roster/import', auth, requireRole('admin'), upload.single('file'), async (req,res)=>{
  if(!req.file) return res.status(400).json({ error:'اختر ملف إكسل (.xlsx)' });
  const full = path.join(UPLOAD_DIR, req.file.filename);
  const mode = (req.body && req.body.mode === 'merge') ? 'merge' : 'replace';
  try{
    const out = await roster.importFile(full, req.file.originalname, mode);
    db.DB.files.push({ id:'f'+Date.now(), owner:req.user.id, ownerName:req.user.name, subject:'سجل الطلاب',
      name:req.file.originalname, status:'approved', mime:req.file.mimetype, path:'uploads/'+req.file.filename,
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
  const t = { id:'t'+Date.now(), role:'teacher', name, user, subject:subject||SUBJECTS[0], nid:nid||'', pass:hashPw(pass||'1234'), perms:Array.isArray(perms)?perms:['files','messages'] };
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
  if(pass) t.pass = hashPw(pass);
  saveDB(); res.json({ teacher: publicUser(t) });
});
app.delete('/api/teachers/:id', auth, requireRole('admin'), (req,res)=>{
  db.DB.users = db.DB.users.filter(u=>u.id!==req.params.id);
  saveDB(); res.json({ ok:true });
});

/* ============================================================
   STUDENTS  (admin)
   ============================================================ */
app.get('/api/students', auth, requireRole('admin'), (req,res)=>{
  res.json({ students: db.DB.students, subjects:SUBJECTS, parents: db.DB.users.filter(u=>u.role==='parent').map(publicUser) });
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
  const s = db.DB.students.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ error:'غير موجود' });
  const b = req.body || {};
  Object.assign(s, {
    name:b.name??s.name, grade:b.grade??s.grade, classNo:b.classNo??s.classNo,
    attendance:b.attendance!=null?+b.attendance:s.attendance, parent:b.parent??s.parent,
    grades:b.grades||s.grades, notes:b.notes??s.notes,
  });
  saveDB(); res.json({ student:s });
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

app.post('/api/files', auth, requireRole('teacher','admin'), upload.single('file'), (req,res)=>{
  const b = req.body || {};
  const isBrain = b.brain === '1';
  const subject = req.user.role==='teacher' ? req.user.subject : (b.subject || (isBrain?'عقل البوت':SUBJECTS[0]));
  let name = b.name || (req.file && req.file.originalname) || 'ملف';
  let content = b.content || '';
  let mime = 'text/plain', filePath = null;
  if(req.file){
    mime = req.file.mimetype || 'application/octet-stream';
    filePath = 'uploads/' + req.file.filename;
    name = b.name || req.file.originalname;
    // استخراج نص الملفات النصية لتغذية عقل البوت
    if(/text\/|json|csv/.test(mime) || /\.(txt|csv|md|json)$/i.test(name)){
      try { content = fs.readFileSync(path.join(UPLOAD_DIR, req.file.filename),'utf8').slice(0,20000); } catch(e){}
    }
  }
  const f = {
    id:'f'+Date.now(), owner:req.user.id, ownerName:req.user.name, subject,
    name, status: (req.user.role==='admin' && isBrain) ? 'approved' : 'pending',
    mime, path:filePath, content, ts:Date.now(),
  };
  db.DB.files.push(f); saveDB();
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
app.get('/api/contacts', auth, requireRole('admin','teacher'), (req,res)=> res.json({ contacts: contactsFor(req.user) }));
app.get('/api/threads', auth, (req,res)=>{
  const me = req.user.id; const out = [];
  Object.entries(db.DB.threads).forEach(([k,arr])=>{
    const ids = k.split('|'); if(!ids.includes(me)) return;
    const peer = ids[0]===me ? ids[1] : ids[0];
    out.push({ peer, last: arr[arr.length-1] || null, unread: arr.filter(m=>m.from===peer && !m.read).length });
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

app.post('/api/reset', auth, requireRole('admin'), (req,res)=>{ resetDB(); res.json({ ok:true }); });

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
    const key = tkey(uid, to);
    db.DB.threads[key] = db.DB.threads[key] || [];
    const msg = { from:uid, text:String(text).slice(0,2000), ts:Date.now(), read:false };
    db.DB.threads[key].push(msg); saveDB();
    io.to('u:'+to).emit('chat:message', { ...msg, peer:uid });
    io.to('u:'+uid).emit('chat:message', { ...msg, peer:to, self:true });
    pushNotif(to, 'رسالة جديدة من '+socket.user.name, String(text).slice(0,40));
  });
});

(async () => {
  try { await db.init(); }               // Mongo (دائم) أو ملف محلي
  catch(e){ console.error('فشل الاتصال بقاعدة البيانات:', e.message); process.exit(1); }
  roster.hydrate();                        // إعادة بناء الفهرس من الحالة المحمّلة
  server.listen(PORT, ()=>{
    console.log('ذكاء الأندلس يعمل: http://localhost:'+PORT);
    console.log('النموذج: '+llm.MODEL+'  | المفتاح: '+(process.env.FIREWORKS_API_KEY?'موجود ✓':'مفقود ✗'));
  });
})();
