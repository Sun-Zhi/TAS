'use strict';

const assert = require('node:assert/strict');
const { toCSV } = require('../src/utils');

const csv = toCSV([['=1+1', '+cmd', '-2+3', '@SUM(A1:A2)', '  =hidden', '普通文本']]);
assert.match(csv, /'=1\+1/);
assert.match(csv, /'\+cmd/);
assert.match(csv, /'-2\+3/);
assert.match(csv, /'@SUM\(A1:A2\)/);
assert.match(csv, /'  =hidden/);
assert.match(csv, /普通文本/);

console.log('utils regression: ok');
