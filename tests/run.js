'use strict';
// Runs every *.test.js file in this folder inside this one Node.js process.
//
// `node --test` starts a separate child process for each test file. Some
// Windows setups don't allow that (the tests fail with "spawn EPERM"), and
// the option to turn it off only exists in newer Node.js versions. Loading
// the files here needs no child processes and behaves the same everywhere.
//
// Usage: npm test   (or: node tests/run.js)

const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).sort();
if (files.length === 0) {
  console.error('No test files found in ' + __dirname);
  process.exitCode = 1;
}
for (const name of files) require(path.join(__dirname, name));
