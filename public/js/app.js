// app.js — منصة "رشد" — تصميم عصري
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  selectedRole: 'student',
  teacherSection: null,
  pollTimers: [],
  myPresidentSections: new Set(),
};

// ---------------- أدوات مساعدة ----------------
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data.error || 'حدث خطأ'); err.data = data; throw err; }
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2800);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function clearPolling() {
  state.pollTimers.forEach(clearInterval);
  state.pollTimers = [];
}

function escapeHtml(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function roleLabel(r) {
  return { student: 'طالب', teacher: 'معلم', admin: 'مدير', developer: 'مطور' }[r] || r;
}

function roleAr(r) {
  return { student: '🎓 طالب', teacher: '📘 معلم', admin: '🏫 مدير', developer: '🛠️ مطور' }[r] || r;
}

// ---------------- مؤشرات الكتابة ----------------
let typingTimeout = null;
async function sendTypingStart(chatType, sectionId = null) {
  try { const body = { chat_type: chatType }; if (sectionId) body.section_id = sectionId; await api('/api/typing-start', { method: 'POST', body }); } catch (e) {}
}
async function sendTypingStop(chatType) {
  try { await api('/api/typing-stop', { method: 'POST', body: { chat_type: chatType } }); } catch (e) {}
}
function setupTypingOnInput(inputId, chatType, sectionId = null) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(typingTimeout);
    sendTypingStart(chatType, sectionId);
    typingTimeout = setTimeout(() => sendTypingStop(chatType), 3000);
  });
  input.addEventListener('blur', () => { clearTimeout(typingTimeout); sendTypingStop(chatType); });
}
async function fetchTypingUsers(chatType, sectionId) {
  try {
    let url = `/api/typing-indicators?chat_type=${chatType}`;
    if (sectionId) url += `&section_id=${sectionId}`;
    const rows = await api(url);
    return rows.filter(r => r.user_id !== state.user.id);
  } catch (e) { return []; }
}
function renderTypingBar(users, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let bar = container.querySelector('.typing-indicator');
  if (!bar) { bar = document.createElement('div'); bar.className = 'typing-indicator'; container.appendChild(bar); }
  if (users.length === 0) { bar.classList.remove('active'); bar.innerHTML = ''; }
  else {
    const names = users.map(u => u.name).join('، ');
    bar.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span> <em>${escapeHtml(names)}${users.length === 1 ? ' يكتب' : ' يكتبون'}</em>`;
    bar.classList.add('active');
  }
}

// ---------------- واجهة المستخدم ----------------
function showView(id) {
  ['view-auth', 'view-student', 'view-teacher', 'view-admin', 'view-developer'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
}

// ---------------- شاشة الدخول ----------------
document.querySelectorAll('.role-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedRole = btn.dataset.role;
    renderAuthMode();
  });
});

document.getElementById('mode-login').addEventListener('click', () => setAuthMode('login'));
document.getElementById('mode-register').addEventListener('click', () => setAuthMode('register'));
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('mode-login').classList.toggle('active', mode === 'login');
  document.getElementById('mode-register').classList.toggle('active', mode === 'register');
  renderAuthMode();
}
function renderAuthMode() {
  const isDev = state.selectedRole === 'developer';
  document.getElementById('mode-register').classList.toggle('hidden', isDev);
  if (isDev && authMode === 'register') authMode = 'login';
  document.getElementById('form-login').classList.toggle('hidden', authMode !== 'login');
  ['student', 'teacher', 'admin'].forEach(r => {
    document.getElementById('form-register-' + r).classList.toggle('hidden', !(authMode === 'register' && state.selectedRole === r));
  });
}
renderAuthMode();

// ---------------- تحميل المدارس ----------------
async function loadSchoolsForStudent() {
  try {
    const schools = await api('/api/schools');
    const sel = document.getElementById('s-school');
    sel.innerHTML = schools.length ? schools.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('') : `<option value="">لا توجد مدارس بعد</option>`;
    if (schools.length) loadSectionsForStudentSchool();
  } catch (e) {}
}
loadSchoolsForStudent();

let studentSchoolSections = [];
async function loadSectionsForStudentSchool() {
  const schoolId = document.getElementById('s-school').value;
  const gradeSel = document.getElementById('s-grade');
  const sectionSel = document.getElementById('s-section');
  gradeSel.innerHTML = `<option value="">جارِ التحميل...</option>`;
  sectionSel.innerHTML = `<option value="">اختر الصف أولاً</option>`;
  if (!schoolId) { gradeSel.innerHTML = `<option value="">اختر المدرسة أولاً</option>`; return; }
  try {
    studentSchoolSections = await api(`/api/sections?school_id=${schoolId}`);
    const grades = [...new Set(studentSchoolSections.map(s => s.grade))].sort((a, b) => a - b);
    gradeSel.innerHTML = grades.length ? `<option value="">اختر الصف</option>` + grades.map(g => `<option value="${g}">الصف ${g}</option>`).join('') : `<option value="">لا توجد صفوف بعد</option>`;
    sectionSel.innerHTML = `<option value="">اختر الصف أولاً</option>`;
  } catch (e) { gradeSel.innerHTML = `<option value="">تعذر التحميل</option>`; }
}
document.getElementById('s-school').addEventListener('change', loadSectionsForStudentSchool);
document.getElementById('s-grade').addEventListener('change', () => {
  const grade = Number(document.getElementById('s-grade').value);
  const matches = studentSchoolSections.filter(s => s.grade === grade);
  document.getElementById('s-section').innerHTML = matches.length ? `<option value="">اختر الشعبة</option>` + matches.map(s => `<option value="${escapeAttr(s.name)}">شعبة ${escapeHtml(s.name)}</option>`).join('') : `<option value="">لا توجد شعب</option>`;
});

// ---------------- بناء صفوف المعلم ----------------
function addTeacherSectionRow() {
  const wrap = document.getElementById('t-sections-list');
  const row = el(`<div class="section-row"><input type="number" min="4" max="10" placeholder="الصف" class="t-sec-grade" required><input type="text" placeholder="الشعبة" class="t-sec-name" required><button type="button" title="حذف">✕</button></div>`);
  row.querySelector('button').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}
document.getElementById('t-add-section').addEventListener('click', addTeacherSectionRow);
addTeacherSectionRow();

// ---------------- تسجيل الدخول ----------------
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/login', { method: 'POST', body: { email: document.getElementById('login-email').value, password: document.getElementById('login-password').value, expected_role: state.selectedRole } });
    onAuthed(data);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('form-register-student').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/register/student', { method: 'POST', body: { school_id: document.getElementById('s-school').value, grade: Number(document.getElementById('s-grade').value), section_name: document.getElementById('s-section').value, name: document.getElementById('s-name').value, phone: document.getElementById('s-phone').value, nationality: document.getElementById('s-nat').value, national_id: document.getElementById('s-national-id').value, email: document.getElementById('s-email').value, password: document.getElementById('s-password').value } });
    onAuthed(data);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('form-register-teacher').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sections = [...document.querySelectorAll('#t-sections-list .section-row')].map(row => ({ grade: Number(row.querySelector('.t-sec-grade').value), name: row.querySelector('.t-sec-name').value }));
  try {
    const data = await api('/api/register/teacher', { method: 'POST', body: { teacher_code: document.getElementById('t-code').value, name: document.getElementById('t-name').value, email: document.getElementById('t-email').value, password: document.getElementById('t-password').value, sections } });
    onAuthed(data);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('form-register-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/register/admin', { method: 'POST', body: { admin_code: document.getElementById('a-code').value, name: document.getElementById('a-name').value, email: document.getElementById('a-email').value, password: document.getElementById('a-password').value } });
    onAuthed(data);
  } catch (err) { toast(err.message, true); }
});

function onAuthed(data) {
  if (data.user.role !== state.selectedRole) {
    toast(`هذا الحساب مسجل كـ (${roleLabel(data.user.role)})`, true); return;
  }
  state.token = data.token; state.user = data.user;
  localStorage.setItem('token', data.token);
  toast('أهلاً ' + data.user.name);
  routeToDashboard();
}

['student', 'teacher', 'admin', 'developer'].forEach(r => {
  document.getElementById(r + '-logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    localStorage.removeItem('token'); state.token = null; state.user = null;
    clearPolling(); showView('view-auth');
  });
});

function routeToDashboard() {
  clearPolling();
  const map = { student: () => { showView('view-student'); renderStudentDash(); }, teacher: () => { showView('view-teacher'); renderTeacherDash(); }, admin: () => { showView('view-admin'); renderAdminDash(); }, developer: () => { showView('view-developer'); renderDeveloperDash(); } };
  if (map[state.user.role]) map[state.user.role]();
}

function setupNav(scope, onSwitch) {
  const items = document.querySelectorAll(`#view-${scope} .nav-item`);
  items.forEach(btn => {
    btn.addEventListener('click', () => {
      items.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll(`#view-${scope} .tab-pane`).forEach(p => p.classList.add('hidden'));
      document.getElementById(`${scope}-${tab}`).classList.remove('hidden');
      onSwitch(tab);
    });
  });
}

// ===================================================================
// صفحة الإعدادات المشتركة
// ===================================================================
function renderSettings(containerId, extraInfo = []) {
  const container = document.getElementById(containerId);
  const u = state.user;
  const initial = (u.name || '?')[0];
  container.innerHTML = `
    <h2>⚙️ الإعدادات</h2>
    <div class="settings-profile">
      <div class="settings-avatar">${escapeHtml(initial)}</div>
      <div class="settings-info">
        <h3>${escapeHtml(u.name)}</h3>
        <p>${escapeHtml(u.email || '')}</p>
        <span class="role-badge">${roleAr(u.role)}</span>
      </div>
    </div>
    <div class="settings-section">
      <h3>المعلومات الشخصية</h3>
      <div class="settings-item"><span class="settings-item-label">الاسم</span><span class="settings-item-value">${escapeHtml(u.name)}</span></div>
      <div class="settings-item"><span class="settings-item-label">البريد الإلكتروني</span><span class="settings-item-value">${escapeHtml(u.email || '—')}</span></div>
      ${u.school_id ? `<div class="settings-item"><span class="settings-item-label">رقم المدرسة</span><span class="settings-item-value">${u.school_id}</span></div>` : ''}
      ${extraInfo.map(([label, value]) => `<div class="settings-item"><span class="settings-item-label">${label}</span><span class="settings-item-value">${value}</span></div>`).join('')}
    </div>
    <div class="settings-section">
      <h3>تغيير كلمة المرور</h3>
      <div class="stack">
        <label>كلمة المرور الحالية<input type="password" id="settings-old-pw"></label>
        <label>كلمة المرور الجديدة<input type="password" id="settings-new-pw"></label>
        <button class="btn-primary" id="settings-pw-btn" style="width:fit-content;padding:10px 24px;">حفظ كلمة المرور</button>
      </div>
    </div>`;
  document.getElementById('settings-pw-btn').addEventListener('click', async () => {
    const old_password = document.getElementById('settings-old-pw').value;
    const new_password = document.getElementById('settings-new-pw').value;
    if (!old_password || !new_password) { toast('املأ كل الحقول', true); return; }
    try {
      await api('/api/change-password', { method: 'POST', body: { old_password, new_password } });
      toast('تم تغيير كلمة المرور بنجاح');
      document.getElementById('settings-old-pw').value = '';
      document.getElementById('settings-new-pw').value = '';
    } catch (err) { toast(err.message, true); }
  });
}

// ===================================================================
// جدول الحصص (مشترك)
// ===================================================================
const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];

function renderTimetableEditor(containerId, sectionId, canEdit) {
  const container = document.getElementById(containerId);
  const title = canEdit ? '🗓️ جدول الحصص' : '🗓️ جدول الحصص';
  const desc = canEdit ? 'عدّل الجدول ثم اضغط حفظ.' : 'الجدول الخاص بشعبتك.';
  container.innerHTML = `<h2>${title}</h2><p class="pane-desc">${desc}</p><div id="${containerId}-editor"></div>${canEdit ? `<button class="btn-primary" id="${containerId}-save" style="width:fit-content;padding:10px 24px;margin-top:14px;">حفظ الجدول</button>` : ''}`;

  const existing = api(`/api/timetable?section_id=${sectionId}`);
  existing.then(rows => {
    const map = {};
    rows.forEach(e => { map[`${e.day}-${e.period_number}`] = e; });
    let html = `<div class="timetable-pin" style="background:var(--sidebar-bg);"><h3>جدول الحصص الأسبوعي</h3><table class="tt"><thead><tr><th>الحصة</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>`;
    PERIODS.forEach(p => {
      html += `<tr><td style="font-weight:700;">${p}</td>`;
      DAYS.forEach(d => {
        const cur = map[`${d}-${p}`];
        if (canEdit) {
          html += `<td><input type="text" data-day="${d}" data-period="${p}" value="${cur ? escapeHtml(cur.subject) : ''}" style="width:85px;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#fff;font-size:12px;text-align:center;"></td>`;
        } else {
          html += `<td style="font-size:12px;">${cur ? escapeHtml(cur.subject) : '—'}</td>`;
        }
      });
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    document.getElementById(`${containerId}-editor`).innerHTML = html;

    if (canEdit) {
      document.getElementById(`${containerId}-save`).addEventListener('click', async () => {
        const inputs = document.querySelectorAll(`#${containerId}-editor input`);
        const entries = [];
        inputs.forEach(inp => { if (inp.value.trim()) entries.push({ day: inp.dataset.day, period_number: Number(inp.dataset.period), subject: inp.value.trim() }); });
        try {
          await api('/api/timetable', { method: 'POST', body: { section_id: sectionId, entries } });
          toast('تم حفظ الجدول');
        } catch (err) { toast(err.message, true); }
      });
    }
  });
}

// ===================================================================
// لوحة الطالب
// ===================================================================
async function renderStudentDash() {
  const u = state.user;
  document.getElementById('student-userbox').innerHTML = `<b>${u.name}</b>الصف ${u.grade}`;
  state.myPresidentSections = new Set();
  try {
    const sections = await api(`/api/sections?school_id=${u.school_id}&grade=${u.grade}`);
    const mySection = sections.find(s => s.id === u.section_id);
    if (mySection) {
      state.myPresidentSections = new Set(sections.filter(s => s.president_id === u.id).map(s => s.id));
      const presTag = mySection.president_id === u.id ? ' — 🎖️ رئيس الصف' : '';
      document.getElementById('student-userbox').innerHTML = `<b>${u.name}</b>الصف ${u.grade} — شعبة ${mySection.name}${presTag}`;
    }
  } catch (e) {}

  renderStudentWarnings();
  renderClassChat('student-class-chat', u.section_id, false);
  renderGeneralChat('student-general-chat');
  renderFilesAndTimetable('student-files', u.section_id);

  const isPresident = state.myPresidentSections.has(u.section_id);
  renderStudentTimetable('student-timetable', u.section_id, isPresident);
  renderStudentNotes('student-notes');
  renderSettings('student-settings', [
    ['الصف', u.grade || '—'],
    ['رقم الشعبة', u.section_id || '—'],
    ['رئيس الصف', isPresident ? '✅ نعم' : '❌ لا'],
  ]);

  setupNav('student', (tab) => {
    clearPolling();
    if (tab === 'class-chat') renderClassChat('student-class-chat', u.section_id, false);
    if (tab === 'general-chat') renderGeneralChat('student-general-chat');
    if (tab === 'files') renderFilesAndTimetable('student-files', u.section_id);
    if (tab === 'timetable') renderStudentTimetable('student-timetable', u.section_id, state.myPresidentSections.has(u.section_id));
    if (tab === 'notes') renderStudentNotes('student-notes');
    if (tab === 'settings') renderSettings('student-settings', [
      ['الصف', u.grade || '—'],
      ['رقم الشعبة', u.section_id || '—'],
      ['رئيس الصف', state.myPresidentSections.has(u.section_id) ? '✅ نعم' : '❌ لا'],
    ]);
  });
}

function renderStudentTimetable(containerId, sectionId, canEdit) {
  if (!sectionId) {
    document.getElementById(containerId).innerHTML = `<h2>🗓️ جدول الحصص</h2><p class="pane-desc">لم يتم تعيينك لأي شعبة بعد.</p>`;
    return;
  }
  renderTimetableEditor(containerId, sectionId, canEdit);
}

async function renderStudentWarnings() {
  const box = document.getElementById('student-warnings');
  box.innerHTML = '';
  try {
    const warnings = await api('/api/my/warnings');
    if (!warnings.length) return;
    warnings.forEach(w => {
      const levelInfo = {
        warning: { icon: '⚠️', title: 'تحذير', cls: 'warning' },
        final_warning: { icon: '🚨', title: 'تحذير نهائي', cls: 'final' },
        expulsion: { icon: '🚫', title: 'تم طردك من المدرسة', cls: 'expulsion' },
      };
      const info = levelInfo[w.level] || levelInfo.warning;
      const overlay = el(`
        <div class="warning-overlay">
          <div class="warning-modal ${info.cls}">
            <div class="warning-icon">${info.icon}</div>
            <h2>${info.title}</h2>
            <p class="warning-reason">${escapeHtml(w.reason)}</p>
            <div class="warning-from">صادر عن: ${escapeHtml(w.issued_by_name)}</div>
            <button class="btn-primary warning-ack" style="margin-top:14px;padding:10px 32px;">أوافق</button>
          </div>
        </div>`);
      overlay.querySelector('.warning-ack').addEventListener('click', async () => {
        overlay.remove();
      });
      box.appendChild(overlay);
    });
    await api('/api/my/warnings/mark-seen', { method: 'POST' });
  } catch (e) {}
}

// ===================================================================
// لوحة المعلم
// ===================================================================
async function renderTeacherDash() {
  const u = state.user;
  document.getElementById('teacher-userbox').innerHTML = `<b>${u.name}</b>معلّم`;
  const sections = await api('/api/teacher/sections');
  const picker = document.getElementById('teacher-section-picker');
  if (!sections.length) { picker.innerHTML = `<option>لا يوجد شعب مسندة</option>`; return; }
  picker.innerHTML = sections.map(s => `<option value="${s.id}">الصف ${s.grade} — ${s.name} (${s.student_count || 0})</option>`).join('');
  state.teacherSection = sections[0];

  function refreshActivePane() {
    clearPolling();
    const tab = document.querySelector('#view-teacher .nav-item.active').dataset.tab;
    const sid = state.teacherSection.id;
    if (tab === 'class-chat') renderClassChat('teacher-class-chat', sid, true);
    if (tab === 'general-chat') renderGeneralChat('teacher-general-chat');
    if (tab === 'files') renderTeacherFiles(sid);
    if (tab === 'my-timetable') renderTeacherMyTimetable('teacher-my-timetable', sections);
    if (tab === 'president') renderTeacherPresident(sid);
    if (tab === 'settings') renderSettings('teacher-settings', [['الشعب المسندة', sections.map(s => `الصف ${s.grade} — ${s.name}`).join('، ')]]);
  }
  picker.addEventListener('change', () => { state.teacherSection = sections.find(s => s.id === Number(picker.value)); refreshActivePane(); });
  setupNav('teacher', () => refreshActivePane());
  refreshActivePane();
}

async function renderTeacherMyTimetable(containerId, sections) {
  const container = document.getElementById(containerId);
  container.innerHTML = `<h2>🗓️ جدولي الشخصي</h2><p class="pane-desc">حدّد حصصك الأسبوعية — اختر الشعبة والวادة لكل حصة.</p><div id="${containerId}-editor"></div>`;
  const existing = await api('/api/timetable/my');
  const existingMap = {};
  existing.forEach(e => { existingMap[`${e.day}-${e.period_number}`] = e; });

  let html = `<div class="timetable-pin" style="background:var(--sidebar-bg);"><h3>جدول حصصي الأسبوعي</h3><table class="tt"><thead><tr><th>الحصة</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>`;
  PERIODS.forEach(p => {
    html += `<tr><td style="font-weight:700;">${p}</td>`;
    DAYS.forEach(d => {
      const cur = existingMap[`${d}-${p}`];
      const sectionOptions = sections.map(s => `<option value="${s.id}" ${cur && cur.section_id == s.id ? 'selected' : ''}>الصف ${s.grade} — ${s.name}</option>`).join('');
      html += `<td><div class="tt-cell"><input type="text" class="tt-subject" data-day="${d}" data-period="${p}" data-orig-section="${cur ? cur.section_id : ''}" value="${cur ? escapeHtml(cur.subject) : ''}" placeholder="المادة" style="width:80px;padding:4px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#fff;font-size:11px;text-align:center;"><select class="tt-section" data-day="${d}" data-period="${p}" style="width:80px;padding:3px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#fff;font-size:10px;"><option value="">—</option>${sectionOptions}</select></div></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table></div>`;
  html += `<button class="btn-primary" id="${containerId}-save" style="width:fit-content;padding:10px 24px;margin-top:14px;">حفظ الجدول</button>`;
  document.getElementById(`${containerId}-editor`).innerHTML = html;

  document.getElementById(`${containerId}-save`).addEventListener('click', async () => {
    const entries = [];
    document.querySelectorAll(`#${containerId}-editor .tt-subject`).forEach(inp => {
      const day = inp.dataset.day;
      const period = Number(inp.dataset.period);
      const subject = inp.value.trim();
      const sectionSel = document.querySelector(`#${containerId}-editor .tt-section[data-day="${day}"][data-period="${period}"]`);
      const sectionId = sectionSel ? Number(sectionSel.value) : 0;
      if (subject || sectionId) {
        entries.push({ day, period_number: period, subject, section_id: sectionId || 0 });
      }
    });
    try {
      await api('/api/timetable', { method: 'POST', body: { section_id: 0, entries, teacher_timetable: true } });
      toast('تم حفظ جدولك');
    } catch (err) { toast(err.message, true); }
  });
}
async function renderTeacherPresident(sectionId) {
  const container = document.getElementById('teacher-president');
  container.innerHTML = `<h2>🎖️ رئيس الصف</h2><p class="pane-desc">عيّن رئيساً للشعبة — يمنحه صلاحية حذف الرسائل المسيئة وتعديل جدول الحصص.</p><div id="pres-body">جارِ التحميل...</div>`;
  try {
    const [students, section] = await Promise.all([
      api(`/api/sections/${sectionId}/students`),
      api(`/api/sections?school_id=${state.user.school_id}`).then(list => list.find(s => s.id === sectionId)),
    ]);
    const body = document.getElementById('pres-body');
    if (!students.length) { body.innerHTML = `<p class="pane-desc">لا يوجد طلاب بعد.</p>`; return; }
    body.innerHTML = `
      <div class="row" style="align-items:flex-end;">
        <label style="flex:1">اختر الطالب<select id="pres-select">
          <option value="">— بدون رئيس —</option>
          ${students.map(s => `<option value="${s.id}" ${section && section.president_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select></label>
        <button class="btn-primary" id="pres-save" style="width:fit-content;padding:10px 20px;">حفظ</button>
      </div>
      ${section && section.president_id ? `<div style="margin-top:14px;padding:12px;background:var(--green-light);border-radius:10px;font-size:13px;color:var(--green-dark);">🎖️ رئيس الصف الحالي يمكنه: حذف الرسائل المسيئة في دردشة الصف + تعديل جدول الحصص</div>` : ''}`;
    document.getElementById('pres-save').addEventListener('click', async () => {
      const studentId = document.getElementById('pres-select').value || null;
      try { await api(`/api/sections/${sectionId}/president`, { method: 'POST', body: { student_id: studentId } }); toast('تم التحديث'); renderTeacherPresident(sectionId); } catch (err) { toast(err.message, true); }
    });
  } catch (err) { document.getElementById('pres-body').innerHTML = `<p class="pane-desc">${err.message}</p>`; }
}

async function renderTeacherFiles(sectionId) {
  const container = document.getElementById('teacher-files');
  container.innerHTML = `
    <h2>📂 الملفات والواجبات</h2><p class="pane-desc">ارفع الملفات لهذه الشعبة.</p>
    <div class="upload-box">
      <label>العنوان<input type="text" id="up-title" placeholder="عنوان الملف"></label>
      <label>النوع<select id="up-category"><option value="worksheet">ورقة عمل</option><option value="assignment">واجب</option><option value="exam">امتحان</option></select></label>
      <label>الملف<input type="file" id="up-file"></label>
      <button class="btn-primary" id="up-btn" style="width:fit-content;padding:10px 20px;">رفع</button>
    </div>
    <div id="files-list" class="files-grid"></div>`;
  document.getElementById('up-btn').addEventListener('click', async () => {
    const title = document.getElementById('up-title').value.trim();
    const category = document.getElementById('up-category').value;
    const fileInput = document.getElementById('up-file');
    if (!title || !fileInput.files[0]) { toast('اختر ملف واكتب عنوان', true); return; }
    const file = fileInput.files[0];
    const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
    try {
      await api('/api/files', { method: 'POST', body: { title, category, filename: file.name, mime: file.type, base64, section_id: sectionId } });
      toast('تم الرفع'); loadFilesList(sectionId, true);
      document.getElementById('up-title').value = ''; fileInput.value = '';
    } catch (err) { toast(err.message, true); }
  });
  loadFilesList(sectionId, true);
}

const CATEGORY_LABEL = { worksheet: 'ورقة عمل', assignment: 'واجب', exam: 'امتحان' };

async function loadFilesList(sectionId, canManage) {
  const list = document.getElementById('files-list');
  try {
    const files = await api(`/api/files?section_id=${sectionId}`);
    list.innerHTML = files.length ? files.map(f => `
      <div class="file-card">
        ${canManage ? `<button class="fdel" onclick="deleteFile(event,${f.id},${sectionId})">✕</button>` : ''}
        <span class="fcat fcat-${f.category || 'worksheet'}">${CATEGORY_LABEL[f.category] || 'ورقة'}</span>
        <div class="fname">📄 ${escapeHtml(f.title)}</div>
        <div class="fmeta">${escapeHtml(f.filename)} · ${escapeHtml(f.uploader_name)}</div>
        <a href="#" onclick="return downloadFile(event,${f.id})">تحميل ⬇</a>
      </div>`).join('') : `<p class="pane-desc">لا توجد ملفات.</p>`;
  } catch (err) { toast(err.message, true); }
}

async function deleteFile(evt, id, sectionId) {
  evt.preventDefault();
  if (!confirm('حذف الملف؟')) return;
  try { await api(`/api/files/${id}`, { method: 'DELETE' }); toast('تم الحذف'); loadFilesList(sectionId, true); } catch (err) { toast(err.message, true); }
}

async function downloadFile(evt, id) {
  evt.preventDefault();
  try {
    const res = await fetch(`/api/files/${id}/download`, { headers: { Authorization: 'Bearer ' + state.token } });
    if (!res.ok) throw new Error('تعذر التحميل');
    const blob = await res.blob();
    const match = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/);
    const filename = match ? decodeURIComponent(match[1]) : 'file';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { toast(err.message, true); }
  return false;
}

// ===================================================================
// دردشة الصف / العامة
// ===================================================================
async function renderClassChat(containerId, sectionId, canPin) {
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <h2>💬 دردشة الصف</h2><p class="pane-desc">خاصة بشعبتك فقط.</p>
    <div id="${containerId}-pinned"></div>
    <div class="chat-box">
      <div class="chat-messages" id="${containerId}-msgs"></div>
      <div id="${containerId}-typing"></div>
      <div class="chat-input-row">
        <label class="chat-img-btn" title="إرفاق صورة">📷<input type="file" accept="image/*" id="${containerId}-img" class="hidden-file"></label>
        <input type="text" id="${containerId}-input" placeholder="اكتب رسالتك...">
        <button id="${containerId}-send">إرسال</button>
      </div>
      <div id="${containerId}-img-preview" class="chat-img-preview hidden"></div>
    </div>`;
  setupChatImgPreview(containerId);
  await pollChat(containerId, 'class', sectionId, false, canPin);
  await loadPinned(containerId, sectionId, canPin);
  document.getElementById(`${containerId}-send`).addEventListener('click', () => sendChat(containerId, 'class', sectionId));
  document.getElementById(`${containerId}-input`).addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(containerId, 'class', sectionId); });
  setupTypingOnInput(`${containerId}-input`, 'class', sectionId);
  state.pollTimers.push(setInterval(() => pollChat(containerId, 'class', sectionId, true, canPin), 3000));
  state.pollTimers.push(setInterval(() => loadPinned(containerId, sectionId, canPin), 5000));
  state.pollTimers.push(setInterval(async () => { renderTypingBar(await fetchTypingUsers('class', sectionId), `${containerId}-typing`); }, 2000));
}

async function loadPinned(containerId, sectionId, canPin) {
  const box = document.getElementById(`${containerId}-pinned`);
  if (!box) return;
  try {
    const msg = await api(`/api/chat/pinned?section_id=${sectionId}`);
    if (!msg) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="pinned-msg"><div><span class="pin-label">📌 مثبّت — ${escapeHtml(msg.sender_name)}</span>${escapeHtml(msg.content)}</div>${canPin ? `<button class="pin-unpin" onclick="pinMessage(${msg.id},false,'${containerId}',${sectionId})">إلغاء التثبيت</button>` : ''}</div>`;
  } catch (e) { box.innerHTML = ''; }
}

async function pinMessage(id, pinned, containerId, sectionId) {
  try { await api(`/api/chat/${id}/pin`, { method: 'POST', body: { pinned } }); loadPinned(containerId, sectionId, true); } catch (err) { toast(err.message, true); }
}

async function renderGeneralChat(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <h2>📣 الدردشة العامة</h2><p class="pane-desc">كل المدرسة.</p>
    <div class="chat-box">
      <div class="chat-messages" id="${containerId}-msgs"></div>
      <div id="${containerId}-typing"></div>
      <div class="chat-input-row">
        <label class="chat-img-btn" title="إرفاق صورة">📷<input type="file" accept="image/*" id="${containerId}-img" class="hidden-file"></label>
        <input type="text" id="${containerId}-input" placeholder="اكتب رسالتك...">
        <button id="${containerId}-send">إرسال</button>
      </div>
      <div id="${containerId}-img-preview" class="chat-img-preview hidden"></div>
    </div>`;
  setupChatImgPreview(containerId);
  await pollChat(containerId, 'general', null);
  document.getElementById(`${containerId}-send`).addEventListener('click', () => sendChat(containerId, 'general', null));
  document.getElementById(`${containerId}-input`).addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(containerId, 'general', null); });
  setupTypingOnInput(`${containerId}-input`, 'general');
  state.pollTimers.push(setInterval(() => pollChat(containerId, 'general', null, true), 3000));
  state.pollTimers.push(setInterval(async () => { renderTypingBar(await fetchTypingUsers('general'), `${containerId}-typing`); }, 2000));
}

let lastMsgId = {};
async function pollChat(containerId, type, sectionId, isPolling = false, canPin = false) {
  const msgsBox = document.getElementById(`${containerId}-msgs`);
  if (!msgsBox) return;
  let url = `/api/chat?type=${type}&after_id=0`;
  if (type === 'class') url += `&section_id=${sectionId}`;
  try {
    const msgs = await api(url);
    const seenIds = new Set();
    msgs.forEach(m => {
      lastMsgId[containerId] = m.id;
      seenIds.add(String(m.id));
      const mine = m.sender_id === state.user.id;
      const canDelete = canDeleteMessage(m);
      const canEdit = canEditMessage(m);
      const canPinThis = canPin && type === 'class' && !m.deleted && !m.pinned;
      const bubble = el(`
        <div class="msg ${mine ? 'mine' : 'theirs'} role-${m.sender_role} ${m.deleted ? 'deleted' : ''}" data-id="${m.id}">
          <div class="meta">
            ${canDelete ? `<button class="msg-del" onclick="deleteMessage(${m.id})">🗑</button>` : ''}
            ${canEdit ? `<button class="msg-edit" onclick="startEditMessage(${m.id})">✎</button>` : ''}
            ${canPinThis ? `<button class="msg-pin" onclick="pinMessage(${m.id},true,'${containerId}',${sectionId})">📌</button>` : ''}
            <span>${escapeHtml(m.sender_name)}</span>
            ${!mine ? `<span style="opacity:.5;">· ${roleLabel(m.sender_role)}</span>` : ''}
          </div>
          ${m.image ? `<img class="msg-image" src="${m.image}" alt="صورة">` : ''}
          <div class="msg-content">${m.deleted ? 'تم الحذف' : (escapeHtml(m.content) + (m.edited ? ' <span class="edited-tag">(معدّلة)</span>' : ''))}</div>
        </div>`);
      const existing = msgsBox.querySelector(`[data-id="${m.id}"]`);
      if (existing) existing.replaceWith(bubble); else msgsBox.appendChild(bubble);
    });
    msgsBox.querySelectorAll('.msg').forEach(domMsg => {
      if (!seenIds.has(domMsg.dataset.id)) domMsg.remove();
    });
    if (msgs.length) msgsBox.scrollTop = msgsBox.scrollHeight;
  } catch (e) {}
}

function canDeleteMessage(m) {
  if (m.deleted) return false;
  if (m.sender_id === state.user.id) return true;
  if (state.user.role === 'admin') return true;
  if (state.user.role === 'teacher' && m.type === 'class') return true;
  if (state.user.role === 'student' && m.type === 'class' && state.myPresidentSections.has(m.section_id)) return true;
  return false;
}

function canEditMessage(m) { return !m.deleted && m.sender_id === state.user.id; }

async function deleteMessage(id) {
  if (!confirm('حذف الرسالة؟')) return;
  try { await api(`/api/chat/${id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
}

function startEditMessage(id) {
  const bubble = document.querySelector(`.msg[data-id="${id}"]`);
  if (!bubble) return;
  const contentDiv = bubble.querySelector('.msg-content');
  const currentText = contentDiv.textContent.replace(/\s*\(معدّلة\)\s*$/, '');
  const box = el(`<div class="msg-edit-box"><input type="text" value="${escapeAttr(currentText)}"><button class="btn-primary" style="padding:0 12px;">حفظ</button><button class="btn-ghost small">إلغاء</button></div>`);
  contentDiv.replaceWith(box);
  const input = box.querySelector('input'); input.focus();
  box.querySelectorAll('button')[1].addEventListener('click', () => cancelEdit(bubble, currentText));
  box.querySelectorAll('button')[0].addEventListener('click', () => saveEdit(bubble, id, input.value.trim()));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') saveEdit(bubble, id, input.value.trim()); if (e.key === 'Escape') cancelEdit(bubble, currentText); });
}

function cancelEdit(bubble, text) { const box = bubble.querySelector('.msg-edit-box'); if (box) box.replaceWith(el(`<div class="msg-content">${escapeHtml(text)}</div>`)); }

async function saveEdit(bubble, id, content) {
  if (!content) { toast('فارغة', true); return; }
  try {
    const updated = await api(`/api/chat/${id}`, { method: 'PATCH', body: { content } });
    const box = bubble.querySelector('.msg-edit-box');
    if (box) box.replaceWith(el(`<div class="msg-content">${escapeHtml(updated.content)} <span class="edited-tag">(معدّلة)</span></div>`));
  } catch (err) { toast(err.message, true); }
}

async function sendChat(containerId, type, sectionId) {
  const input = document.getElementById(`${containerId}-input`);
  const preview = document.getElementById(`${containerId}-img-preview`);
  const content = input.value.trim();
  let imageData = null;
  if (preview && preview.dataset.src) imageData = preview.dataset.src;
  if (!content && !imageData) return;
  input.value = '';
  if (preview) { preview.innerHTML = ''; preview.dataset.src = ''; preview.classList.add('hidden'); }
  try { await api('/api/chat', { method: 'POST', body: { type, content: content || '', section_id: sectionId, image: imageData } }); pollChat(containerId, type, sectionId, false); } catch (err) { toast(err.message, true); }
}

function setupChatImgPreview(containerId) {
  const fileInput = document.getElementById(`${containerId}-img`);
  const preview = document.getElementById(`${containerId}-img-preview`);
  if (!fileInput || !preview) return;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('الصورة كبيرة جداً (الحد 2 ميجا)', true); fileInput.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      preview.innerHTML = `<img src="${reader.result}" style="max-height:100px;border-radius:8px;"><button class="remove-img" style="background:none;color:red;border:none;font-size:18px;cursor:pointer;margin-right:8px;">✕</button>`;
      preview.dataset.src = reader.result;
      preview.classList.remove('hidden');
      preview.querySelector('.remove-img').addEventListener('click', () => { preview.innerHTML = ''; preview.dataset.src = ''; preview.classList.add('hidden'); fileInput.value = ''; });
    };
    reader.readAsDataURL(file);
  });
}

// ===================================================================
// ملفات الطالب (للعرض)
// ===================================================================
async function renderFilesAndTimetable(containerId, sectionId) {
  const container = document.getElementById(containerId);
  if (!sectionId) { container.innerHTML = `<h2>📂 ملفاتي</h2><p class="pane-desc">لم يتم تعيينك لأي شعبة.</p>`; return; }
  container.innerHTML = `<h2>📂 ملفاتي</h2><p class="pane-desc">الملفات المتوفرة بشعبتك.</p>
    <div class="search-row"><input type="text" id="${containerId}-search" placeholder="🔎 بحث بالعنوان..."></div>
    <div id="${containerId}-files" class="files-grid"></div>`;
  try {
    const files = await api(`/api/files?section_id=${sectionId}`);
    function renderCards(list) {
      document.getElementById(`${containerId}-files`).innerHTML = list.length ? list.map(f => `
        <div class="file-card">
          <span class="fcat fcat-${f.category || 'worksheet'}">${CATEGORY_LABEL[f.category] || 'ورقة'}</span>
          <div class="fname">📄 ${escapeHtml(f.title)}</div>
          <div class="fmeta">${escapeHtml(f.filename)} · ${escapeHtml(f.uploader_name)}</div>
          <a href="#" onclick="return downloadFile(event,${f.id})">تحميل ⬇</a>
        </div>`).join('') : `<p class="pane-desc">لا توجد ملفات.</p>`;
    }
    renderCards(files);
    const searchInput = document.getElementById(`${containerId}-search`);
    if (searchInput) searchInput.addEventListener('input', () => { const q = searchInput.value.trim().toLowerCase(); renderCards(q ? files.filter(f => f.title.toLowerCase().includes(q)) : files); });
  } catch (e) {}
}

// ===================================================================
// لوحة المدير
// ===================================================================
async function renderAdminDash() {
  const u = state.user;
  document.getElementById('admin-userbox').innerHTML = `<b>${u.name}</b>مدير المدرسة`;
  renderAdminCodes(); renderAdminPeople();
  renderGeneralChat('admin-general-chat');
  renderSettings('admin-settings', [['المدرسة', u.school_id || '—']]);

  setupNav('admin', (tab) => {
    clearPolling();
    if (tab === 'codes') renderAdminCodes();
    if (tab === 'people') renderAdminPeople();
    if (tab === 'sections') renderAdminSections();
    if (tab === 'log') renderAdminLog();
    if (tab === 'reports') renderAdminReports();
    if (tab === 'stats') renderAdminStats();
    if (tab === 'general-chat') renderGeneralChat('admin-general-chat');
    if (tab === 'settings') renderSettings('admin-settings', [['المدرسة', u.school_id || '—']]);
  });
}

async function renderAdminCodes() {
  const container = document.getElementById('admin-codes');
  try {
    const d = await api('/api/school/codes');
    container.innerHTML = `<h2>🔑 أكواد المدرسة</h2><p class="pane-desc">شارك هذه الأكواد مع المعلمين والمدراء الجدد في ${escapeHtml(d.school_name)}.</p>
      <div class="code-card"><span class="code-label">كود المعلم</span><span class="code-value">${d.teacher_code}</span></div>
      <div class="code-card"><span class="code-label">كود المدير</span><span class="code-value">${d.admin_code}</span></div>
      <div class="upload-box"><label>اسم المدرسة<input type="text" id="school-name-input" value="${escapeHtml(d.school_name)}"></label>
      <button class="btn-primary" id="school-name-save" style="width:fit-content;padding:10px 20px;">حفظ</button></div>`;
    document.getElementById('school-name-save').addEventListener('click', async () => {
      const name = document.getElementById('school-name-input').value.trim();
      if (!name) { toast('اكتب اسماً', true); return; }
      try { await api(`/api/schools/${d.school_id}/rename`, { method: 'POST', body: { name } }); toast('تم التحديث'); } catch (err) { toast(err.message, true); }
    });
  } catch (err) { container.innerHTML = `<p>${err.message}</p>`; }
}

let adminPeopleRows = [];
async function renderAdminPeople() {
  const container = document.getElementById('admin-people');
  try {
    const rows = await api('/api/admin/users');
    adminPeopleRows = rows;
    container.innerHTML = `
      <h2>👥 المعلمون والطلاب</h2><p class="pane-desc">${rows.length} مستخدم.</p>
      <button class="btn-ghost small" id="export-csv-btn" style="margin-bottom:12px;">⬇ تصدير CSV</button>
      <table class="simple">
        <thead><tr><th>الاسم</th><th>الدور</th><th>البريد</th><th>الصف/الشعبة</th><th>الحالة</th><th>إجراء</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${roleLabel(r.role)}</td>
          <td>${escapeHtml(r.email)}</td>
          <td>${r.grade ? `${r.grade} — ${escapeHtml(r.section_name || '')}` : '—'}</td>
          <td><span class="status-pill ${r.status === 'expelled' ? 'status-expelled' : 'status-active'}">${r.status === 'expelled' ? 'مطرود' : 'نشط'}</span></td>
          <td class="actions">
            ${r.role === 'student' ? `<button class="btn-ghost small" onclick="openDisciplineModal(${r.id},'${escapeAttr(r.name)}')">تأديب</button>` : ''}
            ${r.role === 'student' ? `<button class="btn-ghost small" onclick="openMoveSectionModal(${r.id},'${escapeAttr(r.name)}')">نقل</button>` : ''}
            ${r.role === 'student' && r.status === 'expelled' ? `<button class="btn-ghost small" onclick="reinstateStudent(${r.id})">إلغاء الطرد</button>` : ''}
            ${r.role === 'teacher' ? `<button class="btn-danger small" onclick="deleteUser(${r.id},'${escapeAttr(r.name)}')">حذف</button>` : ''}
          </td></tr>`).join('')}</tbody></table>`;
    document.getElementById('export-csv-btn').addEventListener('click', () => {
      const csvRows = [['الاسم', 'الدور', 'البريد', 'الصف', 'الشعبة', 'الحالة'].join(',')];
      rows.forEach(r => { csvRows.push([r.name, r.role === 'student' ? 'طالب' : 'معلم', r.email, r.grade || '', r.section_name || '', r.status === 'expelled' ? 'مطرود' : 'نشط'].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')); });
      const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'المستخدمين.csv'; a.click();
    });
  } catch (err) { container.innerHTML = `<p>${err.message}</p>`; }
}

async function deleteUser(id, name) {
  if (!confirm(`حذف "${name}" نهائياً؟`)) return;
  try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); toast('تم الحذف'); renderAdminPeople(); } catch (err) { toast(err.message, true); }
}

async function reinstateStudent(id) {
  if (!confirm('إعادة تفعيل الحساب؟')) return;
  try { await api(`/api/admin/users/${id}/reinstate`, { method: 'POST' }); toast('تم'); renderAdminPeople(); } catch (err) { toast(err.message, true); }
}

async function openMoveSectionModal(studentId, studentName) {
  const student = adminPeopleRows.find(r => r.id === studentId);
  let sections = [];
  try { sections = await api(`/api/sections?school_id=${state.user.school_id}`); } catch (e) {}
  const overlay = el(`<div class="modal-overlay"><div class="modal-box"><h3>نقل — ${escapeHtml(studentName)}</h3><div class="stack"><label>الشعبة<select id="move-sel">${sections.map(s => `<option value="${s.id}" ${student && student.section_id === s.id ? 'selected' : ''}>الصف ${s.grade} — ${escapeHtml(s.name)}</option>`).join('')}</select></label></div><div class="modal-actions"><button class="btn-ghost" onclick="this.closest('.modal-overlay').remove()">إلغاء</button><button class="btn-primary" id="move-go">نقل</button></div></div></div>`);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#move-go').addEventListener('click', async () => {
    try { await api(`/api/admin/users/${studentId}/section`, { method: 'POST', body: { section_id: Number(overlay.querySelector('#move-sel').value) } }); toast('تم النقل'); overlay.remove(); renderAdminPeople(); } catch (err) { toast(err.message, true); }
  });
}

function openDisciplineModal(studentId, studentName) {
  const overlay = el(`<div class="modal-overlay"><div class="modal-box"><h3>إجراء تأديبي — ${escapeHtml(studentName)}</h3><div class="stack">
    <label>النوع<select id="disc-level"><option value="warning">تحذير</option><option value="final_warning">تحذير نهائي</option><option value="expulsion">طرد</option></select></label>
    <label>السبب<textarea id="disc-reason" rows="3" style="padding:10px;border-radius:8px;border:1px solid var(--line);font-family:inherit;"></textarea></label>
  </div><div class="modal-actions"><button class="btn-ghost" onclick="this.closest('.modal-overlay').remove()">إلغاء</button><button class="btn-danger" id="disc-go">تنفيذ</button></div></div></div>`);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#disc-go').addEventListener('click', async () => {
    const level = overlay.querySelector('#disc-level').value;
    const reason = overlay.querySelector('#disc-reason').value.trim();
    if (!reason) { toast('اكتب السبب', true); return; }
    if (level === 'expulsion' && !confirm('هل أنت متأكد من الطرد؟')) return;
    try { await api('/api/admin/warnings', { method: 'POST', body: { student_id: studentId, level, reason } }); toast('تم'); overlay.remove(); renderAdminPeople(); } catch (err) { toast(err.message, true); }
  });
}

async function renderAdminSections() {
  const container = document.getElementById('admin-sections');
  container.innerHTML = `<h2>📍 الصفوف والشعب</h2><p class="pane-desc">أضف شعب جديدة.</p>
    <div class="upload-box"><div class="row">
      <label>الصف (4-10)<input type="number" id="new-sec-grade" min="4" max="10"></label>
      <label>الشعبة<input type="text" id="new-sec-name"></label>
    </div><button class="btn-primary" id="new-sec-btn" style="width:fit-content;padding:10px 20px;">إضافة</button></div>
    <div id="sections-body">جارِ التحميل...</div>`;
  document.getElementById('new-sec-btn').addEventListener('click', async () => {
    const grade = Number(document.getElementById('new-sec-grade').value);
    const name = document.getElementById('new-sec-name').value.trim();
    if (!grade || !name) { toast('اكتب الصف والشعبة', true); return; }
    try { await api('/api/sections', { method: 'POST', body: { grade, name } }); toast('تمت الإضافة'); document.getElementById('new-sec-grade').value = ''; document.getElementById('new-sec-name').value = ''; loadAdminSectionsList(); } catch (err) { toast(err.message, true); }
  });
  loadAdminSectionsList();
}

async function loadAdminSectionsList() {
  const body = document.getElementById('sections-body');
  try {
    const sections = await api(`/api/sections?school_id=${state.user.school_id}`);
    if (!sections.length) { body.innerHTML = `<p class="pane-desc">لا توجد شعب.</p>`; return; }
    body.innerHTML = `<table class="simple"><thead><tr><th>الصف</th><th>الشعبة</th><th>إجراء</th></tr></thead><tbody>${sections.map(s => `
      <tr><td><input type="number" min="4" max="10" value="${s.grade}" id="sec-g-${s.id}" style="width:60px;padding:5px;border-radius:6px;border:1px solid var(--line);"></td>
      <td><input type="text" value="${escapeHtml(s.name)}" id="sec-n-${s.id}" style="width:80px;padding:5px;border-radius:6px;border:1px solid var(--line);"></td>
      <td class="actions"><button class="btn-ghost small" onclick="saveSection(${s.id})">حفظ</button><button class="btn-danger small" onclick="deleteSection(${s.id})">حذف</button></td></tr>`).join('')}</tbody></table>`;
  } catch (err) { body.innerHTML = `<p>${err.message}</p>`; }
}

async function saveSection(id) {
  try { await api(`/api/sections/${id}`, { method: 'PATCH', body: { grade: Number(document.getElementById(`sec-g-${id}`).value), name: document.getElementById(`sec-n-${id}`).value.trim() } }); toast('تم'); loadAdminSectionsList(); } catch (err) { toast(err.message, true); }
}

async function deleteSection(id) {
  if (!confirm('حذف الشعبة؟ (يجب أن تكون فارغة)')) return;
  try { await api(`/api/sections/${id}`, { method: 'DELETE' }); toast('تم'); loadAdminSectionsList(); } catch (err) { toast(err.message, true); }
}

const WARNING_LEVEL_LABEL = { warning: 'تحذير', final_warning: 'تحذير نهائي', expulsion: 'طرد' };

async function renderAdminLog() {
  const container = document.getElementById('admin-log');
  container.innerHTML = `<h2>📋 السجل التأديبي</h2><div id="log-body">جارِ التحميل...</div>`;
  try {
    const rows = await api('/api/admin/warnings/all');
    const body = document.getElementById('log-body');
    if (!rows.length) { body.innerHTML = `<p class="pane-desc">لا يوجد سجل.</p>`; return; }
    body.innerHTML = `<table class="simple"><thead><tr><th>الطالب</th><th>الصف/الشعبة</th><th>النوع</th><th>السبب</th><th>صادر عن</th><th>التاريخ</th></tr></thead><tbody>${rows.map(w => `
      <tr><td>${escapeHtml(w.student_name)}</td><td>${w.grade ? `${w.grade} — ${escapeHtml(w.section_name || '')}` : '—'}</td>
      <td><span class="status-pill ${w.level === 'expulsion' ? 'status-expelled' : 'status-active'}">${WARNING_LEVEL_LABEL[w.level] || w.level}</span></td>
      <td>${escapeHtml(w.reason)}</td><td>${escapeHtml(w.issued_by_name)}</td><td>${escapeHtml(w.created_at)}</td></tr>`).join('')}</tbody></table>`;
  } catch (err) { document.getElementById('log-body').innerHTML = `<p>${err.message}</p>`; }
}

async function renderAdminStats() {
  const container = document.getElementById('admin-stats');
  container.innerHTML = `<h2>📊 الإحصائيات</h2><div id="stats-body">جارِ التحميل...</div>`;
  try {
    const s = await api('/api/admin/stats');
    document.getElementById('stats-body').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val">${s.students}</div><div class="stat-label">طلاب</div></div>
        <div class="stat-card"><div class="stat-val">${s.teachers}</div><div class="stat-label">معلمون</div></div>
        <div class="stat-card"><div class="stat-val">${s.sections}</div><div class="stat-label">شعب</div></div>
        <div class="stat-card"><div class="stat-val">${s.expelled}</div><div class="stat-label">مطرودون</div></div>
      </div>
      <h3 style="font-size:15px;margin-bottom:10px;">الطلاب لكل صف</h3>
      ${s.by_grade.length ? `<table class="simple"><thead><tr><th>الصف</th><th>عدد</th></tr></thead><tbody>${s.by_grade.map(g => `<tr><td>الصف ${g.grade}</td><td>${g.c}</td></tr>`).join('')}</tbody></table>` : `<p class="pane-desc">لا يوجد طلاب.</p>`}`;
  } catch (err) { document.getElementById('stats-body').innerHTML = `<p>${err.message}</p>`; }
}

// ===================================================================
// لوحة البلاغات والشكاوى (المدير)
// ===================================================================
const REPORT_STATUS = { pending: '⏳ قيد المراجعة', reviewed: '👀 تمت المراجعة', resolved: '✅ تم الحل' };
const REPORT_TYPE = { complaint: 'شكوى', report: 'بلاغ' };

async function renderAdminReports() {
  const container = document.getElementById('admin-reports');
  container.innerHTML = `<h2>📨 البلاغات والشكاوى</h2><p class="pane-desc">بلاغات وشكاوى الطلاب.</p><div id="reports-body">جارِ التحميل...</div>`;
  try {
    const rows = await api('/api/admin/reports');
    const body = document.getElementById('reports-body');
    if (!rows.length) { body.innerHTML = `<p class="pane-desc">لا توجد بلاغات بعد.</p>`; return; }
    body.innerHTML = rows.map(r => `
      <div class="report-card ${r.status}">
        <div class="report-header">
          <span class="report-type ${r.type}">${REPORT_TYPE[r.type] || r.type}</span>
          <span class="report-status status-pill status-${r.status === 'resolved' ? 'active' : 'expelled'}">${REPORT_STATUS[r.status]}</span>
        </div>
        <h4>${escapeHtml(r.title)}</h4>
        <p class="report-content">${escapeHtml(r.content)}</p>
        <div class="report-meta">
          <span>👤 ${escapeHtml(r.student_name)} — الصف ${r.grade || '—'} شعبة ${escapeHtml(r.section_name || '—')}</span>
          <span>📅 ${escapeHtml(r.created_at)}</span>
        </div>
        ${r.admin_reply ? `<div class="report-reply"><b>رد المدير:</b> ${escapeHtml(r.admin_reply)}</div>` : ''}
        <div class="report-actions">
          <select id="rep-status-${r.id}" class="report-status-select">
            <option value="pending" ${r.status === 'pending' ? 'selected' : ''}>قيد المراجعة</option>
            <option value="reviewed" ${r.status === 'reviewed' ? 'selected' : ''}>تمت المراجعة</option>
            <option value="resolved" ${r.status === 'resolved' ? 'selected' : ''}>تم الحل</option>
          </select>
          <input type="text" id="rep-reply-${r.id}" placeholder="رد المدير..." value="${escapeAttr(r.admin_reply || '')}" class="report-reply-input">
          <button class="btn-primary small" onclick="saveReportReply(${r.id})" style="padding:6px 16px;font-size:12px;">حفظ</button>
        </div>
      </div>`).join('');
  } catch (err) { document.getElementById('reports-body').innerHTML = `<p>${err.message}</p>`; }
}

async function saveReportReply(id) {
  const status = document.getElementById(`rep-status-${id}`).value;
  const admin_reply = document.getElementById(`rep-reply-${id}`).value.trim();
  try { await api(`/api/admin/reports/${id}`, { method: 'PATCH', body: { status, admin_reply } }); toast('تم الحفظ'); renderAdminReports(); } catch (err) { toast(err.message, true); }
}

// ===================================================================
// الدفتر الذكي — ملاحظات الطالب
// ===================================================================
const NOTE_COLORS = ['#D9FDD3', '#FFF3CD', '#D1ECF1', '#F8D7DA', '#E2D5F1', '#FDE8D0'];

async function renderStudentNotes(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <h2>📝 ملاحظاتي</h2><p class="pane-desc">دفترك الذكي — احفظ الملاحظات، الروابط، وأجزاء الدروس للرجوع إليها.</p>
    <div class="notes-new">
      <input type="text" id="note-title" placeholder="عنوان الملاحظة" class="note-input-title">
      <textarea id="note-content" placeholder="اكتب ملاحظتك هنا... يمكنك إضافة روابط، ملخصات دروس، أو أي ملاحظات للرجوع إليها قبل الامتحان." rows="4" class="note-input-content"></textarea>
      <div class="note-colors" id="note-colors"></div>
      <button class="btn-primary" id="note-save-btn" style="width:fit-content;padding:8px 20px;">إضافة ملاحظة</button>
    </div>
    <div id="notes-list" class="notes-grid"></div>`;

  const colorBar = document.getElementById('note-colors');
  let selectedColor = NOTE_COLORS[0];
  NOTE_COLORS.forEach(c => {
    const dot = el(`<span class="note-color-dot ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}"></span>`);
    dot.addEventListener('click', () => {
      colorBar.querySelectorAll('.note-color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      selectedColor = c;
    });
    colorBar.appendChild(dot);
  });

  document.getElementById('note-save-btn').addEventListener('click', async () => {
    const title = document.getElementById('note-title').value.trim();
    const content = document.getElementById('note-content').value.trim();
    if (!title) { toast('اكتب عنواناً', true); return; }
    try {
      await api('/api/notes', { method: 'POST', body: { title, content, color: selectedColor } });
      toast('تمت الإضافة');
      document.getElementById('note-title').value = '';
      document.getElementById('note-content').value = '';
      loadNotesList(containerId);
    } catch (err) { toast(err.message, true); }
  });
  loadNotesList(containerId);
}

async function loadNotesList(containerId) {
  const list = document.getElementById('notes-list');
  if (!list) return;
  try {
    const notes = await api('/api/notes');
    if (!notes.length) { list.innerHTML = `<p class="pane-desc">لا توجد ملاحظات بعد.</p>`; return; }
    list.innerHTML = notes.map(n => `
      <div class="note-card" style="border-right:4px solid ${n.color};background:${n.color}22;">
        ${n.pinned ? '<span class="note-pin-badge">📌</span>' : ''}
        <div class="note-card-header">
          <h4>${escapeHtml(n.title)}</h4>
          <div class="note-actions">
            <button class="btn-ghost small" onclick="togglePinNote(${n.id},${n.pinned})" title="تثبيت">${n.pinned ? '📌' : '📍'}</button>
            <button class="btn-ghost small" onclick="deleteNote(${n.id})" title="حذف">🗑</button>
          </div>
        </div>
        <div class="note-card-body">${escapeHtml(n.content).replace(/\n/g, '<br>')}</div>
        <div class="note-card-meta">${escapeHtml(n.updated_at)}</div>
      </div>`).join('');
  } catch (e) { list.innerHTML = `<p>تعذّر التحميل</p>`; }
}

async function togglePinNote(id, currentPinned) {
  try { await api(`/api/notes/${id}`, { method: 'PATCH', body: { pinned: !currentPinned } }); loadNotesList('student-notes'); } catch (err) { toast(err.message, true); }
}

async function deleteNote(id) {
  if (!confirm('حذف الملاحظة؟')) return;
  try { await api(`/api/notes/${id}`, { method: 'DELETE' }); toast('تم الحذف'); loadNotesList('student-notes'); } catch (err) { toast(err.message, true); }
}

// ===================================================================
// لوحة المطور
// ===================================================================
async function renderDeveloperDash() {
  const u = state.user;
  document.getElementById('developer-userbox').innerHTML = `<b>${u.name}</b>مطوّر النظام`;
  renderDeveloperSchools();
  renderSettings('developer-settings');
  setupNav('developer', (tab) => {
    clearPolling();
    if (tab === 'schools') renderDeveloperSchools();
    if (tab === 'overview') renderDeveloperOverview();
    if (tab === 'accounts') renderDeveloperAccounts();
    if (tab === 'security') renderDeveloperSecurity();
    if (tab === 'settings') renderSettings('developer-settings');
  });
}

async function renderDeveloperSchools() {
  const container = document.getElementById('developer-schools');
  container.innerHTML = `<h2>🏫 المدارس</h2><p class="pane-desc">أضف مدرسة جديدة.</p>
    <div class="upload-box"><label>الاسم<input type="text" id="new-school-name" placeholder="اسم المدرسة"></label>
    <button class="btn-primary" id="new-school-btn" style="width:fit-content;padding:10px 20px;">إنشاء</button></div>
    <div id="schools-list"></div>`;
  document.getElementById('new-school-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-school-name').value.trim();
    if (!name) { toast('اكتب الاسم', true); return; }
    try { await api('/api/schools', { method: 'POST', body: { name } }); toast('تم'); document.getElementById('new-school-name').value = ''; loadDevSchools(); } catch (err) { toast(err.message, true); }
  });
  loadDevSchools();
}

async function loadDevSchools() {
  const schools = await api('/api/schools/mine');
  document.getElementById('schools-list').innerHTML = schools.length ? `<table class="simple"><thead><tr><th>المدرسة</th><th>كود المعلم</th><th>كود المدير</th><th>إجراء</th></tr></thead><tbody>${schools.map(s => `
    <tr><td>${escapeHtml(s.name)}</td><td style="font-family:monospace">${s.teacher_code}</td><td style="font-family:monospace">${s.admin_code}</td>
    <td><button class="btn-danger small" onclick="deleteSchool(${s.id},'${escapeAttr(s.name)}')">حذف</button></td></tr>`).join('')}</tbody></table>` : `<p class="pane-desc">لا توجد مدارس.</p>`;
}

async function deleteSchool(id, name) {
  if (!confirm(`حذف "${name}" نهائياً؟`)) return;
  try { await api(`/api/schools/${id}`, { method: 'DELETE' }); toast('تم'); loadDevSchools(); } catch (err) { toast(err.message, true); }
}

async function renderDeveloperOverview() {
  const container = document.getElementById('developer-overview');
  container.innerHTML = `<h2>📊 نظرة شاملة</h2><div id="dev-overview-body">جارِ التحميل...</div>`;
  try {
    const [stats, users] = await Promise.all([api('/api/developer/platform-stats'), api('/api/developer/users')]);
    document.getElementById('dev-overview-body').innerHTML = `
      <div class="stats-grid">
        ${[['schools','مدارس'],['students','طلاب'],['teachers','معلمون'],['admins','مدراء'],['messages','رسائل'],['files','ملفات'],['sections','شعب']].map(([k,l]) => `
          <div class="stat-card"><div class="stat-val">${stats[k]}</div><div class="stat-label">${l}</div></div>`).join('')}
        <div class="stat-card"><div class="stat-val">${formatSize(stats.db_size)}</div><div class="stat-label">حجم DB</div></div>
      </div>
      <table class="simple"><thead><tr><th>الاسم</th><th>الدور</th><th>البريد</th><th>المدرسة</th><th>الحالة</th></tr></thead><tbody>${users.map(u => `
        <tr><td>${escapeHtml(u.name)}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.email)}</td><td>${u.school_name ? escapeHtml(u.school_name) : '—'}</td>
        <td><span class="status-pill ${u.status === 'expelled' ? 'status-expelled' : 'status-active'}">${u.status === 'expelled' ? 'مطرود' : 'نشط'}</span></td></tr>`).join('')}</tbody></table>`;
  } catch (err) { document.getElementById('dev-overview-body').innerHTML = `<p>${err.message}</p>`; }
}

function formatSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

async function renderDeveloperAccounts() {
  const container = document.getElementById('developer-accounts');
  container.innerHTML = `<h2>👤 حسابات المطورين</h2>
    <div class="upload-box"><label>الاسم<input type="text" id="new-dev-name"></label><label>الرمز<input type="text" id="new-dev-code"></label>
    <button class="btn-primary" id="new-dev-btn" style="width:fit-content;padding:10px 20px;">إضافة</button></div>
    <div id="dev-accounts-list"></div>`;
  document.getElementById('new-dev-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-dev-name').value.trim(), code = document.getElementById('new-dev-code').value.trim();
    if (!name || !code) { toast('اكتب الاسم والرمز', true); return; }
    try { await api('/api/developer/accounts', { method: 'POST', body: { name, code } }); toast('تم'); document.getElementById('new-dev-name').value = ''; document.getElementById('new-dev-code').value = ''; loadDevAccounts(); } catch (err) { toast(err.message, true); }
  });
  loadDevAccounts();
}

async function loadDevAccounts() {
  const accounts = await api('/api/developer/accounts');
  document.getElementById('dev-accounts-list').innerHTML = accounts.length ? `<table class="simple"><thead><tr><th>الاسم</th><th>التاريخ</th><th>إجراء</th></tr></thead><tbody>${accounts.map(a => `
    <tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.created_at || '')}</td>
    <td>${a.id === state.user.id ? '<span style="color:var(--ink-lighter)">أنت</span>' : `<button class="btn-danger small" onclick="deleteDevAccount(${a.id},'${escapeAttr(a.name)}')">حذف</button>`}</td></tr>`).join('')}</tbody></table>` : `<p class="pane-desc">لا توجد حسابات.</p>`;
}

async function deleteDevAccount(id, name) {
  if (!confirm(`حذف "${name}"؟`)) return;
  try { await api(`/api/developer/accounts/${id}`, { method: 'DELETE' }); toast('تم'); loadDevAccounts(); } catch (err) { toast(err.message, true); }
}

async function renderDeveloperSecurity() {
  const container = document.getElementById('developer-security');
  container.innerHTML = `<h2>🔐 النسخ الاحتياطية</h2>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="btn-primary" id="backup-create" style="width:fit-content;padding:10px 20px;">🔄 إنشاء نسخة</button>
      <button class="btn-ghost" id="backup-refresh" style="width:fit-content;padding:10px 20px;">🔄 تحديث</button>
    </div>
    <div id="backup-status"></div>
    <div id="backup-list">جارِ التحميل...</div>`;
  document.getElementById('backup-create').addEventListener('click', async () => {
    document.getElementById('backup-status').innerHTML = `<p class="pane-desc">جارِ الإنشاء...</p>`;
    try { const r = await api('/api/developer/backup', { method: 'POST' }); document.getElementById('backup-status').innerHTML = `<div style="padding:10px;background:var(--green-light);border-radius:10px;color:var(--green-dark);font-size:13px;margin-bottom:12px;">✓ تم — ${escapeHtml(r.filename)}</div>`; loadBackupList(); } catch (err) { document.getElementById('backup-status').innerHTML = `<div style="padding:10px;background:var(--red-light);border-radius:10px;color:#842029;font-size:13px;margin-bottom:12px;">✗ ${escapeHtml(err.message)}</div>`; }
  });
  document.getElementById('backup-refresh').addEventListener('click', loadBackupList);
  loadBackupList();
}

async function loadBackupList() {
  const list = document.getElementById('backup-list');
  if (!list) return;
  try {
    const backups = await api('/api/developer/backups');
    if (!backups.length) { list.innerHTML = `<p class="pane-desc">لا توجد نسخ.</p>`; return; }
    list.innerHTML = `<table class="simple"><thead><tr><th>الملف</th><th>الحجم</th><th>التاريخ</th><th>إجراء</th></tr></thead><tbody>${backups.map(b => `
      <tr><td style="font-family:monospace;font-size:11px">${escapeHtml(b.name)}</td><td>${formatSize(b.size)}</td><td>${new Date(b.created).toLocaleString('ar-JO')}</td>
      <td class="actions"><button class="btn-ghost small" onclick="downloadBackup('${escapeAttr(b.name)}')">⬇</button><button class="btn-danger small" onclick="deleteBackup('${escapeAttr(b.name)}')">🗑</button></td></tr>`).join('')}</tbody></table>`;
  } catch (e) { list.innerHTML = `<p>تعذّر</p>`; }
}

async function downloadBackup(filename) {
  try { const res = await fetch(`/api/developer/backup/download?file=${encodeURIComponent(filename)}`, { headers: { Authorization: 'Bearer ' + state.token } }); if (!res.ok) throw new Error(); const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); } catch (err) { toast('تعذّر التحميل', true); }
}

async function deleteBackup(filename) {
  if (!confirm(`حذف "${filename}"؟`)) return;
  try { await api(`/api/developer/backup/${encodeURIComponent(filename)}`, { method: 'DELETE' }); toast('تم'); loadBackupList(); } catch (err) { toast(err.message, true); }
}

// ===================================================================
// بدء التشغيل
// ===================================================================
(async function boot() {
  if (state.token) {
    try { const data = await api('/api/me'); state.user = data.user; routeToDashboard(); } catch (e) { localStorage.removeItem('token'); if (e.data && e.data.expelled) toast(e.message, true); }
  }
})();
