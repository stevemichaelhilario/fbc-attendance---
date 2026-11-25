import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { longDate } from '../api';
import { useApi } from '../hooks';
import { Icon } from '../icons';
import { DataState } from '../ui';
import type { User } from '../api';

interface Stats {
  date: string; students: number; teachers: number; classes: number; sections: number; faces: number;
  present: number; absent: number; late: number; excused: number;
}

interface TeacherStudent {
  student_id: number; student_no: string; first_name: string; last_name: string;
  course: string | null; year_level: string | null; section_id: number; section_name: string;
  class_id: number; class_name: string; status: string | null; time_in: string | null;
}

function TeacherRoster() {
  const { data, loading, error, reload } = useApi<TeacherStudent[]>('/teacher/students', 10000);
  if (!data) return <DataState loading={loading} error={error} onRetry={reload} />;
  if (data.length === 0) return <div className="card data-state">No students are assigned to your classes yet.</div>;
  const classes = [...new Set(data.map(s => s.class_id))];
  return (
    <>
      <div className="sec-title" style={{ marginTop: 26 }}>Your students</div>
      {classes.map(classId => {
        const students = data.filter(s => s.class_id === classId);
        const sections = [...new Set(students.map(s => s.section_id))];
        return (
          <section className="card teacher-class-card" key={classId}>
            <h3>{students[0].class_name}</h3>
            {sections.map(sectionId => {
              const sectionStudents = students.filter(s => s.section_id === sectionId);
              return (
                <div className="teacher-section" key={sectionId}>
                  <h4>{sectionStudents[0].section_name}</h4>
                  <div className="teacher-student-grid">
                    {sectionStudents.map(s => (
                      <article className="teacher-student-card" key={s.student_id}>
                        <strong>{s.last_name}, {s.first_name}</strong>
                        <span className="muted">{s.student_no}{s.course ? ` · ${s.course}` : ''}{s.year_level ? ` · ${s.year_level}` : ''}</span>
                        <span className={`badge ${s.status === 'Present' ? 'badge-present' : s.status === 'Late' ? 'badge-late' : s.status === 'Absent' ? 'badge-absent' : s.status === 'Excused' ? 'badge-excused' : 'badge-muted'}`}>
                          {s.status || 'Not recorded'}
                        </span>
                        {s.time_in && <span className="muted">Time in {s.time_in.slice(0, 5)}</span>}
                      </article>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </>
  );
}

/** Counts up from 0 to the value so the numbers animate in. */
function CountUp({ value }: { value: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setN(value); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 900);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n}</>;
}

function Ring({ pct, empty }: { pct: number; empty: boolean }) {
  const r = 46, c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = setTimeout(() => setShown(pct), 80); return () => clearTimeout(t); }, [pct]);
  return (
    <div className="ring">
      <svg viewBox="0 0 112 112">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff1c9" /><stop offset="100%" stopColor="#f2c14e" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx="56" cy="56" r={r} />
        <circle className="ring-bar" cx="56" cy="56" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - shown / 100)} />
      </svg>
      <div className="ring-inner">
        <div><div className="ring-num">{empty ? "–" : `${pct}%`}</div><div className="ring-label">on time</div></div>
      </div>
    </div>
  );
}

/** The order a new school sets things up in. Each step links straight to where it's done. */
function setupSteps(s: Stats): [boolean, string, string, string][] {
  return [
    [s.teachers > 0, 'Add your teachers', '/setup?tab=teachers', `${s.teachers} added`],
    [s.classes > 0 && s.sections > 0, 'Create classes and sections', '/setup?tab=classes', `${s.classes} classes, ${s.sections} sections`],
    [s.students > 0, 'Add students to their sections', '/students', `${s.students} added`],
    [s.faces > 0, 'Register student faces for check-in', '/students', `${s.faces} of ${s.students} registered`],
  ];
}

export default function Dashboard({ user }: { user: User }) {
  const { data: s, loading, error, reload } = useApi<Stats>('/dashboard', 10000);
  if (!s) return <DataState loading={loading} error={error} onRetry={reload} />;
  const marked = s.present + s.absent + s.late + s.excused;
  const onTime = marked ? Math.round((s.present / marked) * 100) : 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = longDate(s.date, { month: 'long', day: 'numeric' });
  const steps = setupSteps(s);
  const nextStep = steps.findIndex(([done]) => !done);

  let i = 0;
  const stat = (n: number, label: string, icon: string, color: string) => (
    <div className="stat-card" style={{ animationDelay: `${i++ * 60}ms`, ['--accent' as string]: color }}>
      <div className="stat-icon"><Icon name={icon} /></div>
      <div><div className="stat-num"><CountUp value={n} /></div><div className="stat-label">{label}</div></div>
    </div>
  );
  return (
    <>
      <div className="dash-hero">
        <div>
          <h2>{greeting}!</h2>
          <p>{marked
            ? `${marked} of ${s.students} students have attendance for today, ${today}.`
            : `No attendance yet for today, ${today}. Pick one of the options below to start.`}</p>
        </div>
        <Ring pct={onTime} empty={!marked} />
      </div>

      <div className="action-grid">
        <Link to="/attendance?tab=kiosk" className="action-card primary">
          <div className="action-ico"><Icon name="face" /></div>
          <div><div className="action-title">Start face check-in</div><div className="action-sub">Students check themselves in at the entrance camera.</div></div>
          <Icon name="arrow" />
        </Link>
        <Link to="/attendance?tab=manual" className="action-card">
          <div className="action-ico"><Icon name="edit" /></div>
          <div><div className="action-title">Mark attendance by hand</div><div className="action-sub">Pick a section and tap Present, Late, Absent or Excused.</div></div>
          <Icon name="arrow" />
        </Link>
      </div>

      <div className="sec-title" style={{ marginTop: 26 }}>Today</div>
      <div className="stats-grid">
        {stat(s.present, 'Present', 'check', '#86efac')}{stat(s.late, 'Late', 'clock', '#fcd34d')}
        {stat(s.absent, 'Absent', 'x', '#fca5a5')}{stat(s.excused, 'Excused', 'shield', '#93c5fd')}
      </div>

      {user.role === 'teacher' && <TeacherRoster />}

      {nextStep >= 0 && <>
        <div className="sec-title" style={{ marginTop: 26 }}>Finish setting up</div>
        <div className="card checklist">
          {steps.map(([done, label, to, detail], k) => (
            <Link key={label} to={to} className={'check-row' + (done ? ' done' : '') + (k === nextStep ? ' next' : '')}>
              <span className="check-mark">{done ? <Icon name="check" /> : k + 1}</span>
              <span className="check-label">{label}<small>{detail}</small></span>
              {k === nextStep && <span className="btn btn-primary btn-sm">Do this next</span>}
            </Link>
          ))}
        </div>
      </>}
    </>
  );
}
