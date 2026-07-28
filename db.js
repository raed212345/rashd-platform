// db.js — قاعدة بيانات SQLite محلية بالكامل (بدون أي مكتبات خارجية) — منصة "رشد"
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, 'schools.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  admin_code TEXT NOT NULL UNIQUE,
  teacher_code TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  grade INTEGER NOT NULL,
  name TEXT NOT NULL,
  president_id INTEGER,
  UNIQUE(school_id, grade, name),
  FOREIGN KEY (school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('student','teacher','admin','developer')),
  school_id INTEGER,
  name TEXT NOT NULL,
  phone TEXT,
  nationality TEXT,
  national_id TEXT,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  grade INTEGER,
  section_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expelled')),
  expelled_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (school_id) REFERENCES schools(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS teacher_sections (
  teacher_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, section_id),
  FOREIGN KEY (teacher_id) REFERENCES users(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  section_id INTEGER,
  type TEXT NOT NULL CHECK(type IN ('class','general')),
  sender_id INTEGER NOT NULL,
  sender_name TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  image TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS typing_indicators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  section_id INTEGER,
  chat_type TEXT NOT NULL CHECK(chat_type IN ('class','general')),
  school_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  uploader_id INTEGER NOT NULL,
  uploader_name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'worksheet' CHECK(category IN ('worksheet','assignment','exam')),
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL,
  teacher_id INTEGER,
  day TEXT NOT NULL,
  period_number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  teacher_name TEXT,
  UNIQUE(section_id, day, period_number),
  FOREIGN KEY (section_id) REFERENCES sections(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  school_id INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('warning','final_warning','expulsion')),
  reason TEXT NOT NULL,
  issued_by_name TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('complaint','report')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','resolved')),
  admin_reply TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  color TEXT DEFAULT '#D9FDD3',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// ترقية قواعد بيانات قديمة (إن وُجدت) بإضافة الأعمدة الجديدة إن لم تكن موجودة
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('sections', 'president_id', 'INTEGER');
ensureColumn('users', 'status', `TEXT NOT NULL DEFAULT 'active'`);
ensureColumn('users', 'expelled_reason', 'TEXT');
ensureColumn('users', 'national_id', 'TEXT');
ensureColumn('messages', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'edited', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('files', 'category', `TEXT NOT NULL DEFAULT 'worksheet'`);
ensureColumn('timetable', 'teacher_id', 'INTEGER');
ensureColumn('messages', 'image', 'TEXT');

// ---------- كلمات المرور ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

// ---------- أكواد وتوكنات ----------
function genCode(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- شعبة: أوجدها أو أنشئها ----------
function findOrCreateSection(schoolId, grade, name) {
  const existing = db.prepare(
    `SELECT * FROM sections WHERE school_id = ? AND grade = ? AND name = ?`
  ).get(schoolId, grade, name);
  if (existing) return existing;
  const info = db.prepare(
    `INSERT INTO sections (school_id, grade, name) VALUES (?, ?, ?)`
  ).run(schoolId, grade, name);
  return db.prepare(`SELECT * FROM sections WHERE id = ?`).get(info.lastInsertRowid);
}

// ---------- حساب المطوّر الثابت (لا يوجد تسجيل حساب مطور من الواجهة) ----------
// عند أول تشغيل فقط: يُنشأ حساب مطوّر دخوله الثابت raed1980 / RRR
// (البريد = raed1980، كلمة المرور = RRR). من داخل لوحة المطور يمكن إضافة
// حسابات مطورين إضافية (اسم + رمز) تدخل تلقائياً بصلاحية مطور عند تسجيل الدخول.
(function seedDefaultDeveloper() {
  const exists = db.prepare(`SELECT 1 FROM users WHERE role = 'developer' AND email = ?`).get('raed1980');
  if (!exists) {
    const { hash, salt } = hashPassword('RRR');
    db.prepare(
      `INSERT INTO users (role, name, email, password_hash, password_salt) VALUES ('developer', 'المطوّر', 'raed1980', ?, ?)`
    ).run(hash, salt);
  }
})();

// ---------- تنظيف مؤشرات الكتابة المنتهية ----------
function cleanupTypingIndicators() {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM typing_indicators WHERE expires_at < ?`).run(now);
}

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  genCode,
  genToken,
  findOrCreateSection,
  cleanupTypingIndicators,
};
