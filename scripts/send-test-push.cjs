#!/usr/bin/env node
'use strict';

/**
 * scripts/send-test-push.cjs — the authorised way to prove a push reaches a device.
 *
 * Registration succeeding is not delivery. This sends ONE test notification to
 * the token a signed-in user's device saved, built by the same code the Cloud
 * Functions use (functions/notifications.js buildFcmMessage), so what arrives is
 * exactly what a real notification looks like on that platform.
 *
 * It touches nothing else: no bookings, no money, no writes. Without --send it
 * only shows what it would send.
 *
 * Usage (from the repo root; needs `gcloud auth application-default login`):
 *   node scripts/send-test-push.cjs --project <project> --role artisan --uid <uid>
 *   node scripts/send-test-push.cjs --project <project> --role artisan --uid <uid> --validate
 *   node scripts/send-test-push.cjs --project <project> --role artisan --uid <uid> --send
 *
 *   --project   required, named explicitly (lamax-staging, or lamax-4fd82 for a pilot device)
 *   --role      artisan | customer
 *   --uid       the user whose device should receive it
 *   --database  Firestore database id (default: functions/config.js FIRESTORE_DB_ID)
 *   --validate  ask FCM to validate the message and token WITHOUT delivering it
 *   --send      deliver it
 *
 * See docs/PUSH_NOTIFICATIONS.md for the full manual check.
 */

const path = require('path');
const { createRequire } = require('module');

const FN = path.join(__dirname, '..', 'functions');
const fnRequire = createRequire(path.join(FN, 'package.json'));

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes(`--${name}`);

const project = arg('project');
const role    = arg('role');
const uid     = arg('uid');
if (!project || !uid || !['artisan', 'customer'].includes(role)) {
    console.error('Usage: node scripts/send-test-push.cjs --project <project> --role artisan|customer --uid <uid> [--validate | --send]');
    process.exit(2);
}

(async () => {
    process.env.GCLOUD_PROJECT = project;
    const { initializeApp } = fnRequire('firebase-admin/app');
    initializeApp({ projectId: project });
    const { getFirestore } = fnRequire('firebase-admin/firestore');
    const { getMessaging } = fnRequire('firebase-admin/messaging');
    const { FIRESTORE_DB_ID } = require(path.join(FN, 'config.js'));
    const { buildFcmMessage } = require(path.join(FN, 'notifications.js'));

    const database = arg('database') || FIRESTORE_DB_ID;
    const col = role === 'artisan' ? 'artisans' : 'customers';
    const snap = await getFirestore(database).collection(col).doc(uid).get();
    if (!snap.exists) { console.error(`No ${col}/${uid} in ${project}/${database}.`); process.exit(1); }
    const { fcmToken, fcmPlatform, fcmTokenUpdatedAt } = snap.data();
    if (!fcmToken) {
        console.error(`${col}/${uid} has no fcmToken: this device never completed push registration.`);
        console.error('Open the app on the device, allow notifications, reload, and run this again.');
        process.exit(1);
    }
    const masked = `${String(fcmToken).slice(0, 8)}…${String(fcmToken).slice(-4)}`;
    console.log(`Token ${masked}  platform=${fcmPlatform || '(unset → web)'}  saved=${fcmTokenUpdatedAt || '(unknown)'}`);

    const message = buildFcmMessage({
        token: fcmToken,
        platform: fcmPlatform,
        type: 'System',
        userType: role,
        data: {
            title: 'Fidus X test notification',
            message: 'If you can read this, push works on this device.',
            actionUrl: 'dashboard.html',
        },
    });
    console.log('Message:', JSON.stringify({ ...message, token: masked }, null, 2));

    if (!flag('send') && !flag('validate')) {
        console.log('\nDry run — nothing sent. Add --validate to check with FCM, or --send to deliver.');
        return;
    }
    try {
        const id = await getMessaging().send(message, flag('validate'));
        console.log(flag('validate') ? `\nFCM accepted the message and token (validate only, not delivered): ${id}`
                                     : `\nSent: ${id}\nNow confirm it appeared on the device.`);
    } catch (err) {
        console.error(`\nFCM refused it: ${err.code || ''} ${err.message}`);
        if (/registration-token-not-registered|invalid-registration-token/.test(err.code || '')) {
            console.error('The token is dead. The app will save a fresh one on its next load with notifications allowed.');
        }
        process.exit(1);
    }
})().catch((err) => { console.error(err.message); process.exit(1); });
