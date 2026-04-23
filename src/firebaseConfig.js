// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getStorage } from "firebase/storage";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBADiOKusl7ImUMSmO5C4G80xGbp-aEur4",
  authDomain: "face-recognition-d19b052.firebaseapp.com",
  databaseURL: "https://face-recognition-d19b052-default-rtdb.firebaseio.com",
  projectId: "face-recognition-d19b052",
  storageBucket: "face-recognition-d19b052.firebasestorage.app",
  messagingSenderId: "888858885482",
  appId: "1:888858885482:web:1e1b88f872cf077bfbf913",
  measurementId: "G-K792L9KECY"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
export const storage = getStorage(app);   // For uploading images
export const db = getFirestore(app);       // For storing metadata in Firestore