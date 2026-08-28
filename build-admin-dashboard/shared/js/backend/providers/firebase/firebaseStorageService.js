import {
  getDownloadURL,
  ref,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
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

