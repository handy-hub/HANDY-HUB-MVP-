'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'shared', 'js', 'services', 'mapsLoader.js'),
  path.join(__dirname, '..', 'shared', 'js', 'services', 'placesService.js'),
];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /loading\s*:\s*'async'|loading=async/, `${path.basename(file)} must include the async-loading bootstrap flag`);
  assert.match(src, /s\.async\s*=\s*true/, `${path.basename(file)} must set script.async = true`);
}

console.log('google maps async loader regression checks: PASS');
