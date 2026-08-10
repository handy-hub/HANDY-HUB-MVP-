'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const backend = read('functions/profilePhotos.js');
const service = read('shared/js/services/profilePhotoService.js');
const customer = read('customer-app/js/pages/profilePage.js');
const artisan = read('artisan-app/profile.html');
const onboarding = read('artisan-app/onboarding.html');

assert.match(backend, /runTransaction/, 'metadata replacement must be transactional');
assert.match(backend, /previousPublicId/, 'old metadata must come from server state');
assert.match(backend, /ownsProfileAsset/, 'destruction must validate folder ownership');
assert.match(backend, /_cloudinary_cleanup_jobs/, 'failed deletion must be durable');
assert.match(backend, /createHash\('sha1'\)/, 'Cloudinary destroy requests must be signed');
assert.doesNotMatch(service, /CLOUDINARY_API_SECRET|api_secret/, 'frontend must not contain deletion credentials');
assert.match(service, /beginProfilePhotoReplacement/);
assert.match(service, /commitProfilePhotoReplacement/);
assert.match(service, /abortProfilePhotoReplacement/);

for (const [name, source] of Object.entries({ customer, artisan, onboarding })) {
  assert.match(source, /replaceProfilePhoto/, `${name} must use the shared lifecycle`);
  assert.doesNotMatch(source, /UPLO.*PRESETS\.profile/, `${name} must not bypass the lifecycle`);
}

console.log('Profile photo lifecycle architecture checks passed.');
