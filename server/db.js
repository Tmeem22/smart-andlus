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
  };
}

/* ---------- تحميل / حفظ ---------- */
let DB;
/* ---------- التخزين: MongoDB (دائم) إن وُجد MONGODB_URI، وإلا ملف محلي ---------- */
const URI = process.env.MONGODB_URI || '';
let coll = null;   // مجموعة Mongo عند التفعيل

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
    coll = client.db(process.env.MONGODB_DB || 'smart_andlus').collection('state');
    const doc = await coll.findOne({ _id: 'db' });
    if(doc && doc.data){ DB = doc.data; }
    else { DB = seed(); await coll.replaceOne({ _id:'db' }, { _id:'db', data:DB }, { upsert:true }); }
    console.log('التخزين: MongoDB (دائم) ✓');
  } else {
    loadFile();
    console.log('التخزين: ملف محلي data.json (غير دائم على الاستضافة)');
  }
  return DB;
}

function persist(){
  if(coll){ coll.replaceOne({ _id:'db' }, { _id:'db', data:DB }, { upsert:true }).catch(e=>console.error('فشل حفظ Mongo', e.message)); }
  else { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB,null,2)); } catch(e){ console.error('فشل الحفظ', e.message); } }
}
let saveTimer = null;
function saveDB(){ clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150); }   // كتابة مؤجّلة
function saveNow(){ persist(); }
function resetDB(){ DB = seed(); saveNow(); return DB; }

module.exports = { get DB(){ return DB; }, init, saveDB, saveNow, resetDB, hashPw, verifyPw, SUBJECTS, PERMS };
