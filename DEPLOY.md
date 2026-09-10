# نشر «ذكاء الأندلس» — تخزين دائم مجاني

الموقع سيرفر Node دائم (Express + Socket.IO). لا يعمل على Vercel (بلا WebSocket/تخزين).
نستخدم **Render** (تشغيل مجاني) + **MongoDB Atlas** (تخزين دائم مجاني).

> النشر يحتاج تسجيل دخولك لحساباتك الخاصة — نفّذ الخطوات بنفسك، الكود جاهز بالكامل.

---

## الخطوة 1 — قاعدة بيانات دائمة (MongoDB Atlas مجاني)
1. سجّل في https://www.mongodb.com/cloud/atlas/register
2. Create → **M0 Free** (اختر أقرب منطقة) → Create Deployment.
3. **Database Access**: أنشئ مستخدماً (username + password) — احفظهما.
4. **Network Access**: Add IP Address → **Allow Access from Anywhere** (`0.0.0.0/0`).
5. **Connect** → Drivers → انسخ رابط الاتصال، شكله:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   بدّل `USER` و`PASSWORD` بالقيم من الخطوة 3. هذا هو `MONGODB_URI`.

## الخطوة 2 — ارفع الكود على GitHub
```bash
git add -A
git commit -m "deploy: تخزين دائم + إزالة المكالمات"
git branch -M main
git remote add origin https://github.com/<حسابك>/smart-andlus.git
git push -u origin main
```
> `.env` **لا يُرفع** (محمي بـ `.gitignore`) — المفاتيح تبقى سرّية.

## الخطوة 3 — انشر على Render
1. سجّل في https://render.com بحساب GitHub.
2. **New → Web Service** → اختر مستودع `smart-andlus` (يقرأ `render.yaml` تلقائياً).
3. **Environment** → أضف السرّيات:
   - `FIREWORKS_API_KEY` = مفتاح Fireworks
   - `MONGODB_URI` = الرابط من الخطوة 1
4. **Create Web Service** → انتظر البناء → يعطيك رابطاً مثل:
   `https://smart-andlus.onrender.com`

بعد الفتح: ادخل مديراً (`admin` / `1234`) → **سجل الطلاب** → استورد إكسل، وأضف معلمين وطلاب. **كل شيء يُحفظ دائماً في Atlas** ولا يُمسح عند إعادة التشغيل.

---

## ملاحظات
- الخطة المجانية في Render «تنام» بعد ~15 دقيقة خمول؛ أول فتحة بعد النوم ~30–50 ثانية. البيانات تبقى (في Atlas).
- محلياً بدون `MONGODB_URI` يستخدم `server/data.json` تلقائياً.
- **غيّر كلمات المرور** الافتراضية في `server/db.js` (دالة `seed`) قبل النشر العام.
- تلميحات الدخول مخفية على النسخة العامة (`SHOW_DEMO_HINTS=false`).
- لو انكشف أي مفتاح: ألغِه وأنشئ غيره وحدّث متغيرات Render.
