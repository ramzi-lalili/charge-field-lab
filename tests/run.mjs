// Run with:  node tests/run.mjs
import { runPhysicsTests } from './physics.tests.js';
const res = runPhysicsTests();
let bad = 0;
for (const r of res) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
}
console.log(`\n${res.length - bad}/${res.length} passed`);
process.exit(bad ? 1 : 0);
