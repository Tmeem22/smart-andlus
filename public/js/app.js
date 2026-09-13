/* ============================================================
   app.js — واجهة «ذكاء الأندلس» (تتحدث مع الـ Backend عبر REST + Socket.IO)
   ============================================================ */
'use strict';
const $ = s => document.querySelector(s);
const el = (id) => document.getElementById(id);

let TOKEN = localStorage.getItem('andlus_token') || null;
let ME = null;
let SELECTED_ROLE = 'parent';
let socket = null;
let activeChild = null, activeThread = null;
let unread = {}; // peerId -> count (session)

/* ---------- API helper ---------- */
async function api(path, { method='GET', body, form } = {}){
  const headers = {};
  if(TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  let payload;
  if(form){ payload = form; }
  else if(body){ headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if(res.status === 401){ doLogout(true); throw new Error('انتهت الجلسة'); }
  const j = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(j.error || ('خطأ ' + res.status));
  return j;
}

/* ---------- icons ---------- */
const I = {
  chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  teacher:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5"/></svg>',
  files:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  student:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>',
  msg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-9 8 9 9 0 0 1-4-.9L3 20l1.4-4.5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/></svg>',
  bot:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 14h.01M15 14h.01"/><path d="M2 14h2M20 14h2"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6l0 6.5L15 12 3.4 13.9z"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>',
  logo:'<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 3 6.5v5c0 5 3.8 8.9 9 10.5 5.2-1.6 9-5.5 9-10.5v-5L12 2Z" fill="#0d5c46"/><path d="M12 6.5 8 9v4l4 2.2L16 13V9l-4-2.5Z" fill="#c9a227"/></svg>',
};
const SUBJECTS = ['الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية','الدراسات الإسلامية','الاجتماعيات'];
const PERMS = { files:'رفع الملفات', students:'إدارة الطلاب', teachers:'إدارة المعلمين', grades:'تعديل الدرجات', messages:'المراسلة' };

/* ============================================================
   LOGIN
   ============================================================ */
/* لإظهار بيانات الدخول التجريبية على صفحة الدخول اجعل SHOW_DEMO_HINTS=true.
   على النسخة المنشورة للعامة نُبقيها false حتى لا تُعرض كلمات المرور للجميع. */
const SHOW_DEMO_HINTS = false;
const hints = {
  parent:'<b>ولي أمر:</b> parent / 1234',
  teacher:'<b>معلم:</b> sara / 1234 · noura / 1234',
  admin:'<b>مدير:</b> admin / 1234',
};
let PARENT_IDTYPE = 'student';   // student | guardian
const roleIcon = {
  parent:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  teacher:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5"/></svg>',
  admin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 4 6v6c0 5 3.4 7.7 8 10 4.6-2.3 8-5 8-10V6l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg>',
  id:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.2"/><path d="M14 10h4M14 14h4M6.5 16a3 3 0 0 1 5 0"/></svg>',
};

/* ---------- معالج اختيار الدور (متحرك) ---------- */
function wiz(html){
  const w = el('wizard');
  w.innerHTML = `<div class="wz-step">${html}</div>`;
}
function wzYesNo(icon, title, sub, onYes, onNo, extra){
  wiz(`
    <div class="wz-ic">${icon}</div>
    <h2 class="wz-q">${title}</h2>
    ${sub ? `<p class="wz-sub">${sub}</p>` : ''}
    <div class="wz-actions">
      <button class="btn block wz-yes">نعم</button>
      <button class="btn ghost block wz-no">لا</button>
    </div>
    ${extra || ''}`);
  el('wizard').querySelector('.wz-yes').onclick = onYes;
  el('wizard').querySelector('.wz-no').onclick = onNo;
}
function stepParentAsk(){
  wzYesNo(roleIcon.parent, 'هل أنت وليّ أمر؟', 'وتودّ متابعة مستوى ابنك؟', stepParentId, stepTeacherAsk);
}
function stepParentId(){
  wiz(`
    <div class="wz-ic">${roleIcon.id}</div>
    <h2 class="wz-q">بأي هوية تسجّل الدخول؟</h2>
    <p class="wz-sub">اختر الطريقة الأنسب لك</p>
    <div class="wz-actions">
      <button class="btn block wz-child">${roleIcon.parent}<span>بهوية ابني</span></button>
      <button class="btn gold block wz-guardian">${roleIcon.id}<span>بهويتي أنا</span></button>
      <button class="btn ghost block wz-back">↻ رجوع</button>
    </div>`);
  const q = el('wizard');
  q.querySelector('.wz-child').onclick = () => openForm('parent', 'student');
  q.querySelector('.wz-guardian').onclick = () => openForm('parent', 'guardian');
  q.querySelector('.wz-back').onclick = stepParentAsk;
}
function stepTeacherAsk(){
  wzYesNo(roleIcon.teacher, 'هل أنت معلّم؟', 'للدخول إلى ملفات مادتك والمراسلة',
    () => openForm('teacher'), stepAdminAsk);
}
function stepAdminAsk(){
  wzYesNo(roleIcon.admin, 'هل أنت مدير المدرسة؟', 'لإدارة الطلاب والمعلمين والنظام',
    () => openForm('admin'), stepRestart);
}
function stepRestart(){
  wiz(`
    <div class="wz-ic">${I.logo}</div>
    <h2 class="wz-q">لنبدأ من جديد</h2>
    <p class="wz-sub">اختر صفتك للدخول إلى «ذكاء الأندلس»</p>
    <div class="wz-actions">
      <button class="btn block wz-r1">${roleIcon.parent}<span>وليّ أمر</span></button>
      <button class="btn ghost block wz-r2">${roleIcon.teacher}<span>معلّم</span></button>
      <button class="btn ghost block wz-r3">${roleIcon.admin}<span>مدير</span></button>
    </div>`);
  const q = el('wizard');
  q.querySelector('.wz-r1').onclick = stepParentId;
  q.querySelector('.wz-r2').onclick = () => openForm('teacher');
  q.querySelector('.wz-r3').onclick = () => openForm('admin');
}

/* إظهار نموذج الدخول المناسب للدور */
function openForm(role, idType){
  SELECTED_ROLE = role; PARENT_IDTYPE = idType || 'student';
  el('wizard').hidden = true;
  const f = el('loginForm'); f.hidden = false;
  f.classList.remove('form-in'); void f.offsetWidth; f.classList.add('form-in');
  const isParent = role === 'parent';
  el('parentFields').hidden = !isParent;
  el('passFields').hidden = isParent;
  el('lgErr').textContent = '';
  if(isParent){
    el('idLabel').textContent = idType === 'guardian' ? 'رقم هويتك (وليّ الأمر)' : 'رقم هوية الطالب';
    el('lgId').placeholder = idType === 'guardian' ? 'مثال: 1088776655' : 'مثال: ST1001';
    setTimeout(()=> el('lgId').focus(), 60);
    el('demoHint').innerHTML = idType === 'guardian'
      ? 'أدخل رقم هويتك لعرض أبنائك المسجّلين.'
      : 'أدخل رقم هوية الطالب لعرض بياناته.';
  } else {
    setTimeout(()=> el('lgUser').focus(), 60);
    el('demoHint').innerHTML = SHOW_DEMO_HINTS ? hints[role] : ({teacher:'دخول المعلّم ببيانات المدرسة.', admin:'دخول مدير النظام.'}[role]);
  }
}
function backToWizard(){
  el('loginForm').hidden = true;
  el('wizard').hidden = false;
  stepRestart();
}

async function doLogin(){
  el('lgErr').textContent = '';
  let body;
  if(SELECTED_ROLE === 'parent'){
    const identifier = el('lgId').value.trim();
    if(!identifier){ el('lgErr').textContent = 'أدخل رقم الهوية.'; return; }
    body = { role:'parent', idType:PARENT_IDTYPE, identifier };
  } else {
    body = { role:SELECTED_ROLE, user:el('lgUser').value.trim(), pass:el('lgPass').value };
  }
  const btn = el('lgBtn'); btn.disabled = true; btn.textContent = '...جارٍ الدخول';
  try{
    const { token, me } = await api('/api/login', { method:'POST', body });
    TOKEN = token; ME = me; localStorage.setItem('andlus_token', token);
    enterApp();
  }catch(e){ el('lgErr').textContent = e.message; btn.disabled = false; btn.textContent = 'تسجيل الدخول'; }
}
/* موجة ضغط (ripple) على كل الأزرار */
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.btn'); if(!btn) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const s = document.createElement('span'); s.className = 'ripple';
  s.style.width = s.style.height = size + 'px';
  s.style.left = (e.clientX - r.left - size/2) + 'px';
  s.style.top = (e.clientY - r.top - size/2) + 'px';
  btn.appendChild(s); setTimeout(() => s.remove(), 600);
});

el('lgBtn').onclick = doLogin;
el('lgBack').onclick = backToWizard;
el('lgId').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
el('lgPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
stepParentAsk();   // بداية المعالج
function doLogout(silent){
  try{ if(!silent) api('/api/logout', { method:'POST' }); }catch(e){}
  localStorage.removeItem('andlus_token'); TOKEN = null; ME = null;
  if(socket){ socket.disconnect(); socket = null; }
  location.reload();
}
el('logoutBtn').onclick = () => doLogout();
function setDrawer(open){
  const side = document.querySelector('.side'), scrim = el('sideScrim');
  side.classList.toggle('open', open); if(scrim) scrim.classList.toggle('show', open);
}
function closeDrawer(){ setDrawer(false); }
el('menuBtn').onclick = () => setDrawer(!document.querySelector('.side').classList.contains('open'));
if(el('sideScrim')) el('sideScrim').onclick = closeDrawer;
el('notifBtn').onclick = toggleNotif;

/* ============================================================
   BOOT
   ============================================================ */
async function enterApp(){
  el('login').style.display = 'none';
  el('app').style.display = 'block';
  el('uName').textContent = ME.name;
  el('uRole').textContent = { parent:'ولي أمر', teacher:'معلم — '+(ME.subject||''), admin:'مدير النظام' }[ME.role];
  el('uAvatar').textContent = ME.name.replace(/^أ\.\s*/,'').trim()[0] || '؟';
  connectSocket();
  buildNav();
  await refreshNotifBadge();
  if(ME.role !== 'parent') await refreshMsgBadge();
  go(navFor(ME.role)[0].id);
}
const NAV = {
  parent:[{ id:'chat', t:'المساعد الذكي', ic:I.chat }, { id:'children', t:'أبنائي', ic:I.student }],
  teacher:[{ id:'chat', t:'المساعد الذكي', ic:I.chat }, { id:'tfiles', t:'ملفات مادتي', ic:I.files }, { id:'messages', t:'المراسلة', ic:I.msg }],
  admin:[{ id:'dash', t:'الرئيسية', ic:I.home }, { id:'chat', t:'المساعد الذكي', ic:I.chat }, { id:'roster', t:'سجل الطلاب', ic:I.student }, { id:'teachers', t:'المعلمون', ic:I.teacher }, { id:'students', t:'الطلاب', ic:I.student }, { id:'afiles', t:'مركز الملفات', ic:I.files }, { id:'brain', t:'عقل البوت', ic:I.bot }, { id:'messages', t:'المراسلة', ic:I.msg }],
};
let CUR = '';
/* قائمة الدور بعد تطبيق صلاحيات المدير على المعلم (لا نعرض خانة ممنوعة) */
const NEED = { tfiles:'files', messages:'messages' };
function navFor(role){
  const items = NAV[role] || [];
  if(role !== 'teacher') return items;
  const perms = ME.perms || [];
  const out = items.filter(it => !NEED[it.id] || perms.includes(NEED[it.id]));
  return out.length ? out : [items[0]];
}
function buildNav(){
  const nav = el('navMenu'); nav.innerHTML = '';
  const ind = document.createElement('div'); ind.className = 'nav-indicator'; ind.id = 'navInd';
  nav.appendChild(ind);
  navFor(ME.role).forEach(item => {
    const b = document.createElement('button'); b.className = 'nav-item'; b.dataset.id = item.id;
    b.innerHTML = item.ic + '<span>'+item.t+'</span>';
    if(item.id === 'messages') b.innerHTML += '<span class="badge red hidden" id="msgNavBadge">0</span>';
    b.onclick = () => { go(item.id); closeDrawer(); };
    nav.appendChild(b);
  });
}
/* يُنزلق المؤشّر الأخضر إلى الخانة النشطة */
function moveNavIndicator(){
  const ind = el('navInd'); const act = document.querySelector('.nav-item.active');
  if(!ind || !act) return;
  ind.style.width = act.offsetWidth + 'px';
  ind.style.height = act.offsetHeight + 'px';
  ind.style.transform = 'translate(' + act.offsetLeft + 'px,' + act.offsetTop + 'px)';
  ind.style.opacity = '1';
}
addEventListener('resize', () => moveNavIndicator());
function go(id){
  const allowed = navFor(ME.role).map(i=>i.id);
  if(!allowed.includes(id)) id = allowed[0];   // لا نفتح خانة خارج صلاحيات الدور
  CUR = id;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.id === id));
  moveNavIndicator();
  const v = el('mainView'); v.dataset.filt = '';
  const map = { chat:renderChat, children:renderChildren, tfiles:renderTeacherFiles, messages:renderMessages, dash:renderDash, teachers:renderTeachers, students:renderStudents, afiles:renderAdminFiles, brain:renderBrain, roster:renderRoster };
  v.innerHTML = '<div class="empty-state">'+I.bot+'<p>جارٍ التحميل...</p></div>';
  v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in');
  const fn = map[id] || (()=> { v.innerHTML=''; });
  // خطأ في التحميل لا يجوز يترك الشاشة معلّقة على «جارٍ التحميل»
  Promise.resolve().then(()=> fn(v)).catch(e=>{
    v.innerHTML = `<div class="card card-pad empty-state" style="min-height:180px">${I.bot}
      <p>تعذّر تحميل هذه الخانة</p><p class="small muted">${esc(e.message||'خطأ غير معروف')}</p>
      <button class="btn ghost mt" onclick="go('${esc(id)}')">إعادة المحاولة</button></div>`;
  });
}

/* ============================================================
   SOCKET
   ============================================================ */
function connectSocket(){
  socket = io({ auth:{ token:TOKEN } });
  socket.on('chat:message', (m) => {
    // m: {from,text,ts,peer,self}
    if(m.self) return; // صدى رسالتنا — نتجاهله (مضاف محلياً)
    if(CUR === 'messages' && activeThread === m.peer){ appendMgrLine(m); markThreadRead(m.peer); }
    else { unread[m.peer] = (unread[m.peer]||0) + 1; refreshMsgBadgeLocal(); }
  });
  socket.on('notif', (n) => { toast(n.text); bumpNotifBadge(); });
}

/* ============================================================
   PARENT — chat
   ============================================================ */
let CONVOS = [], activeConvo = null;

/* بناء الأدوات البصرية من نتيجة (حيّة أو محفوظة) */
function toolsHtml(r){
  const s = r.student; let extra = '';
  if(s && r.chart && s.grades && Object.keys(s.grades).length)
    extra += barChart(s.grades, `درجات الطالب ${s.name}`, `${s.grade||''} ${s.classNo?'· '+s.classNo:''}`);
  if(s && r.donut && s.attendance) extra += donut(s.attendance, 'المواظبة', `حضور الطالب ${s.name}`, s.name+(s.classNo?' — '+s.classNo:''));
  if(s && r.report && s.grades && Object.keys(s.grades).length) extra += repCardBox(s, r.avg != null ? r.avg : 0);
  if(r.top && r.topData) extra += topChart(r.topData);
  return extra;
}
function greetingChips(){
  const st = el('stream');
  const wrap = document.createElement('div'); wrap.className = 'suggest';
  ['📊 رسم بياني للدرجات','📄 تقرير كامل','✅ نسبة الحضور','⭐ أفضل وأضعف مادة'].forEach(txt=>{
    const b = document.createElement('button'); b.textContent = txt;
    b.onclick = () => { el('chatIn').value = txt.replace(/^[^ ]+ /,''); sendChat(); };
    wrap.appendChild(b);
  });
  st.appendChild(wrap); st.scrollTop = st.scrollHeight;
}

async function renderChat(v){
  const school = ME.role !== 'parent';
  let children = [], cur = null, rst = null;
  if(school){
    rst = await api('/api/roster/stats');
  } else {
    ({ children } = await api('/api/children'));
    if(!children.length){ v.innerHTML = emptyBox('لا يوجد أبناء مسجّلون.'); return; }
    activeChild = activeChild && children.some(c=>c.id===activeChild) ? activeChild : children[0].id;
    cur = children.find(c=>c.id===activeChild);
  }
  const rightCtrl = school
    ? `<span class="chip">${rst.ready ? '🧠 محفوظ: '+rst.count+' طالب' : '⚠️ لم يُستورد سجل بعد'}</span>`
    : `<div class="field" style="margin:0"><select id="childSel" style="min-width:170px">
        ${children.map(k=>`<option value="${k.id}" ${k.id===activeChild?'selected':''}>${esc(k.name)} — ${esc(k.classNo)}</option>`).join('')}
       </select></div>`;
  v.innerHTML = `
    <div class="ai-layout ${school?'no-side':''}">
      ${school ? '' : `<aside class="convo-side" id="convoSide">
        <button class="btn block" id="newChatBtn">＋ محادثة جديدة</button>
        <div class="convo-list" id="convoList"></div>
      </aside>
      <div class="convo-scrim" id="convoScrim"></div>`}
      <div class="chat-wrap">
        <div class="flex between center mb wrap gap">
          <div class="flex center gap">
            ${school ? '' : `<button class="icon-btn convo-btn" id="convoToggle" title="المحادثات"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>`}
            <div><h2 style="margin:0;font-size:19px">المساعد الذكي 🤖</h2>
              <p class="muted small" style="margin:2px 0 0">${school?'اسأل عن أي طالب في السجل':'اسأل عن مستوى ابنك واطلب رسم أو تقرير'}</p></div>
          </div>
          ${rightCtrl}
        </div>
        <div class="chat-stream" id="stream"></div>
        <div class="composer">
          <input id="chatIn" placeholder="${school?'مثال: كم عدد الطلاب المتفوقين؟':'مثال: أعطني رسم بياني لدرجات ابني'}" autocomplete="off">
          <button class="send-btn" id="sendBtn">${I.send}</button>
        </div>
      </div>
    </div>`;
  el('sendBtn').onclick = sendChat;
  el('chatIn').addEventListener('keydown', e => { if(e.key === 'Enter') sendChat(); });

  if(school){
    activeChild = null; activeConvo = null;
    const st = el('stream'); st.innerHTML = '';
    botSay(rst.ready
      ? `أهلاً 👋 حفظت سجل <b>${rst.count} طالب</b> — اسألني عن أي طالب أو إحصائية وأجيب فوراً.`
      : `أهلاً 👋 لم يُستورد سجل الطلاب بعد. افتح <b>سجل الطلاب</b> واستورد ملف الإكسل.`);
    // اقتراحات لا تُعرض إلا إذا كانت البيانات موجودة فعلاً (لا نعد بما لا يقدر عليه)
    if(rst.ready){
      const w = document.createElement('div'); w.className='suggest';
      ['👥 كم عدد الطلاب؟','🏆 أفضل 10 طلاب','📊 متوسط كل مادة'].forEach(t=>{ const b=document.createElement('button');b.textContent=t;b.onclick=()=>{el('chatIn').value=t.replace(/^[^ ]+ /,'');sendChat();};w.appendChild(b); });
      st.appendChild(w);
    } else if(ME.role === 'admin'){
      const w = document.createElement('div'); w.className='suggest';
      const b = document.createElement('button'); b.textContent = '📥 اذهب إلى سجل الطلاب';
      b.onclick = () => go('roster'); w.appendChild(b); st.appendChild(w);
    }
    return;
  }

  // وليّ الأمر: قائمة المحادثات + استئناف
  el('childSel').onchange = e => { activeChild = e.target.value; newChat(); };
  el('newChatBtn').onclick = () => newChat();
  el('convoToggle').onclick = () => { el('convoSide').classList.toggle('open'); el('convoScrim').classList.toggle('show'); };
  el('convoScrim').onclick = () => { el('convoSide').classList.remove('open'); el('convoScrim').classList.remove('show'); };
  await loadConvos();
  if(activeConvo && CONVOS.some(c=>c.id===activeConvo)) await openConvo(activeConvo);
  else newChat();
}

async function loadConvos(){
  try{ const { convos } = await api('/api/convos'); CONVOS = convos || []; }catch(e){ CONVOS = []; }
  renderConvoList();
}
function renderConvoList(){
  const box = el('convoList'); if(!box) return;
  if(!CONVOS.length){ box.innerHTML = `<div class="small muted" style="padding:12px;text-align:center">لا محادثات محفوظة بعد</div>`; return; }
  box.innerHTML = CONVOS.map(c=>`
    <div class="convo-item ${c.id===activeConvo?'active':''}" onclick="openConvo('${c.id}')">
      <span class="ci-title">${esc(c.title||'محادثة')}</span>
      <span class="ci-time">${timeAgo(c.upd)}</span>
      <button class="ci-del" title="حذف" onclick="event.stopPropagation();delConvo('${c.id}')">✕</button>
    </div>`).join('');
}
function newChat(){
  activeConvo = null;
  const st = el('stream'); if(!st) return; st.innerHTML = '';
  const cur = (document.getElementById('childSel')||{}).selectedOptions ? document.getElementById('childSel').selectedOptions[0].textContent : '';
  botSay(`أهلاً بك 👋 أنا مساعد <b>ذكاء الأندلس</b>. اسألني عن <b>${esc((cur||'').split('—')[0].trim())}</b>: الدرجات، الحضور، أو اطلب رسم/تقرير.`);
  greetingChips();
  renderConvoList();
  el('convoSide') && el('convoSide').classList.remove('open');
  el('convoScrim') && el('convoScrim').classList.remove('show');
}
async function openConvo(id){
  let convo;
  try{ ({ convo } = await api('/api/convos/'+id)); }catch(e){ toast('تعذّر فتح المحادثة'); return; }
  activeConvo = id;
  if(convo.sid) activeChild = convo.sid;
  const sel = el('childSel'); if(sel && convo.sid) sel.value = convo.sid;
  const st = el('stream'); st.innerHTML = '';
  convo.msgs.forEach(m=>{ if(m.role==='user') meSay(m.text); else botSay(fmt(m.text||'') + toolsHtml(m)); });
  renderConvoList();
  el('convoSide') && el('convoSide').classList.remove('open');
  el('convoScrim') && el('convoScrim').classList.remove('show');
  st.scrollTop = st.scrollHeight;
}
function afterConvo(r){
  if(!r || !r.convoId || ME.role !== 'parent') return;
  const isNew = activeConvo !== r.convoId;
  activeConvo = r.convoId;
  loadConvos();                          // حدّث القائمة فوراً
  if(isNew) setTimeout(loadConvos, 3500); // التقط عنوان الـAI المولّد لاحقاً
}
async function delConvo(id){
  if(!confirm('حذف هذه المحادثة؟')) return;
  try{ await api('/api/convos/'+id, { method:'DELETE' }); }catch(e){}
  CONVOS = CONVOS.filter(c=>c.id!==id);
  if(activeConvo===id){ activeConvo=null; newChat(); } else renderConvoList();
}

/* ============================================================
   ADMIN — سجل الطلاب (استيراد مرّة واحدة + بحث فوري)
   ============================================================ */
let rosterPage = 1, rosterQ = '';
async function renderRoster(v){
  const info = await api('/api/roster/stats');
  const s = info.stats;
  v.innerHTML = `<div class="page-head"><h2>سجل الطلاب</h2><p>استورد ملف الإكسل مرّة واحدة — يُقرأ ويُفهرس، وبعدها كل الإجابات فورية من الذاكرة</p></div>
    <div class="card card-pad mb">
      <div class="flex between center wrap gap">
        <div class="flex center gap">
          <div style="width:46px;height:46px;border-radius:12px;background:${info.ready?'#e3f6ec':'#fff5e0'};color:${info.ready?'#137a49':'#a9730a'};display:grid;place-items:center">${I.bot}</div>
          <div>${info.ready
            ? `<b>محفوظ في الذاكرة: ${info.count} طالب</b><div class="small muted">الملف: ${esc(info.fileName||'')} · استُورد ${timeAgo(info.importedAt)}</div>`
            : `<b>لم يُستورد سجل بعد</b><div class="small muted">اختر ملف .xlsx واضغط استيراد</div>`}</div>
        </div>
        <div class="flex gap wrap center">
          <input type="file" id="rosterFile" accept=".xlsx" style="max-width:220px;padding:9px;border:1.5px solid var(--line);border-radius:12px">
          <button class="btn" id="rosterSmart" title="الوكيل يقرأ الملف ويفصل الهويات والأسماء والمواد تلقائياً">🤖 تحليل ذكي</button>
          <button class="btn gold" id="rosterReplace" title="يمسح السجل الحالي ويضع الملف الجديد بدله">⬆️ استبدال الكل</button>
          <button class="btn ghost" id="rosterMerge" title="يدمج الملف مع السجل الحالي (يضيف طلاب/درجات بمطابقة رقم الطالب)">＋ إضافة/دمج</button>
          ${info.ready ? `<button class="btn danger" id="rosterClear" title="يمسح السجل من الذاكرة ويحذف ملفه — بعدها يصرّح البوت أنه لا يوجد سجل">🗑 حذف السجل</button>` : ''}
        </div>
      </div>
      <p class="small muted" style="margin:10px 2px 0">💡 <b>استبدال الكل</b>: ملف كامل جديد. · <b>إضافة/دمج</b>: يدمج بمطابقة «رقم الطالب». · <b>تحليل ذكي</b>: الوكيل يفصل الأعمدة بنفسه.</p>
    </div>

    <div class="card card-pad mb" style="border-color:var(--green)">
      <div class="flex between center wrap gap">
        <div class="flex center gap">
          <div style="width:46px;height:46px;border-radius:12px;background:#eef3f0;color:var(--green);display:grid;place-items:center">${I.student}</div>
          <div><b>ملف الهويات — تسجيل الدخول</b>
            <div class="small muted">الأعمدة المطلوبة: رقم الطالب · اسم الطالب · الصف · الفصل · ولي الأمر · هوية ولي الأمر</div></div>
        </div>
        <div class="flex gap wrap center">
          <button class="btn ghost" id="idTemplate">⬇️ تحميل نموذج</button>
          <input type="file" id="idFile" accept=".xlsx" style="max-width:200px;padding:9px;border:1.5px solid var(--line);border-radius:12px">
          <button class="btn" id="idUpload">🔐 رفع وتسجيل الهويات</button>
        </div>
      </div>
      <p class="small muted" style="margin:10px 2px 0">بعد الرفع يقدر وليّ الأمر يدخل <b>برقم الطالب</b> أو <b>برقم هويته</b> مباشرة. ملفات المواد تُرفع فوق بوضع «إضافة/دمج».</p>
    </div>
    ${s ? `<div class="grid cols4 mb">
      ${stat(I.student, s.عدد_الطلاب, 'إجمالي الطلاب', '#12735a', '#e3f6ec')}
      ${stat(I.home, s.المعدل_العام+'%', 'المعدل العام', '#b8901c', '#fff5e0')}
      ${stat(I.files, s.عدد_المتفوقين_90, 'متفوقون (90+)', '#0d5c46', '#eef3f0')}
      ${stat(I.bot, s.عدد_تحت_70, 'تحت 70%', '#c0392b', '#fdecea')}
    </div>
    <div class="card card-pad mb"><h3 style="margin:0 0 10px">متوسط كل مادة</h3>${barChart(s.متوسط_كل_مادة,'متوسط كل مادة على مستوى المدرسة',info.count+' طالب · المعدل العام '+s.المعدل_العام+'%')}</div>` : ''}
    <div class="card card-pad">
      <div class="flex between center wrap gap mb">
        <h3 style="margin:0">البحث في السجل</h3>
        <input id="rosterSearch" placeholder="ابحث بالاسم أو رقم الطالب..." value="${esc(rosterQ)}" style="flex:1;min-width:200px;max-width:340px;padding:10px 14px;border:1.5px solid var(--line);border-radius:12px">
      </div>
      <div id="rosterTable"><div class="empty-state small">جارٍ التحميل...</div></div>
    </div>`;
  el('rosterSmart').onclick = smartImport;
  el('rosterReplace').onclick = () => doImport('replace');
  el('rosterMerge').onclick = () => doImport('merge');
  if(el('rosterClear')) el('rosterClear').onclick = clearRoster;
  el('idTemplate').onclick = downloadIdTemplate;
  el('idUpload').onclick = uploadIdentities;
  animateCounts();
  const sb = el('rosterSearch');
  if(sb){ let t; sb.oninput = () => { clearTimeout(t); t = setTimeout(()=>{ rosterQ = sb.value.trim(); rosterPage = 1; loadRosterTable(); }, 250); }; }
  if(info.ready) loadRosterTable();
  else el('rosterTable').innerHTML = `<div class="empty-state small">استورد ملف الإكسل أولاً</div>`;
}
/* حذف السجل نهائياً — يمسح الذاكرة وملف السجل فلا يبقى تناقض */
async function clearRoster(){
  if(!confirm('حذف سجل الطلاب بالكامل؟\nسيُمسح من ذاكرة البوت ويُحذف ملفه، ولن يعرف أي طالب بعدها.')) return;
  const b = el('rosterClear'); b.disabled = true; b.textContent = 'يحذف...';
  try{
    const r = await api('/api/roster/clear', { method:'POST' });
    toast(`تم حذف السجل (${r.cleared} طالب) ✅`);
    rosterPage = 1; rosterQ = ''; go('roster');
  }catch(e){ toast(e.message); b.disabled = false; b.textContent = '🗑 حذف السجل'; }
}
/* تحميل نموذج ملف الهويات */
async function downloadIdTemplate(){
  try{
    const res = await fetch('/api/roster/template', { headers:{ Authorization:'Bearer '+TOKEN } });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'نموذج-ملف-الهويات.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
    toast('نزّل النموذج — عبّه وارفعه ✅');
  }catch(e){ toast('تعذّر التحميل: '+e.message); }
}

/* رفع ملف الهويات: الوكيل يفصل الأعمدة ثم يُدمج مباشرة */
async function uploadIdentities(){
  const f = el('idFile').files[0];
  if(!f){ toast('اختر ملف الهويات (.xlsx) أولاً'); return; }
  const b = el('idUpload'); b.disabled = true; b.textContent = '🤖 يقرأ ويسجّل...';
  try{
    const fd = new FormData(); fd.append('file', f);
    const a = await api('/api/roster/analyze', { method:'POST', form:fd });
    if(a.question){ b.disabled = false; b.textContent = '🔐 رفع وتسجيل الهويات'; showAgentResult(a, f); return; }
    const m = a.mapping || {};
    if(!m.id && !m.guardianId){ throw new Error('لم أجد عمود «رقم الطالب» ولا «هوية ولي الأمر» — استخدم النموذج.'); }
    const fd2 = new FormData(); fd2.append('file', f); fd2.append('mode','merge'); fd2.append('mapping', JSON.stringify(m));
    const r = await api('/api/roster/import', { method:'POST', form:fd2 });
    toast(`تم تسجيل الهويات — ${r.count} طالب ✅`);
    go('roster');
  }catch(e){ toast(e.message); b.disabled = false; b.textContent = '🔐 رفع وتسجيل الهويات'; }
}

/* الوكيل الذكي: يحلّل الملف ويفصل الأعمدة، ويسأل بخيارات عند الحاجة */
async function smartImport(){
  const f = el('rosterFile').files[0];
  if(!f){ toast('اختر ملف .xlsx أولاً'); return; }
  const b = el('rosterSmart'); b.disabled = true; b.textContent = '🤖 يحلّل...';
  try{
    const fd = new FormData(); fd.append('file', f);
    const a = await api('/api/roster/analyze', { method:'POST', form:fd });
    showAgentResult(a, f);
  }catch(e){ toast(e.message); }
  b.disabled = false; b.textContent = '🤖 تحليل ذكي';
}
function showAgentResult(a, file){
  const m = a.mapping || {};
  const kind = { identities:'ملف هويات (تسجيل دخول)', grades:'ملف درجات مواد', mixed:'ملف شامل (هويات + درجات)' }[a.kind] || 'غير محدد';
  const rows = [['رقم الطالب',m.id],['اسم الطالب',m.name],['الصف',m.level],['الفصل',m.section],
    ['وليّ الأمر',m.guardian],['هوية وليّ الأمر',m.guardianId],['الحضور',m.attendance],['ملاحظات',m.notes]]
    .filter(([,v])=>v).map(([k,v])=>`<div class="r-row"><span class="r-sub">${k}</span><span class="small">${esc(v)}</span></div>`).join('');
  const subs = (m.subjects||[]).map(s=>`<span class="tag approved" style="margin:2px">${esc(s)}</span>`).join('') || '<span class="small muted">لا مواد</span>';
  let body = `<p class="small">حلّلتُ <b>${esc(a.fileName || file.name)}</b> — ${a.totalRows} صف.</p>
    <span class="chip">${kind}</span>
    <div class="rep-sec">الأعمدة المتعرّف عليها</div>${rows || '<span class="small muted">لم أتعرّف على أعمدة الهوية</span>'}
    <div class="rep-sec">المواد المكتشفة</div>${subs}`;
  if(a.question){
    body += `<div class="rep-sec">يحتاج توضيحاً منك</div><p class="small">${esc(a.question.text)}</p>
      <div class="flex gap wrap" id="agentQ">${(a.question.options||[]).map((o,i)=>`<button class="btn ghost sm" data-i="${i}">${esc(o)}</button>`).join('')}</div>
      <div class="small muted mt" id="agentPick">— لم تختر بعد</div>`;
  }
  modal('🤖 نتيجة الوكيل', body, [
    { t:'＋ إضافة/دمج', cls:'btn', fn:()=>{ closeModal(); doImport('merge', m); } },
    { t:'⬆️ استبدال الكل', cls:'btn gold', fn:()=>{ closeModal(); doImport('replace', m); } },
    { t:'إلغاء', cls:'btn ghost', fn:closeModal },
  ]);
  const qb = el('agentQ');
  if(qb) qb.querySelectorAll('button').forEach(btn => btn.onclick = () => {
    qb.querySelectorAll('button').forEach(x => x.classList.add('ghost'));
    btn.classList.remove('ghost');
    el('agentPick').textContent = 'اخترت: ' + btn.textContent;
  });
}

async function doImport(mode, mapping){
  const f = el('rosterFile').files[0];
  if(!f){ toast('اختر ملف .xlsx أولاً'); return; }
  if(mode==='replace' && !confirm('استبدال كل السجل الحالي بهذا الملف؟')) return;
  const rb = el('rosterReplace'), mb = el('rosterMerge');
  rb.disabled = mb.disabled = true; (mode==='merge'?mb:rb).textContent = '⏳ جارٍ...';
  const fd = new FormData(); fd.append('file', f); fd.append('mode', mode);
  if(mapping) fd.append('mapping', JSON.stringify(mapping));
  try{
    const r = await api('/api/roster/import', { method:'POST', form:fd });
    toast(`${mode==='merge'?'تم الدمج':'تم الاستبدال'} — ${r.count} طالب في ${r.ms}ms ✅`);
    rosterPage = 1; rosterQ = ''; go('roster');
  }catch(e){ toast(e.message); rb.disabled = mb.disabled = false; go('roster'); }
}
async function loadRosterTable(){
  const box = el('rosterTable'); if(!box) return;
  const r = await api(`/api/roster/search?q=${encodeURIComponent(rosterQ)}&page=${rosterPage}&per=25`);
  if(!r.rows.length){ box.innerHTML = `<div class="empty-state small">لا نتائج</div>`; return; }
  const subs = Object.keys(r.rows[0].grades || {});
  const pages = Math.ceil(r.total / r.per);
  box.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>الرقم</th><th>الاسم</th><th>الصف</th><th>الفصل</th><th>الحضور</th>
      ${subs.map(x=>`<th>${esc(x.split(' ')[0])}</th>`).join('')}<th>المعدل</th></tr></thead><tbody>
      ${r.rows.map(s=>`<tr><td class="muted small">${esc(s.id)}</td><td><b>${esc(s.name)}</b></td><td class="small">${esc(s.level)}</td><td>${esc(s.section)}</td>
        <td>${s.attendance}%</td>${subs.map(x=>`<td>${s.grades[x]!=null?s.grades[x]:'—'}</td>`).join('')}
        <td><span class="tag ${s.avg>=90?'approved':s.avg>=70?'pending':'rejected'}">${s.avg}</span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="flex between center mt wrap gap"><span class="small muted">${r.total} نتيجة · صفحة ${r.page} من ${pages}</span>
      <div class="flex gap"><button class="btn ghost sm" ${r.page<=1?'disabled':''} onclick="rosterGo(${r.page-1})">السابق</button>
      <button class="btn ghost sm" ${r.page>=pages?'disabled':''} onclick="rosterGo(${r.page+1})">التالي</button></div></div>`;
}
function rosterGo(p){ rosterPage = p; loadRosterTable(); }
function botSay(html){ const st = el('stream'); if(!st) return;
  st.insertAdjacentHTML('beforeend', `<div class="msg bot"><div class="who">${I.bot}</div><div class="bubble">${html}</div></div>`); st.scrollTop = st.scrollHeight; }
function meSay(t){ const st = el('stream');
  st.insertAdjacentHTML('beforeend', `<div class="msg me"><div class="who">${I.user}</div><div class="bubble">${esc(t)}</div></div>`); st.scrollTop = st.scrollHeight; }
const THINK_CARD = `<div class="think-card"><span class="think-ring"></span>
  <span class="think-txt"><b>يحلّل البيانات…</b><span>يجهّز الإجابة من السجل المحفوظ</span></span></div>`;
function typingBubble(){ const st = el('stream'); const w = document.createElement('div'); w.className = 'msg bot';
  w.innerHTML = `<div class="who">${I.bot}</div><div class="bubble">${THINK_CARD}</div>`;
  st.appendChild(w); st.scrollTop = st.scrollHeight; return w.querySelector('.bubble'); }
function fill(b, html){ b.classList.remove('typing'); b.innerHTML = html; const st = el('stream'); if(st) st.scrollTop = st.scrollHeight; }

/* يشيل رموز الأدوات + أي رمز ناقص أثناء البثّ */
function cleanLive(t){ return t.replace(/::CHART::|::DONUT::|::REPORT::/g,'').replace(/:{1,2}[A-Z]*:?$/,''); }
function scrollStream(){ const st = el('stream'); if(st) st.scrollTop = st.scrollHeight; }

async function sendChat(){
  const inp = el('chatIn'); const q = inp.value.trim(); if(!q) return;
  inp.value = ''; meSay(q);
  const b = typingBubble();
  let full = '', started = false, final = null, failed = null;
  try{
    const res = await fetch('/api/chat/stream', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+TOKEN },
      body: JSON.stringify({ studentId:activeChild, message:q, convoId:activeConvo }),
    });
    if(!res.ok || !res.body) throw new Error('HTTP '+res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while(true){
      const { done, value } = await reader.read(); if(done) break;
      buf += dec.decode(value, { stream:true });
      const blocks = buf.split('\n\n'); buf = blocks.pop();
      for(const blk of blocks){
        const ev = (blk.match(/^event: (.+)$/m) || [])[1];
        const dl = (blk.match(/^data: (.+)$/m) || [])[1];
        if(!ev || !dl) continue;
        let data; try{ data = JSON.parse(dl); }catch(_){ continue; }
        if(ev === 'think'){
          if(!started) b.innerHTML = THINK_CARD;
          scrollStream();
        } else if(ev === 'token'){
          if(!started){ started = true; b.classList.remove('typing'); }
          full += data.d;
          b.innerHTML = fmt(cleanLive(full)) + '<span class="caret"></span>';
          scrollStream();
        } else if(ev === 'done'){ final = data; }
        else if(ev === 'error'){ failed = data; }
      }
    }
  }catch(e){ failed = { error:e.message }; }

  // رسم النتيجة (نفس الشكل للمتدفّق وغير المتدفّق)
  const renderResult = (r) => {
    const s = r.student, avg = r.avg;
    const who = s ? `${s.name}${s.classNo?' — '+s.classNo:''}` : '';
    let extra = '';
    if(r.chart && s && s.grades && Object.keys(s.grades).length)
      extra += barChart(s.grades, `درجات الطالب ${s.name}`, `${s.grade||''} ${s.classNo?'· '+s.classNo:''}`);
    if(r.donut && s) extra += donut(s.attendance, 'المواظبة', `حضور الطالب ${s.name}`, who);
    if(r.report && s && s.grades && Object.keys(s.grades).length) extra += repCardBox(s, avg != null ? avg : 0);
    if(r.top && r.topData) extra += topChart(r.topData);
    fill(b, fmt(r.text || cleanLive(full)) + extra);
    afterConvo(r);
  };
  if(final){ renderResult(final); return; }

  // احتياط: طلب غير متدفّق — يعمل على متصفحات الجوال التي لا تدعم البثّ
  try{
    const r = await api('/api/chat', { method:'POST', body:{ studentId:activeChild, message:q, convoId:activeConvo } });
    if(r.fallback) throw new Error(r.error || 'ai');
    renderResult(r); return;
  }catch(e2){
    const s = failed && failed.student;
    fill(b, `<p class="small muted" style="margin:0 0 8px">⚠️ تعذّر الاتصال بالمساعد الذكي — ${esc((failed&&failed.error)||e2.message||'')}</p>`
          + (s && s.grades ? localReply(q, s, failed.avg || 0) : ''));
  }
}
/* fallback محلي */
function localReply(q, s, avg){
  const t = q.toLowerCase(); const has = (...w) => w.some(x => t.includes(x));
  const ge = Object.entries(s.grades);
  if(has('تقرير','report','كشف كامل')) return repCardBoxIntro(s, avg);
  if(has('رسم','بياني','chart','مخطط')) return `الرسم البياني لدرجات <b>${esc(s.name)}</b> (المتوسط ${avg}%):`+barChart(s.grades,`درجات الطالب ${s.name}`,`${s.grade||''} ${s.classNo||''}`);
  if(has('حضور','غياب','attendance')) return `نسبة حضور <b>${esc(s.name)}</b> هي <b>${s.attendance}%</b>. ${donut(s.attendance,'المواظبة',`حضور الطالب ${s.name}`,s.classNo||'')}`;
  if(has('أفضل','افضل','أضعف','اضعف','best','worst')){
    const sr = [...ge].sort((a,b)=>b[1]-a[1]); const top = sr[0], low = sr[sr.length-1];
    return `<p>أقوى مادة: <b style="color:var(--ok)">${esc(top[0])} (${top[1]}%)</b> ⭐</p><p>تحتاج تحسين: <b style="color:var(--danger)">${esc(low[0])} (${low[1]}%)</b></p>`+barChart(s.grades,`درجات الطالب ${s.name}`,`${s.grade||''} ${s.classNo||''}`);
  }
  return `<p>ملخص <b>${esc(s.name)}</b> — المعدل ${avg}% · الحضور ${s.attendance}%</p><p class="small muted">${esc(s.notes||'')}</p>`+barChart(s.grades,`درجات الطالب ${s.name}`,`${s.grade||''} ${s.classNo||''}`);
}

/* ============================================================
   VISUALS — بطاقات مرفقة معنونة (كل مرفق يوضّح ماذا يعرض ولمن)
   ============================================================ */
const gradeColor = v => v>=90 ? '#1e8e5a' : v>=80 ? '#12735a' : v>=70 ? '#c98a1a' : '#c0392b';
const gradeLabel = v => v>=90 ? 'متقن' : v>=80 ? 'جيد جداً' : v>=70 ? 'جيد' : 'يحتاج دعم';

function vizCard(title, subtitle, inner, foot){
  return `<div class="viz">
    <div class="viz-head"><div class="viz-ic">${I.logo}</div>
      <div class="viz-t"><b>${esc(title)}</b>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div></div>
    <div class="viz-body">${inner}</div>
    ${foot?`<div class="viz-foot">${foot}</div>`:''}</div>`;
}

/* أعمدة أفقية بـ HTML — الأسماء العربية لا تُقصّ أبداً (لا حساب مقاسات) */
function hbarRows(rows){
  return `<div class="hbar">${rows.map(r=>`
    <span class="hbar-lbl" title="${esc(r.label)}">${esc(r.label)}</span>
    <span class="hbar-track"><i style="width:${Math.max(2,Math.min(100,r.value))}%;background:${gradeColor(r.value)}"></i></span>
    <span class="hbar-val" style="color:${gradeColor(r.value)}">${r.value}%</span>`).join('')}</div>`;
}
function barChart(grades, title, subtitle){
  const e = Object.entries(grades || {});
  if(!e.length) return '';
  const avg = Math.round(e.reduce((a,[,v])=>a+v,0)/e.length);
  const body = hbarRows(e.map(([k,v])=>({ label:k, value:v })));
  const legend = `<span class="lg-item"><i style="background:#1e8e5a"></i>متقن 90+</span>
    <span class="lg-item"><i style="background:#12735a"></i>جيد جداً 80+</span>
    <span class="lg-item"><i style="background:#c98a1a"></i>جيد 70+</span>
    <span class="lg-item"><i style="background:#c0392b"></i>يحتاج دعم</span>
    <span class="lg-item" style="margin-inline-start:auto"><b>المعدل ${avg}%</b></span>`;
  return vizCard(title || 'مقارنة الدرجات', subtitle || `${e.length} مواد · المعدل ${avg}%`, body, legend);
}

function donut(pct, label, title, subtitle){
  const r=46, c=2*Math.PI*r, off=c*(1-pct/100);
  const col = pct>=95 ? '#1e8e5a' : pct>=85 ? '#12735a' : '#c98a1a';
  const verdict = pct>=95 ? 'مواظبة ممتازة' : pct>=85 ? 'مواظبة جيدة' : 'تحتاج متابعة';
  const svg = `<div class="donut-wrap"><svg class="chart" viewBox="0 0 150 130" style="max-width:180px">
      <circle cx="75" cy="62" r="${r}" fill="none" stroke="#eef3f0" stroke-width="15"/>
      <circle cx="75" cy="62" r="${r}" fill="none" stroke="${col}" stroke-width="15" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 75 62)">
        <animate attributeName="stroke-dashoffset" from="${c}" to="${off}" dur="0.7s"/></circle>
      <text x="75" y="60" text-anchor="middle" font-size="24" font-weight="800" fill="#12261f">${pct}%</text>
      <text x="75" y="78" text-anchor="middle" font-size="10" fill="#5b6b64">${esc(label||'الحضور')}</text></svg>
    <div class="donut-side"><b style="color:${col}">${verdict}</b>
      <span class="small muted">أيام الغياب التقديرية: ${Math.round((100-pct)/100*180)} من 180 يوماً دراسياً</span></div></div>`;
  return vizCard(title || 'نسبة الحضور والمواظبة', subtitle || '', svg);
}

/* ترتيب أعلى الطلاب — لوضع الإدارة */
function topChart(rows, title){
  if(!rows || !rows.length) return '';
  const body = `<div class="hbar wide">${rows.map((r,i)=>{
    const v = r.المعدل;
    return `<span class="hbar-lbl" title="${esc(r.الاسم)}"><b class="rk">${i+1}</b>${esc(r.الاسم)}</span>
      <span class="hbar-track"><i style="width:${Math.max(2,Math.min(100,v))}%;background:${gradeColor(v)}"></i></span>
      <span class="hbar-val" style="color:${gradeColor(v)}">${v}%</span>`;
  }).join('')}</div>`;
  return vizCard(title || 'أعلى الطلاب في المعدل العام', `أول ${rows.length} على مستوى المدرسة`, body,
    rows[0] ? `<span class="small muted">المتصدر: <b>${esc(rows[0].الاسم)}</b> — ${esc(rows[0].الفصل||'')}</span>` : '');
}

/* تقرير الطالب — وثيقة منسّقة */
function repCardBox(s, avg){
  const d = new Date().toLocaleDateString('ar-SA');
  const e = Object.entries(s.grades || {});
  const best = e.length ? e.reduce((a,b)=> b[1]>a[1]?b:a) : null;
  const low  = e.length ? e.reduce((a,b)=> b[1]<a[1]?b:a) : null;
  const rows = e.map(([k,v])=>`<div class="r-row">
      <span class="r-sub">${esc(k)}</span>
      <span class="r-bar"><i style="width:${v}%;background:${gradeColor(v)}"></i></span>
      <span class="r-val" style="color:${gradeColor(v)}">${v}%</span>
      <span class="r-tag">${gradeLabel(v)}</span></div>`).join('');
  return `<div class="report">
    <div class="report-head"><div class="lg">${I.logo}</div>
      <div><h3>تقرير مستوى الطالب</h3><small>ذكاء الأندلس · Smart Andlus — إدارة الشؤون التعليمية</small></div>
      <div class="rep-avg"><b>${avg}%</b><span>المعدل</span></div></div>
    <div class="report-body">
      <div class="rep-meta">
        <div><span>اسم الطالب</span><b>${esc(s.name)}</b></div>
        <div><span>الصف</span><b>${esc(s.grade||'—')}</b></div>
        <div><span>الفصل</span><b>${esc(s.classNo||'—')}</b></div>
        <div><span>نسبة المواظبة</span><b>${s.attendance}%</b></div>
      </div>
      <div class="rep-sec">التحصيل حسب المواد</div>
      ${rows}
      ${best?`<div class="rep-sec">الخلاصة</div>
      <div class="small" style="line-height:1.9">
        أعلى تحصيل في <b style="color:#1e8e5a">${esc(best[0])} (${best[1]}%)</b>،
        وأدنى تحصيل في <b style="color:#c0392b">${esc(low[0])} (${low[1]}%)</b> بفارق ${best[1]-low[1]} نقطة.
        ${s.notes?`<br>ملاحظات المعلم: ${esc(s.notes)}`:''}
      </div>`:''}
    </div>
    <div class="report-foot"><span>تاريخ الإصدار: ${d}</span><span>وثيقة تجريبية — غير رسمية</span></div></div>
    <button class="btn ghost sm mt" onclick="window.print()">🖨️ طباعة / حفظ التقرير</button>`;
}
function repCardBoxIntro(s,avg){ return `<p>تفضّلوا التقرير الكامل للطالب <b>${esc(s.name)}</b>:</p>`+repCardBox(s,avg); }

/* ============================================================
   PARENT — children overview
   ============================================================ */
async function renderChildren(v){
  const { children } = await api('/api/children');
  v.innerHTML = `<div class="page-head"><h2>أبنائي</h2><p>نظرة عامة على أداء أبنائك الدراسي</p></div>
    <div class="grid cols2">${children.map(s=>{
      const avg = Math.round(Object.values(s.grades).reduce((a,b)=>a+b,0)/Object.values(s.grades).length);
      return `<div class="card card-pad"><div class="flex center gap mb"><div class="avatar" style="width:44px;height:44px;border-radius:12px;font-size:18px">${esc(s.name[0])}</div><div><b style="font-size:16px">${esc(s.name)}</b><div class="small muted">${esc(s.grade)} · ${esc(s.classNo)}</div></div></div>
        <div class="flex gap wrap mb"><span class="chip">المعدل ${avg}%</span><span class="chip">الحضور ${s.attendance}%</span></div>${barChart(s.grades,`درجات ${s.name}`,`${s.grade} · ${s.classNo}`)}
        <button class="btn block mt" onclick="setChild('${s.id}')">${I.chat} اسأل المساعد عن ${esc(s.name.split(' ')[0])}</button></div>`;
    }).join('')}</div>`;
}

/* ============================================================
   TEACHER files
   ============================================================ */
async function renderTeacherFiles(v){
  const { files } = await api('/api/files');
  v.innerHTML = `<div class="page-head flex between center wrap gap"><div><h2>ملفات مادة ${esc(ME.subject||'')}</h2><p>ارفع كشوف الدرجات وخطط الدروس — تُرسل للمدير للمراجعة</p></div>
      <button class="btn gold" id="upBtn">＋ رفع ملف جديد</button></div>
    <div class="grid">${files.length ? files.map(fileRow).join('') : emptyBox('لا توجد ملفات بعد. ابدأ برفع أول ملف لمادتك.')}</div>`;
  el('upBtn').onclick = openUpload;
}
function fileRow(f){
  const label = { pending:'قيد المراجعة', approved:'مقبول', rejected:'مرفوض' }[f.status];
  return `<div class="card card-pad flex center gap wrap"><div class="file-pill" style="flex:1;border:none;padding:0"><div class="fi">${I.files}</div><div class="meta"><b>${esc(f.name)}</b><span>${esc(f.subject)} · ${esc(f.ownerName)} · ${new Date(f.ts).toLocaleDateString('ar-SA')}</span></div></div>
    <span class="tag ${f.status}">${label}</span><button class="btn ghost sm" onclick="viewFile('${f.id}')">فتح</button></div>`;
}
function openUpload(){
  modal('رفع ملف — '+(ME.subject||''), `
    <div class="field"><label>اسم الملف (اختياري)</label><input id="upName" placeholder="مثال: درجات الاختبار الشهري"></div>
    <div class="field"><label>ارفع ملفاً (PDF / صورة / نص)</label><input id="upFile" type="file"></div>
    <div class="field"><label>أو الصق المحتوى نصياً</label><textarea id="upContent" rows="5" placeholder="محتوى الكشف / الخطة..."></textarea></div>
    <p class="small muted">الملفات النصية تُقرأ تلقائياً لتغذية عقل البوت.</p>`,
    [{ t:'رفع وإرسال للمدير', cls:'btn', fn: async () => {
      const fileInput = el('upFile'); const name = el('upName').value.trim(); const content = el('upContent').value.trim();
      if(!fileInput.files[0] && !content && !name){ toast('أضف ملفاً أو محتوى'); return; }
      const fd = new FormData();
      if(fileInput.files[0]) fd.append('file', fileInput.files[0]);
      if(name) fd.append('name', name);
      if(content) fd.append('content', content);
      try{
        const r = await api('/api/files', { method:'POST', form:fd });
        closeModal(); go('tfiles');
        const ai = r.file && r.file.autoIdentities;
        toast(ai ? `تم الرفع ✅ وسُجّلت بيانات ${ai.total} طالب في السجل`
                 : 'تم رفع الملف وإرساله للمدير ✅');
      }catch(e){ toast(e.message); }
    }}, { t:'إلغاء', cls:'btn ghost', fn:closeModal }]);
}
async function viewFile(id){
  const { files } = await api('/api/files');
  const f = files.find(x=>x.id===id); if(!f){ toast('غير موجود'); return; }
  const label = { pending:'قيد المراجعة', approved:'مقبول', rejected:'مرفوض' }[f.status];
  let viewer;
  if(f.path && /image\//.test(f.mime)) viewer = `<div class="file-view"><img src="/api/files/${f.id}/raw?t=${TOKEN}" alt="${esc(f.name)}"></div>`;
  else if(f.path && /pdf/.test(f.mime)) viewer = `<div class="file-view" style="max-height:420px"><iframe src="/api/files/${f.id}/raw?t=${TOKEN}" style="height:400px"></iframe></div>`;
  else viewer = `<div class="file-view">${esc(f.content || '(بدون محتوى نصي — ملف مرفق)')}</div>`;
  const body = `<div class="file-pill mb"><div class="fi">${I.files}</div><div class="meta"><b>${esc(f.name)}</b><span>${esc(f.subject)} · ${esc(f.ownerName)}</span></div><span class="tag ${f.status}">${label}</span></div>${viewer}`;
  let btns = [{ t:'إغلاق', cls:'btn ghost', fn:closeModal }];
  if(ME.role === 'admin'){
    btns = [
      { t:'✅ قبول', cls:'btn', fn: async () => { await api('/api/files/'+id, { method:'PUT', body:{ status:'approved' } }); closeModal(); refreshView(); toast('تم قبول الملف'); } },
      { t:'✖ رفض', cls:'btn danger', fn: async () => { await api('/api/files/'+id, { method:'PUT', body:{ status:'rejected' } }); closeModal(); refreshView(); toast('تم رفض الملف'); } },
      { t:'✏️ تعديل', cls:'btn ghost', fn: () => editFile(f) },
      { t:'✉️ مراسلة المعلم', cls:'btn gold', fn: () => { closeModal(); go('messages'); setTimeout(()=>openThread(f.owner), 200); } },
      { t:'🗑 حذف', cls:'btn danger', fn: () => delFile(f) },
    ];
  }
  modal('عرض الملف', body, btns);
}
/* حذف ملف نهائياً — وينبّه إن كان هو مصدر سجل الطلاب */
async function delFile(f){
  const isRoster = f.subject === 'سجل الطلاب';
  const warn = isRoster ? '\n⚠️ هذا ملف سجل الطلاب — سيُمسح السجل من ذاكرة البوت أيضاً.' : '';
  if(!confirm(`حذف «${f.name}» نهائياً؟ لا يمكن التراجع.${warn}`)) return;
  try{
    const r = await api('/api/files/'+f.id, { method:'DELETE' });
    closeModal(); refreshView();
    toast(r.clearedRoster ? `تم حذف الملف ومسح السجل (${r.clearedRoster} طالب) ✅` : 'تم حذف الملف ✅');
  }catch(e){ toast(e.message); }
}
function editFile(f){
  modal('تعديل الملف', `<div class="field"><label>الاسم</label><input id="edName" value="${esc(f.name)}"></div><div class="field"><label>المحتوى</label><textarea id="edC" rows="8">${esc(f.content||'')}</textarea></div>`,
    [{ t:'حفظ التعديل', cls:'btn', fn: async () => { await api('/api/files/'+f.id, { method:'PUT', body:{ name:el('edName').value, content:el('edC').value, status:'approved' } }); closeModal(); refreshView(); toast('تم حفظ التعديل'); } },
     { t:'إلغاء', cls:'btn ghost', fn:closeModal }]);
}

/* ============================================================
   ADMIN — dashboard
   ============================================================ */
async function renderDash(v){
  const [{ teachers }, { students }, { files }] = await Promise.all([ api('/api/teachers'), api('/api/students'), api('/api/files') ]);
  const pend = files.filter(f=>f.status==='pending').length;
  v.innerHTML = `<div class="page-head"><h2>لوحة المدير</h2><p>مرحباً ${esc(ME.name)} — نظرة عامة على المنصة</p></div>
    <div class="grid cols4 mb">
      ${stat(I.teacher, teachers.length, 'المعلمون', '#12735a', '#e3f6ec')}
      ${stat(I.student, students.length, 'الطلاب', '#b8901c', '#fff5e0')}
      ${stat(I.files, files.length, 'الملفات', '#0d5c46', '#eef3f0')}
      ${stat(I.bot, pend, 'بانتظار المراجعة', '#c0392b', '#fdecea')}
    </div>
    <div class="grid cols2">
      <div class="card card-pad"><h3 style="margin:0 0 12px">آخر الملفات</h3>
        ${files.slice(-4).reverse().map(f=>`<div class="flex between center" style="padding:9px 0;border-bottom:1px solid var(--line)"><div><b class="small">${esc(f.name)}</b><div class="small muted">${esc(f.ownerName)}</div></div><span class="tag ${f.status}">${{pending:'مراجعة',approved:'مقبول',rejected:'مرفوض'}[f.status]}</span></div>`).join('') || '<p class="muted small">لا ملفات</p>'}
        <button class="btn ghost block mt" onclick="go('afiles')">إدارة كل الملفات</button></div>
      <div class="card card-pad"><h3 style="margin:0 0 12px">إجراءات سريعة</h3>
        <button class="btn block mb" onclick="go('teachers')">${I.teacher} إضافة / إدارة المعلمين</button>
        <button class="btn ghost block mb" onclick="go('brain')">${I.bot} تغذية عقل البوت</button>
        <button class="btn ghost block mb" onclick="go('messages')">${I.msg} مراسلة المعلمين</button>
        <button class="btn danger block" id="resetBtn">إعادة تعيين البيانات التجريبية</button></div>
    </div>`;
  el('resetBtn').onclick = async () => { if(confirm('إعادة تعيين كل البيانات التجريبية؟')){ await api('/api/reset', { method:'POST' }); toast('تمت الإعادة'); go('dash'); } };
  animateCounts();
}
function stat(ic,n,label,col,bg){ return `<div class="stat"><div class="ic" style="background:${bg};color:${col}">${ic}</div><div><b data-count="${esc(String(n))}">${n}</b><span>${label}</span></div></div>`; }
/* عدّاد تصاعدي للأرقام في بطاقات الإحصاء */
function animateCounts(){
  document.querySelectorAll('.stat b[data-count]').forEach(b=>{
    if(b.dataset.done) return; b.dataset.done='1';
    const raw = String(b.dataset.count);
    const m = raw.match(/^(\D*)(\d+)(.*)$/); if(!m){ return; }
    const pre=m[1], target=+m[2], suf=m[3];
    const dur=800, t0=performance.now();
    function tick(t){ const p=Math.min(1,(t-t0)/dur); const val=Math.round(target*(1-Math.pow(1-p,3)));
      b.textContent=pre+val+suf; if(p<1) requestAnimationFrame(tick); }
    b.textContent=pre+'0'+suf; requestAnimationFrame(tick);
  });
}

/* ============================================================
   ADMIN — teachers
   ============================================================ */
async function renderTeachers(v){
  const { teachers } = await api('/api/teachers');
  v.innerHTML = `<div class="page-head flex between center wrap gap"><div><h2>إدارة المعلمين</h2><p>إضافة حسابات المعلمين وتحديد المادة والصلاحيات</p></div>
      <button class="btn gold" id="addT">＋ إضافة معلم</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>الاسم</th><th>المادة</th><th>اسم الدخول</th><th>الهوية</th><th>الصلاحيات</th><th></th></tr></thead><tbody>
      ${teachers.map(t=>`<tr><td><b>${esc(t.name)}</b></td><td><span class="chip">${esc(t.subject||'')}</span></td><td>${esc(t.user)}</td><td class="muted">${esc(t.nid||'—')}</td>
        <td>${(t.perms||[]).map(p=>`<span class="tag approved" style="margin:1px">${PERMS[p]||p}</span>`).join(' ')||'—'}</td>
        <td class="flex gap"><button class="btn ghost sm" onclick='openTeacher(${JSON.stringify(t)})'>تعديل</button><button class="btn danger sm" onclick="delTeacher('${t.id}')">حذف</button></td></tr>`).join('')}
    </tbody></table></div>`;
  el('addT').onclick = () => openTeacher(null);
}
function openTeacher(t){
  modal(t?'تعديل معلم':'إضافة معلم جديد', `
    <div class="field"><label>الاسم الكامل</label><input id="tName" value="${t?esc(t.name):''}" placeholder="أ. محمد ..."></div>
    <div class="field"><label>المادة</label><select id="tSubj">${SUBJECTS.map(s=>`<option ${t&&t.subject===s?'selected':''}>${s}</option>`).join('')}</select></div>
    <div class="grid cols2"><div class="field"><label>اسم الدخول</label><input id="tUser" value="${t?esc(t.user):''}" placeholder="username"></div>
      <div class="field"><label>رقم الهوية (اختياري)</label><input id="tNid" value="${t?esc(t.nid||''):''}" placeholder="10xxxxxxxx"></div></div>
    <div class="field"><label>كلمة المرور ${t?'(اتركها فارغة لعدم التغيير)':''}</label><input id="tPass" value="${t?'':'1234'}"></div>
    <div class="field"><label>الصلاحيات</label><div class="perm-grid">${Object.entries(PERMS).map(([k,l])=>`<label><input type="checkbox" value="${k}" ${(!t&&['files','messages'].includes(k))||(t&&(t.perms||[]).includes(k))?'checked':''}> ${l}</label>`).join('')}</div></div>`,
    [{ t:t?'حفظ':'إضافة', cls:'btn', fn: async () => {
      const perms = [...document.querySelectorAll('.perm-grid input:checked')].map(x=>x.value);
      const body = { name:el('tName').value.trim(), user:el('tUser').value.trim(), subject:el('tSubj').value, nid:el('tNid').value.trim(), perms };
      const pass = el('tPass').value.trim(); if(pass) body.pass = pass;
      if(!body.name || !body.user){ toast('أكمل الاسم واسم الدخول'); return; }
      try{ await api(t?'/api/teachers/'+t.id:'/api/teachers', { method:t?'PUT':'POST', body }); closeModal(); go('teachers'); toast(t?'تم الحفظ ✅':'تمت الإضافة ✅'); }
      catch(e){ toast(e.message); }
    }}, { t:'إلغاء', cls:'btn ghost', fn:closeModal }]);
}
async function delTeacher(id){ if(confirm('حذف هذا المعلم؟ لا يمكن التراجع.')){ await api('/api/teachers/'+id, { method:'DELETE' }); go('teachers'); toast('تم الحذف'); } }

/* ============================================================
   ADMIN — students
   ============================================================ */
let studPage = 1, studQ = '';
async function renderStudents(v){
  const { students, parents, rosterCount, manualCount } = await api('/api/students');
  const q = studQ.toLowerCase();
  const all = q ? students.filter(s=> (s.name||'').toLowerCase().includes(q) || (s.id||'').toLowerCase().includes(q)) : students;
  const per = 24, pages = Math.max(1, Math.ceil(all.length/per));
  if(studPage > pages) studPage = pages;
  const list = all.slice((studPage-1)*per, studPage*per);
  v.innerHTML = `<div class="page-head flex between center wrap gap"><div><h2>الطلاب والدرجات</h2>
      <p>${students.length ? `${students.length} طالب — ${rosterCount} من السجل المستورد و${manualCount} مُضاف يدوياً` : 'لا يوجد طلاب — استورد ملف السجل أو أضف طالباً'}</p></div>
      <button class="btn gold" id="addS">＋ إضافة طالب</button></div>
    ${students.length ? `<div class="flex between center wrap gap mb">
      <input id="studSearch" placeholder="ابحث بالاسم أو رقم الطالب..." value="${esc(studQ)}" style="flex:1;min-width:200px;max-width:340px;padding:10px 14px;border:1.5px solid var(--line);border-radius:12px">
      <span class="small muted">${all.length} نتيجة · صفحة ${studPage} من ${pages}</span></div>` : ''}
    <div class="grid">${list.length ? list.map(s=>{
      const avg = Math.round(Object.values(s.grades||{}).reduce((a,b)=>a+b,0)/(Object.values(s.grades||{}).length||1)) || 0;
      const initial = (s.name||'؟').trim().charAt(0) || '؟';
      const src = s.source==='roster' ? `<span class="tag approved" title="من ملف السجل المستورد">السجل</span>` : `<span class="tag pending" title="مُضاف يدوياً">يدوي</span>`;
      return `<div class="card card-pad"><div class="flex between center wrap gap mb">
        <div class="flex center gap"><div class="avatar" style="width:42px;height:42px;border-radius:12px">${esc(initial)}</div><div><b style="font-size:16px">${esc(s.name||'—')}</b><div class="small muted">${esc(s.id)} · ${esc(s.grade||'—')} · ${esc(s.classNo||'—')} · حضور ${s.attendance||0}%</div></div></div>
        <div class="flex gap center">${src}<span class="chip">المعدل ${avg}%</span>
        <button class="btn ghost sm" onclick='openStudent(${esc(JSON.stringify(s))},${esc(JSON.stringify(parents))})'>تعديل</button>
        <button class="btn danger sm" onclick="delStudent('${esc(s.id)}')">حذف</button></div></div>
        <div class="flex gap wrap">${Object.entries(s.grades||{}).map(([k,val])=>`<span class="tag ${val>=90?'approved':val>=70?'pending':'rejected'}">${esc(String(k).split(' ')[0])}: ${val}</span>`).join('') || '<span class="small muted">لا درجات مسجّلة</span>'}</div></div>`;
    }).join('') : emptyBox(students.length ? 'لا نتائج للبحث.' : 'لا يوجد طلاب بعد — استورد ملف السجل من «سجل الطلاب» أو أضف طالباً يدوياً.')}</div>
    ${pages>1 ? `<div class="flex between center mt"><button class="btn ghost sm" ${studPage<=1?'disabled':''} onclick="studGo(${studPage-1})">السابق</button>
      <span class="small muted">${studPage} / ${pages}</span>
      <button class="btn ghost sm" ${studPage>=pages?'disabled':''} onclick="studGo(${studPage+1})">التالي</button></div>` : ''}`;
  el('addS').onclick = () => openStudent(null, parents);
  const sb = el('studSearch');
  if(sb){ let t; sb.oninput = () => { clearTimeout(t); t = setTimeout(()=>{ studQ = sb.value.trim(); studPage = 1; renderStudents(v); }, 250); }; }
}
function studGo(p){ studPage = p; renderStudents(el('mainView')); }
async function delStudent(id){
  if(!confirm('حذف هذا الطالب نهائياً؟\nسيُحذف من السجل ومن حسابات أولياء الأمور ومن المحادثات المحفوظة.')) return;
  try{ await api('/api/students/'+id, { method:'DELETE' }); toast('تم حذف الطالب ✅'); renderStudents(el('mainView')); }
  catch(e){ toast(e.message); }
}
function openStudent(s, parents){
  const fromRoster = !!(s && s.source === 'roster');
  // مواد النموذج = مواد المدرسة + أي مادة فعلية في سجل هذا الطالب
  const subs = Array.from(new Set([...(s ? Object.keys(s.grades||{}) : []), ...SUBJECTS]));
  const guardianField = fromRoster
    ? `<div class="grid cols2"><div class="field"><label>ولي الأمر</label><input id="sGuardian" value="${esc(s.guardian||'')}" placeholder="اسم ولي الأمر"></div>
        <div class="field"><label>هوية ولي الأمر (يدخل بها)</label><input id="sGuardianId" value="${esc(s.guardianId||'')}" inputmode="numeric"></div></div>`
    : `<div class="field"><label>ولي الأمر</label><select id="sParent">${parents.length ? parents.map(p=>`<option value="${p.id}" ${s&&s.parent===p.id?'selected':''}>${esc(p.name)}</option>`).join('') : '<option value="">لا يوجد أولياء أمور مسجّلون</option>'}</select></div>`;
  modal(s?'تعديل الطالب':'إضافة طالب', `
    ${fromRoster ? `<p class="small muted" style="margin:0 0 10px">🗂 هذا الطالب من ملف السجل المستورد — التعديل يُحدّث السجل وذاكرة البوت فوراً.</p>` : ''}
    <div class="grid cols2"><div class="field"><label>اسم الطالب</label><input id="sName" value="${s?esc(s.name):''}"></div>
      <div class="field"><label>الصف</label><input id="sGrade" value="${s?esc(s.grade||''):''}" placeholder="الأول متوسط"></div>
      <div class="field"><label>الفصل</label><input id="sClass" value="${s?esc(s.classNo||''):''}" placeholder="1/أ"></div>
      <div class="field"><label>نسبة الحضور %</label><input id="sAtt" type="number" value="${s?(s.attendance||0):95}"></div></div>
    ${guardianField}
    <label class="small" style="font-weight:700;color:var(--muted)">الدرجات</label>
    <div class="perm-grid mt">${subs.map(sub=>`<label style="justify-content:space-between">${esc(sub)}<input type="number" data-subj="${esc(sub)}" style="width:70px;padding:5px;border:1px solid var(--line);border-radius:8px" value="${s&&s.grades&&s.grades[sub]!=null?s.grades[sub]:''}" placeholder="—"></label>`).join('')}</div>
    <div class="field mt"><label>ملاحظات المعلم</label><textarea id="sNotes" rows="2">${s?esc(s.notes||''):''}</textarea></div>`,
    [{ t:s?'حفظ':'إضافة', cls:'btn', fn: async () => {
      const grades = {};
      document.querySelectorAll('[data-subj]').forEach(i=>{ if(String(i.value).trim()!=='') grades[i.dataset.subj] = +i.value||0; });
      const body = { name:el('sName').value.trim(), grade:el('sGrade').value.trim(), classNo:el('sClass').value.trim(),
        attendance:+el('sAtt').value, grades, notes:el('sNotes').value.trim() };
      if(fromRoster){ body.guardian = el('sGuardian').value.trim(); body.guardianId = el('sGuardianId').value.trim(); }
      else if(el('sParent')) body.parent = el('sParent').value;
      if(!body.name){ toast('أدخل اسم الطالب'); return; }
      try{ await api(s?'/api/students/'+s.id:'/api/students', { method:s?'PUT':'POST', body }); closeModal(); go('students'); toast(s?'تم الحفظ ✅':'تمت الإضافة ✅'); }
      catch(e){ toast(e.message); }
    }}, { t:'إلغاء', cls:'btn ghost', fn:closeModal }]);
}

/* ============================================================
   ADMIN — files center
   ============================================================ */
async function renderAdminFiles(v){
  const { files } = await api('/api/files');
  const filt = v.dataset.filt || 'all';
  const list = files.filter(f => filt==='all' ? true : f.status===filt);
  v.innerHTML = `<div class="page-head"><h2>مركز الملفات</h2><p>راجع ملفات المعلمين — افتح، اقبل، ارفض، عدّل، احذف، أو راسل المعلم</p></div>
    <div class="flex gap wrap mb">${['all','pending','approved','rejected'].map(k=>`<button class="btn ${filt===k?'':'ghost'} sm" onclick="filterFiles('${k}')">${{all:'الكل',pending:'قيد المراجعة',approved:'مقبول',rejected:'مرفوض'}[k]}</button>`).join('')}</div>
    <div class="grid">${list.length ? list.map(fileRow).join('') : emptyBox('لا توجد ملفات في هذا التصنيف.')}</div>`;
}
function filterFiles(k){ const v = el('mainView'); v.dataset.filt = k; renderAdminFiles(v); }

/* ============================================================
   ADMIN — bot brain
   ============================================================ */
async function renderBrain(v){
  const { files } = await api('/api/brain');
  const { students } = await api('/api/students');
  v.innerHTML = `<div class="page-head flex between center wrap gap"><div><h2>عقل البوت 🧠</h2><p>الملفات التي يقرأ منها المساعد الذكي ليعرف الطلاب ودرجاتهم</p></div>
      <button class="btn gold" id="brainUp">＋ تغذية ملف</button></div>
    <div class="card card-pad mb" style="background:var(--soft);border:none"><div class="flex center gap"><div style="width:44px;height:44px;border-radius:12px;background:var(--green);color:#fff;display:grid;place-items:center">${I.bot}</div>
      <div><b>${files.length} ملف مُغذّى + ${students.length} سجل طالب</b><div class="small muted">البوت يستخدم هذه المصادر للإجابة على أولياء الأمور</div></div></div></div>
    <div class="grid">${files.length ? files.map(f=>`<div class="card card-pad flex center gap wrap"><div class="file-pill" style="flex:1;border:none;padding:0"><div class="fi" style="background:#e3f6ec">${I.bot}</div><div class="meta"><b>${esc(f.name)}</b><span>مصدر معرفة · ${esc(f.subject)}</span></div></div><button class="btn ghost sm" onclick="viewFile('${f.id}')">فتح</button></div>`).join('') : emptyBox('لا توجد ملفات مقبولة بعد. اقبل ملفات المعلمين أو أضف ملفاً.')}</div>`;
  el('brainUp').onclick = openBrainUpload;
}
function openBrainUpload(){
  modal('تغذية عقل البوت', `
    <div class="field"><label>اسم المصدر</label><input id="bName" placeholder="مثال: كشف درجات الصف الثاني"></div>
    <div class="field"><label>ارفع ملفاً (اختياري)</label><input id="bFile" type="file"></div>
    <div class="field"><label>أو المحتوى المعرفي نصياً</label><textarea id="bC" rows="6" placeholder="بيانات الطلاب / الدرجات..."></textarea></div>`,
    [{ t:'تغذية البوت', cls:'btn', fn: async () => {
      const name = el('bName').value.trim(); if(!name){ toast('أدخل الاسم'); return; }
      const fd = new FormData(); fd.append('brain','1'); fd.append('name', name);
      if(el('bFile').files[0]) fd.append('file', el('bFile').files[0]);
      if(el('bC').value.trim()) fd.append('content', el('bC').value.trim());
      try{
        const r = await api('/api/files', { method:'POST', form:fd });
        closeModal(); go('brain');
        const ai = r.file && r.file.autoIdentities;
        toast(ai ? `تمت التغذية ✅ وسُجّلت الهويات تلقائياً (${ai.total} طالب) — أولياء الأمور يقدرون يدخلون الآن`
                 : 'تمت تغذية البوت ✅');
      }catch(e){ toast(e.message); }
    }}, { t:'إلغاء', cls:'btn ghost', fn:closeModal }]);
}

/* ============================================================
   MESSAGING
   ============================================================ */
let CONTACTS = [];
async function renderMessages(v){
  const [{ contacts }, { threads }] = await Promise.all([ api('/api/contacts'), api('/api/threads') ]);
  CONTACTS = contacts;
  const sum = {}; threads.forEach(t => sum[t.peer] = t);
  contacts.forEach(c => { if(sum[c.id]) unread[c.id] = sum[c.id].unread; });
  activeThread = activeThread && contacts.some(c=>c.id===activeThread) ? activeThread : (contacts[0] && contacts[0].id);
  v.innerHTML = `<div class="page-head flex between center wrap gap"><div><h2>المراسلة 💬</h2><p>محادثات فورية بين المعلمين والإدارة</p></div>
      ${ME.role==='admin' ? `<button class="btn danger" id="clearMsgs">🗑️ مسح كل المحادثات</button>` : ''}</div>
    <div class="mgr"><div class="mgr-list" id="mgrList">${contacts.map(c=>{
      const s = sum[c.id]; const last = s && s.last; const u = unread[c.id]||0;
      return `<button class="mgr-item ${c.id===activeThread?'active':''}" data-peer="${c.id}" onclick="openThread('${c.id}')"><div class="av">${esc(c.name.replace(/^أ\.\s*/,'')[0])}</div><div class="info"><b>${esc(c.name)}</b><span>${last?esc(last.text).slice(0,30):(c.subject?'معلم '+esc(c.subject):'مدير النظام')}</span></div>${u?`<span class="badge red">${u}</span>`:''}</button>`;
    }).join('') || emptyBox('لا جهات اتصال')}</div><div class="mgr-chat" id="mgrChat"></div></div>`;
  if(activeThread) openThread(activeThread); else el('mgrChat').innerHTML = `<div class="empty-state">${I.msg}<p>اختر محادثة للبدء</p></div>`;
  const cb = el('clearMsgs');
  if(cb) cb.onclick = async () => {
    if(!confirm('مسح كل المحادثات والإشعارات نهائياً؟ لا يمكن التراجع.')) return;
    try{ const r = await api('/api/messages/clear', { method:'POST' }); unread = {}; activeThread = null; refreshMsgBadgeLocal(); go('messages'); toast('تم مسح '+ (r.cleared||0) +' محادثة'); }
    catch(e){ toast(e.message); }
  };
}
async function openThread(cid){
  activeThread = cid;
  const c = CONTACTS.find(u=>u.id===cid) || { name:'مستخدم', subject:'' };
  const { messages } = await api('/api/thread/'+cid);
  unread[cid] = 0; refreshMsgBadgeLocal();
  document.querySelectorAll('.mgr-item').forEach(b => b.classList.toggle('active', b.dataset.peer===cid));
  const chat = el('mgrChat'); if(!chat) return;
  chat.innerHTML = `<div class="mgr-chat-head"><div class="av" style="width:38px;height:38px;border-radius:11px;background:var(--green);color:#fff;display:grid;place-items:center;font-weight:800">${esc(c.name.replace(/^أ\.\s*/,'')[0])}</div>
      <div><b>${esc(c.name)}</b><div class="small muted">${c.subject?'معلم '+esc(c.subject):'مدير النظام'}</div></div></div>
    <div class="mgr-stream" id="mgrStream">${messages.map(mLine).join('') || '<div class="empty-state small">ابدأ المحادثة 👋</div>'}</div>
    <div class="mgr-composer"><input id="mgrIn" placeholder="اكتب رسالة..." autocomplete="off"><button class="send-btn" style="width:44px;height:44px" onclick="sendMsg('${cid}')">${I.send}</button></div>`;
  const inp = el('mgrIn'); inp.focus(); inp.addEventListener('keydown', e => { if(e.key==='Enter') sendMsg(cid); });
  const st = el('mgrStream'); st.scrollTop = st.scrollHeight;
}
function mLine(m){ const mine = m.from===ME.id; return `<div class="m-line ${mine?'mine':''}">${esc(m.text)}<span class="t">${new Date(m.ts).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})}</span></div>`; }
function appendMgrLine(m){ const st = el('mgrStream'); if(!st) return; st.insertAdjacentHTML('beforeend', mLine(m)); st.scrollTop = st.scrollHeight; }
function sendMsg(cid){
  const inp = el('mgrIn'); const t = inp.value.trim(); if(!t) return;
  socket.emit('chat:message', { to:cid, text:t });
  appendMgrLine({ from:ME.id, text:t, ts:Date.now() });
  inp.value = '';
}
function markThreadRead(cid){ api('/api/thread/'+cid).catch(()=>{}); }

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
async function refreshNotifBadge(){
  const { notifs } = await api('/api/notifs');
  const n = notifs.filter(x=>!x.read).length;
  const b = el('notifBadge'); b.textContent = n; b.classList.toggle('hidden', n===0);
}
function bumpNotifBadge(){ const b = el('notifBadge'); const n = (+b.textContent||0)+1; b.textContent = n; b.classList.remove('hidden'); }
async function refreshMsgBadge(){ const { threads } = await api('/api/threads'); threads.forEach(t => unread[t.peer]=t.unread); refreshMsgBadgeLocal(); }
function refreshMsgBadgeLocal(){ const n = Object.values(unread).reduce((a,b)=>a+b,0); const b = el('msgNavBadge'); if(b){ b.textContent = n; b.classList.toggle('hidden', n===0); } }
async function toggleNotif(){
  const p = el('notifPanel');
  if(p.querySelector('.notif-panel')){ p.innerHTML = ''; return; }
  const { notifs } = await api('/api/notifs');
  p.innerHTML = `<div class="notif-panel"><div class="nh">الإشعارات <button class="btn ghost sm" id="clrNotif">تعليم كمقروء</button></div>
    ${notifs.length ? notifs.slice(0,12).map(x=>`<div class="notif-item">${x.read?'':'<div class="nd"></div>'}<div><b>${esc(x.text)}</b><small>${esc(x.sub||'')} · ${timeAgo(x.ts)}</small></div></div>`).join('') : '<div class="notif-empty">لا إشعارات</div>'}</div>`;
  el('clrNotif').onclick = async () => { await api('/api/notifs/read', { method:'POST' }); p.innerHTML=''; refreshNotifBadge(); };
  await api('/api/notifs/read', { method:'POST' }); refreshNotifBadge();
}
document.addEventListener('click', e => {
  const p = el('notifPanel');
  if(p && p.innerHTML && !e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) p.innerHTML = '';
});

/* ============================================================
   MODAL + helpers
   ============================================================ */
function modal(title, body, btns){
  const root = el('modalRoot');
  root.innerHTML = `<div class="overlay" id="overlay"><div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="x-btn" onclick="closeModal()">✕</button></div><div class="modal-body">${body}</div><div class="modal-foot" id="mFoot"></div></div></div>`;
  el('overlay').addEventListener('click', e => { if(e.target.id==='overlay') closeModal(); });
  const foot = el('mFoot');
  (btns||[]).forEach(b => { const x = document.createElement('button'); x.className = b.cls; x.textContent = b.t; x.onclick = b.fn; foot.appendChild(x); });
}
function closeModal(){ el('modalRoot').innerHTML = ''; }
function refreshView(){ go(CUR); }
function toast(t){ const w = el('toasts'); const x = document.createElement('div'); x.className='toast'; x.innerHTML = `<div class="dot"></div>${esc(t)}`; w.appendChild(x); setTimeout(()=>{ x.style.opacity='0'; x.style.transition='.3s'; setTimeout(()=>x.remove(),300); }, 3000); }
function emptyBox(t){ return `<div class="card card-pad empty-state" style="min-height:160px">${I.files}<p>${esc(t)}</p></div>`; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* ماركداون مبسّط: عناوين + قوائم + تغميق */
function inlineMd(s){ return s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`([^`]+)`/g,'<code>$1</code>'); }
function fmt(t){
  const lines = esc(String(t||'')).split('\n');
  let html = '', ul = false, ol = false;
  const close = () => { if(ul){ html += '</ul>'; ul = false; } if(ol){ html += '</ol>'; ol = false; } };
  for(const raw of lines){
    const line = raw.trim();
    if(!line){ close(); continue; }
    let m;
    if((m = line.match(/^#{1,6}\s+(.*)$/))){ close(); html += `<h4>${inlineMd(m[1])}</h4>`; continue; }
    if((m = line.match(/^[-*•]\s+(.*)$/))){ if(ol){ html += '</ol>'; ol = false; } if(!ul){ html += '<ul>'; ul = true; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    if((m = line.match(/^(\d+)[.)]\s+(.*)$/))){ if(ul){ html += '</ul>'; ul = false; } if(!ol){ html += '<ol>'; ol = true; } html += `<li>${inlineMd(m[2])}</li>`; continue; }
    close(); html += `<p>${inlineMd(line)}</p>`;
  }
  close();
  return html;
}
function timeAgo(ts){ const d=(Date.now()-ts)/1000; if(d<60)return'الآن'; if(d<3600)return Math.floor(d/60)+' د'; if(d<86400)return Math.floor(d/3600)+' س'; return Math.floor(d/86400)+' يوم'; }

/* expose for inline onclick */
function setChild(id){ activeChild = id; go('chat'); }
Object.assign(window, { go, viewFile, filterFiles, openTeacher, delTeacher, openStudent, delStudent, studGo,
  delFile, clearRoster, openThread, sendMsg, closeModal, setChild, rosterGo, openConvo, delConvo });

/* ============================================================
   مؤشّر مخصّص — نقطة دقيقة + حلقة تتبع بتأخير، تكبر على العناصر
   ============================================================ */
(function customCursor(){
  if(!window.matchMedia('(pointer:fine)').matches) return;
  const dot = document.createElement('div'); dot.className = 'cursor-dot';
  const ring = document.createElement('div'); ring.className = 'cursor-ring';
  document.body.append(dot, ring);
  document.documentElement.classList.add('customcur');
  let mx = innerWidth/2, my = innerHeight/2, rx = mx, ry = my;
  addEventListener('pointermove', e => {
    if(e.pointerType === 'touch') return;
    mx = e.clientX; my = e.clientY;
    dot.style.transform = 'translate('+mx+'px,'+my+'px) translate(-50%,-50%)';
    document.body.classList.remove('cursor-hidden');
  }, { passive:true });
  addEventListener('pointerdown', () => { ring.classList.add('down'); dot.classList.add('down'); });
  addEventListener('pointerup',   () => { ring.classList.remove('down'); dot.classList.remove('down'); });
  document.addEventListener('mouseleave', () => document.body.classList.add('cursor-hidden'));
  const HOVER = 'a,button,.btn,.nav-item,.role-tab,.mgr-item,.suggest button,[onclick],.file-pill,.x-btn,.icon-btn,.send-btn,select,label';
  addEventListener('pointerover', e => {
    if(e.target.closest && e.target.closest(HOVER)){ ring.classList.add('hover'); dot.classList.add('hover'); }
  });
  addEventListener('pointerout', e => {
    const from = e.target.closest && e.target.closest(HOVER);
    const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(HOVER);
    if(from && from !== to){ ring.classList.remove('hover'); dot.classList.remove('hover'); }
  });
  (function loop(){ rx += (mx-rx)*0.2; ry += (my-ry)*0.2;
    ring.style.transform = 'translate('+rx+'px,'+ry+'px) translate(-50%,-50%)';
    requestAnimationFrame(loop); })();
})();

/* ============================================================
   ظهور البيانات بالتتابع من الأعلى للأسفل عند كل تنقّل
   ============================================================ */
(function initReveal(){
  const mv = el('mainView'); if(!mv || !window.MutationObserver) return;
  function applyReveal(n, i){
    if(n.nodeType !== 1) return;
    n.style.animation = 'none'; void n.offsetWidth;
    n.style.animation = 'cardIn .5s cubic-bezier(.22,.9,.3,1) both';
    n.style.animationDelay = Math.min(i*0.06, 0.7) + 's';
  }
  const DIG = ['grid','chat-wrap','mgr'];   // حاويات نفصّل داخلها بدل ظهورها ككتلة واحدة
  let raf;
  function stagger(){
    let i = 0;
    for(const n of mv.children){
      const rows = n.querySelector && n.querySelector('tbody') ? n.querySelectorAll('tbody tr') : null;
      if(rows && rows.length){ applyReveal(n, i++); for(const r of rows) applyReveal(r, i++); continue; }
      const dig = n.classList && DIG.some(c => n.classList.contains(c));
      if(dig){ for(const ch of n.children) applyReveal(ch, i++); }
      else applyReveal(n, i++);
    }
  }
  new MutationObserver(() => { clearTimeout(raf); raf = setTimeout(stagger, 0); })
    .observe(mv, { childList:true });
})();

/* ============================================================
   auto-resume session
   ============================================================ */
(async function init(){
  if(TOKEN){
    try{ const { me } = await api('/api/me'); ME = me; enterApp(); }
    catch(e){ localStorage.removeItem('andlus_token'); TOKEN = null; }
  }
})();
