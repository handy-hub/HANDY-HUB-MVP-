const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'customer-app/transaction-history.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'customer-app/css/transaction-history.css'), 'utf8');

assert.match(html, /import\s*{\s*openSheet\s*}\s*from\s*'\.\.\/shared\/js\/components\/sheet\.js'/);
assert.match(html, /openSheet\(\{[\s\S]*?id:\s*'transaction-receipt'/);
assert.match(html, /dismissible:\s*{\s*backdrop:\s*true,\s*swipe:\s*true,\s*escape:\s*true\s*}/);
assert.match(html, /class="txn-item"[^>]*role="button"[^>]*tabindex="0"/);
assert.doesNotMatch(html, /id="receipt-overlay"/);
assert.doesNotMatch(css, /\.receipt-(?:overlay|backdrop|sheet)\s*{/);
assert.match(css, /\.receipt-content\s*{/);
assert.doesNotMatch(html, /HANDYHUB RECEIPT|receipt-close/);

console.log('Transaction receipt uses the canonical shared sheet.');
