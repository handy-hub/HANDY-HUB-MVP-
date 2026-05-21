import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    where,
    orderBy,
    limit,
    startAfter,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseDb, firestoreDatabaseId } from "./firebaseConfig.js";

/**
 * Builds a Firestore Query from a plain-object description.
 *
 * conditions  — array of { field, op, value }
 * options     — { orderBy, limit, startAfter }
 *   orderBy   — string  OR  { field, direction }  OR  array of either
 */
function buildQuery(collectionRef, conditions = [], options = {}) {
    const constraints = [];

    (conditions || []).forEach(({ field, op, value }) => {
        constraints.push(where(field, op, value));
    });

    const orders = options.orderBy
        ? (Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy])
        : [];

    orders.forEach((o) => {
        if (typeof o === "string") {
            constraints.push(orderBy(o));
        } else {
            constraints.push(orderBy(o.field, o.direction || "asc"));
        }
    });

    if (options.limit) {
        constraints.push(limit(options.limit));
    }

    if (options.startAfter) {
        constraints.push(startAfter(options.startAfter));
    }

    return query(collectionRef, ...constraints);
}

function toRecord(docSnapshot) {
    return { id: docSnapshot.id, data: docSnapshot.data() };
}

export function createFirebaseDatabaseService(dbInstance = firebaseDb) {
    return {

        // ── Original methods (unchanged) ─────────────────────────────────────

        async getDocument(collectionName, documentId) {
            const reference = doc(dbInstance, collectionName, documentId);
            const snapshot  = await getDoc(reference);
            return {
                exists: snapshot.exists(),
                id:     snapshot.id,
                data:   snapshot.exists() ? snapshot.data() : null
            };
        },

        async setDocument(collectionName, documentId, data, options = {}) {
            const reference = doc(dbInstance, collectionName, documentId);
            await setDoc(reference, data, options);
        },

        async queryByField(collectionName, fieldName, operator, value) {
            const q        = query(collection(dbInstance, collectionName), where(fieldName, operator, value));
            const snapshot = await getDocs(q);
            return snapshot.docs.map(toRecord);
        },

        getMetadata() {
            return {
                projectId:  dbInstance.app.options.projectId,
                databaseId: firestoreDatabaseId
            };
        },

        // ── Document CRUD ────────────────────────────────────────────────────

        /** Create a document with an auto-generated ID. Returns the new doc ID. */
        async addDocument(collectionName, data) {
            const ref = await addDoc(collection(dbInstance, collectionName), data);
            return ref.id;
        },

        /** Partial update — only the supplied fields are changed. */
        async updateDocument(collectionName, documentId, data) {
            await updateDoc(doc(dbInstance, collectionName, documentId), data);
        },

        async deleteDocument(collectionName, documentId) {
            await deleteDoc(doc(dbInstance, collectionName, documentId));
        },

        // ── Flexible queries ─────────────────────────────────────────────────

        /**
         * One-shot query with multiple where clauses, ordering, and limit.
         *
         * conditions: [{ field, op, value }, ...]
         * options:    { orderBy, limit, startAfter }
         */
        async queryWithOptions(collectionName, conditions = [], options = {}) {
            const q        = buildQuery(collection(dbInstance, collectionName), conditions, options);
            const snapshot = await getDocs(q);
            return snapshot.docs.map(toRecord);
        },

        /**
         * Real-time listener on a collection.
         * Returns an unsubscribe function.
         */
        subscribeToCollection(collectionName, conditions, options, onChange, onError) {
            const q = buildQuery(collection(dbInstance, collectionName), conditions, options);
            return onSnapshot(
                q,
                (snapshot) => onChange(snapshot.docs.map(toRecord)),
                (err)      => { if (onError) onError(err); }
            );
        },

        // ── Sub-collection CRUD ──────────────────────────────────────────────

        /** Add a document to a sub-collection. Returns the new doc ID. */
        async addSubDocument(collectionName, documentId, subCollectionName, data) {
            const subRef = collection(dbInstance, collectionName, documentId, subCollectionName);
            const ref    = await addDoc(subRef, data);
            return ref.id;
        },

        /** Partial update of a specific sub-collection document. */
        async updateSubDocument(collectionName, documentId, subCollectionName, subDocumentId, data) {
            const ref = doc(dbInstance, collectionName, documentId, subCollectionName, subDocumentId);
            await updateDoc(ref, data);
        },

        /** One-shot query on a sub-collection. */
        async querySubCollection(collectionName, documentId, subCollectionName, conditions = [], options = {}) {
            const subRef   = collection(dbInstance, collectionName, documentId, subCollectionName);
            const q        = buildQuery(subRef, conditions, options);
            const snapshot = await getDocs(q);
            return snapshot.docs.map(toRecord);
        },

        /** Real-time listener on a sub-collection. Returns an unsubscribe function. */
        subscribeToSubCollection(collectionName, documentId, subCollectionName, conditions, options, onChange, onError) {
            const subRef = collection(dbInstance, collectionName, documentId, subCollectionName);
            const q      = buildQuery(subRef, conditions, options);
            return onSnapshot(
                q,
                (snapshot) => onChange(snapshot.docs.map(toRecord)),
                (err)      => { if (onError) onError(err); }
            );
        },

        /** Real-time listener on a single document. Returns an unsubscribe function. */
        subscribeToDocument(collectionName, docId, onChange, onError) {
            const docRef = doc(dbInstance, collectionName, docId);
            return onSnapshot(
                docRef,
                (snap) => onChange({ id: snap.id, exists: snap.exists(), data: snap.exists() ? snap.data() : null }),
                (err)  => { if (onError) onError(err); }
            );
        }
    };
}
