// Students, teachers, classes, sections, schedules.
import express from 'express';
import { exec, one, query, transaction } from '../db.js';
import { hashPassword } from '../auth.js';
import { DAYS, h, HttpError, int, nullableId, required, text } from '../util.js';
import type { SessionUser } from '../auth.js';

const r = express.Router();

function dupMessage(e: any, what: string): never {
  if (isUniqueViolation(e)) throw new HttpError(409, what);
  throw e;
}

// ---- Students ----
const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];
const MAX_STUDENT_IMPORT_ROWS = 2000;

function studentScope(user: SessionUser) {
  if (user.role === 'admin') return { sql: '', params: [] as unknown[] };
  if (user.role === 'teacher' && user.teacher_id) {
    return {
      sql: ' AND s.section_id IN (SELECT section_id FROM sections WHERE class_id IN (SELECT class_id FROM classes WHERE teacher_id=?))',
      params: [user.teacher_id],
    };
  }
  return { sql: ' AND 1=0', params: [] as unknown[] };
}

function canImport(user: SessionUser) {
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher' || !user.teacher_id) throw new HttpError(403, 'Only authorized teachers and administrators can import students.');
  return true;
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ER_DUP_ENTRY' || error.code === '23505';
}

async function importSections(user: SessionUser) {
  canImport(user);
  return user.role === 'admin'
    ? query<{ section_id: number; section_name: string }>('SELECT section_id, section_name FROM sections ORDER BY section_name')
    : query<{ section_id: number; section_name: string }>(
      `SELECT section_id, section_name FROM sections WHERE class_id IN
       (SELECT class_id FROM classes WHERE teacher_id=?) ORDER BY section_name`, [user.teacher_id]);
}

r.get('/students/import-options', h(async (req, res) => {
  res.json({ sections: await importSections(req.session.user!), yearLevels: YEAR_LEVELS, role: req.session.user!.role });
}));

type ImportStudent = {
  student_no: unknown; first_name: unknown; middle_name: unknown; last_name: unknown;
  course: unknown; year_level: unknown; gender: unknown; section_id: unknown; parent_email: unknown;
};
type ImportRowResult = { index: number; status: 'valid' | 'duplicate' | 'invalid' | 'imported' | 'failed'; errors: string[] };

function importRows(value: unknown): ImportStudent[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'Add at least one student record.');
  if (value.length > MAX_STUDENT_IMPORT_ROWS) throw new HttpError(400, `Import up to ${MAX_STUDENT_IMPORT_ROWS} students at a time.`);
  if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new HttpError(400, 'Every student record must be an object.');
  return value as ImportStudent[];
}

function cleanImportStudent(row: ImportStudent) {
  return {
    student_no: text(row.student_no, 30),
    first_name: text(row.first_name, 80),
    middle_name: text(row.middle_name, 80) || null,
    last_name: text(row.last_name, 80),
    course: text(row.course, 100),
    year_level: text(row.year_level, 30),
    gender: text(row.gender, 30),
    section_id: nullableId(row.section_id),
    parent_email: text(row.parent_email, 150) || null,
  };
}

async function validateImportRows(rows: ImportStudent[], user: SessionUser): Promise<ImportRowResult[]> {
  const sections = await importSections(user);
  const sectionIds = new Set(sections.map(s => Number(s.section_id)));
  const cleaned = rows.map(cleanImportStudent);
  const idCounts = new Map<string, number>();
  const rawIds = rows.map(row => typeof row.student_no === 'string' ? row.student_no.trim() : '');
  for (const id of rawIds) {
    const key = id.toLowerCase();
    if (key && key.length <= 30) idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  const ids = [...idCounts.keys()].filter(id => id.length <= 30);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    if (batch.length) {
      const found = await query<{ student_no: string }>(
        `SELECT student_no FROM students WHERE LOWER(student_no) IN (${batch.map(() => '?').join(',')})`,
        batch,
      );
      found.forEach(s => existing.add(s.student_no.toLowerCase()));
    }
  }

  return cleaned.map((row, index) => {
    const errors: string[] = [];
    const limits: [keyof ImportStudent, number][] = [
      ['student_no', 30], ['first_name', 80], ['middle_name', 80], ['last_name', 80],
      ['course', 100], ['year_level', 30], ['gender', 6], ['parent_email', 150],
    ];
    for (const [field, limit] of limits) {
      const value = rows[index][field];
      if (value !== null && value !== undefined && typeof value !== 'string') errors.push(`${field.replace(/_/g, ' ')} must be text.`);
      else if (typeof value === 'string' && value.trim().length > limit) errors.push(`${field.replace(/_/g, ' ')} must be ${limit} characters or fewer.`);
    }
    const rawSection = rows[index].section_id;
    if (rawSection !== null && rawSection !== undefined && String(rawSection).trim() !== '' &&
        !/^\d+$/.test(String(rawSection).trim())) errors.push('Section assignment is invalid.');
    if (!row.student_no) errors.push('Student ID is required.');
    if (!row.first_name) errors.push('First name is required.');
    if (!row.last_name) errors.push('Last name is required.');
    if (!row.course) errors.push('Course is required.');
    if (!YEAR_LEVELS.includes(row.year_level)) errors.push('Year level must be 1st Year through 5th Year.');
    if (row.gender && !['Male', 'Female', 'Other'].includes(row.gender)) errors.push('Gender must be Male, Female, or Other.');
    if (row.parent_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.parent_email)) errors.push('Parent email is invalid.');
    if (user.role === 'teacher' && row.section_id === null) errors.push('A section assigned to you is required.');
    if (row.section_id !== null && (!Number.isInteger(row.section_id) || !sectionIds.has(row.section_id))) {
      errors.push('Section is not available to your account.');
    }
    const id = rawIds[index].toLowerCase();
    const duplicate = id.length > 0 && id.length <= 30 &&
      ((idCounts.get(id) ?? 0) > 1 || existing.has(id));
    if (duplicate) errors.push('Student ID already exists or is repeated in this file.');
    if (duplicate) {
      return { index, status: 'duplicate', errors };
    }
    return { index, status: errors.length ? 'invalid' : 'valid', errors };
  });
}

r.post('/students/import/validate', h(async (req, res) => {
  const rows = importRows(req.body?.students);
  res.json({ rows: await validateImportRows(rows, req.session.user!) });
}));

r.post('/students/import', h(async (req, res) => {
  const rows = importRows(req.body?.students);
  const checks = await validateImportRows(rows, req.session.user!);
  const results: ImportRowResult[] = checks.map(r => ({ ...r }));
  const valid = checks.map((r, index) => r.status === 'valid' ? index : -1).filter(index => index >= 0);

  await transaction(async run => {
    for (const index of valid) {
      const row = cleanImportStudent(rows[index]);
      await run('SAVEPOINT student_import_row');
      try {
        await run(`INSERT INTO students
          (student_no, first_name, middle_name, last_name, course, year_level, gender, section_id, parent_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.student_no, row.first_name, row.middle_name, row.last_name, row.course, row.year_level,
          row.gender || null, row.section_id, row.parent_email]);
        results[index] = { index, status: 'imported', errors: [] };
        await run('RELEASE SAVEPOINT student_import_row');
      } catch (error) {
        await run('ROLLBACK TO SAVEPOINT student_import_row');
        await run('RELEASE SAVEPOINT student_import_row');
        if (isUniqueViolation(error)) {
          results[index] = { index, status: 'duplicate', errors: ['Student ID already exists.'] };
        } else {
          console.error(`Student import failed for row ${index + 1}:`, error);
          results[index] = { index, status: 'failed', errors: ['The database could not save this record.'] };
        }
      }
    }
  });

  res.json({
    total: rows.length,
    imported: results.filter(r => r.status === 'imported').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    invalid: results.filter(r => r.status === 'invalid').length,
    failed: results.filter(r => r.status === 'failed').length,
    rows: results,
  });
}));

r.get('/students', h(async (req, res) => {
  const scope = studentScope(req.session.user!);
  res.json(await query(`
    SELECT s.student_id, s.student_no, s.first_name, s.middle_name, s.last_name, s.course, s.year_level, s.gender,
           s.section_id, s.parent_email, s.face_consent_at, s.face_consent_by, sec.section_name,
           (SELECT COUNT(*) FROM student_faces f WHERE f.student_id = s.student_id) AS face_samples
    FROM students s LEFT JOIN sections sec ON s.section_id = sec.section_id WHERE 1=1 ${scope.sql}
    ORDER BY s.last_name, s.first_name`, scope.params));
}));

r.get('/students/:id', h(async (req, res) => {
  const scope = studentScope(req.session.user!);
  const s = await one(`
    SELECT s.student_id, s.student_no, s.first_name, s.middle_name, s.last_name, s.course, s.year_level, s.gender,
           s.section_id, s.parent_email, s.face_consent_at, s.face_consent_by, sec.section_name,
           (SELECT COUNT(*) FROM student_faces f WHERE f.student_id = s.student_id) AS face_samples
    FROM students s LEFT JOIN sections sec ON s.section_id = sec.section_id WHERE s.student_id = ? ${scope.sql}`, [int(req.params.id), ...scope.params]);
  if (!s) throw new HttpError(404, 'Student not found.');
  res.json(s);
}));

function studentFields(b: any) {
  required(b, ['student_no', 'first_name', 'last_name']);
  const gender = ['Male', 'Female', 'Other'].includes(b.gender) ? b.gender : null;
  return [text(b.student_no, 30), text(b.first_name, 80), text(b.middle_name, 80), text(b.last_name, 80),
          text(b.course, 100), text(b.year_level, 30) || null, gender, nullableId(b.section_id), text(b.parent_email, 150) || null];
}

r.post('/students', h(async (req, res) => {
  const f = studentFields(req.body);
  if (req.session.user!.role === 'teacher') {
    const sections = await importSections(req.session.user!);
    if (f[7] === null || !sections.some(s => Number(s.section_id) === f[7])) {
      throw new HttpError(403, 'You can only add students to a section assigned to you.');
    }
  }
  const r2 = await exec(`INSERT INTO students (student_no, first_name, middle_name, last_name, course, year_level, gender, section_id, parent_email)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, f)
    .catch(e => dupMessage(e, `Student ID "${f[0]}" is already taken. Please use a different ID.`));
  res.json({ ok: true, id: r2.insertId });
}));

r.put('/students/:id', h(async (req, res) => {
  const f = studentFields(req.body);
  const isTeacher = req.session.user!.role === 'teacher';
  if (req.session.user!.role === 'teacher') {
    const sections = await importSections(req.session.user!);
    if (f[7] === null || !sections.some(s => Number(s.section_id) === f[7])) {
      throw new HttpError(403, 'You can only assign students to a section assigned to you.');
    }
  }
  const scopeSql = isTeacher
    ? ' AND section_id IN (SELECT section_id FROM sections WHERE class_id IN (SELECT class_id FROM classes WHERE teacher_id=?))'
    : '';
  await exec(`UPDATE students SET student_no=?, first_name=?, middle_name=?, last_name=?, course=?, year_level=?, gender=?, section_id=?, parent_email=?
              WHERE student_id=? ${scopeSql}`, [...f, int(req.params.id), ...(isTeacher ? [req.session.user!.teacher_id] : [])])
    .catch(e => dupMessage(e, `Student ID "${f[0]}" is already taken.`));
  res.json({ ok: true });
}));

r.delete('/students/:id', h(async (req, res) => {
  const scope = studentScope(req.session.user!);
  const scopedDelete = scope.sql
    ? `DELETE FROM students WHERE student_id=? AND section_id IN
       (SELECT section_id FROM sections WHERE class_id IN (SELECT class_id FROM classes WHERE teacher_id=?))`
    : 'DELETE FROM students WHERE student_id=?';
  await exec(scopedDelete, [int(req.params.id), ...scope.params]);
  res.json({ ok: true });
}));

// ---- Teachers ----
// has_account: the teacher can sign in with their email and a password.
const TEACHER_SQL = `SELECT t.*, (u.password_hash IS NOT NULL) AS has_account
  , (SELECT COUNT(*) FROM sections sec JOIN classes c ON c.class_id=sec.class_id
     WHERE c.teacher_id=t.teacher_id) AS assigned_sections
  FROM teachers t LEFT JOIN users u ON u.email = t.email`;
r.get('/teachers', h(async (_req, res) => {
  res.json(await query(`${TEACHER_SQL} ORDER BY t.last_name, t.first_name`));
}));
r.get('/teachers/:id', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can view teacher details.');
  const t = await one(`${TEACHER_SQL} WHERE t.teacher_id=?`, [int(req.params.id)]);
  if (!t) throw new HttpError(404, 'Teacher not found.');
  res.json(t);
}));
function teacherFields(b: any) {
  required(b, ['first_name', 'last_name', 'email']);
  const firstName = text(b.first_name, 80);
  const lastName = text(b.last_name, 80);
  const email = text(b.email, 150).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid teacher email address.');
  if (b.is_active !== undefined && typeof b.is_active !== 'boolean') throw new HttpError(400, 'Teacher status is invalid.');
  return [firstName, lastName, email, text(b.department, 100), b.is_active];
}
r.post('/teachers', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can manage teachers.');
  const f = teacherFields(req.body);
  await exec('INSERT INTO teachers (first_name, last_name, email, department, is_active) VALUES (?, ?, ?, ?, ?)', [...f.slice(0, 4), f[4] ?? true])
    .catch(e => dupMessage(e, `A teacher with email ${f[2]} already exists.`));
  res.json({ ok: true });
}));
r.put('/teachers/:id', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can manage teachers.');
  const f = teacherFields(req.body);
  const id = int(req.params.id);
  if (!id) throw new HttpError(400, 'Invalid teacher ID.');
  const teacher = await one('SELECT teacher_id, email FROM teachers WHERE teacher_id=?', [id]);
  if (!teacher) throw new HttpError(404, 'Teacher not found.');
  await transaction(async run => {
    await run(`UPDATE teachers SET first_name=?, last_name=?, email=?, department=?${f[4] === undefined ? '' : ', is_active=?'} WHERE teacher_id=?`,
      f[4] === undefined ? [...f.slice(0, 4), id] : [...f, id]);
    await run('UPDATE users SET email=?, name=? WHERE email=?', [f[2], `${f[0]} ${f[1]}`, teacher.email]);
  })
    .catch(e => dupMessage(e, `A teacher with email ${f[2]} already exists.`));
  res.json({ ok: true });
}));
// Assignments use the existing classes.teacher_id relationship; all sections of each selected class follow it.
r.put('/teachers/:id/assignments', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can assign classes.');
  const teacherId = int(req.params.id);
  if (!teacherId) throw new HttpError(400, 'Invalid teacher ID.');
  const teacher = await one('SELECT teacher_id, is_active FROM teachers WHERE teacher_id=?', [teacherId]);
  if (!teacher) throw new HttpError(404, 'Teacher not found.');
  const rawIds: unknown = req.body?.class_ids;
  if (!Array.isArray(rawIds) || rawIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1))
    throw new HttpError(400, 'Choose valid classes.');
  const classIds = rawIds.map(Number);
  if (new Set(classIds).size !== classIds.length) throw new HttpError(400, 'Duplicate class assignments are not allowed.');
  const current = classIds.length
    ? await query<{ class_id: number; teacher_id: number | null }>(
      `SELECT class_id, teacher_id FROM classes WHERE class_id IN (${classIds.map(() => '?').join(',')})`, classIds)
    : [];
  if (current.length !== classIds.length) throw new HttpError(400, 'One or more selected classes no longer exist.');
  if (!teacher.is_active && current.some(c => Number(c.teacher_id) !== teacherId))
    throw new HttpError(409, 'Activate this teacher before assigning new classes.');
  await transaction(async run => {
    if (classIds.length) {
      await run(`UPDATE classes SET teacher_id=NULL WHERE teacher_id=? AND class_id NOT IN (${classIds.map(() => '?').join(',')})`,
        [teacherId, ...classIds]);
      await run(`UPDATE classes SET teacher_id=? WHERE class_id IN (${classIds.map(() => '?').join(',')})`,
        [teacherId, ...classIds]);
    } else {
      await run('UPDATE classes SET teacher_id=NULL WHERE teacher_id=?', [teacherId]);
    }
  });
  res.json({ ok: true, reassigned: current.filter(c => c.teacher_id && Number(c.teacher_id) !== teacherId).length });
}));
r.get('/teachers/:id/students', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can view a teacher roster.');
  const teacherId = int(req.params.id);
  if (!teacherId) throw new HttpError(400, 'Invalid teacher ID.');
  if (!await one('SELECT teacher_id FROM teachers WHERE teacher_id=?', [teacherId]))
    throw new HttpError(404, 'Teacher not found.');
  res.json(await query(`
    SELECT s.student_id, s.student_no, s.first_name, s.middle_name, s.last_name,
           sec.section_name, c.class_name
    FROM students s
    JOIN sections sec ON sec.section_id=s.section_id
    JOIN classes c ON c.class_id=sec.class_id
    WHERE c.teacher_id=?
    ORDER BY c.class_name, sec.section_name, s.last_name, s.first_name`, [teacherId]));
}));
// Admins give a teacher a sign-in: their email plus a password set here.
r.put('/teachers/:id/account', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can set teacher passwords.');
  const t = await one('SELECT * FROM teachers WHERE teacher_id=?', [int(req.params.id)]);
  if (!t) throw new HttpError(404, 'Teacher not found.');
  const password = String(req.body?.password ?? '');
  if (password.length < 8) throw new HttpError(400, 'Use at least 8 characters for the password.');
  const hash = hashPassword(password);
  const r = await exec('UPDATE users SET password_hash=? WHERE email=?', [hash, t.email]);
  if (!r.affectedRows) await exec(`INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'teacher', ?)`,
    [`${t.first_name} ${t.last_name}`, t.email, hash]);
  res.json({ ok: true });
}));
r.delete('/teachers/:id/account', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can remove teacher passwords.');
  const t = await one('SELECT email FROM teachers WHERE teacher_id=?', [int(req.params.id)]);
  if (t) await exec('UPDATE users SET password_hash=NULL WHERE email=?', [t.email]);
  res.json({ ok: true });
}));
r.delete('/teachers/:id', h(async (req, res) => {
  if (req.session.user!.role !== 'admin') throw new HttpError(403, 'Only admins can archive teachers.');
  const id = int(req.params.id);
  if (!id) throw new HttpError(400, 'Invalid teacher ID.');
  if (!await one('SELECT teacher_id FROM teachers WHERE teacher_id=?', [id])) throw new HttpError(404, 'Teacher not found.');
  await exec('UPDATE teachers SET is_active=FALSE WHERE teacher_id=?', [id]);
  res.json({ ok: true });
}));

// ---- Classes, sections, schedules ----
r.get('/classes', h(async (_req, res) => {
  const [classes, sections, schedules] = await Promise.all([
    query(`SELECT c.*, CONCAT(t.first_name, ' ', t.last_name) AS teacher_name
           FROM classes c LEFT JOIN teachers t ON c.teacher_id = t.teacher_id ORDER BY c.class_name`),
    query(`SELECT s.*, c.class_name FROM sections s LEFT JOIN classes c ON s.class_id = c.class_id ORDER BY s.section_name`),
    query(`SELECT sc.*, c.class_name, c.subject, s.section_name
           FROM schedules sc JOIN classes c ON sc.class_id = c.class_id
           LEFT JOIN sections s ON sc.section_id = s.section_id
           ORDER BY CASE sc.day_of_week ${DAYS.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} END, sc.time_start`, DAYS),
  ]);
  res.json({ classes, sections, schedules });
}));

r.post('/classes', h(async (req, res) => {
  const b = req.body;
  required(b, ['class_name']);
  const withSchedule = b.day_of_week && b.time_start && b.time_end;
  if (withSchedule) checkSchedule(b);
  const teacherId = nullableId(b.teacher_id);
  if (teacherId && !await one('SELECT teacher_id FROM teachers WHERE teacher_id=? AND is_active=TRUE', [teacherId]))
    throw new HttpError(400, 'Choose an active teacher.');
  const c = await exec('INSERT INTO classes (class_name, subject, teacher_id) VALUES (?, ?, ?)',
    [text(b.class_name, 100), text(b.subject, 100), teacherId]);
  if (withSchedule) await addSchedule({ ...b, class_id: c.insertId });
  res.json({ ok: true });
}));
r.delete('/classes/:id', h(async (req, res) => {
  await exec('DELETE FROM classes WHERE class_id=?', [int(req.params.id)]);
  res.json({ ok: true });
}));

r.post('/sections', h(async (req, res) => {
  required(req.body, ['section_name']);
  await exec('INSERT INTO sections (section_name, class_id) VALUES (?, ?)', [text(req.body.section_name, 100), nullableId(req.body.class_id)]);
  res.json({ ok: true });
}));
r.delete('/sections/:id', h(async (req, res) => {
  await exec('DELETE FROM sections WHERE section_id=?', [int(req.params.id)]);
  res.json({ ok: true });
}));

function checkSchedule(b: any) {
  if (!DAYS.includes(b.day_of_week)) throw new HttpError(400, 'Pick a day of the week.');
  const time = /^\d{2}:\d{2}(:\d{2})?$/;
  if (!time.test(b.time_start) || !time.test(b.time_end)) throw new HttpError(400, 'Enter start and end times.');
  if (b.time_end <= b.time_start) throw new HttpError(400, 'End time must be after start time.');
}
async function addSchedule(b: any) {
  checkSchedule(b);
  await exec('INSERT INTO schedules (class_id, section_id, day_of_week, time_start, time_end, room) VALUES (?, ?, ?, ?, ?, ?)',
    [int(b.class_id), nullableId(b.section_id ?? b.sched_section_id), b.day_of_week, b.time_start, b.time_end, text(b.room, 50)]);
}
r.post('/schedules', h(async (req, res) => {
  required(req.body, ['class_id']);
  await addSchedule(req.body);
  res.json({ ok: true });
}));
r.delete('/schedules/:id', h(async (req, res) => {
  await exec('DELETE FROM schedules WHERE schedule_id=?', [int(req.params.id)]);
  res.json({ ok: true });
}));

export default r;
