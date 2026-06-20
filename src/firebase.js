import { initializeApp } from "firebase/app";
import { getAnalytics, logEvent as firebaseLogEvent } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID",
};

let analytics = null;
try {
  if (firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_KEY" && firebaseConfig.projectId !== "YOUR_PROJECT_ID") {
    const app = initializeApp(firebaseConfig);
    analytics = getAnalytics(app);
  } else {
    console.warn("Firebase: Using placeholder config. Analytics disabled.");
  }
} catch (error) {
  console.error("Firebase analytics failed to initialize:", error);
}

export { analytics };
export function logEvent(analyticsInstance, eventName, eventParams) {
  if (analyticsInstance) {
    try {
      firebaseLogEvent(analyticsInstance, eventName, eventParams);
    } catch (err) {
      console.error("Firebase logEvent failed:", err);
    }
  }
}