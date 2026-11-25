// Dashboard, Record Attendance, View Records, Reports.
import express from 'express';
import { teacherFilter } from '../auth.js';
import { exec, isDate, one, query, today, weekday } from '../db.js';
import { notifyParents } from '../mailer.js';
import { h, HttpError, int, STATUSES } from '../util.js';

const r = express.Router();

const COUNTS = `
  SUM(CASE WHEN a.status='Present' THEN 1 ELSE 0 END) AS present_count, SUM(CASE WHEN a.status='Absent' THEN 1 ELSE 0 END) AS absent_count,
  SUM(CASE WHEN a.status='Late' THEN 1 ELSE 0 END) AS late_count, SUM(CASE WHEN a.status='Excused' THEN 1 ELSE 0 END) AS excused_count, COUNT(*) AS total`;

r.get('/dashboard', h(async (req, res) => {
  const d = today();
  const user = req.session.user!;
  const teacher = user.role === 'teacher' ? user.teacher_id : null;
  const studentScope = teacher
    ? ' AND s.section_id IN (SELECT section_id FROM sections WHERE class_id IN (SELECT class_id FROM classes WHERE teacher_id=?))'
    : '';
  const studentParams = teacher ? [teacher] : [];
  const [s, t, c, sec, f, a] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM students s WHERE 1=1 ${studentScope}`, studentParams),
    one(`SELECT COUNT(*) AS n FROM teachers t ${teacher ? 'WHERE t.teacher_id=?' : ''}`, teacher ? [teacher] : []),
    one(`SELECT COUNT(*) AS n FROM classes c ${teacher ? 'WHERE c.teacher_id=?' : ''}`, teacher ? [teacher] : []),
    one(`SELECT COUNT(*) AS n FROM sections sec ${teacher ? 'WHERE sec.class_id IN (SELECT class_id FROM classes WHERE teacher_id=?)' : ''}`, teacher ? [teacher] : []),
    one(`SELECT COUNT(DISTINCT f.student_id) AS n FROM student_faces f JOIN students s ON s.student_id=f.student_id
         WHERE 1=1 ${studentScope}`, studentParams),
    one(`SELECT ${COUNTS} FROM attendance a JOIN students s ON s.student_id=a.student_id
         LEFT JOIN sections sec ON sec.section_id=s.section_id LEFT JOIN classes c ON c.class_id=sec.class_id
         WHERE a.date = ? ${teacher ? 'AND c.teacher_id=?' : ''}`, teacher ? [d, teacher] : [d]),
  ]);
  res.json({
    date: d, students: Number(s?.n), teachers: Number(t?.n), classes: Number(c?.n),
    sections: Number(sec?.n), faces: Number(f?.n),
    present: Number(a?.present_count ?? 0), absent: Number(a?.absent_count ?? 0),
    late: Number(a?.late_count ?? 0), excused: Number(a?.excused_count ?? 0),
  });
}));

r.get('/teacher/students', h(async (req, res) => {
  const user = req.session.user!;
  if (user.role !== 'teacher' || !user.teacher_id) throw new HttpError(403, 'Teacher access required.');
  res.json(await query(`
    SELECT s.student_id, s.student_no, s.first_name, s.last_name, s.course, s.year_level,
           sec.section_id, sec.section_name, c.class_id, c.class_name,
           a.status, a.time_in, a.method
    FROM classes c
    JOIN sections sec ON sec.class_id=c.class_id
    JOIN students s ON s.section_id=sec.section_id
    LEFT JOIN attendance a ON a.student_id=s.student_id AND a.date=?
    WHERE c.teacher_id=?
    ORDER BY c.class_name, sec.section_name, s.last_name, s.first_name`,
  [today(), user.teacher_id]));
}));

// Sections the signed-in user may take attendance for.
r.get('/sections', h(async (req, res) => {
  const f = teacherFilter(req.session.user!);
  res.json(await query(`SELECT s.section_id, s.section_name, c.class_name FROM sections s
                        LEFT JOIN classes c ON s.class_id = c.class_id WHERE 1=1 ${f.sql}
                        ORDER BY s.section_name`, f.params));
}));

async function schedulesFor(sectionId: number, date: string) {
  return query(`SELECT sc.*, c.class_name, c.subject FROM schedules sc JOIN classes c ON sc.class_id = c.class_id
                WHERE sc.section_id = ? AND sc.day_of_week = ? ORDER BY sc.time_start`, [sectionId, weekday(date)]);
}

r.get('/attendance/sheet', h(async (req, res) => {
  const sectionId = int(req.query.section_id);
  const scope = teacherFilter(req.session.user!);
  if (!sectionId) throw new HttpError(400, 'Choose a valid section.');
  const user = req.session.user!;
  const visible = await one(`SELECT s.section_id FROM sections s LEFT JOIN classes c ON c.class_id=s.class_id
                             WHERE s.section_id=? ${teacherFilter(user).sql}`, [sectionId, ...teacherFilter(user).params]);
  if (!visible) throw new HttpError(404, 'Section not found or not assigned to your account.');
  const date = isDate(req.query.date) ? req.query.date : today();
  const students = await query(`
    SELECT s.student_id, s.student_no, s.first_name, s.last_name,
           a.status, a.time_in, a.method,
           (SELECT COUNT(*) FROM attendance x WHERE x.student_id = s.student_id AND x.status = 'Absent') AS absences
    FROM students s LEFT JOIN attendance a ON a.student_id = s.student_id AND a.date = ?
    WHERE s.section_id = ? ORDER BY s.last_name, s.first_name`, [date, sectionId]);
  res.json({ date, day: weekday(date), section_id: sectionId, students, schedules: await schedulesFor(sectionId, date) });
}));

r.post('/attendance/sheet', h(async (req, res) => {
  const { date, section_id: sectionId, statuses } = req.body as { date: string; section_id: number; statuses: Record<string, string> };
  if (!isDate(date)) throw new HttpError(400, 'Invalid date.');
  const user = req.session.user!;
  const section = int(sectionId);
  if (!section) throw new HttpError(400, 'Choose a valid section.');
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses))
    throw new HttpError(400, 'Attendance statuses are invalid.');
  const visible = await one(`SELECT s.section_id FROM sections s LEFT JOIN classes c ON c.class_id=s.class_id
                             WHERE s.section_id=? ${teacherFilter(user).sql}`, [section, ...teacherFilter(user).params]);
  if (!visible) throw new HttpError(404, 'Section not found or not assigned to your account.');
  const ids = Object.keys(statuses ?? {}).map(id => int(id));
  if (ids.some(id => !id)) throw new HttpError(400, 'Attendance contains an invalid student.');
  if (ids.length) {
    const assigned = await query<{ student_id: number }>(
      `SELECT s.student_id FROM students s WHERE s.section_id=? AND s.student_id IN (${ids.map(() => '?').join(',')})`,
      [section, ...ids],
    );
    if (new Set(assigned.map(s => Number(s.student_id))).size !== ids.length)
      throw new HttpError(403, 'One or more students are not assigned to this section.');
  }
  let changed = 0;
  for (const [sid, status] of Object.entries(statuses ?? {})) {
    const studentId = int(sid);
    if (!studentId || !(STATUSES as readonly string[]).includes(status))
      throw new HttpError(400, 'Attendance contains an invalid student or status.');
    const prev = await one('SELECT attendance_id, status FROM attendance WHERE student_id=? AND date=?', [studentId, date]);
    // Unchanged rows (e.g. from face check-in) keep their time-in, and parents aren't emailed twice.
    if (prev && prev.status === status) continue;
    if (prev) {
      await exec("UPDATE attendance SET status=?, method='manual', recorded_by=? WHERE attendance_id=?", [status, user.user_id, prev.attendance_id]);
    } else {
      await exec("INSERT INTO attendance (student_id, date, status, recorded_by, method) VALUES (?, ?, ?, ?, 'manual')",
        [studentId, date, status, user.user_id]);
    }
    changed++;
    notifyParents(studentId, status, date).catch(() => {});
  }
  res.json({ ok: true, changed });
}));

r.get('/attendance/dates', h(async (req, res) => {
  const f = teacherFilter(req.session.user!);
  res.json(await query(`
    SELECT a.date, ${COUNTS}
    FROM attendance a JOIN students s ON a.student_id = s.student_id
    LEFT JOIN sections sec ON s.section_id = sec.section_id LEFT JOIN classes c ON sec.class_id = c.class_id
    WHERE 1=1 ${f.sql} GROUP BY a.date ORDER BY a.date DESC`, f.params));
}));

r.get('/attendance/day/:date', h(async (req, res) => {
  const date = req.params.date;
  if (!isDate(date)) throw new HttpError(400, 'Invalid date.');
  const f = teacherFilter(req.session.user!);
  const rows = await query(`
    SELECT a.attendance_id, a.status, a.time_in, a.method, s.student_no,
           CONCAT(s.first_name, ' ', s.last_name) AS student_name, sec.section_id, sec.section_name
    FROM attendance a JOIN students s ON a.student_id = s.student_id
    LEFT JOIN sections sec ON s.section_id = sec.section_id LEFT JOIN classes c ON sec.class_id = c.class_id
    WHERE a.date = ? ${f.sql} ORDER BY sec.section_name, s.last_name`, [date, ...f.params]);
  const sections = new Map<string, { section_id: number | null; section_name: string; rows: any[]; schedules: any[] }>();
  for (const row of rows) {
    const name = row.section_name ?? 'No Section';
    if (!sections.has(name)) sections.set(name, { section_id: row.section_id, section_name: name, rows: [], schedules: [] });
    sections.get(name)!.rows.push(row);
  }
  for (const s of sections.values()) if (s.section_id) s.schedules = await schedulesFor(s.section_id, date);
  res.json({ date, day: weekday(date), sections: [...sections.values()] });
}));

r.delete('/attendance/:id', h(async (req, res) => {
  const f = teacherFilter(req.session.user!);
  const row = await one(`SELECT a.attendance_id FROM attendance a
    JOIN students s ON s.student_id=a.student_id
    LEFT JOIN sections sec ON sec.section_id=s.section_id
    LEFT JOIN classes c ON c.class_id=sec.class_id
    WHERE a.attendance_id=? ${f.sql}`, [int(req.params.id), ...f.params]);
  if (!row) throw new HttpError(404, 'Attendance record not found or not assigned to your account.');
  await exec('DELETE FROM attendance WHERE attendance_id=?', [int(req.params.id)]);
  res.json({ ok: true });
}));

r.get('/reports', h(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : today().slice(0, 7);
  const sectionId = int(req.query.section_id);
  const scope = teacherFilter(req.session.user!);
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const where = 'WHERE a.date >= ? AND a.date < ?' + (sectionId ? ' AND s.section_id = ?' : '') + scope.sql;
  const params = [...(sectionId ? [`${month}-01`, next, sectionId] : [`${month}-01`, next]), ...scope.params];
  const [rows, totals] = await Promise.all([
    query(`SELECT s.student_id, s.student_no, CONCAT(s.last_name, ', ', s.first_name) AS student_name, sec.section_name, ${COUNTS}
           FROM attendance a JOIN students s ON a.student_id = s.student_id
           LEFT JOIN sections sec ON s.section_id = sec.section_id LEFT JOIN classes c ON c.class_id=sec.class_id
           ${where} GROUP BY s.student_id, s.student_no, s.last_name, s.first_name, sec.section_name ORDER BY s.last_name`, params),
    one(`SELECT ${COUNTS} FROM attendance a JOIN students s ON a.student_id = s.student_id
         LEFT JOIN sections sec ON sec.section_id=s.section_id LEFT JOIN classes c ON c.class_id=sec.class_id ${where}`, params),
  ]);
  res.json({ month, section_id: sectionId, rows, totals });
}));

export default r;
