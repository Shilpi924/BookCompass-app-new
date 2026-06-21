import { initializeApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "firebase/app-check";
import { getAnalytics, logEvent as firebaseLogEvent } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "YOUR_KEY",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "YOUR_APP_ID",
  measurementId:
    import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "YOUR_MEASUREMENT_ID",
};

const isFirebaseConfigured =
  firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== "YOUR_KEY" &&
  firebaseConfig.projectId &&
  firebaseConfig.projectId !== "YOUR_PROJECT_ID";

let app = null;
let analytics = null;
let auth = null;
let db = null;
let appCheck = null;
let cloudFunctions = null;

try {
  if (isFirebaseConfigured) {
    app = initializeApp(firebaseConfig);
    analytics = getAnalytics(app);
    auth = getAuth(app);
    db = getFirestore(app);
    cloudFunctions = getFunctions(app, "us-central1");

    if (import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY) {
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(
          import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY
        ),
        isTokenAutoRefreshEnabled: true,
      });
    }
  } else {
    console.warn("Firebase: Using placeholder config. Firebase services disabled.");
  }
} catch (error) {
  console.error("Firebase failed to initialize:", error);
}

export { analytics, app, appCheck, auth, cloudFunctions, db, isFirebaseConfigured };
export function logEvent(analyticsInstance, eventName, eventParams) {
  if (analyticsInstance) {
    try {
      firebaseLogEvent(analyticsInstance, eventName, eventParams);
    } catch (err) {
      console.error("Firebase logEvent failed:", err);
    }
  }
}
