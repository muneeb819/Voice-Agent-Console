import fs from 'fs';
import path from 'path';

/** A row from the user's greeting dataset. The labels are descriptive metadata. */
export interface GreetingRecord {
  greeting_id: string;
  persona: string;
  context: string;
  greeting_text: string;
  tone: string;
}

/** Validate the entire bundled seed before importing any of it into SQLite. */
export function loadBundledGreetings(): GreetingRecord[] {
  const file = path.resolve(__dirname, '..', 'public', 'greetings.json');
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (parsed as { greetings?: unknown })?.greetings;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Greeting catalog is empty or invalid');
  const ids = new Set<string>();
  const fields = ['greeting_id', 'persona', 'context', 'greeting_text', 'tone'] as const;
  return rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || fields.some((field) =>
      typeof raw[field] !== 'string' || !raw[field].trim()
    )) throw new Error('Greeting catalog contains an invalid row');
    const row = Object.fromEntries(fields.map((field) => [field, raw[field]])) as unknown as GreetingRecord;
    if (ids.has(row.greeting_id)) throw new Error(`Duplicate greeting ID: ${row.greeting_id}`);
    ids.add(row.greeting_id);
    return row;
  });
}
