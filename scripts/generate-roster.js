/* ============================================================
   generate-roster.js — يولّد ملف إكسل بـ 300 طالب (بيانات تجريبية)
   التشغيل:  node scripts/generate-roster.js
   المخرج :  data/سجل-الطلاب-300.xlsx
   ============================================================ */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const FIRST = ['عبدالله','محمد','خالد','سعود','فهد','نواف','عمر','يزيد','تركي','بندر','ماجد','سلطان','ريان','فيصل','عبدالعزيز','راكان','مشعل','ناصر','سالم','بدر','زياد','أنس','هيثم','وليد','طلال','عادل','مازن','رائد','سامي','حسام',
  'سارة','نورة','ريم','لمى','دانة','جواهر','هيا','شهد','رغد','منال','أمل','لطيفة','مها','عبير','رنا','بشاير','وجدان','أروى','غادة','هند','نجود','ملاك','يارا','جنى','ديمة','رهف','أسماء','فاطمة','عائشة','مريم'];
const FATHER = ['فهد','عبدالله','سعد','محمد','ناصر','سليمان','إبراهيم','عبدالرحمن','مساعد','حمد','صالح','علي','يوسف','خالد','متعب','فيصل','عايض','مبارك','راشد','طارق'];
const FAMILY = ['الغامدي','القحطاني','العتيبي','الشهري','الحربي','الدوسري','الزهراني','المطيري','السبيعي','العنزي','الشمري','البقمي','الرشيدي','الخالدي','العمري','الجهني','الأنصاري','الحازمي','السهلي','المالكي','الثبيتي','الصاعدي','البلوي','النفيعي'];
const SUBJECTS = ['الرياضيات','العلوم','اللغة العربية','اللغة الإنجليزية','الدراسات الإسلامية','الاجتماعيات'];
const LEVELS = ['الأول متوسط','الثاني متوسط','الثالث متوسط'];
const SECTIONS = ['أ','ب','ج'];
const NOTES = [
  'طالب مجتهد ومستواه العام جيد.','متميز في المواد العلمية.','يحتاج متابعة في اللغة الإنجليزية.',
  'سلوك ممتاز ومشاركة فعّالة.','مستواه متذبذب ويحتاج تحفيزاً.','متفوق على مستوى الصف.',
  'يحتاج إلى تحسين الانضباط في الحضور.','مهاراته في الحفظ ممتازة.','يشارك في الأنشطة اللاصفية.','بحاجة إلى دعم في الرياضيات.',
];

/* مولّد عشوائي ثابت البذرة — نفس الملف في كل مرة */
let seed = 20260905;
function rnd(){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a,b) => Math.floor(rnd() * (b - a + 1)) + a;

function makeStudents(n){
  const out = [], used = new Set();
  for(let i = 0; i < n; i++){
    let name;
    do { name = `${pick(FIRST)} ${pick(FATHER)} ${pick(FAMILY)}`; } while(used.has(name));
    used.add(name);
    const levelIdx = Math.floor(i / (n / 3));                 // توزيع متساوٍ على 3 صفوف
    const level = LEVELS[Math.min(levelIdx, 2)];
    const section = SECTIONS[i % 3];
    // مستوى الطالب العام (يجعل الدرجات مترابطة بدل عشوائية بحتة)
    const base = between(62, 97);
    const grades = {};
    SUBJECTS.forEach(s => {
      grades[s] = Math.max(45, Math.min(100, base + between(-8, 8)));
    });
    out.push({
      id: 'ST' + String(1001 + i),
      name,
      level, section: `${level.startsWith('الأول')?1:level.startsWith('الثاني')?2:3}/${section}`,
      guardian: `${pick(FATHER)} ${name.split(' ')[2]}`,
      guardianId: '10' + between(10000000, 99999999),
      attendance: between(78, 100),
      grades,
      notes: pick(NOTES),
    });
  }
  return out;
}

async function main(){
  const students = makeStudents(300);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ذكاء الأندلس — Smart Andlus';
  wb.created = new Date();
  const ws = wb.addWorksheet('سجل الطلاب', { views:[{ rightToLeft:true, state:'frozen', ySplit:1 }] });

  ws.columns = [
    { header:'رقم الطالب', key:'id', width:12 },
    { header:'اسم الطالب', key:'name', width:28 },
    { header:'الصف', key:'level', width:14 },
    { header:'الفصل', key:'section', width:9 },
    { header:'ولي الأمر', key:'guardian', width:22 },
    { header:'هوية ولي الأمر', key:'guardianId', width:15 },
    { header:'نسبة الحضور', key:'attendance', width:12 },
    ...SUBJECTS.map(s => ({ header:s, key:s, width:15 })),
    { header:'المعدل', key:'avg', width:9 },
    { header:'ملاحظات المعلم', key:'notes', width:36 },
  ];

  students.forEach(s => {
    const avg = Math.round(SUBJECTS.reduce((a,k)=> a + s.grades[k], 0) / SUBJECTS.length);
    const row = { id:s.id, name:s.name, level:s.level, section:s.section, guardian:s.guardian,
      guardianId:s.guardianId, attendance:s.attendance, avg, notes:s.notes };
    SUBJECTS.forEach(k => row[k] = s.grades[k]);
    ws.addRow(row);
  });

  /* تنسيق الترويسة */
  const head = ws.getRow(1);
  head.height = 26;
  head.eachCell(c => {
    c.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:12 };
    c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0D5C46' } };
    c.alignment = { vertical:'middle', horizontal:'center' };
    c.border = { bottom:{ style:'thin', color:{ argb:'FF0A4636' } } };
  });

  /* تلوين الدرجات + محاذاة */
  const gradeCols = SUBJECTS.map(s => ws.getColumn(s).number).concat([ws.getColumn('avg').number, ws.getColumn('attendance').number]);
  ws.eachRow((row, i) => {
    if(i === 1) return;
    row.alignment = { vertical:'middle' };
    gradeCols.forEach(cn => {
      const c = row.getCell(cn);
      c.alignment = { horizontal:'center' };
      const v = Number(c.value);
      if(!isNaN(v)){
        const argb = v >= 90 ? 'FFE3F6EC' : v >= 80 ? 'FFEEF3F0' : v >= 70 ? 'FFFFF5E0' : 'FFFDECEA';
        c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb } };
      }
    });
    if(i % 2 === 0) row.getCell(2).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF7F9F8' } };
  });
  ws.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:ws.columnCount } };

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive:true });
  const outFile = path.join(outDir, 'سجل-الطلاب-300.xlsx');
  await wb.xlsx.writeFile(outFile);
  console.log('تم إنشاء الملف:', outFile);
  console.log('عدد الطلاب:', students.length, '| الأعمدة:', ws.columnCount);
}
main().catch(e => { console.error(e); process.exit(1); });
