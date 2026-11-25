import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import PgStoreFactory from 'connect-pg-simple';
import { pgPool, pool, query, today } from './db.js';
import { authRoutes, requireStaff } from './auth.js';
import { migrate } from './migrate.js';
import records from './routes/records.js';
import attendance from './routes/attendance.js';
import { faceRoutes, kioskRoutes } from './routes/face.js';
import classroom from './routes/classroom.js';
import { runAutoAbsent } from './jobs/autoAbsent.js';
import { h, HttpError } from './util.js';

export function createApp(extra?: (app: express.Express) => void) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // Logins are kept in the database, so they survive a restart (and work across Vercel's servers).
  const store = pgPool
    ? new (PgStoreFactory(session))({ pool: pgPool, tableName: 'sessions' })
    : new (MySQLStoreFactory(session as any))({ createDatabaseTable: true }, pool as any);
  app.use(session({
    name: 'fbc.sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  }));

  extra?.(app);

  app.get('/api/me', (req, res) => {
    res.json({ user: req.session.user ?? null, kiosk: !!req.session.kiosk });
  });
  app.get('/api/parent/dashboard', h(async (req, res) => {
    const user = req.session.user;
    if (!user) throw new HttpError(401, 'Please sign in.');
    if (user.role !== 'parent') throw new HttpError(403, 'Parent access required.');
    const date = today();
    const children = await query(`
      SELECT s.student_id, s.student_no, s.first_name, s.middle_name, s.last_name,
             s.course, s.year_level, sec.section_name,
             a.status, a.time_in, a.method, a.confidence
      FROM students s
      LEFT JOIN sections sec ON sec.section_id=s.section_id
      LEFT JOIN attendance a ON a.student_id=s.student_id AND a.date=?
      WHERE LOWER(s.parent_email)=? ORDER BY s.last_name, s.first_name`, [date, user.email.toLowerCase()]);
    const notifications = await query(`
      SELECT n.notification_id, n.student_id, n.recipient_email, n.subject, n.message,
             n.event_type, n.event_key, n.event_at, n.sent_at,
             CONCAT(s.first_name, ' ', s.last_name) AS student_name
      FROM notifications n JOIN students s ON s.student_id=n.student_id
      WHERE LOWER(s.parent_email)=? AND LOWER(n.recipient_email)=?
      ORDER BY n.sent_at DESC LIMIT 100`, [user.email.toLowerCase(), user.email.toLowerCase()]);
    res.json({ date, children, notifications });
  }));
  app.get('/api/parent/students/:id/attendance', h(async (req, res) => {
    const user = req.session.user;
    if (!user) throw new HttpError(401, 'Please sign in.');
    if (user.role !== 'parent') throw new HttpError(403, 'Parent access required.');
    const studentId = Number(req.params.id);
    if (!Number.isSafeInteger(studentId) || studentId < 1) throw new HttpError(400, 'Invalid student.');
    const child = await query(`
      SELECT student_id, student_no, first_name, last_name
      FROM students WHERE student_id=? AND LOWER(parent_email)=?`,
    [studentId, user.email.toLowerCase()]);
    if (!child.length) throw new HttpError(404, 'Student not found.');
    const rows = await query(`
      SELECT date, status, time_in, method FROM attendance
      WHERE student_id=? ORDER BY date DESC LIMIT 120`, [studentId]);
    res.json({ student: child[0], rows });
  }));
  app.use('/auth', authRoutes());
  app.use('/api/kiosk', kioskRoutes);
  app.use('/api', faceRoutes);
  app.use('/api', requireStaff, records);
  app.use('/api', requireStaff, attendance);
  app.use('/api', requireStaff, classroom);
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  // The built React app.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(here, '../client');
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

function scheduleAutoAbsent() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(config.face.autoAbsentTime);
  if (!m) { console.log('Auto-absent is off (AUTO_ABSENT_TIME is empty).'); return; }
  // Every day; runAutoAbsent itself skips non-school days per section.
  cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, () => {
    runAutoAbsent().catch(e => console.error('Auto-absent failed:', e));
  }, { timezone: config.tz });
  console.log(`Auto-absent runs daily at ${config.face.autoAbsentTime} (${config.tz}).`);
}

if (process.argv[1]?.match(/index\.(js|ts)$/) && !process.env.VERCEL) {
  await migrate(() => {});
  createApp().listen(config.port, () => {
    console.log(`FBC Attendance is running at ${config.appUrl}`);
    scheduleAutoAbsent();
  });
}
