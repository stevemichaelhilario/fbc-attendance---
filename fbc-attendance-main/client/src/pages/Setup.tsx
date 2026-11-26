import { Tabs } from '../ui';
import { ClassesTab, SchedulesTab } from './Classes';

/** Classes, sections and schedules retain their existing setup flow. Teacher records are managed separately. */
export default function Setup() {
  return (
    <Tabs numbered tabs={[
      { id: 'classes', label: 'Classes & sections', icon: 'classes', hint: 'Create a class, then add its sections. Students are placed in a section.', render: () => <ClassesTab /> },
      { id: 'times', label: 'Class times', icon: 'clock', hint: 'Set when each section has class. A check-in more than 15 minutes after the first class counts as Late.', render: () => <SchedulesTab /> },
    ]} />
  );
}
