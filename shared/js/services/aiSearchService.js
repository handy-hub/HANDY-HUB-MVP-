import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { firebaseApp }
    from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION }
    from '../config/appConfig.js';

let _functions = null;
function fn() {
    if (!_functions) _functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _functions;
}

/**
 * Interpret a natural-language search query using Claude AI.
 * Returns { searchTerms, category, interpretation } or null on any failure
 * so callers can fall back to raw Firestore search gracefully.
 *
 * @param {string} query  Raw user input, e.g. "my ceiling is leaking"
 * @returns {Promise<{ searchTerms: string[], category: string, interpretation: string } | null>}
 */
export async function interpretSearch(query) {
    try {
        const callable = httpsCallable(fn(), 'aiSearch');
        const { data } = await callable({ query });
        return data;
    } catch {
        return null;
    }
}
