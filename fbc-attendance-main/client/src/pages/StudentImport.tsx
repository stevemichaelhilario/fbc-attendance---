import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { api } from '../api';
import { Alert } from '../Layout';
import { Icon } from '../icons';
import { IconLabel, Modal } from '../ui';

type ImportStudent = {
  student_no: string; first_name: string; middle_name: string; last_name: string;
  course: string; year_level: string; gender: string; section_id: number | null; parent_email: string;
};
type Section = { section_id: number; section_name: string };
type ImportRow = { line: number; sectionValue: string; student: ImportStudent; errors: string[]; status: 'valid' | 'duplicate' | 'invalid' | 'imported' | 'failed' };
type ServerRow = { index: number; status: ImportRow['status']; errors: string[] };
type ImportResult = { total: number; imported: number; duplicates: number; invalid: number; failed: number; rows: ServerRow[] };
type Options = { sections: Section[]; yearLevels: string[]; role: string };

const HEADERS = ['student_id', 'first_name', 'middle_name', 'last_name', 'course', 'year_level', 'gender', 'section', 'parent_email'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value.length === 0) quoted = true;
    else if (ch === ',') { row.push(value.trim()); value = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(value.trim()); value = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
    } else value += ch;
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted field.');
  row.push(value.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows;
}

export function normalizeHeader(value: string) {
  const normalized = value.normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const aliases: Record<string, string> = {
    id: 'student_id',
    studentid: 'student_id',
    student_no: 'student_id',
    student_number: 'student_id',
    firstname: 'first_name',
    middlename: 'middle_name',
    lastname: 'last_name',
    course_name: 'course',
    yearlevel: 'year_level',
    academic_year_level: 'year_level',
    section_name: 'section',
    section_id: 'section',
    parent_email_address: 'parent_email',
    parentemail: 'parent_email',
  };
  return aliases[normalized] ?? normalized;
}

export function parseStudentCsv(source: string, options: Options, role: string): ImportRow[] {
  const records = parseCsv(source);
  if (records.length < 2) throw new Error('The CSV needs a header row and at least one student.');
  if (records.length - 1 > MAX_ROWS) throw new Error(`Import up to ${MAX_ROWS} students at a time.`);
  const headers = records[0].map(normalizeHeader);
  const column = (name: string) => headers.indexOf(name);
  const required = ['student_id', 'first_name', 'last_name', 'course', 'year_level'];
  const missing = required.filter(name => column(name) < 0);
  if (missing.length) throw new Error(`Missing CSV column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  const sections = options.sections;
  const rows: ImportRow[] = records.slice(1).map((cells, index) => {
    const cell = (name: string) => {
      const position = column(name);
      return position < 0 ? '' : (cells[position] ?? '').trim();
    };
    const sectionName = cell('section');
    const matches = /^\d+$/.test(sectionName)
      ? sections.filter(s => Number(s.section_id) === Number(sectionName))
      : sections.filter(s => s.section_name.trim().toLowerCase() === sectionName.toLowerCase());
    const student: ImportStudent = {
      student_no: cell('student_id'), first_name: cell('first_name'), middle_name: cell('middle_name'),
      last_name: cell('last_name'), course: cell('course'), year_level: cell('year_level'), gender: cell('gender'),
      section_id: sectionName && matches.length === 1 ? Number(matches[0].section_id) : null,
      parent_email: cell('parent_email'),
    };
    const errors: string[] = [];
    if (!student.student_no) errors.push('Student ID is required.');
    if (!student.first_name) errors.push('First name is required.');
    if (!student.last_name) errors.push('Last name is required.');
    if (!student.course) errors.push('Course is required.');
    if (!options.yearLevels.includes(student.year_level)) errors.push('Year level must be 1st Year through 5th Year.');
    if (student.gender && !['Male', 'Female', 'Other'].includes(student.gender)) errors.push('Gender must be Male, Female, or Other.');
    if (student.parent_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.parent_email)) errors.push('Parent email is invalid.');
    if (role === 'teacher' && !sectionName) errors.push('A section is required.');
    if (sectionName && matches.length === 0) errors.push('Section is not available to your account.');
    if (sectionName && matches.length > 1) errors.push('Section name is ambiguous; ask an administrator to make it unique.');
    return { line: index + 2, sectionValue: sectionName, student, errors, status: errors.length ? 'invalid' : 'valid' };
  });
  const counts = new Map<string, number>();
  rows.forEach(row => {
    const id = row.student.student_no.toLowerCase();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  rows.forEach(row => {
    if (row.student.student_no && (counts.get(row.student.student_no.toLowerCase()) ?? 0) > 1) {
      row.status = 'duplicate';
      row.errors = ['Student ID is repeated in this file.'];
    }
  });
  return rows;
}

export function createStudentImportTemplate() {
  return `${HEADERS.join(',')}\r\n`;
}

function downloadTemplate() {
  const blob = new Blob([createStudentImportTemplate()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'student-import-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export function StudentImport({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ label: string; value: number | null } | null>(null);
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const close = () => { if (result?.imported) onChanged(); onClose(); };

  const receive = async (file?: File) => {
    if (!file) return;
    setMsg(null);
    setResult(null);
    setRows([]);
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > MAX_FILE_BYTES) {
      setMsg({ text: file.size > MAX_FILE_BYTES ? 'CSV files must be 2 MB or smaller.' : 'Choose a .csv file. Excel files are not supported.', type: 'error' });
      return;
    }
    setBusy(true);
    setProgress({ label: 'Reading CSV…', value: null });
    try {
      const text = await file.text();
      const res = await api<Options>('/students/import-options');
      setOptions(res);
      const parsed = parseStudentCsv(text.replace(/^\uFEFF/, ''), res, res.role);
      setRows(parsed);
      setProgress({ label: 'Checking student IDs and section assignments…', value: null });
      const checked = await api<{ rows: ServerRow[] }>('/students/import/validate', {
        body: { students: parsed.map(row => row.student) },
      });
      setRows(parsed.map((row, i) => ({
        ...row,
        status: checked.rows[i]?.status === 'duplicate' ? 'duplicate' : checked.rows[i]?.status === 'invalid' ? 'invalid' : row.status,
        errors: checked.rows[i]?.errors.length ? checked.rows[i].errors : row.errors,
      })));
      setProgress(null);
    } catch (error) {
      setProgress(null);
      setMsg({ text: error instanceof Error ? error.message : 'Could not read this CSV.', type: 'error' });
    } finally { setBusy(false); }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => { void receive(event.target.files?.[0]); event.target.value = ''; };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void receive(event.dataTransfer.files[0]); };
  const validCount = rows.filter(row => row.status === 'valid').length;
  const importRows = async () => {
    if (!validCount) return;
    setBusy(true);
    setProgress({ label: `Importing ${validCount} valid students…`, value: null });
    setMsg(null);
    try {
      const response = await api<ImportResult>('/students/import', { body: { students: rows.map(row => row.student) } });
      setResult(response);
      setRows(rows.map((row, i) => ({
        ...row,
        status: response.rows[i]?.status ?? row.status,
        errors: response.rows[i]?.errors ?? row.errors,
      })));
      setProgress({ label: 'Import complete', value: 100 });
      onChanged();
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : 'Import failed. No records were reported as saved.', type: 'error' });
      setProgress(null);
    } finally { setBusy(false); }
  };

  const counts = result ?? {
    total: rows.length, imported: 0,
    duplicates: rows.filter(row => row.status === 'duplicate').length,
    invalid: rows.filter(row => row.status === 'invalid').length, failed: 0, rows: [],
  };

  return (
    <Modal title="Import students" subtitle="Upload a CSV file, review every row, then save valid records." onClose={close}>
      <Alert msg={msg} />
      <div className="student-import">
        <div className="import-intro">
          <div><h3>Prepare your student list</h3><p className="muted">CSV only · up to {MAX_ROWS.toLocaleString()} students · 2 MB maximum</p></div>
          <button type="button" className="btn btn-outline btn-sm" onClick={downloadTemplate}><IconLabel icon="list">Download template</IconLabel></button>
        </div>
        <p className="import-instructions">Use the template headers. Student ID, first name, last name, course, and year level are required. Section can be its name or ID and must be available to your account; parent email and middle name are optional.</p>
        <div className={'import-drop' + (dragging ? ' dragging' : '')} role="button" tabIndex={0}
          onClick={() => fileRef.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={choose} />
          <Icon name="list" />
          <strong>Drop your CSV file here</strong>
          <span className="muted">or click to browse · .csv files only</span>
        </div>

        {progress && <div className="import-progress" aria-live="polite">
          <div className="import-progress-label"><span>{progress.label}</span>{progress.value === null && <span className="spinner" />}</div>
          <progress value={progress.value ?? undefined} max="100" />
        </div>}

        {rows.length > 0 && <>
          <div className="import-summary">
            <span>{counts.total} uploaded</span><span className="import-valid">{validCount} ready</span>
            <span className="import-duplicate">{counts.duplicates} duplicate</span><span className="import-invalid">{counts.invalid} invalid</span>
            {result && <span>{result.failed} failed</span>}
          </div>
          <div className="import-table-wrap">
            <table className="import-table">
              <thead><tr><th>Line</th><th>Student ID</th><th>First name</th><th>Middle name</th><th>Last name</th><th>Course</th><th>Year level</th><th>Gender</th><th>Section</th><th>Parent email</th><th>Status / errors</th></tr></thead>
              <tbody>{rows.map((row, i) => (
                <tr key={`${row.line}-${i}`}>
                  <td>{row.line}</td><td>{row.student.student_no}</td><td>{row.student.first_name}</td><td>{row.student.middle_name}</td>
                  <td>{row.student.last_name}</td><td>{row.student.course}</td><td>{row.student.year_level}</td><td>{row.student.gender}</td>
                  <td>{options?.sections.find(s => Number(s.section_id) === row.student.section_id)?.section_name ?? row.sectionValue}</td>
                  <td>{row.student.parent_email}</td>
                  <td><span className={`import-status ${row.status}`}>{row.status}</span>{row.errors.length > 0 && <div className="import-row-error">{row.errors.join(' ')}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {result && <div className="import-results" role="status">
            <strong>Import results</strong>
            <span>{result.total} uploaded</span><span>{result.imported} imported</span><span>{result.duplicates} duplicates</span>
            <span>{result.invalid} invalid</span><span>{result.failed} failed</span>
          </div>}
          <div className="form-actions">
            <button type="button" className="btn btn-outline" onClick={close}>Close</button>
            {!result && <button type="button" className="btn btn-primary" onClick={() => void importRows()} disabled={busy || !validCount}>
              <IconLabel icon="save">{busy ? 'Importing…' : `Import ${validCount} valid student${validCount === 1 ? '' : 's'}`}</IconLabel>
            </button>}
          </div>
        </>}
      </div>
    </Modal>
  );
}
