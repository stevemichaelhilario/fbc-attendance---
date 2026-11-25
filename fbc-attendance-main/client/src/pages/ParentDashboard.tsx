import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks';
import { DataState, Empty } from '../ui';
import { BADGE, longDate, time12 } from '../api';

interface Child {
  student_id: number;
  student_no: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  course: string | null;
  year_level: string | null;
  section_name: string | null;
  status: string | null;
  time_in: string | null;
  method: string | null;
  confidence: string | null;
}

interface ParentDashboardData {
  date: string;
  children: Child[];
  notifications: {
    notification_id: number;
    student_name: string;
    subject: string;
    message: string;
    event_type: string | null;
    event_key: string;
    sent_at: string;
  }[];
}

export default function ParentDashboard() {
  const { data, loading, error, reload } =
    useApi<ParentDashboardData>('/parent/dashboard', 10000);

  if (!data) return <DataState loading={loading} error={error} onRetry={reload} />;
  return (
    <>
      <div className="sec-title">{longDate(data.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
      {data.children.length === 0 ? (
        <Empty><p>No registered children are currently linked to this account.</p></Empty>
      ) : (
        <div className="stats-grid parent-child-grid">
          {data.children.map(child => (
            <Link className="card parent-child-card" key={child.student_id} to={`/parent/students/${child.student_id}/attendance`}>
              <div className="parent-child-head">
                <div>
                  <h3>{child.first_name} {child.middle_name ? `${child.middle_name} ` : ''}{child.last_name}</h3>
                  <div className="muted">{child.student_no}</div>
                </div>
                {child.status
                  ? <span className={`badge ${BADGE[child.status] ?? 'badge-muted'}`}>{child.status}</span>
                  : <span className="badge badge-muted">Not recorded</span>}
              </div>
              <div className="muted">{child.course || 'No course'} · {child.year_level || 'Year level not set'}</div>
              <div className="muted">{child.section_name || 'No section assigned'}</div>
              <div className="parent-arrival">
                {child.time_in ? `Time in: ${time12(child.time_in)}` : 'No arrival recorded today'}
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="sec-title" style={{ marginTop: 24 }}>Notification history</div>
      <div className="card" style={{ padding: 0 }}>
        {data.notifications.length === 0 ? (
          <div className="empty"><p>No attendance notifications yet.</p></div>
        ) : (
          data.notifications.map(note => (
            <div className="date-row" key={note.notification_id}>
              <div>
                <strong>{note.subject}</strong>
                <div className="muted">{note.student_name} · {longDate(note.sent_at.slice(0, 10))}</div>
              </div>
              <span className={`badge ${note.event_type === 'late' ? 'badge-late' : note.event_type === 'absent' ? 'badge-absent' : 'badge-present'}`}>
                {note.event_type || 'notification'}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

interface AttendanceHistory {
  student: { student_no: string; first_name: string; last_name: string };
  rows: { date: string; status: string; time_in: string | null; method: string }[];
}

export function ParentChildHistory() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<AttendanceHistory>(
    id ? `/parent/students/${id}/attendance` : null,
  );
  if (!data) return <DataState loading={loading} error={error} onRetry={reload} />;
  return (
    <>
      <Link to="/" className="btn btn-outline btn-sm">Back to children</Link>
      <div className="sec-title" style={{ marginTop: 16 }}>{data.student.first_name} {data.student.last_name} · {data.student.student_no}</div>
      {data.rows.length === 0 ? <Empty><p>No attendance history is recorded for this child yet.</p></Empty> : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>Time in</th><th>Recorded by</th></tr></thead>
            <tbody>{data.rows.map(row => (
              <tr key={row.date}>
                <td>{longDate(row.date)}</td>
                <td><span className={`badge ${BADGE[row.status] ?? 'badge-muted'}`}>{row.status}</span></td>
                <td>{row.time_in ? time12(row.time_in) : '—'}</td>
                <td>{row.method}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
