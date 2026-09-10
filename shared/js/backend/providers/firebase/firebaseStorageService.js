import {
  getDownloadURL,
  ref,
  uploadBytes
} from "../../../../vendor/firebase/firebase-storage.js";
import { firebaseStorage } from "./firebaseConfig.js";

export function createFirebaseStorageService(storageInstance = firebaseStorage) {
  return {
    async uploadFile(path, file, metadata = {}) {
      const fileRef = ref(storageInstance, path);
      const uploadResult = await uploadBytes(fileRef, file, metadata);

      return {
        fullPath: uploadResult.metadata.fullPath,
        name: uploadResult.metadata.name
      };
    },

    async getDownloadUrl(path) {
      const fileRef = ref(storageInstance, path);
      return getDownloadURL(fileRef);
    }
  };
}

