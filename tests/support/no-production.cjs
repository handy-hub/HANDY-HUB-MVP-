'use strict';

/**
 * tests/support/no-production.cjs — the first thing every test loads.
 * scripts/check-test-safety.cjs (npm run lint:tests) fails when one doesn't.
 *
 * This machine has gcloud application-default credentials, so firebase-admin
 * inside a test can reach PRODUCTION. On 2026-10-22 one did: a test that loaded
 * functions/index.js wrote _rate_limits/u_verifyTopupNow to the live database.
 *
 * Here every Google client in the process authenticates with a credential that
 * cannot work, and child processes inherit it through the environment. The SDKs
 * still initialise (functions/index.js loads), the emulators still work (they
 * need no credentials), and anything that would have reached a real Google
 * service is refused with `invalid_client`.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const credentialPath = path.join(os.tmpdir(), 'fidusx-tests-no-production-credential.json');
if (!fs.existsSync(credentialPath)) {
    fs.writeFileSync(credentialPath, JSON.stringify({
        type:          'authorized_user',
        client_id:     'fidusx-tests-no-production',
        client_secret: 'fidusx-tests-no-production',
        refresh_token: 'fidusx-tests-no-production',
    }));
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
