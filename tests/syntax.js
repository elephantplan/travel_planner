// Every inline <script> in the pages must parse. A bad edit once turned a
// regex into a syntax error and the whole trip page stopped loading; the
// browser tests only noticed by timing out.
//
//   node tests/syntax.js
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
for (const f of ['trip.html', 'index.html']){
  const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !/type="(application\/ld\+json|text\/template)"/.test(m[1]));
  scripts.forEach((m, k) => {
    try { new vm.Script(m[2], { filename: `${f}#${k}` }); pass++; console.log(`  ok   ${f} script ${k + 1} parses`); }
    catch (e){ fail++; console.log(`  FAIL ${f} script ${k + 1}: ${e.message}`); }
  });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
