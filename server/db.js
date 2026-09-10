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
      { id:'admin1', role:'admin', user:'admin', pass:hashPw('1234'), name:'أ. خالد المدير', perms:Object.keys(PERMS) },
      { id:'t1', role:'teacher', user:'sara',  pass:hashPw('1234'), name:'أ. سارة الغامدي',   subject:'الرياضيات', nid:'1088776655', perms:['files','messages'] },
      { id:'t2', role:'teacher', user:'noura', pass:hashPw('1234'), name:'أ. نورة القحطاني', subject:'العلوم',     nid:'1099887766', perms:['files','messages'] },
      { id:'p1', role:'parent',  user:'parent', pass:hashPw('1234'), name:'ولي أمر — فهد', children:['s1','s2'] },
    ],
    students: [
      { id:'s1', name:'عبدالله فهد', grade:'الثاني متوسط', classNo:'2/أ', parent:'p1', attendance:96,
        grades:{ 'الرياضيات':92,'العلوم':88,'اللغة العربية':95,'اللغة الإنجليزية':78,'الدراسات الإسلامية':97,'الاجتماعيات':85 },
        notes:'طالب مجتهد، متميز في الرياضيات. يحتاج متابعة في الإنجليزي.' },
      { id:'s2', name:'سارة فهد', grade:'الرابع ابتدائي', classNo:'4/ب', parent:'p1', attendance:99,
        grades:{ 'الرياضيات':99,'العلوم':94,'اللغة العربية':90,'اللغة الإنجليزية':92,'الدراسات الإسلامية':100,'الاجتماعيات':96 },
        notes:'طالبة متفوقة على مستوى الصف. سلوك ممتاز.' },
    ],
    files: [
      { id:'f1', owner:'t1', ownerName:'أ. سارة الغامدي', subject:'الرياضيات', name:'درجات اختبار الفصل الأول.txt',
        status:'approved', mime:'text/plain', path:null,
        content:'كشف درجات — مادة الرياضيات\nالصف الثاني متوسط 2/أ\n\nعبدالله فهد: 92\nنواف سعد: 84\nعمر ماجد: 77\nيزيد خالد: 90\n\nملاحظة: مستوى عام جيد جداً.', ts:Date.now()-864e5*2 },
      { id:'f2', owner:'t2', ownerName:'أ. نورة القحطاني', subject:'العلوم', name:'خطة الوحدة الثالثة.txt',
        status:'pending', mime:'text/plain', path:null,
        content:'خطة درس — مادة العلوم\nالوحدة الثالثة: الطاقة\n\nالأهداف:\n1. أن يعرّف الطالب الطاقة الحركية.\n2. أن يميز بين أنواع الطاقة.\n\nالأنشطة: تجربة عملية + عرض مرئي.', ts:Date.now()-864e5 },
    ],
    threads: {},   // "idA|idB" (مرتّبة) -> [{ from, text, ts }]
    notifs: {},    // userId -> [{ id, text, sub, ts, read }]
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
