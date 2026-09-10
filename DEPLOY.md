# نشر «ذكاء الأندلس» على الإنترنت

## لماذا ليس Vercel؟
هذا الموقع سيرفر Node دائم (Express + Socket.IO) يحفظ بيانات في ملفات.
Vercel «serverless»: لا يدعم WebSocket، ونظام ملفاته للقراءة فقط، والذاكرة تُمسح كل طلب.
لذلك المراسلة، حفظ الحسابات، والسجل المفهرس **لن تعمل** عليه. استخدم مضيفاً يشغّل سيرفر Node عادياً.

## الأفضل: Render.com (مجاني، يعمل كما هو)

### 1. ارفع الكود على GitHub
```bash
git init
git add .
git commit -m "Smart Andlus"
git branch -M main
git remote add origin https://github.com/<حسابك>/smart-andlus.git
git push -u origin main
```
> ملاحظة أمنية: `.env` **مُستبعد** بـ `.gitignore` ولا يُرفع — المفتاح يبقى سرّياً. لا تُلغِ هذا الاستبعاد.

### 2. أنشئ خدمة على Render
1. سجّل الدخول إلى https://render.com عبر GitHub.
2. New → Web Service → اختر مستودع `smart-andlus`.
3. الإعدادات (يقرؤها Render تلقائياً من `render.yaml`):
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Environment → أضف المتغيرات السرّية:
   - `FIREWORKS_API_KEY` = مفتاحك من Fireworks
   - `FIREWORKS_MODEL` = `accounts/fireworks/models/glm-5p3-flash`
5. Create Web Service → انتظر البناء → يعطيك رابطاً مثل `https://smart-andlus.onrender.com`.

### 3. بعد النشر
- افتح الرابط، ادخل كمدير، ثم **سجل الطلاب** واستورد `data/سجل-الطلاب-300.xlsx`.
- الخطة المجانية «تنام» بعد خمول؛ أول فتحة بعد النوم تأخذ ~30 ثانية.

## قبل النشر للعامة — أمان
1. **غيّر كلمات المرور الافتراضية** في `server/db.js` (دالة `seed`) قبل الرفع؛ `1234` معروفة.
2. تلميحات كلمات المرور على صفحة الدخول **مخفية** (`SHOW_DEMO_HINTS=false` في `public/js/app.js`). أبقِها مخفية على النسخة العامة.
3. لا تنشر مفتاح Fireworks في أي ملف يُرفع. لو انكشف: ألغِه من لوحة Fireworks وأنشئ غيره.
4. أي شخص لديه حساب يستطيع الكتابة في الشات الداخلي — لا تشارك الرابط على نطاق واسع، واستخدم زر «مسح كل المحادثات» في لوحة المدير للتنظيف.

## بدائل تعمل أيضاً
- **Railway.app** — مشابه لـ Render.
- **Fly.io** — يدعم أقراصاً دائمة (تبقى البيانات بعد إعادة التشغيل).
