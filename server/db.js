/* ============================================================
   db.js — مخزن JSON بسيط + بذور بيانات + تشفير كلمات المرور
   لا يحتاج قاعدة بيانات خارجية. الملف: server/data.json
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');

const SUBJECTS = ['الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية','الدراسات الإسلامية','الاجتماعيات'];
const PERMS = { files:'رفع الملفات', students:'إدارة الطلاب', teachers:'إدارة المعلمين', grades:'تعديل الدرجات', messages:'المراسلة' };

/* ---------- تشفير كلمات المرور (scrypt) ---------- */
function hashPw(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPw(pw, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  // مقارنة زمن-ثابت
  const a = Buffer.from(test), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- البذور ---------- */
function seed(){
  return {
    users: [
      { id:'admin1', role:'admin', user:'naif', pass:hashPw('43321'), name:'أ. نايف المدير', perms:Object.keys(PERMS) },
      { id:'t1', role:'teacher', user:'ali', pass:hashPw('4321'), name:'أ. علي', subject:'الرياضيات', nid:'', perms:['files','messages'] },
    ],
    students: [],
    files: [],
    threads: {},   // "idA|idB" (مرتّبة) -> [{ from, text, ts }]
    notifs: {},    // userId -> [{ id, text, sub, ts, read }]
    convos: {},    // userId -> [{ id, sid, title, msgs:[...], upd }]  (محادثات AI محفوظة)
    tokens: {},    // token -> userId
    tokenTs: {},   // token -> وقت الإصدار (انتهاء الجلسة بعد 30 يوماً)
  };
}

/* ---------- تحميل / حفظ ---------- */
let DB;
/* ---------- التخزين: MongoDB (دائم) إن وُجد MONGODB_URI، وإلا ملف محلي ---------- */
const URI = process.env.MONGODB_URI || '';
let coll = null;   // مجموعة Mongo عند التفعيل
let blobs = null;  // محتوى الملفات الأصلية (منفصل: وثيقة الحالة سقفها 16MB)

/* ---------- الملفات الأصلية ----------
   قرص الاستضافة المجانية يُمسح عند كل تحديث أو خمول، فالملف يُحفظ في Mongo.
   محلياً يُحفظ في server/blobs — خارج public فلا يُنزَّل بلا تسجيل دخول. */
const BLOB_DIR = path.join(__dirname, 'blobs');
const blobKey = id => String(id).replace(/[^A-Za-z0-9_-]/g, '');
async function putBlob(id, buffer, mime){
  if(blobs){ await blobs.replaceOne({ _id:blobKey(id) }, { _id:blobKey(id), mime, size:buffer.length, data:buffer }, { upsert:true }); return; }
  fs.mkdirSync(BLOB_DIR, { recursive:true });
  fs.writeFileSync(path.join(BLOB_DIR, blobKey(id)), buffer);
}
async function getBlob(id){
  if(blobs){
    const d = await blobs.findOne({ _id:blobKey(id) });
    if(!d || !d.data) return null;
    return { data: Buffer.from(d.data.buffer || d.data), mime:d.mime };
  }
  const p = path.join(BLOB_DIR, blobKey(id));
  return fs.existsSync(p) ? { data: fs.readFileSync(p), mime:null } : null;
}
async function delBlob(id){
  try{
    if(blobs) await blobs.deleteOne({ _id:blobKey(id) });
    else fs.unlinkSync(path.join(BLOB_DIR, blobKey(id)));
  }catch(_){}
}

function loadFile(){
  try {
    if(fs.existsSync(DATA_FILE)){ DB = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
    else { DB = seed(); fs.writeFileSync(DATA_FILE, JSON.stringify(DB,null,2)); }
  } catch(e){ console.error('data.json تالف — إعادة البذر', e.message); DB = seed(); }
  return DB;
}

/* يُستدعى مرة واحدة عند الإقلاع قبل بدء الخادم */
async function init(){
  if(URI){
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const mdb = client.db(process.env.MONGODB_DB || 'smart_andlus');
    coll = mdb.collection('state');
    blobs = mdb.collection('blobs');
    const doc = await coll.findOne({ _id: 'db' });
    if(doc && doc.data){ DB = doc.data; }
    else { DB = seed(); await coll.replaceOne({ _id:'db' }, { _id:'db', data:DB }, { upsert:true }); }
    console.log('التخزين: MongoDB (دائم) ✓');
  } else {
    loadFile();
    console.log('التخزين: ملف محلي data.json (غير دائم على الاستضافة)');
  }
  ensureShape();   // ترقية أي بيانات قديمة تنقصها حقول جديدة
  return DB;
}

/* يضمن وجود كل الحقول العليا (لبيانات أُنشئت قبل إضافة حقول جديدة) */
function ensureShape(){
  if(!DB || typeof DB !== 'object') DB = seed();
  DB.users   = DB.users   || [];
  DB.students= DB.students|| [];
  DB.files   = DB.files   || [];
  DB.threads = DB.threads || {};
  DB.notifs  = DB.notifs  || {};
  DB.convos  = DB.convos  || {};
  DB.tokens  = DB.tokens  || {};
  DB.tokenTs = DB.tokenTs || {};
  // جلسات قديمة بلا وقت إصدار: تُحتسب من الآن (لا نُخرج أحداً فجأة)
  Object.keys(DB.tokens).forEach(t => { if(!DB.tokenTs[t]) DB.tokenTs[t] = Date.now(); });
}

/* الحفظ: كتابة واحدة في كل لحظة، وما يُطلب أثناءها يُدمج في كتابة تالية واحدة.
   كانت كل عملية (مثل كل تسجيل دخول) تكتب القاعدة كاملة فوراً وبالتوازي:
   بطء تحت الضغط، وفي Mongo قد تصل كتابة أقدم بعد أحدث فتمحوها (جلسة تضيع). */
let writing = false, dirty = false;
async function persist(){
  if(writing){ dirty = true; return; }
  writing = true;
  try{
    do{
      dirty = false;
      if(coll){
        await coll.replaceOne({ _id:'db' }, { _id:'db', data:DB }, { upsert:true });
      } else {
        // كتابة ذرّية: ملف مؤقت ثم إعادة تسمية — انقطاع أثناء الكتابة لا يُتلف البيانات
        const tmp = DATA_FILE + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(DB));
        await fs.promises.rename(tmp, DATA_FILE);
      }
    } while(dirty);
  }catch(e){
    console.error('فشل الحفظ:', e.message);
    dirty = false;
  }finally{ writing = false; }
}
let saveTimer = null;
function saveDB(){ clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150); }   // كتابة مؤجّلة
function saveNow(){ clearTimeout(saveTimer); return persist(); }
function resetDB(){ DB = seed(); ensureShape(); saveNow(); return DB; }   // ensureShape: لا حقل ناقص بعد إعادة التعيين

module.exports = { get DB(){ return DB; }, init, saveDB, saveNow, resetDB, hashPw, verifyPw, SUBJECTS, PERMS,
  putBlob, getBlob, delBlob };
