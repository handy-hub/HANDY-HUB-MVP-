import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { firebaseApp } from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION } from '../config/appConfig.js';
import { uploadImage, UPLOAD_PRESETS } from './cloudinaryService.js';

let functionsInstance;
const activeReplacements = new Map();

function functions() {
  if (!functionsInstance) functionsInstance = getFunctions(firebaseApp, FUNCTIONS_REGION);
  return functionsInstance;
}

async function call(name, data) {
  const result = await httpsCallable(functions(), name)(data);
  return result.data;
}

/**
 * The canonical customer/artisan profile-photo replacement flow.
 * The backend allocates the public id and owns all destructive decisions.
 */
export function replaceProfilePhoto(file, accountType) {
  if (!['customer', 'artisan'].includes(accountType)) {
    return Promise.reject(new Error('Invalid account type.'));
  }
  if (activeReplacements.has(accountType)) return activeReplacements.get(accountType);

  const task = (async () => {
    const operation = await call('beginProfilePhotoReplacement', { accountType });
    try {
      const uploaded = await uploadImage(file, UPLOAD_PRESETS.profile, { publicId: operation.publicId });
      if (uploaded.publicId !== operation.publicId) throw new Error('Storage returned an unexpected asset id.');
      return await call('commitProfilePhotoReplacement', {
        operationId: operation.operationId,
        version: uploaded.version,
      });
    } catch (error) {
      await call('abortProfilePhotoReplacement', { operationId: operation.operationId }).catch(() => {});
      throw error;
    }
  })().finally(() => activeReplacements.delete(accountType));

  activeReplacements.set(accountType, task);
  return task;
}
