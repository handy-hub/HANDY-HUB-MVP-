import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseDb, firestoreDatabaseId } from "./firebaseConfig.js";

export function createFirebaseDatabaseService(dbInstance = firebaseDb) {
  return {
    async getDocument(collectionName, documentId) {
      const reference = doc(dbInstance, collectionName, documentId);
      const snapshot = await getDoc(reference);

      return {
        exists: snapshot.exists(),
        id: snapshot.id,
        data: snapshot.exists() ? snapshot.data() : null
      };
    },

    async setDocument(collectionName, documentId, data, options = {}) {
      const reference = doc(dbInstance, collectionName, documentId);
      await setDoc(reference, data, options);
    },

    async queryByField(collectionName, fieldName, operator, value) {
      const lookup = query(
        collection(dbInstance, collectionName),
        where(fieldName, operator, value)
      );
      const snapshot = await getDocs(lookup);

      return snapshot.docs.map((documentSnapshot) => ({
        id: documentSnapshot.id,
        data: documentSnapshot.data()
      }));
    },

    getMetadata() {
      return {
        projectId: dbInstance.app.options.projectId,
        databaseId: firestoreDatabaseId
      };
    }
  };
}

