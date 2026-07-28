// server.js — سيرفر محلي بالكامل (Node.js فقط، بدون أي حزم خارجية) — منصة "رشد"
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  db,
  hashPassword,
  verifyPassword,
  genCode,
  genToken,
  findOrCreateSection,
  cleanupTypingIndicators,
} = require('./db.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------- أدوات مساعدة ----------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { // حد أقصى 25MB
        reject(new Error('البيانات كبيرة جداً'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id);
}

function auth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return getUserFromToken(token);
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return rest;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('غير موجود');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// يتحقق إن كان المعلم يدرّس الشعبة المحددة
function teacherOwnsSection(teacherId, sectionId) {
  return !!db.prepare(`SELECT 1 FROM teacher_sections WHERE teacher_id = ? AND section_id = ?`).get(teacherId, sectionId);
}

function getDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fp = path.join(dir, item);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) total += getDirSize(fp);
    else total += stat.size;
  }
  return total;
}

// ---------------- السيرفر ----------------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const p = parsed.pathname;
  const q = parsed.searchParams;

  try {
    if (!p.startsWith('/api/')) {
      return serveStatic(req, res, p);
    }

    // ============= المدارس =============
    if (p === '/api/schools' && req.method === 'GET') {
      const rows = db.prepare(`SELECT id, name FROM schools ORDER BY name`).all();
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/schools' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const body = await readBody(req);
      if (!body.name) return sendJSON(res, 400, { error: 'اسم المدرسة مطلوب' });
      const admin_code = genCode('ADMIN');
      const teacher_code = genCode('TCHR');
      const info = db.prepare(
        `INSERT INTO schools (name, admin_code, teacher_code) VALUES (?, ?, ?)`
      ).run(body.name, admin_code, teacher_code);
      const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(info.lastInsertRowid);
      return sendJSON(res, 201, school);
    }

    if (p === '/api/schools/mine' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      if (user.role === 'developer') {
        const rows = db.prepare(`SELECT * FROM schools ORDER BY id DESC`).all();
        return sendJSON(res, 200, rows);
      }
      if (!user.school_id) return sendJSON(res, 200, []);
      const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(user.school_id);
      return sendJSON(res, 200, school ? [school] : []);
    }

    // تعديل اسم مدرسة — المدير لمدرسته، أو المطوّر لأي مدرسة
    if (p.startsWith('/api/schools/') && p.endsWith('/rename') && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      if (user.role === 'admin' && user.school_id !== id) return sendJSON(res, 403, { error: 'لا تملك صلاحية على هذه المدرسة' });
      if (!['admin', 'developer'].includes(user.role)) return sendJSON(res, 403, { error: 'صلاحية المدير أو المطور فقط' });
      const body = await readBody(req);
      if (!body.name || !body.name.trim()) return sendJSON(res, 400, { error: 'الاسم مطلوب' });
      db.prepare(`UPDATE schools SET name = ? WHERE id = ?`).run(body.name.trim(), id);
      const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(id);
      return sendJSON(res, 200, school);
    }

    // حذف مدرسة بالكامل — المطور فقط
    if (p.startsWith('/api/schools/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const id = Number(p.split('/')[3]);
      const sectionIds = db.prepare(`SELECT id FROM sections WHERE school_id = ?`).all(id).map(s => s.id);
      for (const sid of sectionIds) {
        db.prepare(`DELETE FROM timetable WHERE section_id = ?`).run(sid);
      }
      db.prepare(`DELETE FROM teacher_sections WHERE section_id IN (SELECT id FROM sections WHERE school_id = ?)`).run(id);
      db.prepare(`DELETE FROM messages WHERE school_id = ?`).run(id);
      db.prepare(`DELETE FROM files WHERE school_id = ?`).run(id);
      db.prepare(`DELETE FROM warnings WHERE school_id = ?`).run(id);
      db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE school_id = ?)`).run(id);
      db.prepare(`DELETE FROM users WHERE school_id = ?`).run(id);
      db.prepare(`DELETE FROM sections WHERE school_id = ?`).run(id);
      db.prepare(`DELETE FROM schools WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= التسجيل =============
    if (p === '/api/register/student' && req.method === 'POST') {
      const body = await readBody(req);
      const { school_id, grade, section_name, name, phone, nationality, national_id, email, password } = body;
      if (!school_id || !grade || !section_name || !name || !phone || !nationality || !national_id || !email || !password) {
        return sendJSON(res, 400, { error: 'الرجاء تعبئة كل الحقول' });
      }
      if (grade < 4 || grade > 10) return sendJSON(res, 400, { error: 'الصف يجب أن يكون بين 4 و 10' });
      const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(school_id);
      if (!school) return sendJSON(res, 400, { error: 'المدرسة غير موجودة' });
      const section = findOrCreateSection(school_id, grade, section_name);
      const { hash, salt } = hashPassword(password);
      try {
        const info = db.prepare(
          `INSERT INTO users (role, school_id, name, phone, nationality, national_id, email, password_hash, password_salt, grade, section_id)
           VALUES ('student', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(school_id, name, phone, nationality, national_id, email, hash, salt, grade, section.id);
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
        const token = genToken();
        db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, user.id);
        return sendJSON(res, 201, { token, user: publicUser(user) });
      } catch (e) {
        return sendJSON(res, 400, { error: 'البريد الإلكتروني مستخدم مسبقاً' });
      }
    }

    if (p === '/api/register/teacher' && req.method === 'POST') {
      const body = await readBody(req);
      const { teacher_code, name, email, password, sections } = body;
      // sections: [{grade, name}, ...]
      if (!teacher_code || !name || !email || !password || !Array.isArray(sections) || sections.length === 0) {
        return sendJSON(res, 400, { error: 'الرجاء تعبئة كل الحقول واختيار صف وشعبة واحدة على الأقل' });
      }
      // تحقق أولاً إذا كان الكود المدخل هو كود مدير
      const isAdminCode = db.prepare(`SELECT 1 FROM schools WHERE admin_code = ?`).get(teacher_code);
      if (isAdminCode) {
        return sendJSON(res, 403, { error: 'هذا الكود خاص بالمديرين. يرجى الذهاب إلى خانة "مدير" للتسجيل' });
      }

      const school = db.prepare(`SELECT * FROM schools WHERE teacher_code = ?`).get(teacher_code);
      if (!school) return sendJSON(res, 400, { error: 'كود المعلم غير صحيح' });
      const { hash, salt } = hashPassword(password);
      try {
        const info = db.prepare(
          `INSERT INTO users (role, school_id, name, email, password_hash, password_salt)
           VALUES ('teacher', ?, ?, ?, ?, ?)`
        ).run(school.id, name, email, hash, salt);
        const teacherId = info.lastInsertRowid;
        for (const s of sections) {
          if (!s.grade || !s.name) continue;
          const section = findOrCreateSection(school.id, s.grade, s.name);
          db.prepare(`INSERT OR IGNORE INTO teacher_sections (teacher_id, section_id) VALUES (?, ?)`)
            .run(teacherId, section.id);
        }
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(teacherId);
        const token = genToken();
        db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, user.id);
        return sendJSON(res, 201, { token, user: publicUser(user) });
      } catch (e) {
        return sendJSON(res, 400, { error: 'البريد الإلكتروني مستخدم مسبقاً' });
      }
    }

    if (p === '/api/register/admin' && req.method === 'POST') {
      const body = await readBody(req);
      const { admin_code, name, email, password } = body;
      if (!admin_code || !name || !email || !password) {
        return sendJSON(res, 400, { error: 'الرجاء تعبئة كل الحقول' });
      }
      // تحقق أولاً إذا كان الكود المدخل هو كود معلم
      const isTeacherCode = db.prepare(`SELECT 1 FROM schools WHERE teacher_code = ?`).get(admin_code);
      if (isTeacherCode) {
        return sendJSON(res, 403, { error: 'هذا الكود خاص بالمعلمين. يرجى الذهاب إلى خانة "معلم" للتسجيل' });
      }

      const school = db.prepare(`SELECT * FROM schools WHERE admin_code = ?`).get(admin_code);
      if (!school) return sendJSON(res, 400, { error: 'كود المدير غير صحيح' });
      const { hash, salt } = hashPassword(password);
      try {
        const info = db.prepare(
          `INSERT INTO users (role, school_id, name, email, password_hash, password_salt)
           VALUES ('admin', ?, ?, ?, ?, ?)`
        ).run(school.id, name, email, hash, salt);
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
        const token = genToken();
        db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, user.id);
        return sendJSON(res, 201, { token, user: publicUser(user) });
      } catch (e) {
        return sendJSON(res, 400, { error: 'البريد الإلكتروني مستخدم مسبقاً' });
      }
    }

    // ============= حسابات المطورين (تُدار فقط من داخل لوحة المطور، لا يوجد تسجيل عام) =============
    if (p === '/api/developer/accounts' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const rows = db.prepare(`SELECT id, name, email, created_at FROM users WHERE role = 'developer' ORDER BY id`).all();
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/developer/accounts' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const code = (body.code || '').trim();
      if (!name || !code) return sendJSON(res, 400, { error: 'الرجاء إدخال الاسم والرمز' });
      const { hash, salt } = hashPassword(code);
      try {
        const info = db.prepare(
          `INSERT INTO users (role, name, email, password_hash, password_salt) VALUES ('developer', ?, ?, ?, ?)`
        ).run(name, name, hash, salt);
        const created = db.prepare(`SELECT id, name, email, created_at FROM users WHERE id = ?`).get(info.lastInsertRowid);
        return sendJSON(res, 201, created);
      } catch (e) {
        return sendJSON(res, 400, { error: 'هذا الاسم مستخدم مسبقاً، اختر اسماً آخر' });
      }
    }

    if (p.startsWith('/api/developer/accounts/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const id = Number(p.split('/')[4]);
      if (id === user.id) return sendJSON(res, 400, { error: 'لا يمكنك حذف حسابك الحالي' });
      const total = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'developer'`).get().c;
      if (total <= 1) return sendJSON(res, 400, { error: 'لا يمكن حذف آخر حساب مطور في النظام' });
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      const result = db.prepare(`DELETE FROM users WHERE id = ? AND role = 'developer'`).run(id);
      if (result.changes === 0) return sendJSON(res, 404, { error: 'الحساب غير موجود' });
      return sendJSON(res, 200, { ok: true });
    }

    // ============= الدخول =============
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { email, password, expected_role } = body;
      if (!email || !password) return sendJSON(res, 400, { error: 'الرجاء إدخال البريد وكلمة المرور' });
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
      if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
        return sendJSON(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة' });
      }
      // تحقق من تطابق الدور المتوقع مع دور الحساب الفعلي
      if (expected_role && expected_role !== user.role) {
        let roleAr = { student: 'طالب', teacher: 'معلم', admin: 'مدير', developer: 'مطور' };
        return sendJSON(res, 403, { error: `هذا الحساب مسجل كـ (${roleAr[user.role]}). يرجى اختياره من القائمة بالأعلى للتسجيل` });
      }
      if (user.status === 'expelled') {
        return sendJSON(res, 403, { error: 'تم إيقاف حسابك. السبب: ' + (user.expelled_reason || 'غير محدد'), expelled: true });
      }
      const token = genToken();
      db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, user.id);
      return sendJSON(res, 200, { token, user: publicUser(user) });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      if (user.status === 'expelled') {
        return sendJSON(res, 403, { error: 'تم إيقاف حسابك. السبب: ' + (user.expelled_reason || 'غير محدد'), expelled: true });
      }
      return sendJSON(res, 200, { user: publicUser(user) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= أكواد المدرسة (للمدير) =============
    if (p === '/api/school/codes' && req.method === 'GET') {
      const user = auth(req);
      if (!user || (user.role !== 'admin')) return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(user.school_id);
      return sendJSON(res, 200, { admin_code: school.admin_code, teacher_code: school.teacher_code, school_name: school.name, school_id: school.id });
    }

    // ============= الشعب =============
    if (p === '/api/sections' && req.method === 'GET') {
      const school_id = q.get('school_id');
      const grade = q.get('grade');
      if (!school_id) return sendJSON(res, 400, { error: 'school_id مطلوب' });
      let rows;
      if (grade) {
        rows = db.prepare(`SELECT * FROM sections WHERE school_id = ? AND grade = ? ORDER BY name`).all(school_id, grade);
      } else {
        rows = db.prepare(`SELECT * FROM sections WHERE school_id = ? ORDER BY grade, name`).all(school_id);
      }
      return sendJSON(res, 200, rows);
    }

    // إضافة صف وشعبة جديدة — المدير فقط (لتظهر لاحقاً كخيار جاهز عند تسجيل الطلاب)
    if (p === '/api/sections' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const body = await readBody(req);
      const grade = Number(body.grade);
      const name = (body.name || '').trim();
      if (!grade || grade < 4 || grade > 10 || !name) return sendJSON(res, 400, { error: 'الرجاء إدخال صف صحيح (4-10) واسم شعبة' });
      const existing = db.prepare(`SELECT 1 FROM sections WHERE school_id = ? AND grade = ? AND name = ?`).get(user.school_id, grade, name);
      if (existing) return sendJSON(res, 400, { error: 'يوجد شعبة بنفس الاسم والصف مسبقاً' });
      try {
        const section = findOrCreateSection(user.school_id, grade, name);
        return sendJSON(res, 201, section);
      } catch (e) {
        return sendJSON(res, 400, { error: 'حدث خطأ أثناء الإضافة' });
      }
    }

    // تعديل اسم شعبة أو صفها — المدير فقط
    if (p.startsWith('/api/sections/') && req.method === 'PATCH') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[3]);
      const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id);
      if (!section || section.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الشعبة غير موجودة' });
      const body = await readBody(req);
      const newName = (body.name || section.name).trim();
      const newGrade = body.grade ? Number(body.grade) : section.grade;
      try {
        db.prepare(`UPDATE sections SET name = ?, grade = ? WHERE id = ?`).run(newName, newGrade, id);
        return sendJSON(res, 200, db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id));
      } catch (e) {
        return sendJSON(res, 400, { error: 'يوجد شعبة بنفس الاسم والصف مسبقاً' });
      }
    }

    // حذف شعبة — المدير فقط، بشرط عدم وجود طلاب فيها
    if (p.startsWith('/api/sections/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[3]);
      const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id);
      if (!section || section.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الشعبة غير موجودة' });
      const studentCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE section_id = ?`).get(id).c;
      if (studentCount > 0) return sendJSON(res, 400, { error: 'لا يمكن حذف شعبة بها طلاب' });
      db.prepare(`DELETE FROM teacher_sections WHERE section_id = ?`).run(id);
      db.prepare(`DELETE FROM timetable WHERE section_id = ?`).run(id);
      db.prepare(`DELETE FROM sections WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // تعيين / إلغاء رئيس صف — المعلم لشعبته أو المدير
    if (p.startsWith('/api/sections/') && p.endsWith('/president') && req.method === 'POST') {
      const user = auth(req);
      if (!user || !['teacher', 'admin'].includes(user.role)) return sendJSON(res, 403, { error: 'صلاحية المعلم أو المدير فقط' });
      const id = Number(p.split('/')[3]);
      const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id);
      if (!section) return sendJSON(res, 404, { error: 'الشعبة غير موجودة' });
      if (user.role === 'teacher' && !teacherOwnsSection(user.id, id)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      if (user.role === 'admin' && section.school_id !== user.school_id) return sendJSON(res, 403, { error: 'لا صلاحية' });
      const body = await readBody(req);
      const studentId = body.student_id || null;
      if (studentId) {
        const student = db.prepare(`SELECT * FROM users WHERE id = ? AND section_id = ? AND role = 'student'`).get(studentId, id);
        if (!student) return sendJSON(res, 400, { error: 'الطالب غير موجود في هذه الشعبة' });
      }
      db.prepare(`UPDATE sections SET president_id = ? WHERE id = ?`).run(studentId, id);
      return sendJSON(res, 200, db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id));
    }

    // قائمة طلاب شعبة معيّنة — للمعلم (اختيار رئيس الصف) وللمدير
    if (p.startsWith('/api/sections/') && p.endsWith('/students') && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(id);
      if (!section) return sendJSON(res, 404, { error: 'الشعبة غير موجودة' });
      if (user.role === 'teacher' && !teacherOwnsSection(user.id, id)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      if (user.role === 'admin' && section.school_id !== user.school_id) return sendJSON(res, 403, { error: 'لا صلاحية' });
      const rows = db.prepare(`SELECT id, name, email FROM users WHERE section_id = ? AND role = 'student' ORDER BY name`).all(id);
      return sendJSON(res, 200, rows);
    }

    // ============= لوحة المدير: قوائم =============
    if (p === '/api/admin/users' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const rows = db.prepare(
        `SELECT u.id, u.role, u.name, u.email, u.phone, u.nationality, u.grade, u.section_id, u.status, u.expelled_reason,
                s.name AS section_name
         FROM users u LEFT JOIN sections s ON s.id = u.section_id
         WHERE u.school_id = ? AND u.role IN ('student','teacher') ORDER BY u.role, u.grade, u.name`
      ).all(user.school_id);
      return sendJSON(res, 200, rows);
    }

    // ============= إجراءات تأديبية (تحذير / تحذير نهائي / طرد) — المدير فقط =============
    if (p === '/api/admin/warnings' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const body = await readBody(req);
      const { student_id, level, reason } = body;
      if (!student_id || !level || !reason || !reason.trim()) return sendJSON(res, 400, { error: 'بيانات ناقصة' });
      if (!['warning', 'final_warning', 'expulsion'].includes(level)) return sendJSON(res, 400, { error: 'نوع إجراء غير صحيح' });
      const student = db.prepare(`SELECT * FROM users WHERE id = ? AND school_id = ? AND role = 'student'`).get(student_id, user.school_id);
      if (!student) return sendJSON(res, 404, { error: 'الطالب غير موجود في مدرستك' });

      db.prepare(
        `INSERT INTO warnings (student_id, school_id, level, reason, issued_by_name) VALUES (?, ?, ?, ?, ?)`
      ).run(student_id, user.school_id, level, reason.trim(), user.name);

      if (level === 'expulsion') {
        db.prepare(`UPDATE users SET status = 'expelled', expelled_reason = ? WHERE id = ?`).run(reason.trim(), student_id);
        db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(student_id);
      }
      return sendJSON(res, 201, { ok: true });
    }

    // إلغاء الطرد وإعادة تفعيل الحساب — المدير فقط
    if (p.startsWith('/api/admin/users/') && p.endsWith('/reinstate') && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[4]);
      const student = db.prepare(`SELECT * FROM users WHERE id = ? AND school_id = ?`).get(id, user.school_id);
      if (!student) return sendJSON(res, 404, { error: 'غير موجود' });
      db.prepare(`UPDATE users SET status = 'active', expelled_reason = NULL WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // سجل كامل لكل الإجراءات التأديبية في المدرسة — المدير
    // ملاحظة: يجب أن يسبق هذا المسار مسار "/api/admin/warnings/:studentId" لأنه أكثر تحديداً
    if (p === '/api/admin/warnings/all' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const rows = db.prepare(
        `SELECT w.*, u.name AS student_name, u.grade, sec.name AS section_name
         FROM warnings w
         JOIN users u ON u.id = w.student_id
         LEFT JOIN sections sec ON sec.id = u.section_id
         WHERE w.school_id = ? ORDER BY w.id DESC`
      ).all(user.school_id);
      return sendJSON(res, 200, rows);
    }

    // سجل الإجراءات التأديبية لطالب معيّن — المدير
    if (p.startsWith('/api/admin/warnings/') && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const studentId = Number(p.split('/')[3]);
      const rows = db.prepare(`SELECT * FROM warnings WHERE student_id = ? AND school_id = ? ORDER BY id DESC`).all(studentId, user.school_id);
      return sendJSON(res, 200, rows);
    }

    // نقل طالب من شعبة لأخرى — المدير فقط
    if (p.startsWith('/api/admin/users/') && p.endsWith('/section') && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[4]);
      const student = db.prepare(`SELECT * FROM users WHERE id = ? AND school_id = ? AND role = 'student'`).get(id, user.school_id);
      if (!student) return sendJSON(res, 404, { error: 'الطالب غير موجود في مدرستك' });
      const body = await readBody(req);
      const sectionId = Number(body.section_id);
      const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(sectionId);
      if (!section || section.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الشعبة غير موجودة' });
      db.prepare(`UPDATE users SET section_id = ?, grade = ? WHERE id = ?`).run(section.id, section.grade, id);
      const updated = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
      return sendJSON(res, 200, publicUser(updated));
    }

    // إحصائيات عامة للمدرسة — المدير
    if (p === '/api/admin/stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const byGrade = db.prepare(
        `SELECT grade, COUNT(*) c FROM users WHERE school_id = ? AND role = 'student' GROUP BY grade ORDER BY grade`
      ).all(user.school_id);
      const stats = {
        students: db.prepare(`SELECT COUNT(*) c FROM users WHERE school_id = ? AND role = 'student'`).get(user.school_id).c,
        teachers: db.prepare(`SELECT COUNT(*) c FROM users WHERE school_id = ? AND role = 'teacher'`).get(user.school_id).c,
        sections: db.prepare(`SELECT COUNT(*) c FROM sections WHERE school_id = ?`).get(user.school_id).c,
        expelled: db.prepare(`SELECT COUNT(*) c FROM users WHERE school_id = ? AND status = 'expelled'`).get(user.school_id).c,
        by_grade: byGrade,
      };
      return sendJSON(res, 200, stats);
    }

    // التحذيرات الخاصة بالطالب نفسه (يظهر له بانر عند الدخول)
    if (p === '/api/my/warnings' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const rows = db.prepare(`SELECT * FROM warnings WHERE student_id = ? AND seen = 0 ORDER BY id ASC`).all(user.id);
      return sendJSON(res, 200, rows);
    }
    if (p === '/api/my/warnings/mark-seen' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      db.prepare(`UPDATE warnings SET seen = 1 WHERE student_id = ?`).run(user.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= الدردشة =============
    if (p === '/api/chat' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const type = q.get('type'); // class | general
      const after = q.get('after_id') || 0;
      if (!user.school_id) return sendJSON(res, 400, { error: 'الحساب غير مرتبط بمدرسة' });

      let sectionId = null;
      if (type === 'class') {
        sectionId = q.get('section_id') || user.section_id;
        if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
      }

      let rows;
      if (type === 'general') {
        rows = db.prepare(
          `SELECT * FROM messages WHERE school_id = ? AND type = 'general' AND id > ? ORDER BY id ASC`
        ).all(user.school_id, after);
      } else {
        rows = db.prepare(
          `SELECT * FROM messages WHERE school_id = ? AND type = 'class' AND section_id = ? AND id > ? ORDER BY id ASC`
        ).all(user.school_id, sectionId, after);
      }
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { type, content, section_id, image } = body;
      if (!content && !image) return sendJSON(res, 400, { error: 'الرسالة فارغة' });
      if (!['class', 'general'].includes(type)) return sendJSON(res, 400, { error: 'نوع دردشة غير صحيح' });

      let sectionId = null;
      if (type === 'class') {
        sectionId = section_id || user.section_id;
        if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
        if (user.role === 'student' && Number(sectionId) !== Number(user.section_id)) {
          return sendJSON(res, 403, { error: 'لا يمكنك الكتابة في دردشة شعبة أخرى' });
        }
        if (user.role === 'teacher') {
          if (!teacherOwnsSection(user.id, sectionId)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
        }
      }

      const info = db.prepare(
        `INSERT INTO messages (school_id, section_id, type, sender_id, sender_name, sender_role, content, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(user.school_id, sectionId, type, user.id, user.name, user.role, (content || '').trim(), image || null);
      const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(info.lastInsertRowid);
      return sendJSON(res, 201, msg);
    }

    // حذف رسالة — المعلم، المدير، أو رئيس الصف لهذه الشعبة فقط (ضمن دردشة الصف)
    if (p.startsWith('/api/chat/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
      if (!msg || msg.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الرسالة غير موجودة' });

      let allowed = false;
      if (['admin'].includes(user.role)) allowed = true;
      if (user.role === 'teacher' && msg.type === 'class' && teacherOwnsSection(user.id, msg.section_id)) allowed = true;
      if (user.role === 'student' && msg.type === 'class') {
        const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(msg.section_id);
        if (section && section.president_id === user.id) allowed = true;
      }
      // صاحب الرسالة يقدر يحذفها بنفسه دايماً (تصحيح غلطة مثلاً)
      if (msg.sender_id === user.id) allowed = true;
      if (!allowed) return sendJSON(res, 403, { error: 'لا تملك صلاحية حذف هذه الرسالة' });

      db.prepare(`UPDATE messages SET deleted = 1, content = '' WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // تعديل رسالة — فقط صاحبها، وطالما لم تُحذف
    if (p.startsWith('/api/chat/') && !p.includes('/pin') && req.method === 'PATCH') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
      if (!msg || msg.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الرسالة غير موجودة' });
      if (msg.sender_id !== user.id) return sendJSON(res, 403, { error: 'يمكنك تعديل رسائلك فقط' });
      if (msg.deleted) return sendJSON(res, 400, { error: 'لا يمكن تعديل رسالة محذوفة' });
      const body = await readBody(req);
      const content = (body.content || '').trim();
      if (!content) return sendJSON(res, 400, { error: 'الرسالة فارغة' });
      db.prepare(`UPDATE messages SET content = ?, edited = 1 WHERE id = ?`).run(content, id);
      return sendJSON(res, 200, db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id));
    }

    // تثبيت / إلغاء تثبيت رسالة في دردشة الصف — المعلم لشعبته أو المدير
    if (p.startsWith('/api/chat/') && p.endsWith('/pin') && req.method === 'POST') {
      const user = auth(req);
      if (!user || !['teacher', 'admin'].includes(user.role)) return sendJSON(res, 403, { error: 'صلاحية المعلم أو المدير فقط' });
      const id = Number(p.split('/')[3]);
      const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
      if (!msg || msg.school_id !== user.school_id || msg.type !== 'class') return sendJSON(res, 404, { error: 'الرسالة غير موجودة' });
      if (user.role === 'teacher' && !teacherOwnsSection(user.id, msg.section_id)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      const body = await readBody(req);
      const wantPin = !!body.pinned;
      if (wantPin) {
        db.prepare(`UPDATE messages SET pinned = 0 WHERE section_id = ? AND type = 'class'`).run(msg.section_id);
        db.prepare(`UPDATE messages SET pinned = 1 WHERE id = ?`).run(id);
      } else {
        db.prepare(`UPDATE messages SET pinned = 0 WHERE id = ?`).run(id);
      }
      return sendJSON(res, 200, db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id));
    }

    // جلب الرسالة المثبّتة حالياً في دردشة صف معيّنة
    if (p === '/api/chat/pinned' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const sectionId = q.get('section_id') || user.section_id;
      if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
      const row = db.prepare(`SELECT * FROM messages WHERE section_id = ? AND type = 'class' AND pinned = 1 AND deleted = 0`).get(sectionId);
      return sendJSON(res, 200, row || null);
    }

    // ============= الملفات =============
    if (p === '/api/files' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const sectionId = q.get('section_id') || user.section_id;
      if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
      const rows = db.prepare(
        `SELECT id, title, category, filename, mime, uploader_name, created_at FROM files WHERE section_id = ? ORDER BY id DESC`
      ).all(sectionId);
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/files' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      if (!['teacher', 'admin'].includes(user.role)) return sendJSON(res, 403, { error: 'صلاحية المعلم أو المدير فقط' });
      const body = await readBody(req);
      const { title, filename, mime, base64, section_id, category } = body;
      if (!title || !filename || !base64 || !section_id) return sendJSON(res, 400, { error: 'بيانات ناقصة' });
      const cat = ['worksheet', 'assignment', 'exam'].includes(category) ? category : 'worksheet';
      if (user.role === 'teacher') {
        if (!teacherOwnsSection(user.id, section_id)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      }
      const storedName = crypto.randomBytes(12).toString('hex') + '-' + filename.replace(/[^a-zA-Z0-9._\u0600-\u06FF-]/g, '_');
      const buffer = Buffer.from(base64, 'base64');
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);
      const info = db.prepare(
        `INSERT INTO files (school_id, section_id, uploader_id, uploader_name, title, category, filename, stored_name, mime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(user.school_id, section_id, user.id, user.name, title, cat, filename, storedName, mime || 'application/octet-stream');
      const file = db.prepare(`SELECT id, title, category, filename, mime, uploader_name, created_at FROM files WHERE id = ?`).get(info.lastInsertRowid);
      return sendJSON(res, 201, file);
    }

    if (p.startsWith('/api/files/') && p.endsWith('/download') && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = p.split('/')[3];
      const file = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id);
      if (!file) return sendJSON(res, 404, { error: 'الملف غير موجود' });
      const filePath = path.join(UPLOADS_DIR, file.stored_name);
      if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: 'الملف غير موجود على السيرفر' });
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': file.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
      });
      return res.end(data);
    }

    if (p.startsWith('/api/files/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || !['teacher', 'admin'].includes(user.role)) return sendJSON(res, 403, { error: 'صلاحية المعلم أو المدير فقط' });
      const id = Number(p.split('/')[3]);
      const file = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id);
      if (!file || file.school_id !== user.school_id) return sendJSON(res, 404, { error: 'الملف غير موجود' });
      if (user.role === 'teacher' && !teacherOwnsSection(user.id, file.section_id)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      const filePath = path.join(UPLOADS_DIR, file.stored_name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= الجدول الدراسي =============
    // جدول الشعبة (للطلاب ورئيس الصف)
    if (p === '/api/timetable' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const sectionId = q.get('section_id') || user.section_id;
      if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
      const rows = db.prepare(
        `SELECT * FROM timetable WHERE section_id = ? AND (teacher_id IS NULL) ORDER BY period_number, day`
      ).all(sectionId);
      return sendJSON(res, 200, rows);
    }

    // جدول المعلم الشخصي
    if (p === '/api/timetable/my' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'teacher') return sendJSON(res, 403, { error: 'صلاحية المعلم فقط' });
      const rows = db.prepare(
        `SELECT t.*, s.grade AS section_grade, s.name AS section_name
         FROM timetable t LEFT JOIN sections s ON s.id = t.section_id
         WHERE t.teacher_id = ? ORDER BY t.period_number, t.day`
      ).all(user.id);
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/timetable' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { section_id, entries } = body;
      if (!section_id || !Array.isArray(entries)) return sendJSON(res, 400, { error: 'بيانات ناقصة' });

      // حفظ جدول المعلم الشخصي
      if (body.teacher_timetable) {
        if (user.role !== 'teacher') return sendJSON(res, 403, { error: 'صلاحية المعلم فقط' });
        db.prepare(`DELETE FROM timetable WHERE teacher_id = ?`).run(user.id);
        const insert = db.prepare(
          `INSERT INTO timetable (section_id, teacher_id, day, period_number, subject) VALUES (?, ?, ?, ?, ?)`
        );
        for (const e of entries) {
          if (!e.day || !e.period_number) continue;
          insert.run(e.section_id || 0, user.id, e.day, e.period_number, e.subject || '');
        }
        const rows = db.prepare(
          `SELECT t.*, s.grade AS section_grade, s.name AS section_name
           FROM timetable t LEFT JOIN sections s ON s.id = t.section_id
           WHERE t.teacher_id = ? ORDER BY t.period_number, t.day`
        ).all(user.id);
        return sendJSON(res, 200, rows);
      }

      // حفظ جدول الشعبة (رئيس الصف أو المدير)
      let allowed = false;
      if (['admin'].includes(user.role)) allowed = true;
      if (user.role === 'teacher' && teacherOwnsSection(user.id, section_id)) allowed = true;
      if (user.role === 'student') {
        const section = db.prepare(`SELECT * FROM sections WHERE id = ?`).get(section_id);
        if (section && section.president_id === user.id) allowed = true;
      }
      if (!allowed) return sendJSON(res, 403, { error: 'لا تملك صلاحية تعديل هذا الجدول' });
      db.prepare(`DELETE FROM timetable WHERE section_id = ? AND teacher_id IS NULL`).run(section_id);
      const insert = db.prepare(
        `INSERT INTO timetable (section_id, day, period_number, subject, teacher_name) VALUES (?, ?, ?, ?, ?)`
      );
      for (const e of entries) {
        if (!e.day || !e.period_number || !e.subject) continue;
        insert.run(section_id, e.day, e.period_number, e.subject, e.teacher_name || '');
      }
      const rows = db.prepare(`SELECT * FROM timetable WHERE section_id = ? AND teacher_id IS NULL ORDER BY period_number, day`).all(section_id);
      return sendJSON(res, 200, rows);
    }

    // ============= معلم: شعبه =============
    if (p === '/api/teacher/sections' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'teacher') return sendJSON(res, 403, { error: 'صلاحية المعلم فقط' });
      const rows = db.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM users u WHERE u.section_id = s.id AND u.role = 'student') AS student_count
         FROM sections s JOIN teacher_sections ts ON ts.section_id = s.id WHERE ts.teacher_id = ? ORDER BY s.grade, s.name`
      ).all(user.id);
      return sendJSON(res, 200, rows);
    }

    // ============= المطوّر: نظرة شاملة =============
    if (p === '/api/developer/users' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const rows = db.prepare(
        `SELECT u.id, u.role, u.name, u.email, u.status, u.school_id, sc.name AS school_name
         FROM users u LEFT JOIN schools sc ON sc.id = u.school_id
         ORDER BY u.role, u.name`
      ).all();
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/developer/stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const stats = {
        schools: db.prepare(`SELECT COUNT(*) c FROM schools`).get().c,
        students: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'student'`).get().c,
        teachers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'teacher'`).get().c,
        admins: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c,
        messages: db.prepare(`SELECT COUNT(*) c FROM messages`).get().c,
        files: db.prepare(`SELECT COUNT(*) c FROM files`).get().c,
        expelled: db.prepare(`SELECT COUNT(*) c FROM users WHERE status = 'expelled'`).get().c,
      };
      return sendJSON(res, 200, stats);
    }

    // ============= صلاحيات المدير الكاملة: حذف المعلمين والطلاب =============
    if (p.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[4]);
      const targetUser = db.prepare(`SELECT * FROM users WHERE id = ? AND school_id = ?`).get(id, user.school_id);
      if (!targetUser) return sendJSON(res, 404, { error: 'المستخدم غير موجود' });
      if (targetUser.role === 'admin') return sendJSON(res, 403, { error: 'لا يمكن حذف مدير' });
      
      // حذف المعلم مع جميع بيانات الشعب
      if (targetUser.role === 'teacher') {
        db.prepare(`DELETE FROM teacher_sections WHERE teacher_id = ?`).run(id);
      }
      
      // حذف الرسائل والملفات والتحذيرات
      db.prepare(`DELETE FROM messages WHERE sender_id = ?`).run(id);
      db.prepare(`DELETE FROM files WHERE uploader_id = ?`).run(id);
      db.prepare(`DELETE FROM warnings WHERE student_id = ?`).run(id);
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      db.prepare(`DELETE FROM typing_indicators WHERE user_id = ?`).run(id);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
      
      return sendJSON(res, 200, { ok: true });
    }

    // ============= تغيير كلمة المرور =============
    if (p === '/api/change-password' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { old_password, new_password } = body;
      if (!old_password || !new_password) return sendJSON(res, 400, { error: 'كلمة المرور القديمة والجديدة مطلوبتان' });
      if (new_password.length < 3) return sendJSON(res, 400, { error: 'كلمة المرور الجديدة قصيرة جداً' });
      if (!verifyPassword(old_password, user.password_hash, user.password_salt)) {
        return sendJSON(res, 403, { error: 'كلمة المرور القديمة غير صحيحة' });
      }
      const { hash, salt } = hashPassword(new_password);
      db.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, user.id);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= إحصائيات الطالب (إنجازاته الحقيقية) =============
    if (p === '/api/student/stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const msgCount = db.prepare(`SELECT COUNT(*) c FROM messages WHERE sender_id = ?`).get(user.id).c;
      const fileCount = user.section_id ? db.prepare(`SELECT COUNT(*) c FROM files WHERE section_id = ?`).get(user.section_id).c : 0;
      const warningCount = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE student_id = ?`).get(user.id).c;
      const sections = user.school_id ? db.prepare(`SELECT * FROM sections WHERE school_id = ? AND grade = ?`).all(user.school_id, user.grade) : [];
      const isPresident = sections.some(s => s.president_id === user.id);
      const sectionsCount = db.prepare(`SELECT COUNT(*) c FROM sections WHERE school_id = ?`).get(user.school_id).c;
      const classmates = user.section_id ? db.prepare(`SELECT COUNT(*) c FROM users WHERE section_id = ? AND role = 'student'`).get(user.section_id).c : 0;
      return sendJSON(res, 200, {
        messages_sent: msgCount,
        files_available: fileCount,
        warnings: warningCount,
        is_president: isPresident,
        classmates,
        total_sections: sectionsCount,
      });
    }

    // ============= إحصائيات المعلم لشعبته =============
    if (p === '/api/teacher/section-stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'teacher') return sendJSON(res, 403, { error: 'صلاحية المعلم فقط' });
      const sectionId = q.get('section_id');
      if (!sectionId) return sendJSON(res, 400, { error: 'section_id مطلوب' });
      if (!teacherOwnsSection(user.id, sectionId)) return sendJSON(res, 403, { error: 'أنت لا تدرّس هذه الشعبة' });
      const studentCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE section_id = ? AND role = 'student'`).get(sectionId).c;
      const msgCount = db.prepare(`SELECT COUNT(*) c FROM messages WHERE section_id = ? AND type = 'class'`).get(sectionId).c;
      const fileCount = db.prepare(`SELECT COUNT(*) c FROM files WHERE section_id = ?`).get(sectionId).c;
      const myMsgCount = db.prepare(`SELECT COUNT(*) c FROM messages WHERE section_id = ? AND sender_id = ?`).get(sectionId, user.id).c;
      const activeStudents = db.prepare(`SELECT COUNT(DISTINCT m.sender_id) c FROM messages m WHERE m.section_id = ? AND m.sender_id IN (SELECT id FROM users WHERE section_id = ? AND role = 'student')`).get(sectionId, sectionId).c;
      return sendJSON(res, 200, {
        student_count: studentCount,
        message_count: msgCount,
        file_count: fileCount,
        my_messages: myMsgCount,
        active_students: activeStudents,
      });
    }

    // ============= إحصائيات المعلمين (للمدير) =============
    if (p === '/api/admin/teacher-stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const teachers = db.prepare(
        `SELECT u.id, u.name FROM users u WHERE u.school_id = ? AND u.role = 'teacher'`
      ).all(user.school_id);
      const stats = teachers.map(t => {
        const sectionIds = db.prepare(`SELECT section_id FROM teacher_sections WHERE teacher_id = ?`).all(t.id).map(r => r.section_id);
        let totalStudents = 0, totalMessages = 0, totalFiles = 0;
        for (const sid of sectionIds) {
          totalStudents += db.prepare(`SELECT COUNT(*) c FROM users WHERE section_id = ? AND role = 'student'`).get(sid).c;
          totalMessages += db.prepare(`SELECT COUNT(*) c FROM messages WHERE section_id = ?`).get(sid).c;
          totalFiles += db.prepare(`SELECT COUNT(*) c FROM files WHERE section_id = ?`).get(sid).c;
        }
        return {
          id: t.id,
          name: t.name,
          sections_count: sectionIds.length,
          students: totalStudents,
          messages: totalMessages,
          files: totalFiles,
        };
      });
      return sendJSON(res, 200, stats);
    }

    // ============= إحصائيات عامة للمطور =============
    if (p === '/api/developer/platform-stats' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const stats = {
        schools: db.prepare(`SELECT COUNT(*) c FROM schools`).get().c,
        students: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'student'`).get().c,
        teachers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'teacher'`).get().c,
        admins: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c,
        developers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'developer'`).get().c,
        messages: db.prepare(`SELECT COUNT(*) c FROM messages`).get().c,
        files: db.prepare(`SELECT COUNT(*) c FROM files`).get().c,
        sections: db.prepare(`SELECT COUNT(*) c FROM sections`).get().c,
        expelled: db.prepare(`SELECT COUNT(*) c FROM users WHERE status = 'expelled'`).get().c,
        db_size: fs.existsSync(path.join(__dirname, 'schools.db')) ? fs.statSync(path.join(__dirname, 'schools.db')).size : 0,
        uploads_size: getDirSize(UPLOADS_DIR),
      };
      return sendJSON(res, 200, stats);
    }

    // ============= النسخ الاحتياطي (للمطور) =============
    if (p === '/api/developer/backup' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const backupDir = path.join(__dirname, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dbBackup = path.join(backupDir, `schools_${timestamp}.db`);
      try {
        fs.copyFileSync(path.join(__dirname, 'schools.db'), dbBackup);
        return sendJSON(res, 200, { ok: true, filename: path.basename(dbBackup), timestamp });
      } catch (e) {
        return sendJSON(res, 500, { error: 'فشل إنشاء النسخة الاحتياطية' });
      }
    }

    if (p === '/api/developer/backups' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const backupDir = path.join(__dirname, 'backups');
      if (!fs.existsSync(backupDir)) return sendJSON(res, 200, []);
      const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { name: f, size: stat.size, created: stat.mtime };
      }).sort((a, b) => new Date(b.created) - new Date(a.created));
      return sendJSON(res, 200, files);
    }

    if (p === '/api/developer/backup/download' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const filename = q.get('file');
      if (!filename || filename.includes('..') || filename.includes('/')) return sendJSON(res, 400, { error: 'اسم ملف غير صالح' });
      const filePath = path.join(__dirname, 'backups', filename);
      if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: 'النسخة غير موجودة' });
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return res.end(data);
    }

    if (p.startsWith('/api/developer/backup/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user || user.role !== 'developer') return sendJSON(res, 403, { error: 'صلاحية المطور فقط' });
      const filename = p.split('/')[4];
      if (!filename || filename.includes('..') || filename.includes('/')) return sendJSON(res, 400, { error: 'اسم ملف غير صالح' });
      const filePath = path.join(__dirname, 'backups', filename);
      if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: 'النسخة غير موجودة' });
      fs.unlinkSync(filePath);
      return sendJSON(res, 200, { ok: true });
    }

    // ============= المراسلة الفورية: مؤشرات الكتابة =============
    if (p === '/api/typing-start' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { section_id, chat_type } = body; // chat_type: 'class' | 'general'
      if (!chat_type || !['class', 'general'].includes(chat_type)) {
        return sendJSON(res, 400, { error: 'نوع الدردشة غير صحيح' });
      }
      
      let sectionId = null;
      if (chat_type === 'class') {
        sectionId = section_id || user.section_id;
        if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
      }
      
      // حذف المؤشرات القديمة للمستخدم
      db.prepare(`DELETE FROM typing_indicators WHERE user_id = ? AND chat_type = ?`).run(user.id, chat_type);
      
      // إضافة مؤشر جديد (ينتهي بعد 5 ثوانٍ)
      const expiresAt = new Date(Date.now() + 5000).toISOString();
      db.prepare(
        `INSERT INTO typing_indicators (user_id, section_id, chat_type, school_id, expires_at) VALUES (?, ?, ?, ?, ?)`
      ).run(user.id, sectionId, chat_type, user.school_id, expiresAt);
      
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/typing-stop' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { chat_type } = body;
      if (!chat_type) return sendJSON(res, 400, { error: 'نوع الدردشة مطلوب' });
      
      db.prepare(`DELETE FROM typing_indicators WHERE user_id = ? AND chat_type = ?`).run(user.id, chat_type);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/typing-indicators' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const chatType = q.get('chat_type');
      if (!chatType) return sendJSON(res, 400, { error: 'نوع الدردشة مطلوب' });
      
      // تنظيف المؤشرات المنتهية
      cleanupTypingIndicators();
      
      let query = `SELECT ti.*, u.name FROM typing_indicators ti JOIN users u ON u.id = ti.user_id WHERE ti.school_id = ? AND ti.chat_type = ?`;
      let params = [user.school_id, chatType];
      
      if (chatType === 'class') {
        const sectionId = q.get('section_id') || user.section_id;
        if (!sectionId) return sendJSON(res, 400, { error: 'يجب تحديد الشعبة' });
        query += ` AND ti.section_id = ?`;
        params.push(sectionId);
      }
      
      const rows = db.prepare(query).all(...params);
      return sendJSON(res, 200, rows);
    }

    // ============= البلاغات والشكاوى =============
    if (p === '/api/reports' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      if (user.role === 'student') {
        const rows = db.prepare(`SELECT * FROM reports WHERE student_id = ? ORDER BY id DESC`).all(user.id);
        return sendJSON(res, 200, rows);
      }
      return sendJSON(res, 403, { error: 'صلاحية غير كافية' });
    }

    if (p === '/api/reports' && req.method === 'POST') {
      const user = auth(req);
      if (!user || user.role !== 'student') return sendJSON(res, 403, { error: 'صلاحية الطالب فقط' });
      const body = await readBody(req);
      const { type, title, content } = body;
      if (!title || !content) return sendJSON(res, 400, { error: 'العنوان والمحتوى مطلوبان' });
      if (!['complaint', 'report'].includes(type)) return sendJSON(res, 400, { error: 'نوع غير صحيح' });
      const info = db.prepare(`INSERT INTO reports (school_id, student_id, type, title, content) VALUES (?, ?, ?, ?, ?)`).run(user.school_id, user.id, type, title.trim(), content.trim());
      const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(info.lastInsertRowid);
      return sendJSON(res, 201, report);
    }

    if (p === '/api/admin/reports' && req.method === 'GET') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const rows = db.prepare(`SELECT r.*, u.name AS student_name, u.grade, sec.name AS section_name FROM reports r JOIN users u ON u.id = r.student_id LEFT JOIN sections sec ON sec.id = u.section_id WHERE r.school_id = ? ORDER BY r.id DESC`).all(user.school_id);
      return sendJSON(res, 200, rows);
    }

    if (p.startsWith('/api/admin/reports/') && req.method === 'PATCH') {
      const user = auth(req);
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: 'صلاحية المدير فقط' });
      const id = Number(p.split('/')[4]);
      const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
      if (!report || report.school_id !== user.school_id) return sendJSON(res, 404, { error: 'البلاغ غير موجود' });
      const body = await readBody(req);
      const { status, admin_reply } = body;
      if (status && ['pending', 'reviewed', 'resolved'].includes(status)) {
        db.prepare(`UPDATE reports SET status = ?, admin_reply = ?, updated_at = datetime('now') WHERE id = ?`).run(status, admin_reply || report.admin_reply, id);
      } else if (admin_reply !== undefined) {
        db.prepare(`UPDATE reports SET admin_reply = ?, updated_at = datetime('now') WHERE id = ?`).run(admin_reply, id);
      }
      return sendJSON(res, 200, db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id));
    }

    // ============= الدفتر الذكي (ملاحظات الطالب) =============
    if (p === '/api/notes' && req.method === 'GET') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const rows = db.prepare(`SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC`).all(user.id);
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/notes' && req.method === 'POST') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const body = await readBody(req);
      const { title, content, color } = body;
      if (!title) return sendJSON(res, 400, { error: 'العنوان مطلوب' });
      const info = db.prepare(`INSERT INTO notes (user_id, title, content, color) VALUES (?, ?, ?, ?)`).run(user.id, title.trim(), (content || '').trim(), color || '#D9FDD3');
      return sendJSON(res, 201, db.prepare(`SELECT * FROM notes WHERE id = ?`).get(info.lastInsertRowid));
    }

    if (p.startsWith('/api/notes/') && req.method === 'PATCH') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id);
      if (!note || note.user_id !== user.id) return sendJSON(res, 404, { error: 'الملاحظة غير موجودة' });
      const body = await readBody(req);
      const title = body.title !== undefined ? body.title.trim() : note.title;
      const content = body.content !== undefined ? body.content.trim() : note.content;
      const color = body.color || note.color;
      const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : note.pinned;
      db.prepare(`UPDATE notes SET title = ?, content = ?, color = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?`).run(title, content, color, pinned, id);
      return sendJSON(res, 200, db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id));
    }

    if (p.startsWith('/api/notes/') && req.method === 'DELETE') {
      const user = auth(req);
      if (!user) return sendJSON(res, 401, { error: 'غير مسجل الدخول' });
      const id = Number(p.split('/')[3]);
      const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id);
      if (!note || note.user_id !== user.id) return sendJSON(res, 404, { error: 'الملاحظة غير موجودة' });
      db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'المسار غير موجود' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'خطأ داخلي في السيرفر' });
  }
});

server.listen(PORT, () => {
  console.log(`✅ منصة "رشد" شغالة محلياً على: http://localhost:${PORT}`);
});
