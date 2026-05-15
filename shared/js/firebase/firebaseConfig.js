// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw",
  authDomain: "lamax-4fd82.firebaseapp.com",
  projectId: "lamax-4fd82",
  storageBucket: "lamax-4fd82.firebasestorage.app",
  messagingSenderId: "1034220501833",
  appId: "1:1034220501833:web:bba9ad6f78881029a0f898"
};

const app = initializeApp(firebaseConfig);
export const firestoreDatabaseId = "ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6";
export const auth = getAuth(app);
export const db = getFirestore(app, firestoreDatabaseId);
