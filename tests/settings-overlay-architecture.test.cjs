const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sheetCss = read('shared/css/components/sheet.css');
const modalCss = read('shared/css/components/modal.css');
const dismissJs = read('shared/js/utils/sheetDismiss.js');
const settingsCss = read('customer-app/css/settings.css');
const settingsHtml = read('customer-app/settings.html');
const polishCss = read('shared/css/ui-polish.css');

assert.match(sheetCss, /\.ui-sheet-overlay::before\s*{/);
assert.match(sheetCss, /\.ui-sheet-overlay\.open\s*{[^}]*--ui-backdrop-opacity:\s*1/s);
assert.doesNotMatch(sheetCss, /\.ui-sheet-overlay\.open\s*{[^}]*(?:^|[;{])\s*opacity:\s*1/sm);
assert.match(modalCss, /\.ui-modal-overlay::before\s*{/);
assert.doesNotMatch(modalCss, /\.ui-modal-overlay\.open\s*{[^}]*(?:^|[;{])\s*opacity:\s*1/sm);
assert.doesNotMatch(dismissJs, /overlayEl\.style\.opacity/);
assert.match(dismissJs, /--ui-backdrop-opacity/);
assert.match(settingsCss, /\.modal-backdrop\s*{/);
assert.match(settingsCss, /\.modal-overlay\s*{[^}]*visibility:\s*hidden/s);
assert.match(settingsCss, /\.modal-overlay\.visible\s*{[^}]*visibility:\s*visible/s);
assert.match(settingsCss, /\.modal-card\s*{[^}]*background-color:\s*var\(--ui-surface,\s*#fff\)/s);
assert.match(settingsHtml, /role="dialog" aria-modal="true"/);
assert.match(settingsHtml, /class="modal-backdrop"/);
assert.match(settingsHtml, /document\.body\.style\.overflow = 'hidden'/);
assert.match(settingsHtml, /e\.key === 'Escape'/);
assert.match(settingsHtml, /closeAll\(false\)/);
assert.match(polishCss, /\.overlay-backdrop\s*{[^}]*z-index:\s*calc\(var\(--ui-z-drawer,\s*800\)\s*-\s*1\)\s*!important/s);
assert.doesNotMatch(polishCss, /\.overlay-backdrop\s*,[\s\S]*?z-index:\s*1900\s*!important/);

console.log('Settings overlay architecture regression checks passed.');
