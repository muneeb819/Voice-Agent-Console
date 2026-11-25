import assert from 'assert';
import { createErrorBudget } from '../src/process-guards';

const b = createErrorBudget(3, 1000);
assert(b.record(0) && b.record(100) && b.record(200), 'first 3 faults are within budget');
assert(!b.record(300), 'a 4th fault inside the window exhausts the budget');
const c = createErrorBudget(3, 1000);
for (let i = 0; i < 10; i++) assert(c.record(i * 2000), 'spaced-out faults never exhaust the budget');
console.log('✓ process guards: isolated faults survive, bursts trigger a clean restart');
