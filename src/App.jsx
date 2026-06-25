import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  addDoc,
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import {
  analytics,
  auth,
  cloudFunctions,
  db,
  isFirebaseConfigured,
  logEvent,
} from "./firebase";

const googleBooksApiKey = import.meta.env.GOOGLE_BOOKS_API_KEY;
const firebaseProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "lumina-kaboom";
const firestoreConsoleUrl = `https://console.firebase.google.com/project/${firebaseProjectId}/firestore/databases/-default-/data/~2Fusers`;
const firebaseAuthConsoleUrl = `https://console.firebase.google.com/project/${firebaseProjectId}/authentication/users`;
const isNativeApp = Capacitor.isNativePlatform();
const isAndroidApp = Capacitor.getPlatform() === "android";
const NativeSpeech = registerPlugin("NativeSpeech");
const hasNativeFirebaseAuthentication = Capacitor.isPluginAvailable("FirebaseAuthentication");
const isAndroidGoogleSsoConfigured =
  import.meta.env.VITE_ANDROID_GOOGLE_SSO_READY === "true";
const isGeminiConfigured = isFirebaseConfigured;
const MODEL_NAME = "gemini-2.5-flash-lite";
const GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS = 10000;
const GOOGLE_BOOKS_PREVIEW_STALE_MS = GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS + 3000;
const ONE_MINUTE_MS = 60 * 1000;
const DEFAULT_FILTERS = {
  genre: "",
  gradeBand: "",
  readingLevel: "",
  ageRecommendation: "",
  shelfPick: "",
  minRating: "",
};
const FILTER_OPTIONS = {
  gradeBand: ["K-3", "4-6", "7+"],
  readingLevel: ["Easy", "Intermediate", "Advanced"],
  ageRecommendation: ["Kids", "Young Readers", "Teen", "Adult", "All ages"],
  shelfPick: [
    "Top Rated",
    "Hidden Gem",
    "Beginner Friendly",
    "Popular",
    "Educational",
  ],
  minRating: ["3", "3.5", "4", "4.5"],
};
const APP_STATE_DOC = "bookCompass";
const API_USAGE_COLLECTION = "developerApiUsage";
const MAX_DISPLAY_NAME_LENGTH = 24;
const BLOCKED_NAME_TERMS = [
  "admin",
  "administrator",
  "firebase",
  "google",
  "http",
  "https",
  "moderator",
  "support",
  "www",
];
const DAILY_GUEST_SCAN_LIMIT = 12;
const DAILY_USER_SCAN_LIMIT = 30;
const DEVELOPER_EMAILS = ["shilpispin@gmail.com"];
const DEFAULT_FOLDERS = ["Want to read", "For kids", "Gift ideas", "Favorites"];
const HIDDEN_FOLDER_NAMES = new Set(["read aloud", "school"]);
const NEW_FOLDER_OPTION = "__new_folder__";
const MAX_LIBRARY_CARDS = 10;
const MAX_LIBRARY_CARD_NAME_LENGTH = 36;
const MAX_LIBRARY_CARD_NUMBER_LENGTH = 64;
const SECTION_DEFAULT_OPEN = {
  account: true,
  libraryFolders: true,
  savedBooks: true,
  scanResults: true,
};
const CODE_128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213",
  "122312", "132212", "221213", "221312", "231212", "112232", "122132",
  "122231", "113222", "123122", "123221", "223211", "221132", "221231",
  "213212", "223112", "312131", "311222", "321122", "321221", "312212",
  "322112", "322211", "212123", "212321", "232121", "111323", "131123",
  "131321", "112313", "132113", "132311", "211313", "231113", "231311",
  "112133", "112331", "132131", "113123", "113321", "133121", "313121",
  "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111",
  "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114",
  "413111", "241112", "134111", "111242", "121142", "121241", "114212",
  "124112", "124211", "411212", "421112", "421211", "212141", "214121",
  "412121", "111143", "111341", "131141", "114113", "114311", "411113",
  "411311", "113141", "114131", "311141", "411131", "211412", "211214",
  "211232", "2331112",
];

function normalizeFilters(filters) {
  return {
    ...DEFAULT_FILTERS,
    ...(filters && typeof filters === "object" ? filters : {}),
  };
}

function getUserDisplayName(user) {
  return sanitizeDisplayName(user?.displayName || user?.email?.split("@")[0]) || "Reader";
}

function getTimeGreeting(date = new Date()) {
  const hour = date.getHours();

  if (hour < 12) return "good morning";
  if (hour < 17) return "good afternoon";
  if (hour < 22) return "good evening";
  return "good night";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hasDeveloperAccess(user) {
  return DEVELOPER_EMAILS.includes(String(user?.email || "").toLowerCase());
}

function isSyncUser(user) {
  return Boolean(user?.uid && !user.isAnonymous);
}

function sanitizeDisplayName(name) {
  return String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function validatePassword(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a special character.";

  return "";
}

function validateDisplayName(name) {
  const sanitizedName = sanitizeDisplayName(name);
  const normalizedName = normalizeBookText(sanitizedName);

  if (!sanitizedName) return "Enter a display name.";
  if (sanitizedName.length < 3) return "Display name must be at least 3 characters.";
  if (!/^[a-zA-Z0-9 ]+$/.test(sanitizedName)) {
    return "Use only letters, numbers, and spaces in your display name.";
  }
  if (BLOCKED_NAME_TERMS.some((term) => normalizedName.includes(term))) {
    return "Choose a different display name.";
  }

  return "";
}

function getDailyScanUsageKey(user) {
  return `scanUsage:${user?.uid || "guest"}:${getTodayKey()}`;
}

function getDailyScanUsage(user) {
  return readStoredJson(getDailyScanUsageKey(user), {
    count: 0,
    date: getTodayKey(),
  });
}

function canStartScan(user) {
  const usage = getDailyScanUsage(user);
  const scanLimit = user ? DAILY_USER_SCAN_LIMIT : DAILY_GUEST_SCAN_LIMIT;

  return Number(usage.count || 0) < scanLimit;
}

function recordLocalScanUsage(user) {
  const usageKey = getDailyScanUsageKey(user);
  const usage = getDailyScanUsage(user);

  localStorage.setItem(
    usageKey,
    JSON.stringify({
      date: getTodayKey(),
      count: Number(usage.count || 0) + 1,
    })
  );
}

function getScanLimitMessage(user) {
  const scanLimit = user ? DAILY_USER_SCAN_LIMIT : DAILY_GUEST_SCAN_LIMIT;

  return `Daily scan limit reached. ${user ? "" : "Log in for a higher limit. "}Limit: ${scanLimit} scans/day.`;
}

function getUserAppStateRef(uid) {
  if (!db || !uid) return null;
  return doc(db, "users", uid, "appData", APP_STATE_DOC);
}

async function saveUserAppState(uid, appState) {
  const appStateRef = getUserAppStateRef(uid);
  if (!appStateRef) return;

  await setDoc(
    appStateRef,
    {
      ...appState,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function saveUserScan(uid, scanData) {
  if (!db || !uid) return;

  await addDoc(collection(db, "users", uid, "scans"), {
    ...scanData,
    createdAt: serverTimestamp(),
  });
}

function getDeveloperUsageRef(dateKey = getTodayKey()) {
  if (!db) return null;
  return doc(db, API_USAGE_COLLECTION, dateKey);
}

async function recordSuccessfulLogin(user, method = "password") {
  if (!db || !user?.uid) return;

  const userRef = doc(db, "users", user.uid);
  const now = serverTimestamp();

  await setDoc(
    userRef,
    {
      uid: user.uid,
      email: user.email || "",
      displayName: sanitizeDisplayName(getUserDisplayName(user)),
      emailVerified: Boolean(user.emailVerified),
      lastLoginAt: now,
      loginCount: increment(1),
      provider: method,
    },
    { merge: true }
  );

  await addDoc(collection(db, "loginEvents"), {
    userId: user.uid,
    email: user.email || "",
    displayName: sanitizeDisplayName(getUserDisplayName(user)),
    method,
    date: getTodayKey(),
    createdAtMs: Date.now(),
    createdAt: now,
  });
}

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getDefaultGeminiUsage() {
  return {
    date: getTodayKey(),
    count: 0,
    promptTokens: 0,
    requestEvents: [],
    tokenEvents: [],
    lastStatus: "Idle",
    lastType: "",
    lastUpdatedAt: "",
  };
}

function normalizeGeminiUsage(usage) {
  const fallback = getDefaultGeminiUsage();

  if (!usage || usage.date !== fallback.date) return fallback;

  return {
    date: fallback.date,
    count: Number(usage.count || 0),
    promptTokens: Number(usage.promptTokens || 0),
    requestEvents: Array.isArray(usage.requestEvents) ? usage.requestEvents : [],
    tokenEvents: Array.isArray(usage.tokenEvents) ? usage.tokenEvents : [],
    lastStatus: usage.lastStatus || "Idle",
    lastType: usage.lastType || "",
    lastUpdatedAt: usage.lastUpdatedAt || "",
  };
}

function getInitialGeminiUsage() {
  return normalizeGeminiUsage(readStoredJson("geminiDailyUsage", getDefaultGeminiUsage()));
}

function mergeGeminiUsage(cloudUsage, localUsage) {
  const normalizedCloud = normalizeGeminiUsage(cloudUsage);
  const normalizedLocal = normalizeGeminiUsage(localUsage);
  const mergedRequestEvents = Array.from(
    new Set([
      ...getRecentEvents(normalizedCloud.requestEvents),
      ...getRecentEvents(normalizedLocal.requestEvents),
    ])
  );
  const mergedTokenEvents = [
    ...normalizedCloud.tokenEvents,
    ...normalizedLocal.tokenEvents,
  ].filter((event) => {
    if (!event?.at) return false;
    return new Date(event.at).getTime() > Date.now() - ONE_MINUTE_MS;
  });
  const cloudUpdatedAt = new Date(normalizedCloud.lastUpdatedAt || 0).getTime();
  const localUpdatedAt = new Date(normalizedLocal.lastUpdatedAt || 0).getTime();
  const latestUsage = localUpdatedAt > cloudUpdatedAt ? normalizedLocal : normalizedCloud;

  return {
    date: getTodayKey(),
    count: Math.max(normalizedCloud.count, normalizedLocal.count),
    promptTokens: Math.max(
      normalizedCloud.promptTokens,
      normalizedLocal.promptTokens
    ),
    requestEvents: mergedRequestEvents,
    tokenEvents: mergedTokenEvents,
    lastStatus: latestUsage.lastStatus || "Idle",
    lastType: latestUsage.lastType || "",
    lastUpdatedAt: latestUsage.lastUpdatedAt || "",
  };
}

function getDisplayTime(isoDate) {
  if (!isoDate) return "";

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

function getRecentEvents(events, now = Date.now()) {
  return (events || []).filter((event) => {
    const eventTime = new Date(event?.at || event).getTime();
    return Number.isFinite(eventTime) && now - eventTime < ONE_MINUTE_MS;
  });
}

function getPromptTokenCount(result) {
  return Number(result?.usageMetadata?.promptTokenCount || 0);
}

function getTotalTokenCount(result) {
  return Number(
    result?.usageMetadata?.totalTokenCount ||
      result?.usageMetadata?.promptTokenCount ||
      0
  );
}

function getGeminiText(result) {
  return (
    result?.text ||
    result?.candidates?.[0]?.content?.parts?.[0]?.text ||
    ""
  );
}

async function generateGeminiContent(contents, generationConfig = {}, callType = "Gemini call") {
  if (!cloudFunctions) {
    throw new Error("Firebase Functions is not configured.");
  }

  const callable = httpsCallable(cloudFunctions, "generateGeminiContent");
  const response = await callable({ contents, generationConfig, callType });

  return response.data;
}

function getFriendlyScanError(error) {
  const code = String(error?.code || "").toLowerCase();
  const details = String(error?.details?.message || error?.details || "");
  const message = String(error?.message || details || "");
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("high demand") ||
    lowerMessage.includes("try again later") ||
    lowerMessage.includes("temporarily unavailable") ||
    code.includes("unavailable")
  ) {
    return "The scan AI is temporarily busy. Try again in a minute.";
  }
  if (lowerMessage.includes("failed to fetch")) {
    return "Lumina could not reach the scan service. Check your connection and try again.";
  }
  if (lowerMessage.includes("api key") || lowerMessage.includes("key not valid")) {
    return "Gemini is not configured on the server. Check the Firebase Function secret.";
  }
  if (
    code.includes("admin-restricted-operation") ||
    lowerMessage.includes("admin-restricted-operation") ||
    lowerMessage.includes("operation is restricted")
  ) {
    return "Guest scanning needs Anonymous sign-in enabled in Firebase Authentication. Open Firebase Console > Authentication > Sign-in method, then enable Anonymous.";
  }
  if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit") || code.includes("resource-exhausted")) {
    return "Gemini quota or rate limit was reached. Lumina will try Claude fallback when Gemini reports quota exhaustion.";
  }
  if (lowerMessage.includes("too large")) {
    return "That photo is too large. Try a smaller or cropped bookshelf photo.";
  }
  if (lowerMessage.includes("permission") || lowerMessage.includes("forbidden") || code.includes("failed-precondition")) {
    return message || "Gemini rejected this request. Check that the API key allows the Gemini API.";
  }
  if (code.includes("internal") && lowerMessage === "internal") {
    return "The scan service hit an internal error. Try again once; if it repeats, check Firebase Function logs.";
  }

  return message || "Could not scan the bookshelf. Try a clearer photo of book spines.";
}
function getTimestamp() {
  return new Date().getTime();
}

const encodeFileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
  });

function cleanJsonText(text) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    return cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

function safeParseJson(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch (err) {
    console.error("Invalid JSON:", text);
    console.error(err);
    return null;
  }
}

function getBookKey(book) {
  return `${book?.title || ""}-${book?.author || ""}`.toLowerCase();
}

function mergeUniqueByKey(primary = [], secondary = [], getKey = (item) => item?.id) {
  const merged = [];
  const seen = new Set();

  [...primary, ...secondary].forEach((item) => {
    const key = getKey(item);
    if (!item || !key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });

  return merged;
}

function hasActiveFilters(filters) {
  return Object.values(filters || {}).some(Boolean);
}

function getVisibleFolders(folders) {
  return (Array.isArray(folders) ? folders : DEFAULT_FOLDERS).filter(
    (folder) => !HIDDEN_FOLDER_NAMES.has(normalizeBookText(folder))
  );
}

function normalizeBookText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAuthorMatch(book, item) {
  const expectedAuthor = normalizeBookText(book?.author);
  const candidateAuthors = (item?.volumeInfo?.authors || [])
    .map(normalizeBookText)
    .filter(Boolean);

  if (!expectedAuthor || expectedAuthor === "unknown") return true;

  return candidateAuthors.some(
    (author) =>
      author === expectedAuthor ||
      author.includes(expectedAuthor) ||
      expectedAuthor.includes(author)
  );
}

const formatVariantRules = [
  {
    terms: ["graphic novel", "comic", "comics", "manga"],
    allowedBy: ["graphic novel", "comic", "comics", "manga"],
  },
  {
    terms: ["cookbook", "recipe", "recipes", "cooking"],
    allowedBy: ["cookbook", "recipe", "recipes", "cooking"],
  },
  {
    terms: ["study guide", "sparknotes", "cliffsnotes", "summary", "summaries"],
    allowedBy: ["study guide", "sparknotes", "cliffsnotes", "summary"],
  },
  {
    terms: ["coloring book", "activity book", "sticker book"],
    allowedBy: ["coloring book", "activity book", "sticker book"],
  },
];

function hasTextTerm(text, terms) {
  const normalizedText = normalizeBookText(text);
  return terms.some((term) => normalizedText.includes(normalizeBookText(term)));
}

function hasFormatVariantMismatch(book, item) {
  const catalogText = [
    book?.title,
    book?.genre,
    book?.summary,
    book?.whyRead,
    book?.shelfPick,
    book?.readingLevel,
  ].join(" ");
  const candidateText = [
    item?.volumeInfo?.title,
    item?.volumeInfo?.subtitle,
    item?.volumeInfo?.description,
    ...(item?.volumeInfo?.categories || []),
  ].join(" ");

  return formatVariantRules.some(
    ({ terms, allowedBy }) =>
      hasTextTerm(candidateText, terms) && !hasTextTerm(catalogText, allowedBy)
  );
}

function getTitleMatchScore(expectedTitle, candidateTitle) {
  if (candidateTitle === expectedTitle) return 100;
  if (candidateTitle.startsWith(`${expectedTitle} `)) return 75;
  if (expectedTitle.startsWith(`${candidateTitle} `) && candidateTitle.length > 6) {
    return 55;
  }
  if (expectedTitle.length > 12 && candidateTitle.includes(expectedTitle)) return 50;

  return -1;
}

function getLoosePreviewScore(book, item) {
  const expectedTitle = normalizeBookText(book?.title);
  const candidateText = normalizeBookText(
    [
      item?.volumeInfo?.title,
      item?.volumeInfo?.subtitle,
      item?.volumeInfo?.description,
      ...(item?.volumeInfo?.categories || []),
    ].join(" ")
  );
  const words = expectedTitle
    .split(" ")
    .filter((word) => word.length > 2);

  if (words.length < 3) return -1;

  const candidateWords = candidateText.split(" ");
  const matchedWords = words.filter((word) => candidateWords.includes(word));
  const matchRatio = matchedWords.length / words.length;

  if (matchRatio < 0.9) return -1;

  return Math.round(matchRatio * 40);
}

function scoreGoogleBooksMatch(book, item) {
  const expectedTitle = normalizeBookText(book?.title);
  const candidateTitle = normalizeBookText(item?.volumeInfo?.title);
  const expectedAuthor = normalizeBookText(book?.author);
  const expectedWords = expectedTitle.split(" ").filter(Boolean);

  if (!expectedTitle || !candidateTitle) return -1;
  if (hasFormatVariantMismatch(book, item)) return -1;
  if (
    expectedWords.length <= 2 &&
    (!expectedAuthor || expectedAuthor === "unknown") &&
    candidateTitle !== expectedTitle
  ) {
    return -1;
  }

  let score = getTitleMatchScore(expectedTitle, candidateTitle);

  if (score < 0) score = getLoosePreviewScore(book, item);
  if (score < 0) return -1;

  if (hasAuthorMatch(book, item)) score += 25;

  if (item?.accessInfo?.embeddable) score += 10;
  if (item?.accessInfo?.viewability && item.accessInfo.viewability !== "NO_PAGES") {
    score += 5;
  }

  return score;
}

function getGoogleBooksSimilarQuery(book) {
  const terms = [
    book?.genre && `subject:${book.genre}`,
    book?.author &&
      normalizeBookText(book.author) !== "unknown" &&
      `inauthor:${book.author}`,
    book?.title && `intitle:${book.title}`,
  ].filter(Boolean);

  if (terms.length) return terms.join(" ");

  return [book?.title, book?.genre, book?.ageRecommendation]
    .filter(Boolean)
    .join(" ");
}

function mapGoogleBookToCatalogBook(item, selectedBook) {
  const info = item?.volumeInfo || {};
  const categories = Array.isArray(info.categories) ? info.categories : [];
  const title = info.title || "Recommended book";
  const authors = Array.isArray(info.authors) && info.authors.length
    ? info.authors.join(", ")
    : "Unknown";
  const averageRating = Number(info.averageRating || 0);

  return enrichScannedBook({
    title,
    author: authors,
    authorBio: authors === "Unknown"
      ? "Author information unavailable."
      : `${authors} is listed as the author on Google Books.`,
    rating: averageRating || Number(selectedBook?.rating || 4),
    ratingSource: averageRating ? "Google Books" : "Estimated",
    summary: info.description || "Google Books did not provide a description for this recommendation.",
    genre: categories[0] || selectedBook?.genre || "Book",
    readingLevel: selectedBook?.readingLevel || "Intermediate",
    gradeBand: selectedBook?.gradeBand || "",
    ageRecommendation: selectedBook?.ageRecommendation || "All ages",
    whyRead: `Recommended because it shares signals with ${selectedBook?.title || "the selected book"}.`,
    shelfPick: averageRating >= 4 ? "Top Rated" : "Popular",
    googleBooksId: item?.id || "",
    googleBooksCategories: categories,
  });
}

function scoreSimilarGoogleBook(selectedBook, item) {
  const info = item?.volumeInfo || {};
  const selectedTitle = normalizeBookText(selectedBook?.title);
  const candidateTitle = normalizeBookText(info.title);

  if (!candidateTitle || candidateTitle === selectedTitle) return -1;

  const selectedGenre = normalizeBookText(selectedBook?.genre);
  const selectedAuthor = normalizeBookText(selectedBook?.author);
  const selectedAge = normalizeBookText(selectedBook?.ageRecommendation);
  const selectedLevel = normalizeBookText(selectedBook?.readingLevel);
  const candidateText = normalizeBookText(
    [
      info.title,
      info.subtitle,
      info.description,
      ...(info.categories || []),
      ...(info.authors || []),
    ].join(" ")
  );

  let score = 0;
  if (selectedGenre && candidateText.includes(selectedGenre)) score += 35;
  if (
    selectedAuthor &&
    selectedAuthor !== "unknown" &&
    (info.authors || []).map(normalizeBookText).some((author) => author.includes(selectedAuthor))
  ) {
    score += 18;
  }
  if (selectedAge && candidateText.includes(selectedAge)) score += 12;
  if (selectedLevel && candidateText.includes(selectedLevel)) score += 8;
  score += Math.min(Number(info.averageRating || 0) * 6, 30);
  if (info.description) score += 6;
  if ((info.categories || []).length) score += 5;

  return score;
}

function scoreShelfSimilarBook(selectedBook, candidateBook) {
  if (!selectedBook || !candidateBook) return 0;

  const selectedTitle = normalizeBookText(selectedBook.title);
  const candidateTitle = normalizeBookText(candidateBook.title);
  if (!candidateTitle || candidateTitle === selectedTitle) return 0;

  let score = 0;
  const selectedGenre = normalizeBookText(selectedBook.genre);
  const candidateGenre = normalizeBookText(candidateBook.genre);
  const selectedAuthor = normalizeBookText(selectedBook.author);
  const candidateAuthor = normalizeBookText(candidateBook.author);
  const selectedAge = normalizeBookText(selectedBook.ageRecommendation);
  const candidateAge = normalizeBookText(candidateBook.ageRecommendation);
  const selectedLevel = normalizeBookText(selectedBook.readingLevel);
  const candidateLevel = normalizeBookText(candidateBook.readingLevel);
  const selectedGrade = normalizeBookText(selectedBook.gradeBand);
  const candidateGrade = normalizeBookText(candidateBook.gradeBand);
  const selectedPick = normalizeBookText(selectedBook.shelfPick);
  const candidatePick = normalizeBookText(candidateBook.shelfPick);

  if (selectedGenre && selectedGenre === candidateGenre) score += 35;
  if (
    selectedAuthor &&
    selectedAuthor !== "unknown" &&
    selectedAuthor === candidateAuthor
  ) {
    score += 25;
  }
  if (selectedAge && selectedAge === candidateAge) score += 14;
  if (selectedLevel && selectedLevel === candidateLevel) score += 12;
  if (selectedGrade && selectedGrade === candidateGrade) score += 10;
  if (selectedPick && selectedPick === candidatePick) score += 8;

  const ratingGap = Math.abs(
    Number(selectedBook.rating || 0) - Number(candidateBook.rating || 0)
  );
  if (ratingGap <= 0.5) score += 8;
  if (ratingGap <= 1) score += 4;

  return score;
}

function getSafeFileName(text) {
  return normalizeBookText(text).replace(/\s+/g, "-") || "book-preview";
}

function getSavedFileKey(bookTitle, type) {
  return `${type}-${normalizeBookText(bookTitle)}`;
}

function readStoredJson(key, fallbackValue) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallbackValue));
  } catch (err) {
    console.error(`Could not read ${key} from local storage:`, err);
    return fallbackValue;
  }
}

function getBookDetailsPayload(book) {
  return {
    title: book.title,
    author: book.author,
    authorBio: book.authorBio,
    rating: book.rating,
    ratingSource: book.ratingSource,
    genre: book.genre,
    readingLevel: book.readingLevel,
    gradeBand: book.gradeBand,
    ageRecommendation: book.ageRecommendation,
    shelfPick: book.shelfPick,
    whyRead: book.whyRead,
    summary: book.summary,
  };
}

function getSavedFileType(file) {
  return file?.payload?.preview ? "preview" : "details";
}

function normalizeSavedFile(file) {
  const type = file?.type || getSavedFileType(file);
  const bookTitle = file?.bookTitle || file?.payload?.catalogBook?.title || "Saved book";

  return {
    ...file,
    id: getSavedFileKey(bookTitle, type),
    name: file?.name || `${bookTitle} ${type}`,
    bookTitle,
    location: file?.location || "This phone",
    type,
  };
}

function normalizeSavedFiles(files) {
  const savedById = new Map();

  files.map(normalizeSavedFile).forEach((file) => {
    if (!savedById.has(file.id)) {
      savedById.set(file.id, file);
    }
  });

  return [...savedById.values()];
}

function sanitizeLibraryCardName(name) {
  return String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LIBRARY_CARD_NAME_LENGTH);
}

function sanitizeLibraryCardNumber(number) {
  return String(number || "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LIBRARY_CARD_NUMBER_LENGTH);
}

function normalizeLibraryCard(card) {
  const cardNumber = sanitizeLibraryCardNumber(card?.cardNumber);
  const normalizedCardNumber = normalizeBookText(cardNumber).replace(/\s+/g, "-");
  const fallbackId = normalizedCardNumber
    ? `library-card-${normalizedCardNumber}`
    : `library-card-${Date.now()}`;

  return {
    id: card?.id || fallbackId,
    name: sanitizeLibraryCardName(card?.name) || "Library card",
    cardNumber,
    barcodeFormat: card?.barcodeFormat || "CODE_128",
    imageDataUrl:
      typeof card?.imageDataUrl === "string" && card.imageDataUrl.startsWith("data:image/")
        ? card.imageDataUrl
        : "",
    imageName: sanitizeLibraryCardName(card?.imageName) || "",
    addedAt: card?.addedAt || new Date().toISOString(),
  };
}

function normalizeLibraryCards(cards) {
  const cardsById = new Map();

  (Array.isArray(cards) ? cards : [])
    .map(normalizeLibraryCard)
    .filter((card) => card.cardNumber)
    .forEach((card) => {
      if (!cardsById.has(card.id)) cardsById.set(card.id, card);
    });

  return [...cardsById.values()]
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .slice(0, MAX_LIBRARY_CARDS);
}

function getCode128Pattern(value) {
  const text = sanitizeLibraryCardNumber(value);
  if (!text) return "";

  const values = [104];
  for (const character of text) {
    const code = character.charCodeAt(0);
    values.push(code >= 32 && code <= 126 ? code - 32 : 0);
  }

  const checksum =
    values[0] + values.slice(1).reduce((sum, code, index) => sum + code * (index + 1), 0);
  values.push(checksum % 103, 106);

  return values.map((code) => CODE_128_PATTERNS[code]).join("");
}

function getCode128Bars(value) {
  const pattern = getCode128Pattern(value);
  let x = 0;
  const bars = [];

  pattern.split("").forEach((widthText, index) => {
    const width = Number(widthText);
    if (index % 2 === 0) bars.push({ x, width });
    x += width;
  });

  return { bars, width: x };
}

function getImageDataUrl(file, maxWidth = 700) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxWidth / Math.max(1, image.width));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.74));
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getSavedBookGroups(files) {
  const savedByBook = new Map();

  files.forEach((file) => {
    const bookTitle = file?.bookTitle || file?.payload?.catalogBook?.title || "Saved book";
    const bookAuthor = file?.payload?.catalogBook?.author || "";
    const bookKey =
      [normalizeBookText(bookTitle), normalizeBookText(bookAuthor)]
        .filter(Boolean)
        .join("-") ||
      file?.id ||
      bookTitle;
    const savedAt = file?.savedAt || new Date().toISOString();
    const preview = file?.payload?.preview;
    const existing = savedByBook.get(bookKey) || {
      id: bookKey,
      ids: [],
      bookTitle,
      catalogBook: null,
      preview: null,
      location: file?.location || "This phone",
      savedAt,
    };

    existing.ids.push(file.id);
    existing.bookTitle = existing.bookTitle || bookTitle;
    existing.location = file?.location || existing.location;

    if (!existing.catalogBook || getSavedFileType(file) === "details") {
      existing.catalogBook = file?.payload?.catalogBook || existing.catalogBook;
    }

    if (
      preview &&
      (!existing.preview ||
        preview.status === "ready" ||
        existing.preview.status !== "ready")
    ) {
      existing.preview = preview;
    }

    if (new Date(savedAt).getTime() > new Date(existing.savedAt).getTime()) {
      existing.savedAt = savedAt;
    }

    savedByBook.set(bookKey, existing);
  });

  return [...savedByBook.values()].sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
  );
}

function canOpenSavedBookPreview(savedBook) {
  return (
    savedBook?.preview?.status === "ready" && Boolean(savedBook.preview.embedUrl)
  );
}

function getScopedSaveStatus(saveStatus, book, type) {
  if (!saveStatus?.message || !book?.title) return "";

  return saveStatus.bookKey === getSavedFileKey(book.title, type)
    ? saveStatus.message
    : "";
}

function getComparedValue(book, field, fallback = "Not listed") {
  return book?.[field] || fallback;
}

function getShelfPickStyle(shelfPick) {
  const pick = normalizeBookText(shelfPick);

  if (pick.includes("popular")) {
    return {
      background: "rgba(26, 115, 232, 0.16)",
      color: "#2563eb",
      border: "1px solid rgba(37, 99, 235, 0.32)",
    };
  }

  if (pick.includes("top rated")) {
    return {
      background: "rgba(245, 158, 11, 0.14)",
      color: "#92400e",
      border: "1px solid rgba(245, 158, 11, 0.32)",
    };
  }

  if (pick.includes("hidden gem")) {
    return {
      background: "rgba(24, 121, 78, 0.14)",
      color: "#A7D7B8",
      border: "1px solid rgba(24, 121, 78, 0.32)",
    };
  }

  if (pick.includes("beginner")) {
    return {
      background: "rgba(220, 38, 38, 0.14)",
      color: "#b91c1c",
      border: "1px solid rgba(220, 38, 38, 0.32)",
    };
  }

  return {
    background: "rgba(154, 160, 166, 0.16)",
    color: "#243044",
    border: "1px solid rgba(154, 160, 166, 0.28)",
  };
}

function getGoogleBooksQuery(book) {
  const title = book?.title || "";
  const author =
    book?.author && book.author !== "Unknown" ? book.author : "";

  return [title, author].filter(Boolean).join(" ");
}

function getGoogleBooksEmbedUrl(volumeId) {
  if (!volumeId) return "";

  const params = new URLSearchParams({
    id: volumeId,
    output: "embed",
    pg: "PP1",
  });

  return `https://books.google.com/books?${params}`;
}

function getTheme(book) {
  const text = `${book?.gradeBand || ""} ${book?.readingLevel || ""} ${
    book?.ageRecommendation || ""
  }`.toLowerCase();

  if (
    text.includes("k-3") ||
    text.includes("grade 3") ||
    text.includes("kids") ||
    text.includes("easy")
  ) {
    return {
      name: "kids",
      cardBg: "#ffffff",
      imageBg: "linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(24, 121, 78, 0.16))",
      border: "#dde5f0",
      title: "#172033",
      badgeBg: "rgba(37, 99, 235, 0.14)",
      badgeText: "#2563eb",
    };
  }

  if (
    text.includes("4-6") ||
    text.includes("grade 4") ||
    text.includes("grade 5") ||
    text.includes("grade 6") ||
    text.includes("young") ||
    text.includes("intermediate")
  ) {
    return {
      name: "young",
      cardBg: "#ffffff",
      imageBg: "linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(220, 38, 38, 0.14))",
      border: "#dde5f0",
      title: "#172033",
      badgeBg: "rgba(245, 158, 11, 0.13)",
      badgeText: "#92400e",
    };
  }

  return {
    name: "teen",
    cardBg: "#ffffff",
    imageBg: "linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(168, 85, 247, 0.14))",
    border: "#dde5f0",
    title: "#172033",
    badgeBg: "rgba(24, 121, 78, 0.14)",
    badgeText: "#A7D7B8",
  };
}

function getBookSearchText(book) {
  return [
    book?.title,
    book?.author,
    book?.authorBio,
    book?.genre,
    book?.summary,
    book?.shelfPick,
    book?.readingLevel,
    book?.gradeBand,
    book?.ageRecommendation,
    book?.whyRead,
    book?.ratingSource,
    String(book?.rating || ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getSearchIntent(searchText) {
  const rawSearch = String(searchText || "").toLowerCase();
  const normalized = normalizeBookText(searchText);
  const minRatingMatch = normalized.match(
    /\b(?:rating|rated|stars?)?\s*(?:above|over|at least|more than|greater than)\s*(\d(?:\.\d)?)\b/
  );
  const directRatingMatch = normalized.match(
    /\b(?:rating|rated|stars?)\s*(\d(?:\.\d)?)\b/
  );
  const gradeMatch = normalized.match(/\bgrade\s*(\d+)\b/);
  const minRating = Number(minRatingMatch?.[1] || directRatingMatch?.[1] || 0);
  const gradeNumber = Number(gradeMatch?.[1] || 0);
  const gradeBand =
    rawSearch.includes("k-3") || (gradeNumber > 0 && gradeNumber <= 3)
      ? "k-3"
      : rawSearch.includes("4-6") || (gradeNumber >= 4 && gradeNumber <= 6)
        ? "4-6"
        : rawSearch.includes("7+") || normalized.includes("teen") || gradeNumber >= 7
          ? "7+"
          : "";
  const ageTerms = ["kids", "young readers", "teen", "adult", "all ages"];
  const levelTerms = ["easy", "intermediate", "advanced"];
  const shelfTerms = [
    "top rated",
    "hidden gem",
    "beginner friendly",
    "popular",
    "educational",
  ];
  const age = ageTerms.find((term) => normalized.includes(normalizeBookText(term))) || "";
  const readingLevel =
    levelTerms.find((term) => normalized.includes(term)) ||
    (normalized.includes("beginner") ? "easy" : "");
  const shelfPick =
    shelfTerms.find((term) => normalized.includes(normalizeBookText(term))) ||
    (normalized.includes("beginner") ? "beginner friendly" : "");
  const stopWords = new Set([
    "a",
    "all",
    "and",
    "are",
    "book",
    "books",
    "find",
    "filter",
    "for",
    "give",
    "i",
    "in",
    "is",
    "list",
    "me",
    "of",
    "please",
    "recommend",
    "recommendation",
    "recommendations",
    "search",
    "show",
    "that",
    "the",
    "to",
    "with",
  ]);
  const conditionWords = new Set([
    "above",
    "adult",
    "advanced",
    "ages",
    "at",
    "beginner",
    "easy",
    "educational",
    "friendly",
    "gem",
    "grade",
    "greater",
    "hidden",
    "kids",
    "least",
    "more",
    "over",
    "popular",
    "rated",
    "rating",
    "stars",
    "teen",
    "than",
    "top",
    "young",
  ]);
  const terms = normalized
    .split(" ")
    .filter((term) => term.length > 1)
    .filter((term) => !stopWords.has(term))
    .filter((term) => !conditionWords.has(term))
    .filter((term) => !/^\d+(\.\d+)?$/.test(term));

  return {
    normalized,
    minRating: Number.isFinite(minRating) ? minRating : 0,
    gradeBand,
    age,
    readingLevel,
    shelfPick,
    terms,
  };
}

function matchesSearchIntent(book, intent) {
  const searchText = getBookSearchText(book);

  if (!intent.normalized) return true;
  if (intent.minRating && Number(book?.rating || 0) < intent.minRating) return false;
  if (
    intent.gradeBand &&
    normalizeBookText(book?.gradeBand) !== normalizeBookText(intent.gradeBand)
  ) {
    return false;
  }
  if (intent.age && !normalizeBookText(book?.ageRecommendation).includes(intent.age)) {
    return false;
  }
  if (
    intent.readingLevel &&
    !normalizeBookText(book?.readingLevel).includes(intent.readingLevel)
  ) {
    return false;
  }
  if (
    intent.shelfPick &&
    !normalizeBookText(book?.shelfPick).includes(normalizeBookText(intent.shelfPick))
  ) {
    return false;
  }

  if (intent.terms.length === 0) return true;

  return intent.terms.every((term) => searchText.includes(term));
}

function getScanConfidence(book) {
  const title = String(book?.title || "").trim();
  const author = String(book?.author || "").trim().toLowerCase();
  const source = String(book?.ratingSource || "").trim().toLowerCase();

  if (!title || title.length < 4 || author === "unknown") {
    return { label: "Needs review", reason: "Title or author may need correction." };
  }
  if (source === "estimated" || title.split(" ").length < 2) {
    return { label: "Possible match", reason: "Lumina estimated some details." };
  }
  return { label: "High confidence", reason: "Title and metadata look complete." };
}

function enrichScannedBook(book) {
  const confidence = getScanConfidence(book);

  return {
    ...book,
    scanConfidence: book?.scanConfidence || confidence.label,
    confidenceReason: book?.confidenceReason || confidence.reason,
    reviewed: Boolean(book?.reviewed),
  };
}

function getContentGuidance(book) {
  const age = normalizeBookText(book?.ageRecommendation);
  const level = normalizeBookText(book?.readingLevel);
  const grade = normalizeBookText(book?.gradeBand);

  if (age.includes("adult")) return "Best reviewed by an adult before sharing with younger readers.";
  if (age.includes("teen") || grade.includes("7")) return "Good for older readers; skim themes if choosing for a child.";
  if (level.includes("advanced")) return "May need support for younger or developing readers.";
  return "Generally approachable for the listed age and level.";
}

function matchesStructuredFilters(book, filters) {
  const genre = normalizeBookText(filters.genre);
  const gradeBand = normalizeBookText(filters.gradeBand);
  const readingLevel = normalizeBookText(filters.readingLevel);
  const ageRecommendation = normalizeBookText(filters.ageRecommendation);
  const shelfPick = normalizeBookText(filters.shelfPick);
  const minRating = Number(filters.minRating || 0);

  if (genre && !normalizeBookText(book?.genre).includes(genre)) return false;
  if (gradeBand && normalizeBookText(book?.gradeBand) !== gradeBand) return false;
  if (
    readingLevel &&
    !normalizeBookText(book?.readingLevel).includes(readingLevel)
  ) {
    return false;
  }
  if (
    ageRecommendation &&
    !normalizeBookText(book?.ageRecommendation).includes(ageRecommendation)
  ) {
    return false;
  }
  if (shelfPick && !normalizeBookText(book?.shelfPick).includes(shelfPick)) {
    return false;
  }
  if (minRating && Number(book?.rating || 0) < minRating) return false;

  return true;
}

/* eslint-disable react-refresh/only-export-components */
export {
  cleanJsonText,
  getBookKey,
  getCode128Bars,
  getContentGuidance,
  getFriendlyScanError,
  getSearchIntent,
  matchesSearchIntent,
  matchesStructuredFilters,
  mergeUniqueByKey,
  normalizeBookText,
  normalizeLibraryCards,
  normalizeSavedFiles,
  safeParseJson,
  sanitizeDisplayName,
  scoreGoogleBooksMatch,
  validateDisplayName,
  validatePassword,
};
/* eslint-enable react-refresh/only-export-components */

export default function App() {
  useEffect(() => {
    logEvent(analytics, "app_opened");
  }, []);

  const [imagePreview, setImagePreview] = useState(null);
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(() => normalizeFilters(DEFAULT_FILTERS));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState("scan");
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("signin");
  const [authForm, setAuthForm] = useState({
    name: "",
    email: "",
    password: "",
  });
  const [authMessage, setAuthMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [developerStats, setDeveloperStats] = useState({
    totalLoginEvents: 0,
    todayLoginEvents: 0,
    recentUniqueUsers: 0,
    registeredUsers: 0,
    lastLoginEmail: "",
    lastLoginMethod: "",
    lastLoginAt: "",
  });
  const [developerUsage, setDeveloperUsage] = useState({
    apiCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    successCalls: 0,
    failedCalls: 0,
    lastCallType: "",
    lastStatus: "",
    lastProvider: "",
    lastModel: "",
    lastUserEmail: "",
  });
  const [developerIpUsage, setDeveloperIpUsage] = useState([]);
  const [developerStatsStatus, setDeveloperStatsStatus] = useState(
    isFirebaseConfigured ? "Loading Firebase stats..." : "Firebase is not configured yet."
  );
  const userDataLoadedRef = useRef(false);

  const [readingList, setReadingList] = useState(() => {
    return readStoredJson("readingList", []);
  });

  const [selectedBook, setSelectedBook] = useState(null);
  const [similarBooksView, setSimilarBooksView] = useState(null);
  const [similarBooksCache, setSimilarBooksCache] = useState({});
  const [scanHistory, setScanHistory] = useState([]);
  const [folders, setFolders] = useState(DEFAULT_FOLDERS);
  const [bookFolders, setBookFolders] = useState({});
  const [activeFolder, setActiveFolder] = useState("All");
  const [folderModal, setFolderModal] = useState({
    isOpen: false,
    book: null,
    name: "",
  });
  const [compare, setCompare] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [geminiUsage, setGeminiUsage] = useState(getInitialGeminiUsage);
  const [previewCache, setPreviewCache] = useState({});
  const [previewModal, setPreviewModal] = useState(null);
  const [selectedLibraryCard, setSelectedLibraryCard] = useState(null);
  const previewCacheRef = useRef({});
  const previewRequestId = useRef(0);
  const [saveStatus, setSaveStatus] = useState(null);
  const [idleBursts, setIdleBursts] = useState([]);
  const [savedArtActive, setSavedArtActive] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const recognitionRef = useRef(null);
  const filterSearchRef = useRef(null);
  const libraryCardScanInputRef = useRef(null);
  const [savedFiles, setSavedFiles] = useState(() => {
    return normalizeSavedFiles(readStoredJson("savedPreviewFiles", []));
  });
  const [libraryCards, setLibraryCards] = useState([]);
  const [libraryCardForm, setLibraryCardForm] = useState({
    name: "",
    cardNumber: "",
    imageDataUrl: "",
    imageName: "",
  });
  const [libraryCardMessage, setLibraryCardMessage] = useState("");
  const [libraryCardLoginPromptOpen, setLibraryCardLoginPromptOpen] =
    useState(false);
  const [openSections, setOpenSections] = useState(() => ({
    ...SECTION_DEFAULT_OPEN,
    ...readStoredJson("openSections", {}),
  }));
  const savedFileIdsRef = useRef(new Set(savedFiles.map((file) => file.id)));
  const localUserStateRef = useRef({
    readingList,
    savedFiles,
    filters,
    books,
    geminiUsage,
    scanHistory,
    folders,
    bookFolders,
    libraryCards,
  });

  useEffect(() => {
    localStorage.setItem("readingList", JSON.stringify(readingList));
  }, [readingList]);

  useEffect(() => {
    localStorage.setItem("savedPreviewFiles", JSON.stringify(savedFiles));
    savedFileIdsRef.current = new Set(savedFiles.map((file) => file.id));
  }, [savedFiles]);

  useEffect(() => {
    localStorage.setItem("geminiDailyUsage", JSON.stringify(geminiUsage));
  }, [geminiUsage]);

  useEffect(() => {
    localStorage.setItem("openSections", JSON.stringify(openSections));
  }, [openSections]);

  useEffect(() => {
    if (!authLoading) return undefined;

    const authTimeout = window.setTimeout(() => {
      setAuthLoading(false);
      setAuthMessage("Sign-in is taking too long. Try Google again, or use email login.");
    }, 20000);

    return () => window.clearTimeout(authTimeout);
  }, [authLoading]);

  useEffect(() => {
    localUserStateRef.current = {
      readingList,
      savedFiles,
      filters,
      books,
      geminiUsage,
      scanHistory,
      folders,
      bookFolders,
      libraryCards,
    };
  }, [readingList, savedFiles, filters, books, geminiUsage, scanHistory, folders, bookFolders, libraryCards]);

  useEffect(() => {
    if (!auth || !db) {
      return undefined;
    }

    return onAuthStateChanged(auth, async (firebaseUser) => {
      userDataLoadedRef.current = false;

      if (!firebaseUser) {
        setUser(null);
        return;
      }
      if (firebaseUser.isAnonymous) {
        setUser(firebaseUser);
        userDataLoadedRef.current = true;
        return;
      }
      if (!firebaseUser.emailVerified) {
        await signOut(auth);
        setUser(null);
        setAuthMode("signin");
        setAuthMessage("Please verify your email before logging in.");
        return;
      }

      setUser(firebaseUser);

      try {
        const userRef = doc(db, "users", firebaseUser.uid);
        await setDoc(
          userRef,
          {
            uid: firebaseUser.uid,
            email: firebaseUser.email || "",
            displayName: sanitizeDisplayName(getUserDisplayName(firebaseUser)),
            emailVerified: Boolean(firebaseUser.emailVerified),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        const appStateRef = getUserAppStateRef(firebaseUser.uid);
        const appStateSnapshot = appStateRef ? await getDoc(appStateRef) : null;
        const cloudState = appStateSnapshot?.exists()
          ? appStateSnapshot.data()
          : null;

        if (cloudState) {
          const localState = localUserStateRef.current;
          const cloudFilters = normalizeFilters(cloudState.filters);
          const localFilters = normalizeFilters(localState.filters);
          const mergedReadingList = mergeUniqueByKey(
            localState.readingList,
            Array.isArray(cloudState.readingList) ? cloudState.readingList : [],
            getBookKey
          );
          const mergedSavedFiles = mergeUniqueByKey(
            normalizeSavedFiles(localState.savedFiles || []),
            normalizeSavedFiles(cloudState.savedFiles || []),
            (file) => file.id
          );
          const mergedBooks = mergeUniqueByKey(
            Array.isArray(localState.books) ? localState.books.map(enrichScannedBook) : [],
            Array.isArray(cloudState.books) ? cloudState.books.map(enrichScannedBook) : [],
            getBookKey
          );
          const mergedScanHistory = mergeUniqueByKey(
            Array.isArray(localState.scanHistory) ? localState.scanHistory : [],
            Array.isArray(cloudState.scanHistory) ? cloudState.scanHistory : [],
            (scan) => scan.id
          ).slice(0, 30);
          const mergedFolders = mergeUniqueByKey(
            Array.isArray(localState.folders) ? localState.folders : [],
            Array.isArray(cloudState.folders) ? cloudState.folders : [],
            (folder) => folder
          );
          const mergedBookFolders = {
            ...(cloudState.bookFolders && typeof cloudState.bookFolders === "object" ? cloudState.bookFolders : {}),
            ...(localState.bookFolders && typeof localState.bookFolders === "object" ? localState.bookFolders : {}),
          };
          const mergedLibraryCards = mergeUniqueByKey(
            normalizeLibraryCards(localState.libraryCards || []),
            normalizeLibraryCards(cloudState.libraryCards || []),
            (card) => card.id
          ).slice(0, MAX_LIBRARY_CARDS);

          setReadingList(mergedReadingList);
          setSavedFiles(mergedSavedFiles);
          setFilters(hasActiveFilters(localFilters) ? localFilters : cloudFilters);
          setBooks(mergedBooks);
          setScanHistory(mergedScanHistory);
          setFolders(mergedFolders.length ? mergedFolders : DEFAULT_FOLDERS);
          setBookFolders(mergedBookFolders);
          setLibraryCards(mergedLibraryCards);
          setGeminiUsage(
            mergeGeminiUsage(
              cloudState.geminiUsage,
              localUserStateRef.current.geminiUsage
            )
          );
        } else {
          await saveUserAppState(firebaseUser.uid, localUserStateRef.current);
        }

        userDataLoadedRef.current = true;
      } catch (err) {
        console.error("Could not load user app data:", err);
        userDataLoadedRef.current = true;
      }
    });
  }, []);

  useEffect(() => {
    if (!auth || !db) return undefined;

    let isMounted = true;

    getRedirectResult(auth)
      .then(async (credential) => {
        if (!credential?.user || !isMounted) return;

        await recordSuccessfulLogin(credential.user, "google");
        logEvent(analytics, "login", { method: "google-redirect" });
        setAuthMessage("Signed in with Google.");
        setCurrentPage("scan");
      })
      .catch((err) => {
        console.error("Google redirect sign-in failed:", err);
        if (isMounted) {
          setAuthMessage(getAuthErrorMessage(err));
          setCurrentPage("account");
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSyncUser(user) || !userDataLoadedRef.current) {
      return undefined;
    }

    const saveTimer = window.setTimeout(() => {
      saveUserAppState(user.uid, {
        readingList,
        savedFiles,
        filters,
        books,
        geminiUsage,
        scanHistory,
        folders,
        bookFolders,
        libraryCards,
      }).catch((err) => {
        console.error("Could not save user app data:", err);
      });
    }, 500);

    return () => window.clearTimeout(saveTimer);
  }, [user, readingList, savedFiles, filters, books, geminiUsage, scanHistory, folders, bookFolders, libraryCards]);

  useEffect(() => {
    if (!db || !hasDeveloperAccess(user)) {
      return undefined;
    }

    let cancelled = false;

    async function loadDeveloperStats() {
      try {
        const todayKey = getTodayKey();
        const userCountSnapshot = await getCountFromServer(collection(db, "users"));
        const totalLoginSnapshot = await getCountFromServer(collection(db, "loginEvents"));
        const todayLoginQuery = query(
          collection(db, "loginEvents"),
          where("date", "==", todayKey)
        );
        const todayLoginSnapshot = await getCountFromServer(todayLoginQuery);
        const recentLoginQuery = query(
          collection(db, "loginEvents"),
          orderBy("createdAtMs", "desc"),
          limit(50)
        );
        const recentLoginSnapshot = await getDocs(recentLoginQuery);
        const recentLogins = recentLoginSnapshot.docs.map((eventDoc) => eventDoc.data());
        const lastLogin = recentLogins[0] || {};
        const recentUniqueUsers = new Set(
          recentLogins.map((loginEvent) => loginEvent.userId).filter(Boolean)
        ).size;

        if (cancelled) return;

        setDeveloperStats({
          totalLoginEvents: totalLoginSnapshot.data().count || 0,
          todayLoginEvents: todayLoginSnapshot.data().count || 0,
          recentUniqueUsers,
          registeredUsers: userCountSnapshot.data().count || 0,
          lastLoginEmail: lastLogin.email || "",
          lastLoginMethod: lastLogin.method || "",
          lastLoginAt: lastLogin.createdAtMs
            ? new Date(lastLogin.createdAtMs).toISOString()
            : "",
        });
        setDeveloperStatsStatus("");
      } catch (err) {
        console.error("Could not load developer stats:", err);
        if (!cancelled) {
          setDeveloperStatsStatus("Could not load Firebase developer stats.");
        }
      }
    }

    loadDeveloperStats();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!db || !hasDeveloperAccess(user)) {
      return undefined;
    }

    const usageRef = getDeveloperUsageRef();
    if (!usageRef) return undefined;

    return onSnapshot(
      usageRef,
      (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : {};
        setDeveloperUsage({
          apiCalls: Number(data.apiCalls || 0),
          promptTokens: Number(data.promptTokens || 0),
          outputTokens: Number(data.outputTokens || 0),
          totalTokens: Number(data.totalTokens || 0),
          successCalls: Number(data.successCalls || 0),
          failedCalls: Number(data.failedCalls || 0),
          lastCallType: data.lastCallType || "",
          lastStatus: data.lastStatus || "",
          lastProvider: data.lastProvider || "",
          lastModel: data.lastModel || "",
          lastUserEmail: data.lastUserEmail || "",
        });
      },
      (err) => {
        console.error("Could not load developer API usage:", err);
      }
    );
  }, [user]);

  useEffect(() => {
    if (!db || !hasDeveloperAccess(user)) {
      return undefined;
    }

    const todayEventsQuery = query(
      collection(db, "developerApiUsageEvents"),
      where("date", "==", getTodayKey())
    );

    return onSnapshot(
      todayEventsQuery,
      (snapshot) => {
        const eventTotals = snapshot.docs.reduce(
          (totals, eventDoc) => {
            const eventData = eventDoc.data();
            const promptTokens = Number(eventData.promptTokens || 0);
            const totalTokens = Number(eventData.totalTokens || promptTokens);
            const outputTokens = Number(
              eventData.outputTokens ?? Math.max(0, totalTokens - promptTokens)
            );

            return {
              apiCalls: totals.apiCalls + 1,
              promptTokens: totals.promptTokens + promptTokens,
              outputTokens: totals.outputTokens + outputTokens,
              totalTokens: totals.totalTokens + totalTokens,
              successCalls:
                totals.successCalls + (eventData.status === "Success" ? 1 : 0),
              failedCalls:
                totals.failedCalls + (eventData.status === "Success" ? 0 : 1),
            };
          },
          {
            apiCalls: 0,
            promptTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            successCalls: 0,
            failedCalls: 0,
          }
        );
        const ipUsageByAddress = new Map();

        snapshot.docs.forEach((eventDoc) => {
          const eventData = eventDoc.data();
          const ipAddress = eventData.ipAddress || "Unknown IP";
          const totalTokens = Number(
            eventData.totalTokens || eventData.promptTokens || 0
          );
          const currentUsage = ipUsageByAddress.get(ipAddress) || {
            ipAddress,
            apiCalls: 0,
            totalTokens: 0,
          };

          currentUsage.apiCalls += 1;
          currentUsage.totalTokens += totalTokens;
          ipUsageByAddress.set(ipAddress, currentUsage);
        });

        setDeveloperUsage((currentUsage) => ({
          ...currentUsage,
          ...eventTotals,
        }));
        setDeveloperIpUsage(
          [...ipUsageByAddress.values()]
            .sort((a, b) => b.totalTokens - a.totalTokens)
            .slice(0, 8)
        );
      },
      (err) => {
        console.error("Could not load developer API usage events:", err);
      }
    );
  }, [user]);

  useEffect(() => {
    previewCacheRef.current = previewCache;
  }, [previewCache]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  function beginGeminiCall(callType) {
    const todayKey = getTodayKey();
    const now = new Date().toISOString();

    setGeminiUsage((currentUsage) => {
      const currentCount =
        currentUsage?.date === todayKey ? Number(currentUsage.count || 0) : 0;

      return {
        date: todayKey,
        count: currentCount + 1,
        promptTokens: Number(currentUsage?.promptTokens || 0),
        requestEvents: [
          ...getRecentEvents(currentUsage?.requestEvents, new Date(now).getTime()),
          now,
        ],
        tokenEvents: getRecentEvents(
          currentUsage?.tokenEvents,
          new Date(now).getTime()
        ),
        lastStatus: "Running",
        lastType: callType,
        lastUpdatedAt: now,
      };
    });
  }

  function finishGeminiCall(callType, status, tokenCount = 0) {
    const todayKey = getTodayKey();
    const now = new Date().toISOString();
    const nowTime = new Date(now).getTime();
    const tokens = Number(tokenCount || 0);

    setGeminiUsage((currentUsage) => ({
      date: todayKey,
      count:
        currentUsage?.date === todayKey ? Number(currentUsage.count || 0) : 0,
      promptTokens:
        (currentUsage?.date === todayKey
          ? Number(currentUsage.promptTokens || 0)
          : 0) + tokens,
      requestEvents: getRecentEvents(currentUsage?.requestEvents, nowTime),
      tokenEvents:
        tokens > 0
          ? [
              ...getRecentEvents(currentUsage?.tokenEvents, nowTime),
              { at: now, count: tokens },
            ]
          : getRecentEvents(currentUsage?.tokenEvents, nowTime),
      lastStatus: status,
      lastType: callType,
      lastUpdatedAt: now,
    }));
  }

  function handleScanPickerClick(event) {
    if (isFirebaseConfigured) return;

    event.preventDefault();
    setError("Firebase is not configured yet.");
  }

  async function ensureScanAuth() {
    if (!auth) {
      throw new Error("Firebase Authentication is not configured.");
    }
    if (auth.currentUser?.uid) {
      return auth.currentUser;
    }

    try {
      const credential = await signInAnonymously(auth);
      return credential.user;
    } catch (err) {
      if (String(err?.code || "").includes("admin-restricted-operation")) {
        throw new Error(
          "Guest scanning needs Anonymous sign-in enabled in Firebase Authentication. Open Firebase Console > Authentication > Sign-in method, then enable Anonymous.",
          { cause: err }
        );
      }
      throw err;
    }
  }

  function updateAuthForm(field, value) {
    setAuthForm((currentForm) => ({
      ...currentForm,
      [field]: value,
    }));
    setAuthMessage("");
  }

  function getAuthErrorMessage(err) {
    const code = err?.code || "";
    const message = String(err?.message || "");

    if (code.includes("invalid-credential")) return "Email or password is incorrect.";
    if (code.includes("email-already-in-use")) return "That email already has an account.";
    if (code.includes("user-not-found")) return "No password account was found for that email.";
    if (code.includes("weak-password")) return "Use a stronger password.";
    if (code.includes("too-many-requests")) return "Too many attempts. Wait a few minutes, then try again.";
    if (code.includes("missing-email")) return "Enter your email address first.";
    if (code.includes("invalid-email")) return "Enter a valid email address.";
    if (code.includes("popup-closed-by-user")) return "Google sign-in was closed.";
    if (code.includes("configuration-not-found")) {
      return "Firebase Authentication is not enabled for this project yet. In Firebase, open Authentication, click Get started, then enable Google and Email/Password sign-in.";
    }
    if (code.includes("popup-blocked")) {
      return "The browser blocked the Google pop-up. Trying redirect sign-in...";
    }
    if (code.includes("operation-not-allowed")) {
      return "Google sign-in is not enabled in Firebase yet. Enable Google under Authentication > Sign-in method.";
    }
    if (code.includes("unauthorized-domain")) {
      return "This app URL is not authorized in Firebase. Add 127.0.0.1 and localhost under Authentication > Settings > Authorized domains.";
    }
    if (code.includes("network-request-failed")) {
      return "Firebase could not connect. Check your internet connection and try again.";
    }
    if (
      message.toLowerCase().includes("no credentials available") ||
      code.includes("credential-unavailable")
    ) {
      return "No Google account is available on this device, or Android Google sign-in is not fully configured yet. Sign into Google on the device, verify the Firebase Android app setup for com.shilpi.lumina, then try again.";
    }

    return err?.message || "Authentication failed. Please try again.";
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();

    if (!auth || !db) {
      setAuthMessage("Add your Firebase config and enable Authentication first.");
      return;
    }

    const email = authForm.email.trim().toLowerCase();
    const password = authForm.password;
    const displayName = sanitizeDisplayName(authForm.name);

    if (!email || !password) {
      setAuthMessage("Enter your email and password.");
      return;
    }
    if (!isValidEmail(email)) {
      setAuthMessage("Enter a valid email address.");
      return;
    }
    if (authMode === "signup") {
      const nameError = validateDisplayName(displayName);
      if (nameError) {
        setAuthMessage(nameError);
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        setAuthMessage(passwordError);
        return;
      }
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      const credential =
        authMode === "signup"
          ? await createUserWithEmailAndPassword(auth, email, password)
          : await signInWithEmailAndPassword(auth, email, password);

      if (authMode === "signup") {
        await updateProfile(credential.user, {
          displayName,
        });
        await sendEmailVerification(credential.user);
        await signOut(auth);
        setUser(null);
        setAuthMode("signin");
        setAuthMessage("Verification email sent. Please verify your email, then log in.");
        return;
      }

      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        setUser(null);
        setAuthMode("signin");
        setAuthMessage("Your email is not verified. I sent a new verification email. Please verify, then log in.");
        return;
      }

      await recordSuccessfulLogin(
        {
          ...credential.user,
          displayName: displayName || credential.user.displayName,
        },
        "email"
      );
      logEvent(analytics, "login", {
        method: "email",
      });
      setAuthMessage("Signed in. Your saved list and filters will sync here.");
      setCurrentPage("scan");
    } catch (err) {
      console.error("Auth failed:", err);
      setAuthMessage(getAuthErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleGoogleLogin() {
    if (!auth || !db) {
      setAuthMessage("Add your Firebase config and enable Authentication first.");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    if (isAndroidApp && !isAndroidGoogleSsoConfigured) {
      setAuthLoading(false);
      setAuthMessage(
        "Google SSO needs the Android Firebase config. Add android/app/google-services.json, set VITE_ANDROID_GOOGLE_SSO_READY=true, rebuild, then try again."
      );
      return;
    }

    async function signInWithGoogleWeb() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        prompt: "select_account",
      });
      const credential = await signInWithPopup(auth, provider);
      await recordSuccessfulLogin(credential.user, "google");
      logEvent(analytics, "login", { method: "google" });
      setAuthMessage("Signed in with Google.");
      setCurrentPage("scan");
    }

    async function redirectToGoogleSignIn() {
      setAuthMessage("Opening Google sign-in in this tab...");
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        prompt: "select_account",
      });
      await signInWithRedirect(auth, provider);
    }

    try {
      if (isNativeApp && hasNativeFirebaseAuthentication) {
        const nativeResult = await FirebaseAuthentication.signInWithGoogle({
          skipNativeAuth: true,
        });
        const idToken = nativeResult.credential?.idToken || null;
        const accessToken = nativeResult.credential?.accessToken || undefined;

        if (!idToken && !accessToken) {
          throw new Error(
            "Google sign-in did not return a Firebase credential. Check the Android Firebase client setup."
          );
        }

        const googleCredential = GoogleAuthProvider.credential(idToken, accessToken);
        const credential = await signInWithCredential(auth, googleCredential);

        await recordSuccessfulLogin(credential.user, "google");
        logEvent(analytics, "login", { method: "google-native" });
        setAuthMessage("Signed in with Google.");
        setCurrentPage("scan");
        return;
      }

      if (!isNativeApp) {
        await signInWithGoogleWeb();
        return;
      }

      setAuthMessage(
        "Google SSO must use native sign-in in the phone app. Add android/app/google-services.json, set VITE_ANDROID_GOOGLE_SSO_READY=true, rebuild, then try again."
      );
    } catch (err) {
      console.error("Google sign-in failed:", err);
      const code = err?.code || "";
      const message = String(err?.message || "");
      if (
        message.includes("FirebaseAuthentication") &&
        message.includes("not implemented")
      ) {
        if (isAndroidApp) {
          setAuthMessage(
            "Google SSO needs the Android Firebase config. Add android/app/google-services.json, set VITE_ANDROID_GOOGLE_SSO_READY=true, rebuild, then try again."
          );
          return;
        }

        try {
          await signInWithGoogleWeb();
          return;
        } catch (fallbackErr) {
          console.error("Google web fallback sign-in failed:", fallbackErr);
          if (String(fallbackErr?.code || "").includes("popup")) {
            await redirectToGoogleSignIn();
            return;
          }
          setAuthMessage(getAuthErrorMessage(fallbackErr));
          return;
        }
      }
      if (
        code.includes("popup-blocked") ||
        code.includes("popup-closed-by-user") ||
        code.includes("cancelled-popup-request") ||
        code.includes("web-storage-unsupported")
      ) {
        if (isAndroidApp) {
          setAuthMessage(
            "Google SSO must use native Android sign-in. Add android/app/google-services.json, set VITE_ANDROID_GOOGLE_SSO_READY=true, rebuild, then try again."
          );
          return;
        }

        await redirectToGoogleSignIn();
        return;
      }

      setAuthMessage(getAuthErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!auth) {
      setAuthMessage("Add your Firebase config and enable Authentication first.");
      return;
    }

    const email = authForm.email.trim().toLowerCase();
    if (!email) {
      setAuthMessage("Enter your email first, then click Forgot password.");
      return;
    }
    if (!isValidEmail(email)) {
      setAuthMessage("Enter a valid email address for password reset.");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      await sendPasswordResetEmail(auth, email, {
        url: window.location.origin,
        handleCodeInApp: false,
      });
      setAuthMessage(
        `Password reset email sent to ${email}. Check spam or promotions if it does not show up in a minute.`
      );
    } catch (err) {
      console.error("Password reset failed:", err);
      setAuthMessage(getAuthErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!user) {
      setAuthMessage("Log in first, then request a verification email.");
      return;
    }
    if (user.emailVerified) {
      setAuthMessage("Your email is already verified.");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      await sendEmailVerification(user);
      await signOut(auth);
      setUser(null);
      setAuthMode("signin");
      setAuthMessage("Verification email sent. Please verify your email, then log in.");
    } catch (err) {
      console.error("Email verification failed:", err);
      setAuthMessage(getAuthErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleRefreshVerification() {
    if (!auth?.currentUser) return;

    setAuthLoading(true);
    setAuthMessage("");

    try {
      await reload(auth.currentUser);
      const refreshedUser = auth.currentUser;
      setUser(refreshedUser);
      if (refreshedUser?.uid && db) {
        await setDoc(
          doc(db, "users", refreshedUser.uid),
          {
            emailVerified: Boolean(refreshedUser.emailVerified),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
      setAuthMessage(
        refreshedUser?.emailVerified
          ? "Email verified. Thank you."
          : "Email is not verified yet."
      );
    } catch (err) {
      console.error("Refresh verification failed:", err);
      setAuthMessage("Could not refresh verification status.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    if (!auth) return;

    try {
      await signOut(auth);
      setAuthMessage("Signed out. You can keep browsing as a guest.");
    } catch (err) {
      console.error("Sign out failed:", err);
      setAuthMessage("Could not sign out. Please try again.");
    }
  }

  function updateLibraryCardForm(field, value) {
    setLibraryCardForm((currentForm) => ({
      ...currentForm,
      [field]: field === "name" ? sanitizeLibraryCardName(value) : sanitizeLibraryCardNumber(value),
    }));
    setLibraryCardMessage("");
  }

  function requireLoginForLibraryCards() {
    setAuthMode("signin");
    setCurrentPage("account");
    setLibraryCardLoginPromptOpen(true);
  }

  function addLibraryCardFromForm(event) {
    event.preventDefault();

    if (!isSyncUser(user)) {
      requireLoginForLibraryCards();
      return;
    }

    if (libraryCards.length >= MAX_LIBRARY_CARDS) {
      setLibraryCardMessage(`You can keep up to ${MAX_LIBRARY_CARDS} library cards.`);
      return;
    }

    const cardNumber = sanitizeLibraryCardNumber(libraryCardForm.cardNumber);
    const name = sanitizeLibraryCardName(libraryCardForm.name) || "Library card";

    if (!cardNumber) {
      setLibraryCardMessage("Enter or scan a library card barcode.");
      return;
    }

    if (
      libraryCards.some(
        (card) =>
          sanitizeLibraryCardNumber(card.cardNumber).toLowerCase() ===
          cardNumber.toLowerCase()
      )
    ) {
      setLibraryCardMessage("That library card is already saved.");
      return;
    }

    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `library-card-${Date.now()}`;

    setLibraryCards((currentCards) =>
      normalizeLibraryCards([
        {
          id,
          name,
          cardNumber,
          barcodeFormat: "CODE_128",
          imageDataUrl: libraryCardForm.imageDataUrl,
          imageName: libraryCardForm.imageName,
          addedAt: new Date().toISOString(),
        },
        ...currentCards,
      ])
    );
    setLibraryCardForm({ name: "", cardNumber: "", imageDataUrl: "", imageName: "" });
    setLibraryCardMessage("Library card saved.");
  }

  async function handleLibraryCardScan(file) {
    if (!file) return;

    if (!isSyncUser(user)) {
      requireLoginForLibraryCards();
      if (libraryCardScanInputRef.current) {
        libraryCardScanInputRef.current.value = "";
      }
      return;
    }

    setLibraryCardMessage("Scanning library card photo...");

    try {
      const imageDataUrl = await getImageDataUrl(file);
      const bitmap = await createImageBitmap(file);
      let barcodeValue = "";
      let detectedLibraryName = "";

      if ("BarcodeDetector" in window) {
        const detector = new window.BarcodeDetector({
          formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf"],
        });
        const barcodes = await detector.detect(bitmap);
        barcodeValue = sanitizeLibraryCardNumber(barcodes[0]?.rawValue || "");
      }

      bitmap.close?.();

      if (isGeminiConfigured) {
        try {
          await ensureScanAuth();
          const base64 = await encodeFileToBase64(file);
          beginGeminiCall("Library card scan");
          const result = await generateGeminiContent([
            {
              role: "user",
              parts: [
                {
                  text: `
Read this library card image. Return ONLY valid JSON:
{
  "libraryName": "Library name visible on the card, or empty string",
  "cardNumber": "Barcode or card number visible on the card, or empty string"
}
Do not include explanations.
                  `,
                },
                {
                  inlineData: {
                    mimeType: file.type || "image/jpeg",
                    data: base64,
                  },
                },
              ],
            },
          ], {
            maxOutputTokens: 512,
            responseMimeType: "application/json",
          }, "Library card scan");
          const parsed = safeParseJson(getGeminiText(result));
          detectedLibraryName = sanitizeLibraryCardName(parsed?.libraryName);
          barcodeValue =
            barcodeValue || sanitizeLibraryCardNumber(parsed?.cardNumber);
          finishGeminiCall(
            "Library card scan",
            "Success",
            getTotalTokenCount(result)
          );
        } catch (ocrErr) {
          console.error("Library card text scan failed:", ocrErr);
          finishGeminiCall("Library card scan", "Failed");
        }
      }

      setLibraryCardForm((currentForm) => ({
        ...currentForm,
        name: detectedLibraryName || currentForm.name,
        cardNumber: barcodeValue || currentForm.cardNumber,
        imageDataUrl,
        imageName: sanitizeLibraryCardName(file.name),
      }));
      setLibraryCardMessage(
        barcodeValue
          ? "Card photo saved and barcode scanned. Review, then save it."
          : "Card photo saved. Type the barcode number if it was not detected."
      );
    } catch (err) {
      console.error("Library card barcode scan failed:", err);
      setLibraryCardMessage("Could not scan that card photo. Try again or type it.");
    } finally {
      if (libraryCardScanInputRef.current) {
        libraryCardScanInputRef.current.value = "";
      }
    }
  }

  function deleteLibraryCard(cardId) {
    setLibraryCards((currentCards) =>
      currentCards.filter((card) => card.id !== cardId)
    );
    setLibraryCardMessage("Library card removed.");
  }

  async function handleImage(file) {
    if (!file) return;
    if (!isGeminiConfigured) {
      setError("Firebase is not configured yet.");
      return;
    }
    const quotaUser = isSyncUser(user) ? user : null;
    if (!canStartScan(quotaUser)) {
      setError(getScanLimitMessage(quotaUser));
      return;
    }

    setError("");
    setLoading(true);
    setBooks([]);
    setPreviewCache({});
    setSearch("");
    setVoiceStatus("");
    setVoiceListening(false);
    recognitionRef.current?.abort();
    setImagePreview(URL.createObjectURL(file));

    let geminiCallStarted = false;
    try {
      await ensureScanAuth();
      const base64 = await encodeFileToBase64(file);
      recordLocalScanUsage(quotaUser);
      beginGeminiCall("Bookshelf scan");
      geminiCallStarted = true;

      const result = await generateGeminiContent([
        {
          role: "user",
          parts: [
            {
              text: `
You are a smart library bookshelf assistant.

Look at this bookshelf image. Detect visible book titles as best as possible.

Return ONLY valid JSON in this exact format:

{
  "books": [
    {
      "title": "Book title",
      "author": "Author name or Unknown",
      "authorBio": "Short 1-2 sentence description of the author",
      "rating": 4.5,
      "ratingSource": "Goodreads, Amazon, Google Books, or Estimated",
      "summary": "Short useful summary",
      "genre": "Genre",
      "readingLevel": "Easy / Intermediate / Advanced",
      "gradeBand": "K-3 / 4-6 / 7+",
      "ageRecommendation": "Kids / Young Readers / Teen / Adult / All ages",
      "whyRead": "Why someone may like this book",
      "shelfPick": "Top Rated / Hidden Gem / Beginner Friendly / Popular / Educational"
    }
  ]
}

Important:
- If rating is not visible, estimate a general public rating.
- If exact rating source is unknown, use "Estimated".
- Include a short author biography.
- Choose gradeBand carefully:
  - K-3 for grade 3 and below
  - 4-6 for grade 4 to grade 6
  - 7+ for grade 7 and above or teen/adult books
- Include at most 12 books.
- Do not invent too many books.
- Only include books you can reasonably detect.
- Keep summaries short.
                `,
            },
            {
              inlineData: {
                mimeType: file.type || "image/jpeg",
                data: base64,
              },
            },
          ],
        },
      ], {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      }, "Bookshelf scan");

      const text = getGeminiText(result);

      const parsed = safeParseJson(text);

      if (!parsed?.books || !Array.isArray(parsed.books)) {
        throw new Error("No books returned from Gemini");
      }

      const scannedBooks = parsed.books.map(enrichScannedBook);
      const promptTokenCount = getPromptTokenCount(result);
      const totalTokenCount = getTotalTokenCount(result);
      const scanEntry = {
        id: `scan-${Date.now()}`,
        createdAt: new Date().toISOString(),
        imageName: file.name || "bookshelf image",
        bookCount: scannedBooks.length,
        provider: result.provider || "gemini",
        model: result.model || MODEL_NAME,
        promptTokens: promptTokenCount,
        totalTokens: totalTokenCount,
        books: scannedBooks,
      };
      setBooks(scannedBooks);
      if (isSyncUser(user)) {
        setScanHistory((currentHistory) => [scanEntry, ...currentHistory].slice(0, 30));
        await saveUserScan(user.uid, {
          books: scannedBooks,
          bookCount: scannedBooks.length,
          filters,
          image: {
            name: file.name || "bookshelf image",
            type: file.type || "image/jpeg",
            size: Number(file.size || 0),
          },
          model: result.model || MODEL_NAME,
          provider: result.provider || "gemini",
          promptTokens: promptTokenCount,
          totalTokens: totalTokenCount,
          scannedAtLocalDate: getTodayKey(),
        });
      }
      finishGeminiCall("Bookshelf scan", "Success", totalTokenCount);
    } catch (err) {
      console.error("SCAN ERROR:", err);
      if (geminiCallStarted) {
        finishGeminiCall("Bookshelf scan", "Failed");
      }
      setError(getFriendlyScanError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleVoiceSearch() {
    if (voiceListening) {
      recognitionRef.current?.stop();
      setVoiceListening(false);
      setVoiceStatus("Voice search stopped.");
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const microphoneSettingsMessage = isAndroidApp
      ? "Microphone permission is needed. Open Android Settings > Apps > Lumina > Permissions > Microphone, allow it, then try again."
      : "Microphone permission is needed. Allow microphone access for this app in your browser or device settings, then try again.";

    if (isAndroidApp && NativeSpeech?.start) {
      setVoiceListening(true);
      setVoiceStatus("Listening...");
      setError("");

      try {
        const result = await NativeSpeech.start({ language: "en-US" });
        const transcript = String(result?.transcript || "").trim();

        if (!transcript) {
          setVoiceStatus("I did not catch that. Try again.");
          return;
        }

        setSearch(transcript);
        setVoiceStatus(`Voice searched: "${transcript}"`);
      } catch (err) {
        console.error("Native voice search failed:", err);
        filterSearchRef.current?.focus();
        setVoiceStatus(
          String(err?.message || "").toLowerCase().includes("permission")
            ? microphoneSettingsMessage
            : "Voice search could not hear you. Try again."
        );
      } finally {
        setVoiceListening(false);
      }
      return;
    }

    if (!SpeechRecognition) {
      filterSearchRef.current?.focus();
      setVoiceStatus(
        "Voice dictation is not available on this device. Type your search instead."
      );
      return;
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.error("Microphone permission failed:", err);
        filterSearchRef.current?.focus();
        setVoiceStatus(microphoneSettingsMessage);
        return;
      }
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setVoiceListening(true);
      setVoiceStatus("Listening...");
      setError("");
    };

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join(" ")
        .trim();

      if (!transcript) {
        setVoiceStatus("I did not catch that. Try again.");
        return;
      }

      setSearch(transcript);
      setVoiceStatus(`Voice searched: "${transcript}"`);
    };

    recognition.onerror = (event) => {
      const blocked = event.error === "not-allowed" || event.error === "service-not-allowed";
      filterSearchRef.current?.focus();
      setVoiceStatus(
        blocked
          ? microphoneSettingsMessage
          : "Voice search could not hear you. Try again."
      );
      setVoiceListening(false);
    };

    recognition.onend = () => {
      setVoiceListening(false);
    };

    try {
      recognition.start();
    } catch (err) {
      console.error("Voice search failed:", err);
      setVoiceListening(false);
      setVoiceStatus("Voice search could not start. Try again.");
    }
  }

  const genreOptions = useMemo(() => {
    return [...new Set(books.map((book) => book.genre).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }, [books]);

  const activeFilterCount = useMemo(() => {
    return Object.values(filters).filter(Boolean).length + (search.trim() ? 1 : 0);
  }, [filters, search]);

  function updateFilter(filterName, value) {
    setFilters((currentFilters) => ({
      ...currentFilters,
      [filterName]: value,
    }));
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_FILTERS });
    setSearch("");
    setVoiceStatus("");
    setFiltersOpen(false);
  }

  const filteredBooks = useMemo(() => {
    const intent = getSearchIntent(search);

    return books.filter(
      (book) =>
        matchesStructuredFilters(book, filters) &&
        matchesSearchIntent(book, intent)
    );
  }, [books, filters, search]);

  const topBooks = useMemo(() => {
    return [...filteredBooks]
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 3);
  }, [filteredBooks]);

  const detectedBooks = useMemo(() => {
    const topBookKeys = new Set(topBooks.map(getBookKey));
    return filteredBooks.filter((book) => !topBookKeys.has(getBookKey(book)));
  }, [filteredBooks, topBooks]);

  const selectedBookKey = selectedBook ? getBookKey(selectedBook) : "";
  const similarBooksState = selectedBookKey
    ? similarBooksCache[selectedBookKey]
    : null;
  const similarBooks = similarBooksState?.books || [];
  const shelfSimilarBooks = useMemo(() => {
    if (!selectedBookKey) return [];

    return books
      .filter((book) => getBookKey(book) !== selectedBookKey)
      .map((book) => ({
        book,
        score: scoreShelfSimilarBook(selectedBook, book),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ book }) => book);
  }, [books, selectedBook, selectedBookKey]);

  function hasSavedPreview(book) {
    return savedFiles.some(
      (file) =>
        file.type === "preview" &&
        file.id === getSavedFileKey(book?.title, "preview")
    );
  }

  function hasSavedDetails(book) {
    return savedFiles.some(
      (file) =>
        file.type === "details" &&
        file.id === getSavedFileKey(book?.title, "details")
    );
  }

  function isBookInReadingList(book) {
    return readingList.some(
      (savedBook) => getBookKey(savedBook) === getBookKey(book)
    );
  }

  function toggleReadingList(book) {
    if (!book) return;

    const exists = isBookInReadingList(book);
    const bookKey = getBookKey(book);

    setReadingList((currentList) =>
      exists
        ? currentList.filter((savedBook) => getBookKey(savedBook) !== bookKey)
        : [{ ...book, savedAt: new Date().toISOString() }, ...currentList]
    );

    setBookFolders((currentFolders) => {
      if (exists) {
        const nextFolders = { ...currentFolders };
        delete nextFolders[bookKey];
        return nextFolders;
      }
      return { ...currentFolders, [bookKey]: currentFolders[bookKey] || "Want to read" };
    });

    setSaveStatus({
      message: exists
        ? `${book.title} removed from favorites.`
        : `${book.title} added to favorites.`,
      bookKey: getSavedFileKey(book.title, "favorite"),
      type: "favorite",
    });
  }

  function assignBookFolder(book, folderName) {
    const bookKey = getBookKey(book);
    if (!bookKey) return;

    setBookFolders((currentFolders) => ({
      ...currentFolders,
      [bookKey]: folderName,
    }));
  }

  function createFolderForBook(book) {
    setFolderModal({
      isOpen: true,
      book: book || null,
      name: "",
    });
  }

  function createFolder() {
    setFolderModal({
      isOpen: true,
      book: null,
      name: "",
    });
  }

  function closeFolderModal() {
    setFolderModal({ isOpen: false, book: null, name: "" });
  }

  function saveFolderFromModal(event) {
    event.preventDefault();

    const cleanName = folderModal.name.trim();
    if (!cleanName) return;

    const existingFolder = folders.find(
      (folder) => folder.toLowerCase() === cleanName.toLowerCase()
    );
    const nextFolder = existingFolder || cleanName;

    if (!existingFolder) {
      setFolders((currentFolders) => [...currentFolders, nextFolder]);
    }

    setActiveFolder(nextFolder);
    if (folderModal.book) {
      assignBookFolder(folderModal.book, nextFolder);
    }
    setSaveStatus({
      message: existingFolder
        ? `${nextFolder} folder opened.`
        : folderModal.book
          ? `${nextFolder} folder created and ${folderModal.book.title} was added.`
          : `${nextFolder} folder created.`,
      bookKey: folderModal.book
        ? getSavedFileKey(folderModal.book.title, "favorite")
        : "folder",
      type: folderModal.book ? "favorite" : "folder",
    });
    closeFolderModal();
  }

  function handleFolderSelect(book, folderName) {
    if (folderName === NEW_FOLDER_OPTION) {
      createFolderForBook(book);
      return;
    }

    assignBookFolder(book, folderName);
  }

  function handleSavedBookFolderSelect(savedBook, folderName) {
    const book = savedBook?.catalogBook;
    if (!book) return;

    if (folderName === NEW_FOLDER_OPTION) {
      createFolderForBook(book);
      return;
    }

    const bookKey = getBookKey(book);
    setReadingList((currentList) => {
      if (currentList.some((saved) => getBookKey(saved) === bookKey)) {
        return currentList;
      }

      return [{ ...book, savedAt: new Date().toISOString() }, ...currentList];
    });
    assignBookFolder(book, folderName);
    setSaveStatus({
      message: `${book.title} added to ${folderName}.`,
      bookKey: getSavedFileKey(book.title, "favorite"),
      type: "favorite",
    });
  }

  function getPreviewButtonState(book) {
    const cachedPreview = previewCache[getBookKey(book)];

    if (cachedPreview?.status === "ready") {
      return {
        label: hasSavedPreview(book) ? "Saved Preview" : "Preview Available",
        disabled: false,
        saved: hasSavedPreview(book),
      };
    }

    if (cachedPreview?.status === "loading") {
      return {
        label: "Checking preview...",
        disabled: true,
        saved: false,
      };
    }

    if (cachedPreview?.status === "unavailable") {
      return {
        label: "No preview available",
        disabled: true,
        saved: false,
      };
    }

    if (cachedPreview?.status === "error") {
      return {
        label: "No preview available",
        disabled: false,
        saved: false,
      };
    }

    return {
      label: hasSavedPreview(book) ? "Saved Preview" : "Preview",
      disabled: false,
      saved: hasSavedPreview(book),
    };
  }

  function updateBookPreviewCache(key, previewResult) {
    previewCacheRef.current = {
      ...previewCacheRef.current,
      [key]: previewResult,
    };
    setPreviewCache(previewCacheRef.current);
  }

  function deleteSavedBook(savedBook) {
    const idsToDelete = new Set(savedBook.ids);

    setSavedFiles((currentFiles) =>
      currentFiles.filter((file) => !idsToDelete.has(file.id))
    );
    setSaveStatus({
      message: `${savedBook.bookTitle} deleted from this phone.`,
      bookKey: savedBook.id,
      type: "delete",
    });
  }

  function toggleCompare(book) {
    const exists = compare.some((b) => b.title === book.title);

    if (exists) {
      setCompare(compare.filter((b) => b.title !== book.title));
      return;
    }

    if (compare.length < 2) {
      const nextCompare = [...compare, book];
      setCompare(nextCompare);
      if (nextCompare.length === 2) setCompareOpen(true);
      return;
    }

    setCompare([compare[1], book]);
    setCompareOpen(true);
  }

  const loadSimilarBooks = useCallback(async (book) => {
    const bookKey = getBookKey(book);
    if (!bookKey) return;

    if (!googleBooksApiKey) {
      setSimilarBooksCache((currentCache) => ({
        ...currentCache,
        [bookKey]: {
          status: "error",
          message:
            "Google Books API key is not configured, so global similar books cannot be loaded.",
          books: [],
        },
      }));
      return;
    }

    setSimilarBooksCache((currentCache) => ({
      ...currentCache,
      [bookKey]: {
        status: "loading",
        message: "Finding similar books across Google Books...",
        books: currentCache[bookKey]?.books || [],
      },
    }));

    try {
      const params = new URLSearchParams({
        q: getGoogleBooksSimilarQuery(book),
        key: googleBooksApiKey,
        maxResults: "30",
        printType: "books",
        orderBy: "relevance",
        fields:
          "items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,description,categories,averageRating))",
      });
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?${params}`
      );

      if (!response.ok) {
        throw new Error("Google Books did not return recommendations right now.");
      }

      const data = await response.json();
      const seen = new Set([normalizeBookText(book.title)]);
      const recommendedBooks = (data.items || [])
        .map((item) => ({
          item,
          score: scoreSimilarGoogleBook(book, item),
        }))
        .filter(({ item, score }) => {
          const titleKey = normalizeBookText(item?.volumeInfo?.title);
          if (score <= 0 || !titleKey || seen.has(titleKey)) return false;
          seen.add(titleKey);
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(({ item }) => mapGoogleBookToCatalogBook(item, book));

      setSimilarBooksCache((currentCache) => ({
        ...currentCache,
        [bookKey]: {
          status: recommendedBooks.length ? "ready" : "empty",
          message: recommendedBooks.length
            ? "Similar books loaded from Google Books."
            : "No global similar books were found for this title right now.",
          books: recommendedBooks,
        },
      }));
    } catch (err) {
      console.error("Similar books lookup failed:", err);
      setSimilarBooksCache((currentCache) => ({
        ...currentCache,
        [bookKey]: {
          status: "error",
          message:
            "Could not load global similar books. Check your connection and try again.",
          books: [],
        },
      }));
    }
  }, []);

  const findBookPreview = useCallback(async (book) => {
    if (!googleBooksApiKey) {
      return {
        status: "error",
        message:
          "Google Books API key is not configured. Add GOOGLE_BOOKS_API_KEY to .env.local and restart the dev server.",
      };
    }

    const query = getGoogleBooksQuery(book);
    if (!query) {
      return {
        status: "error",
        message: "Could not search Google Books because this book is missing a title.",
      };
    }

    let timeoutId;

    try {
      const controller = new AbortController();
      timeoutId = window.setTimeout(
        () => controller.abort(),
        GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS
      );
      const params = new URLSearchParams({
        q: query,
        key: googleBooksApiKey,
        maxResults: "20",
        printType: "books",
        fields:
          "items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,description,categories),accessInfo(embeddable,viewability,webReaderLink))",
      });
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?${params}`,
        { signal: controller.signal }
      );

      if (!response.ok) {
        return {
          status: "error",
          message:
            "Google Books did not return a preview right now. Please try again in a moment.",
        };
      }

      const data = await response.json();
      const rankedBooks = (data.items || [])
        .map((item) => ({ item, score: scoreGoogleBooksMatch(book, item) }))
        .sort((a, b) => b.score - a.score);
      const matchingBooks = rankedBooks.filter(({ score }) => score >= 50);
      const embeddableBook = matchingBooks.find(
        ({ item }) =>
          item?.id &&
          item?.accessInfo?.embeddable &&
          item?.accessInfo?.viewability !== "NO_PAGES"
      )?.item;

      if (!embeddableBook) {
        return {
          status: "unavailable",
          message: "No preview available",
          checkedResults: data.items?.length || 0,
        };
      }

      return {
        status: "ready",
        title: embeddableBook.volumeInfo?.title || book.title,
        embedUrl: getGoogleBooksEmbedUrl(embeddableBook.id),
        googleBooksTitle: embeddableBook.volumeInfo?.title || "",
        googleBooksAuthors: embeddableBook.volumeInfo?.authors || [],
        googleBooksDescription: embeddableBook.volumeInfo?.description || "",
        googleBooksCategories: embeddableBook.volumeInfo?.categories || [],
        googleBooksViewability: embeddableBook.accessInfo?.viewability || "",
        googleBooksReaderLink: embeddableBook.accessInfo?.webReaderLink || "",
      };
    } catch (err) {
      console.error("Google Books preview lookup failed:", err);
      if (err?.name === "AbortError") {
        return {
          status: "unavailable",
          message: "No preview available",
        };
      }

      return {
        status: "error",
        message:
          "Could not load the preview. Check your connection and try again.",
      };
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    if (books.length === 0) return;

    let cancelled = false;
    const fallbackTimers = [];

    books.forEach((book) => {
      const key = getBookKey(book);
      const cachedPreview = previewCacheRef.current[key];
      const loadingAge =
        cachedPreview?.status === "loading"
          ? getTimestamp() - Number(cachedPreview.startedAt || 0)
          : 0;

      if (
        !key ||
        (cachedPreview &&
          cachedPreview.status !== "loading" &&
          cachedPreview.status !== "error") ||
        (cachedPreview?.status === "loading" &&
          loadingAge < GOOGLE_BOOKS_PREVIEW_STALE_MS)
      ) {
        return;
      }

      const loadingPreview = {
        status: "loading",
        message: "Checking preview availability...",
        startedAt: getTimestamp(),
      };

      updateBookPreviewCache(key, loadingPreview);

      const fallbackTimer = window.setTimeout(() => {
        if (
          !cancelled &&
          previewCacheRef.current[key]?.status === "loading" &&
          previewCacheRef.current[key]?.startedAt === loadingPreview.startedAt
        ) {
          updateBookPreviewCache(key, {
            status: "unavailable",
            message: "No preview available",
          });
        }
      }, GOOGLE_BOOKS_PREVIEW_STALE_MS);
      fallbackTimers.push(fallbackTimer);

      findBookPreview(book).then((previewResult) => {
        window.clearTimeout(fallbackTimer);
        if (cancelled) return;

        updateBookPreviewCache(key, previewResult);
      });
    });

    return () => {
      cancelled = true;
      fallbackTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [books, findBookPreview]);

  async function openPreview(book) {
    if (!book?.title) {
      setPreviewModal({
        book: book || { title: "Book preview" },
        status: "error",
        message: "Preview needs a book title first.",
      });
      return;
    }

    const key = getBookKey(book);
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;

    setPreviewModal({
      book,
      status: "loading",
      message: "Loading Google Books preview...",
    });

    const cachedPreview = previewCache[key];
    const cachedPreviewIsFreshLoading =
      cachedPreview?.status === "loading" &&
      getTimestamp() - Number(cachedPreview.startedAt || 0) <
        GOOGLE_BOOKS_PREVIEW_STALE_MS;

    if (
      cachedPreview &&
      cachedPreview.status !== "error" &&
      cachedPreview.status !== "loading"
    ) {
      setPreviewModal({ book, ...previewCache[key] });
      return;
    }

    if (cachedPreviewIsFreshLoading) return;

    let previewResult;
    try {
      previewResult = await findBookPreview(book);
    } catch (err) {
      console.error("Preview failed unexpectedly:", err);
      previewResult = {
        status: "error",
        message: "Preview could not be opened right now.",
      };
    }

    if (previewRequestId.current !== requestId) return;

    setPreviewCache((currentCache) => ({
      ...currentCache,
      [key]: previewResult,
    }));
    setPreviewModal({ book, ...previewResult });
  }

  function closePreview() {
    previewRequestId.current += 1;
    setPreviewModal(null);
  }

  function saveLocalPreviewFile(fileName, payload, bookTitle, displayName, type) {
    const savedAt = new Date().toISOString();
    const savedKey = getSavedFileKey(bookTitle, type);
    const savedFile = {
      id: savedKey,
      name: displayName || fileName,
      bookTitle,
      location: "This phone",
      savedAt,
      type,
      payload,
    };
    const alreadySaved = savedFileIdsRef.current.has(savedKey);

    if (alreadySaved) {
      setSavedFiles((currentFiles) =>
        currentFiles.map((file) =>
          file.id === savedKey ? { ...file, ...savedFile } : file
        )
      );
    } else {
      savedFileIdsRef.current.add(savedKey);
      setSavedFiles((currentFiles) => [savedFile, ...currentFiles]);
    }

    setSaveStatus({
      message: alreadySaved
        ? `Updated ${displayName || fileName} on this phone.`
        : `Saved ${displayName || fileName} on this phone.`,
      bookKey: savedKey,
      type,
    });
  }

  function downloadPreviewDetails() {
    if (!previewModal?.book) return;

    const book = previewModal.book;
    const fileName = `${getSafeFileName(book.title)}-preview-details.json`;
    const payload = {
      savedAt: new Date().toISOString(),
      catalogBook: getBookDetailsPayload(book),
      preview: {
        status: previewModal.status,
        message: previewModal.message || "",
        embedUrl: previewModal.embedUrl || "",
        googleBooksTitle: previewModal.googleBooksTitle || "",
        googleBooksAuthors: previewModal.googleBooksAuthors || [],
        googleBooksCategories: previewModal.googleBooksCategories || [],
        googleBooksViewability: previewModal.googleBooksViewability || "",
        googleBooksReaderLink: previewModal.googleBooksReaderLink || "",
      },
      note:
        "This file saves Lumina and Google Books preview metadata. Preview pages are displayed by Google Books and are not downloaded.",
    };

    saveLocalPreviewFile(
      fileName,
      payload,
      book.title,
      `${book.title} preview`,
      "preview"
    );
  }

  function downloadBookDetails(book) {
    if (!book) return;

    const payload = {
      savedAt: new Date().toISOString(),
      catalogBook: getBookDetailsPayload(book),
    };

    saveLocalPreviewFile(
      `${getSafeFileName(book.title)}-details.json`,
      payload,
      book.title,
      `${book.title} details`,
      "details"
    );
  }

  function openSavedBookPreview(savedBook) {
    if (!savedBook?.catalogBook || !savedBook?.preview) return;

    setPreviewModal({
      book: savedBook.catalogBook,
      ...savedBook.preview,
      status: savedBook.preview.status || "error",
      message: savedBook.preview.message || "",
      source: "saved",
    });
  }

  function showPreviewBookDetails() {
    if (!previewModal?.book) return;

    setSelectedBook(previewModal.book);
    closePreview();
  }

  function renderBookCard(book, index, options = {}) {
    const theme = getTheme(book);
    const previewButton = getPreviewButtonState(book);
    const favoriteSaved = isBookInReadingList(book);
    const compareSelected = compare.some((selectedBook) => getBookKey(selectedBook) === getBookKey(book));
    const confidence = book.scanConfidence || getScanConfidence(book).label;
    const folderName = bookFolders[getBookKey(book)] || "Want to read";

    return (
      <div
        key={`${book.title}-${options.prefix || "book"}-${index}`}
        style={{
          ...styles.card,
          background: theme.cardBg,
          border: `3px solid ${theme.border}`,
        }}
      >
        <div style={styles.bookImage}>
          <span style={styles.cardBookOne} />
          <span style={styles.cardBookTwo} />
          <span style={styles.cardBookThree} />
          <span style={styles.cardLens} />
        </div>

        <h3 style={{ ...styles.cardTitle, color: theme.title }}>{book.title}</h3>

        <div style={styles.metaPillRow}>
          <span style={styles.metaPill}>{confidence}</span>
        </div>

        {options.compact ? (
          <>
            <p>⭐ {book.rating}</p>
            <p>{book.readingLevel}</p>
            <p>{book.whyRead}</p>
          </>
        ) : (
          <>
            <p>
              <b>Author:</b> {book.author}
            </p>

            <p style={styles.rating}>
              <b>Rating:</b> ⭐ {book.rating}
            </p>

            <p>
              <b>Genre:</b> {book.genre}
            </p>

            <p>
              <b>Level:</b> {book.readingLevel}
            </p>

            <p>
              <b>Grade:</b> {book.gradeBand || "Not listed"}
            </p>

            <p>{book.summary}</p>

            <div style={styles.buttonRow}>
              <button
                style={styles.smallButton}
                onClick={() => {
                  setSelectedBook(book);
                  setSimilarBooksView(null);
                }}
              >
                🌟 Details
              </button>

              <button
                style={{
                  ...styles.smallButton,
                  ...(previewButton.saved ? styles.savedButton : {}),
                  ...(previewButton.disabled ? styles.disabledButton : {}),
                }}
                onClick={() => openPreview(book)}
                disabled={previewButton.disabled}
                aria-disabled={previewButton.disabled}
              >
                {previewButton.label}
              </button>

              <button
                style={{
                  ...styles.smallButton,
                  ...styles.favoriteButton,
                  ...(favoriteSaved ? styles.favoriteButtonSaved : {}),
                }}
                onClick={() => toggleReadingList(book)}
                aria-label={favoriteSaved ? "Remove favorite" : "Add favorite"}
                title={favoriteSaved ? "Remove favorite" : "Add favorite"}
              >
                ♥
              </button>

              <select
                style={styles.inlineSelect}
                value={folderName}
                onChange={(event) => handleFolderSelect(book, event.target.value)}
                aria-label="Book folder"
              >
                {getVisibleFolders(folders).map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
                <option value={NEW_FOLDER_OPTION}>Add new folder...</option>
              </select>

              <button
                style={{
                  ...styles.smallButton,
                  ...(compareSelected ? styles.selectedButton : {}),
                }}
                onClick={() => toggleCompare(book)}
              >
                {compareSelected ? "Comparing" : "⚖️ Compare"}
              </button>
            </div>
          </>
        )}

        {options.topPick && (
          <p
            style={{
              ...styles.badge,
              ...getShelfPickStyle(book.shelfPick),
            }}
          >
            {book.shelfPick}
          </p>
        )}
      </div>
    );
  }

  function renderFilterControls() {
    return (
      <section style={styles.filterPanel}>
        <div style={styles.filterHeader}>
          <button
            type="button"
            style={styles.filterTitleButton}
            onClick={() => setFiltersOpen((isOpen) => !isOpen)}
            aria-expanded={filtersOpen}
          >
            <span style={styles.filterTitle}>Filters</span>
            <span style={styles.filterCountBadge}>{activeFilterCount}</span>
            <span style={styles.filterChevron}>{filtersOpen ? "▲" : "▼"}</span>
          </button>
          <div style={styles.filterHeaderActions}>
            <button
              type="button"
              style={styles.clearFilterButton}
              onClick={clearFilters}
              disabled={activeFilterCount === 0}
            >
              Clear
            </button>
          </div>
        </div>

        <div style={styles.filterComposer}>
          <input
            ref={filterSearchRef}
            style={styles.filterSearchInput}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            placeholder={
              voiceListening
                ? "Listening for genre, age, rating, or level..."
                : "Search or speak filters..."
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const trimmedSearch = search.trim();
                setVoiceStatus(
                  trimmedSearch
                    ? `Searched: "${trimmedSearch}"`
                    : "Type or speak a filter search first."
                );
              }
            }}
          />
          <button
            type="button"
            style={{
              ...styles.iconComposerButton,
              ...(voiceListening ? styles.iconComposerButtonActive : {}),
            }}
            onClick={handleVoiceSearch}
            aria-label={voiceListening ? "Stop voice search" : "Start voice search"}
            aria-pressed={voiceListening}
          >
            {voiceListening ? "■" : "🎙"}
          </button>
          <button
            type="button"
            style={styles.sendComposerButton}
            onClick={() => {
              const trimmedSearch = search.trim();
              setVoiceStatus(
                trimmedSearch
                  ? `Searched: "${trimmedSearch}"`
                  : "Type or speak a filter search first."
              );
            }}
            aria-label="Search filters"
          >
            ↑
          </button>
        </div>

        {voiceStatus && <p style={styles.voiceStatus}>{voiceStatus}</p>}

        {!filtersOpen && activeFilterCount > 0 && (
          <p style={styles.filterSummary}>
            {activeFilterCount} active filter{activeFilterCount === 1 ? "" : "s"}
          </p>
        )}

        {filtersOpen && <div style={styles.filterGrid}>
          <label style={styles.filterLabel}>
            <span>Genre</span>
            <input
              style={styles.filterControl}
              list="genre-options"
              value={filters.genre}
              placeholder="Any genre"
              onChange={(event) => updateFilter("genre", event.target.value)}
            />
            <datalist id="genre-options">
              {genreOptions.map((genre) => (
                <option key={genre} value={genre} />
              ))}
            </datalist>
          </label>

          <label style={styles.filterLabel}>
            <span>Grade</span>
            <select
              style={styles.filterControl}
              value={filters.gradeBand}
              onChange={(event) => updateFilter("gradeBand", event.target.value)}
            >
              <option value="">Any grade</option>
              {FILTER_OPTIONS.gradeBand.map((gradeBand) => (
                <option key={gradeBand} value={gradeBand}>
                  {gradeBand}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.filterLabel}>
            <span>Book Level</span>
            <select
              style={styles.filterControl}
              value={filters.readingLevel}
              onChange={(event) =>
                updateFilter("readingLevel", event.target.value)
              }
            >
              <option value="">Any level</option>
              {FILTER_OPTIONS.readingLevel.map((readingLevel) => (
                <option key={readingLevel} value={readingLevel}>
                  {readingLevel}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.filterLabel}>
            <span>Age</span>
            <select
              style={styles.filterControl}
              value={filters.ageRecommendation}
              onChange={(event) =>
                updateFilter("ageRecommendation", event.target.value)
              }
            >
              <option value="">Any age</option>
              {FILTER_OPTIONS.ageRecommendation.map((ageRecommendation) => (
                <option key={ageRecommendation} value={ageRecommendation}>
                  {ageRecommendation}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.filterLabel}>
            <span>Shelf Pick</span>
            <select
              style={styles.filterControl}
              value={filters.shelfPick}
              onChange={(event) => updateFilter("shelfPick", event.target.value)}
            >
              <option value="">Any pick</option>
              {FILTER_OPTIONS.shelfPick.map((shelfPick) => (
                <option key={shelfPick} value={shelfPick}>
                  {shelfPick}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.filterLabel}>
            <span>Rating</span>
            <select
              style={styles.filterControl}
              value={filters.minRating}
              onChange={(event) => updateFilter("minRating", event.target.value)}
            >
              <option value="">Any rating</option>
              {FILTER_OPTIONS.minRating.map((rating) => (
                <option key={rating} value={rating}>
                  {rating}+ stars
                </option>
              ))}
            </select>
          </label>
        </div>}
      </section>
    );
  }

  function renderLoginPage() {
    const isSignUp = authMode === "signup";
    const accountUser = isSyncUser(user) ? user : null;

    if (accountUser) {
      return (
        <section style={styles.authPanel}>
          <div style={styles.authHeader}>
            <h2 style={styles.authTitle}>Account</h2>
            <p style={styles.authSubtitle}>
              Signed in as {getUserDisplayName(accountUser)}
              {accountUser.email ? ` (${accountUser.email})` : ""}.
            </p>
          </div>

          {!accountUser.emailVerified && (
            <p style={styles.authNotice}>
              Your email is not verified yet. Verify it to protect the account
              and unlock full saved-list sync.
            </p>
          )}

          <div style={styles.authActionRow}>
            {!accountUser.emailVerified && (
              <>
                <button
                  type="button"
                  style={styles.authSecondaryButton}
                  onClick={handleResendVerification}
                  disabled={authLoading || !isFirebaseConfigured}
                >
                  Resend verification
                </button>
                <button
                  type="button"
                  style={styles.authTextButton}
                  onClick={handleRefreshVerification}
                  disabled={authLoading || !isFirebaseConfigured}
                >
                  I verified, refresh
                </button>
              </>
            )}
            <button type="button" style={styles.authTextButton} onClick={handleSignOut}>
              Sign out
            </button>
          </div>

          {authMessage && <p style={styles.authMessage}>{authMessage}</p>}
        </section>
      );
    }

    return (
      <section style={styles.authPanel}>
        <div style={styles.authHeader}>
          <h2 style={styles.authTitle}>{isSignUp ? "Create account" : "Log in"}</h2>
          <p style={styles.authSubtitle}>
            Use Google single sign-on or create an email/password account to
            keep your saved books and filters synced.
          </p>
        </div>

        {!isFirebaseConfigured && (
          <p style={styles.authNotice}>
            Firebase is not configured yet. Add your Firebase web config in
            `.env.local`, then enable Authentication and Firestore.
          </p>
        )}

        {isAndroidApp && !isAndroidGoogleSsoConfigured && (
          <p style={styles.authNotice}>
            Phone Google SSO needs `android/app/google-services.json` and
            `VITE_ANDROID_GOOGLE_SSO_READY=true` before the Android build can sign in.
          </p>
        )}

        {accountUser && !accountUser.emailVerified && (
          <p style={styles.authNotice}>
            Your email is not verified yet. Verify it to protect the account and
            reduce spam signups.
          </p>
        )}

        <form style={styles.authForm} onSubmit={handleAuthSubmit}>
          {isSignUp && (
            <label style={styles.filterLabel}>
              <span>Name</span>
              <input
                style={styles.filterControl}
                value={authForm.name}
                placeholder="Reader name"
                autoComplete="name"
                maxLength={MAX_DISPLAY_NAME_LENGTH}
                onChange={(event) => updateAuthForm("name", event.target.value)}
              />
            </label>
          )}

          <label style={styles.filterLabel}>
            <span>Email</span>
            <input
              style={styles.filterControl}
              value={authForm.email}
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              onChange={(event) => updateAuthForm("email", event.target.value)}
            />
          </label>

          <label style={styles.filterLabel}>
            <span>Password</span>
            <input
              style={styles.filterControl}
              value={authForm.password}
              type="password"
              placeholder="Password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              onChange={(event) => updateAuthForm("password", event.target.value)}
            />
            {isSignUp && (
              <span style={styles.passwordHint}>
                At least 8 characters with an uppercase letter, a number, and a special character.
              </span>
            )}
          </label>

          <button
            type="submit"
            style={styles.authPrimaryButton}
            disabled={authLoading || !isFirebaseConfigured}
          >
            {authLoading ? "Working..." : isSignUp ? "Create Account" : "Log In"}
          </button>
        </form>

        <div style={styles.authActionRow}>
          <button
            type="button"
            style={styles.googleSignInButton}
            onClick={handleGoogleLogin}
            disabled={authLoading || !isFirebaseConfigured}
          >
            <span style={styles.googleSignInIcon} aria-hidden="true">G</span>
            <span>Continue with Google</span>
          </button>
          <button
            type="button"
            style={styles.authTextButton}
            onClick={handleForgotPassword}
            disabled={authLoading || !isFirebaseConfigured}
          >
            Forgot password
          </button>
          {accountUser && !accountUser.emailVerified && (
            <>
              <button
                type="button"
                style={styles.authTextButton}
                onClick={handleResendVerification}
                disabled={authLoading || !isFirebaseConfigured}
              >
                Resend verification
              </button>
              <button
                type="button"
                style={styles.authTextButton}
                onClick={handleRefreshVerification}
                disabled={authLoading || !isFirebaseConfigured}
              >
                I verified, refresh
              </button>
            </>
          )}
        </div>

        <div style={styles.authFooter}>
          <button
            type="button"
            style={styles.authTextButton}
            onClick={() => {
              setAuthMode(isSignUp ? "signin" : "signup");
              setAuthMessage("");
            }}
          >
            {isSignUp ? "Already have an account? Log in" : "Need an account? Sign up"}
          </button>
        </div>

        {authMessage && <p style={styles.authMessage}>{authMessage}</p>}
      </section>
    );
  }

  function renderBarcodeSvg(cardNumber) {
    const { bars, width } = getCode128Bars(cardNumber);
    const viewBoxWidth = Math.max(width + 24, 120);

    if (!bars.length) return null;

    return (
      <svg
        style={styles.libraryCardBarcode}
        viewBox={`0 0 ${viewBoxWidth} 92`}
        role="img"
        aria-label="Scannable library card barcode"
        preserveAspectRatio="none"
      >
        <rect x="0" y="0" width={viewBoxWidth} height="92" fill="#ffffff" />
        {bars.map((bar, index) => (
          <rect
            key={`${bar.x}-${index}`}
            x={bar.x + 12}
            y="10"
            width={bar.width}
            height="58"
            fill="#111111"
          />
        ))}
        <text
          x={viewBoxWidth / 2}
          y="84"
          textAnchor="middle"
          fontFamily="ui-monospace, Consolas, monospace"
          fontSize="8"
          fill="#111111"
        >
          {cardNumber}
        </text>
      </svg>
    );
  }

  function renderLibraryCards() {
    const canUseLibraryCards = isSyncUser(user);
    const canAddCard = libraryCards.length < MAX_LIBRARY_CARDS;
    const visibleLibraryCards = canUseLibraryCards ? libraryCards : [];

    return renderCollapsibleSection({
      id: "libraryCards",
      title: "Library cards",
      meta: "",
      defaultOpen: true,
      style: styles.authPanel,
      bodyStyle: styles.libraryCardBody,
      children: (
        <>
          <form style={styles.libraryCardForm} onSubmit={addLibraryCardFromForm}>
            <div style={styles.walletAddHeader}>
              <span style={styles.walletAddIcon}>+</span>
              <div>
                <h3 style={styles.walletAddTitle}>Add library card</h3>
                <p style={styles.savedFileMeta}>
                  {canUseLibraryCards
                    ? "Take a photo or upload the card."
                    : "Sign in to unlock saved library cards."}
                </p>
              </div>
            </div>

            <label style={styles.filterLabel}>
              <span>Library</span>
              <input
                style={styles.filterControl}
                value={libraryCardForm.name}
                placeholder="City Library"
                maxLength={MAX_LIBRARY_CARD_NAME_LENGTH}
                onChange={(event) => updateLibraryCardForm("name", event.target.value)}
                disabled={!canUseLibraryCards || !canAddCard}
              />
            </label>

            <label style={styles.filterLabel}>
              <span>Card barcode</span>
              <input
                style={styles.filterControl}
                value={libraryCardForm.cardNumber}
                placeholder="Scan or type card number"
                inputMode="text"
                maxLength={MAX_LIBRARY_CARD_NUMBER_LENGTH}
                onChange={(event) =>
                  updateLibraryCardForm("cardNumber", event.target.value)
                }
                disabled={!canUseLibraryCards || !canAddCard}
              />
            </label>

            <div style={styles.libraryCardActions}>
              <label
                style={{
                  ...styles.authSecondaryButton,
                  ...styles.libraryCardScanButton,
                  ...(!canUseLibraryCards || !canAddCard ? styles.disabledButton : {}),
                }}
                onClick={() => {
                  if (!canUseLibraryCards) requireLoginForLibraryCards();
                }}
              >
                Take card photo
                <input
                  ref={libraryCardScanInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  disabled={!canUseLibraryCards || !canAddCard}
                  onChange={(event) => handleLibraryCardScan(event.target.files[0])}
                />
              </label>
              <button
                type="submit"
                style={styles.authPrimaryButton}
                disabled={canUseLibraryCards && !canAddCard}
              >
                {canUseLibraryCards ? "Add card" : "Log in to add"}
              </button>
            </div>

            {libraryCardForm.imageDataUrl && (
              <div style={styles.libraryCardPhotoPreview}>
                <img
                  src={libraryCardForm.imageDataUrl}
                  alt="Library card preview"
                  style={styles.libraryCardPhoto}
                />
              </div>
            )}

            {!canAddCard && (
              <p style={styles.countText}>Remove a card before adding another one.</p>
            )}
            {libraryCardMessage && (
              <p style={styles.authMessage}>{libraryCardMessage}</p>
            )}
          </form>

          <div style={styles.libraryCardList}>
            {visibleLibraryCards.length === 0 ? (
              <p style={styles.countText}>
                {canUseLibraryCards
                  ? "No library cards saved yet."
                  : "Saved cards appear here after login."}
              </p>
            ) : (
              visibleLibraryCards.map((card) => (
                <article key={card.id} style={styles.libraryCardTile}>
                  <button
                    type="button"
                    style={styles.libraryCardWalletButton}
                    onClick={() => setSelectedLibraryCard(card)}
                    aria-label={`Open ${card.name}`}
                  >
                    <span style={styles.walletAccent} />
                    <div>
                      <p style={styles.walletEyebrow}>Library card</p>
                      <h3 style={styles.libraryCardName}>{card.name}</h3>
                      <p style={styles.walletMaskedNumber}>
                        •••• {card.cardNumber.slice(-4) || "card"}
                      </p>
                    </div>
                    <span style={styles.walletTapHint}>Show</span>
                  </button>
                  <div style={styles.libraryCardTileActions}>
                    <button
                      type="button"
                      style={styles.smallButton}
                      onClick={() => setSelectedLibraryCard(card)}
                    >
                      Barcode
                    </button>
                    <button
                      type="button"
                      style={styles.deleteButton}
                      onClick={() => deleteLibraryCard(card.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </>
      ),
    });
  }

  function renderCollapsibleSection({
    id,
    title,
    meta = "",
    defaultOpen = false,
    children,
    style = {},
    bodyStyle = {},
    headerAction = null,
  }) {
    const isOpen = Boolean(openSections[id] ?? defaultOpen);
    const headerButton = (
      <button
        type="button"
        style={{
          ...styles.collapsibleHeader,
          ...(headerAction ? styles.collapsibleHeaderToggle : {}),
        }}
        onClick={() =>
          setOpenSections((sections) => ({
            ...sections,
            [id]: !isOpen,
          }))
        }
        aria-expanded={isOpen}
      >
        <span style={styles.collapsibleTitle}>{title}</span>
        <span style={styles.collapsibleMeta}>
          {meta}
          <span style={styles.collapsibleChevron}>{isOpen ? "▲" : "▼"}</span>
        </span>
      </button>
    );

    return (
      <section style={{ ...styles.collapsibleSection, ...style }}>
        {headerAction ? (
          <div style={styles.collapsibleHeaderWithAction}>
            {headerButton}
            {headerAction}
          </div>
        ) : (
          headerButton
        )}
        {isOpen && <div style={{ ...styles.collapsibleBody, ...bodyStyle }}>{children}</div>}
      </section>
    );
  }

  function renderSavedFiles(sectionKey) {
    const savedFileBooks = getSavedBookGroups(savedFiles).map((savedBook) => ({
      ...savedBook,
      preview:
        previewCache[getBookKey(savedBook.catalogBook)]?.status === "ready"
          ? previewCache[getBookKey(savedBook.catalogBook)]
          : savedBook.preview,
      favorite: false,
      source: "file",
    }));
    const savedBooksByKey = new Map();

    savedFileBooks.forEach((savedBook) => {
      const key = getBookKey(savedBook.catalogBook) || savedBook.id;
      savedBooksByKey.set(key, savedBook);
    });

    readingList.forEach((book) => {
      const key = getBookKey(book);
      const existingSavedBook = savedBooksByKey.get(key);

      if (existingSavedBook) {
        savedBooksByKey.set(key, {
          ...existingSavedBook,
          favorite: true,
          source: "file-favorite",
          savedAt:
            new Date(book.savedAt || 0).getTime() >
            new Date(existingSavedBook.savedAt || 0).getTime()
              ? book.savedAt
              : existingSavedBook.savedAt,
        });
        return;
      }

      savedBooksByKey.set(key, {
        id: `favorite-${key}`,
        ids: [],
        bookTitle: book.title,
        catalogBook: book,
        preview:
          previewCache[getBookKey(book)]?.status === "ready"
            ? previewCache[getBookKey(book)]
            : null,
        favorite: true,
        location: "Favorite",
        savedAt: book.savedAt || new Date().toISOString(),
        source: "favorite",
      });
    });

    const savedBooks = [...savedBooksByKey.values()].sort(
      (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
    );

    return renderCollapsibleSection({
      id: `${sectionKey}-savedBooks`,
      title: "Saved",
      meta: `${savedBooks.length}`,
      defaultOpen: sectionKey !== "results",
      style: styles.savedFilesSection,
      children: (
        <>
        <div style={styles.savedFilesTop}>
          <button
            type="button"
            className={savedArtActive ? "saved-files-art is-active" : "saved-files-art"}
            style={styles.savedFilesArt}
            onClick={triggerMagicBurst}
            aria-label="Spark saved files"
            title="Spark saved files"
          >
            <span style={styles.savedArtBookOne} />
            <span style={styles.savedArtBookTwo} />
            <span style={styles.savedArtBookThree} />
            <span style={styles.savedArtSpark} />
          </button>

          <span style={styles.fileCountBadge}>{savedBooks.length}</span>
        </div>

        {saveStatus?.message && sectionKey === "home" && (
          <p style={styles.saveStatus}>{saveStatus.message}</p>
        )}

        {savedBooks.length === 0 ? (
          <p style={styles.countText}>
            No books yet. Add favorites from Details, or save preview/details
            from a popup.
          </p>
        ) : (
          <div style={styles.savedFileList}>
            {savedBooks.map((savedBook) => (
              <div
                key={`${sectionKey}-${savedBook.id}`}
                className="saved-file-item"
                style={styles.savedFileItem}
              >
                <div className="saved-file-info" style={styles.savedFileInfo}>
                  <button
                    className="saved-file-name-button"
                    style={styles.savedFileNameButton}
                    onClick={() =>
                      savedBook.catalogBook && setSelectedBook(savedBook.catalogBook)
                    }
                  >
                    {savedBook.bookTitle}
                  </button>
                  <p style={styles.savedFileMeta}>
                    {savedBook.favorite ? "Favorite" : "Saved"}
                    {savedBook.favorite && savedBook.source !== "favorite"
                      ? " + Saved"
                      : ""}{" "}
                    · {new Date(savedBook.savedAt).toLocaleString()}
                  </p>
                </div>

                <div className="saved-file-actions" style={styles.savedFileActions}>
                  {savedBook.catalogBook && (
                    <select
                      style={styles.inlineSelect}
                      value={
                        bookFolders[getBookKey(savedBook.catalogBook)] ||
                        "Want to read"
                      }
                      onChange={(event) =>
                        handleSavedBookFolderSelect(savedBook, event.target.value)
                      }
                      aria-label={`Folder for ${savedBook.bookTitle}`}
                    >
                      {getVisibleFolders(folders).map((folder) => (
                        <option key={folder} value={folder}>
                          {folder}
                        </option>
                      ))}
                      <option value={NEW_FOLDER_OPTION}>Add new folder...</option>
                    </select>
                  )}

                  {canOpenSavedBookPreview(savedBook) ? (
                    <button
                      style={styles.smallButton}
                      onClick={() => openSavedBookPreview(savedBook)}
                    >
                      Open Preview
                    </button>
                  ) : (
                    <span style={styles.noPreviewBadge}>No preview available</span>
                  )}

                  <button
                    style={styles.deleteButton}
                    onClick={() => {
                      if (savedBook.source !== "favorite") deleteSavedBook(savedBook);
                      if (savedBook.favorite) {
                        setReadingList((currentList) =>
                          currentList.filter(
                            (book) =>
                              getBookKey(book) !== getBookKey(savedBook.catalogBook)
                          )
                        );
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        </>
      ),
    });
  }

  function renderCompareRow(label, field) {
    return (
      <div className="compare-row" style={styles.compareRow}>
        <div style={styles.compareLabel}>{label}</div>
        {compare.map((book) => (
          <div key={`${book.title}-${label}`} style={styles.compareValue}>
            {getComparedValue(book, field)}
          </div>
        ))}
      </div>
    );
  }

  function handleIdleBookTap(event, color) {
    const burstId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;

    setIdleBursts((currentBursts) => [
      ...currentBursts,
      {
        id: burstId,
        color,
        x: event.clientX,
        y: event.clientY,
      },
    ]);

    window.setTimeout(() => {
      setIdleBursts((currentBursts) =>
        currentBursts.filter((burst) => burst.id !== burstId)
      );
    }, 900);
  }

  function triggerMagicBurst(event) {
    setSavedArtActive(true);
    handleIdleBookTap(event, "#f59e0b");
    window.setTimeout(() => handleIdleBookTap(event, "#2563eb"), 120);
    window.setTimeout(() => handleIdleBookTap(event, "#A7D7B8"), 220);
    window.setTimeout(() => setSavedArtActive(false), 520);
  }

  function resetPage() {
    setImagePreview(null);
    setBooks([]);
    setSearch("");
    setLoading(false);
    setError("");
    setSelectedBook(null);
    setSimilarBooksView(null);
    setCompare([]);
    setCompareOpen(false);
    setPreviewCache({});
    previewCacheRef.current = {};
    setPreviewModal(null);
    previewRequestId.current += 1;
    setSaveStatus(null);
    setVoiceStatus("");
    setVoiceListening(false);
    recognitionRef.current?.abort();
  }

  const syncUser = isSyncUser(user) ? user : null;
  const signedInName = syncUser ? getUserDisplayName(syncUser) : "";
  const canOpenDeveloper = hasDeveloperAccess(syncUser);
  const homeGreeting = syncUser
    ? `Hi ${signedInName}, ${getTimeGreeting()}.`
    : "Welcome to Lumina.";
  const homeGreetingDetail = syncUser
    ? "Your saved books, filters, and preview files are ready here."
    : "Sign in to sync your saved books and filters across devices.";

  function renderSavedBooksPage() {
    const visibleFolders = getVisibleFolders(folders);
    const folderTabs = ["All", ...visibleFolders];
    const libraryBooks = readingList.filter((book) => {
      if (activeFolder === "All") return true;
      return (bookFolders[getBookKey(book)] || "Want to read") === activeFolder;
    });

    return (
      <section style={styles.pagePanel}>
        <div style={styles.authHeader}>
          <h2 style={styles.authTitle}>Saved</h2>
        </div>

        {renderCollapsibleSection({
          id: "libraryFolders",
          title: "Folders",
          meta: `${folderTabs.length}`,
          defaultOpen: true,
          children: (
            <>
              <div style={styles.folderToolbar}>
                <div style={styles.folderTabs}>
                  {folderTabs.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      style={{
                        ...styles.navButton,
                        ...(activeFolder === folder ? styles.navButtonActive : {}),
                      }}
                      onClick={() => setActiveFolder(folder)}
                    >
                      {folder}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  style={styles.authSecondaryButton}
                  onClick={createFolder}
                >
                  Add folder
                </button>
              </div>
              {saveStatus?.type === "folder" && (
                <p style={styles.saveStatus}>{saveStatus.message}</p>
              )}
              {libraryBooks.length === 0 ? (
                <p style={styles.countText}>No saved books in this folder yet.</p>
              ) : (
                <div style={styles.grid}>
                  {libraryBooks.map((book, index) =>
                    renderBookCard(book, index, { prefix: "library" })
                  )}
                </div>
              )}
            </>
          ),
        })}

        {renderSavedFiles("library")}
      </section>
    );
  }

  function renderAccountPage() {
    return (
      <>
        {renderLoginPage()}
        {renderLibraryCards()}
        {canOpenDeveloper && renderDeveloperPage()}
      </>
    );
  }

  const renderDeveloperPage = () =>
    renderCollapsibleSection({
      id: "developer",
      title: "Developer",
      meta: developerStatsStatus ? "Stats" : "",
      style: styles.pagePanel,
      children: (
        <>
          <div style={styles.developerLinkRow}>
            <a
              style={styles.developerLinkButton}
              href={firestoreConsoleUrl}
              target="_blank"
              rel="noreferrer"
            >
              Firebase Console
            </a>
            <a
              style={styles.developerLinkButton}
              href={firebaseAuthConsoleUrl}
              target="_blank"
              rel="noreferrer"
            >
              Firebase Auth
            </a>
          </div>

      <div style={styles.developerStatsGrid}>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>API calls today</span>
          <strong style={styles.developerStatValue}>
            {developerUsage.apiCalls.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Prompt tokens today</span>
          <strong style={styles.developerStatValue}>
            {developerUsage.promptTokens.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Output tokens today</span>
          <strong style={styles.developerStatValue}>
            {developerUsage.outputTokens.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Total tokens today</span>
          <strong style={styles.developerStatValue}>
            {developerUsage.totalTokens.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Success / failed</span>
          <strong style={styles.developerStatValueSmall}>
            {developerUsage.successCalls.toLocaleString()} / {developerUsage.failedCalls.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Last API call</span>
          <strong style={styles.developerStatValueSmall}>
            {developerUsage.lastCallType || "No API calls yet"}
            {developerUsage.lastStatus ? ` · ${developerUsage.lastStatus}` : ""}
            {developerUsage.lastProvider ? ` · ${developerUsage.lastProvider}` : ""}
            {developerUsage.lastModel ? ` · ${developerUsage.lastModel}` : ""}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Last customer</span>
          <strong style={styles.developerStatValueSmall}>
            {developerUsage.lastUserEmail || "No API calls yet"}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Tokens by IP</span>
          <div style={styles.developerIpList}>
            {developerIpUsage.length === 0 ? (
              <strong style={styles.developerStatValueSmall}>No IP usage yet</strong>
            ) : (
              developerIpUsage.map((usage) => (
                <div key={usage.ipAddress} style={styles.developerIpRow}>
                  <strong>{usage.ipAddress}</strong>
                  <span>
                    {usage.totalTokens.toLocaleString()} tokens · {usage.apiCalls.toLocaleString()} calls
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Registered users</span>
          <strong style={styles.developerStatValue}>
            {developerStats.registeredUsers.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Total logins</span>
          <strong style={styles.developerStatValue}>
            {developerStats.totalLoginEvents.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Logins today</span>
          <strong style={styles.developerStatValue}>
            {developerStats.todayLoginEvents.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Recent unique users</span>
          <strong style={styles.developerStatValue}>
            {developerStats.recentUniqueUsers.toLocaleString()}
          </strong>
        </div>
        <div style={styles.developerStatCard}>
          <span style={styles.developerStatLabel}>Last login</span>
          <strong style={styles.developerStatValueSmall}>
            {developerStats.lastLoginEmail || "No logins yet"}
            {developerStats.lastLoginMethod ? ` · ${developerStats.lastLoginMethod}` : ""}
            {developerStats.lastLoginAt ? ` · ${getDisplayTime(developerStats.lastLoginAt)}` : ""}
          </strong>
        </div>
      </div>
        </>
      ),
    });

  return (
    <div style={styles.page}>
      <div className="idle-background" aria-hidden="true">
        <span className="gravity-line gravity-line-one" />
        <span className="gravity-line gravity-line-two" />
        <span className="gravity-line gravity-line-three" />
        <span className="gravity-line gravity-line-four" />
        <span className="gravity-dot gravity-dot-blue gravity-dot-one" />
        <span className="gravity-dot gravity-dot-green gravity-dot-two" />
        <span className="gravity-dot gravity-dot-yellow gravity-dot-three" />
        <span className="gravity-dot gravity-dot-red gravity-dot-four" />
        <span className="gravity-dot gravity-dot-blue gravity-dot-five" />
        <span className="gravity-dot gravity-dot-green gravity-dot-six" />
        <span className="gravity-dot gravity-dot-yellow gravity-dot-seven" />
        <span className="gravity-dot gravity-dot-red gravity-dot-eight" />
        <span className="idle-scan idle-scan-one" />
        <span className="idle-scan idle-scan-two" />
        <span
          className="idle-book idle-book-blue"
          onPointerDown={(event) => handleIdleBookTap(event, "#2563eb")}
        />
        <span
          className="idle-book idle-book-green"
          onPointerDown={(event) => handleIdleBookTap(event, "#A7D7B8")}
        />
        <span
          className="idle-book idle-book-yellow"
          onPointerDown={(event) => handleIdleBookTap(event, "#92400e")}
        />
        <span
          className="idle-book idle-book-red"
          onPointerDown={(event) => handleIdleBookTap(event, "#b91c1c")}
        />
        <span className="idle-star idle-star-one" />
        <span className="idle-star idle-star-two" />
        <span className="idle-star idle-star-three" />
        {idleBursts.map((burst) => (
          <span
            key={burst.id}
            className="idle-burst"
            style={{
              "--burst-color": burst.color,
              left: burst.x,
              top: burst.y,
            }}
          />
        ))}
      </div>

      <div style={styles.hero}>
        <div style={styles.heroText}>
          <button
            type="button"
            style={styles.brandButton}
            onClick={resetPage}
            aria-label="Reset Lumina"
          >
            <div style={styles.brandMark} aria-hidden="true">
              <span style={styles.logoBook} />
              <span style={styles.logoSpine} />
              <span style={styles.logoLens} />
              <span style={styles.logoBeam} />
            </div>
            <h1 style={styles.title}>Lumina</h1>
          </button>
          {currentPage === "scan" && (
            <p style={styles.subtitle}>
              Take a photo of your bookshelf and Lumina will identify the books,
              organize them, and help you choose what to read next.
            </p>
          )}
        </div>

        <div style={styles.heroArt} aria-hidden="true">
          <span style={{ ...styles.agentDot, background: "#2563eb" }} />
          <span style={{ ...styles.agentDot, background: "#18794e" }} />
          <span style={{ ...styles.agentDot, background: "#f59e0b" }} />
        </div>
      </div>

      {currentPage === "account" && renderAccountPage()}
      {currentPage === "saved" && renderSavedBooksPage()}

      {currentPage === "scan" && (
        <>
      <section style={styles.homeGreetingPanel}>
        <h2 style={styles.homeGreetingTitle}>{homeGreeting}</h2>
        <p style={styles.homeGreetingText}>{homeGreetingDetail}</p>
      </section>

      <div style={styles.uploadBox}>
        <label
          style={{
            ...styles.cameraButton,
            ...(!isFirebaseConfigured ? styles.scanButtonNeedsAuth : {}),
          }}
          onClick={handleScanPickerClick}
        >
          📷 Take Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => handleImage(e.target.files[0])}
          />
        </label>
      </div>

      {renderFilterControls()}

      {imagePreview && (
        <img src={imagePreview} alt="Bookshelf" style={styles.preview} />
      )}

      {error && <p style={styles.error}>{error}</p>}

      {books.length === 0 && renderSavedFiles("home")}

      {books.length > 0 && (
        <>
          {filteredBooks.length === 1 ? (
            renderCollapsibleSection({
              id: "scannedBook",
              title: "Scanned book",
              meta: "1",
              defaultOpen: true,
              children: (
                <div style={styles.grid}>
                  {filteredBooks.map((book, index) =>
                    renderBookCard(book, index, { prefix: "single", topPick: true })
                  )}
                </div>
              ),
            })
          ) : (
            <>
              {renderCollapsibleSection({
                id: "topPicks",
                title: "Top picks",
                meta: `${topBooks.length}`,
                defaultOpen: true,
                children:
                  topBooks.length === 0 ? (
                    <p style={styles.error}>No top picks match your search.</p>
                  ) : (
                    <div style={styles.grid}>
                      {topBooks.map((book, index) =>
                        renderBookCard(book, index, { prefix: "top", topPick: true })
                      )}
                    </div>
                  ),
              })}

              {renderCollapsibleSection({
                id: "detectedBooks",
                title: "Detected books",
                meta: `${detectedBooks.length}`,
                defaultOpen: true,
                children: (
                  <div style={styles.grid}>
                    {detectedBooks.length === 0 ? (
                      <p style={styles.error}>
                        {filteredBooks.length === 0
                          ? "No matching books found. Try another word."
                          : "All matching books are already shown in Top Picks."}
                      </p>
                    ) : (
                      detectedBooks.map((book, index) =>
                        renderBookCard(book, index, { prefix: "detected" })
                      )
                    )}
                  </div>
                ),
              })}
            </>
          )}

          {renderSavedFiles("results")}
        </>
      )}
        </>
      )}

      {currentPage === "scan" && compare.length > 0 && (
        <section style={styles.compareTray}>
          <div>
            <h2 style={{ ...styles.sectionTitle, marginTop: 0 }}>⚖️ Compare Books</h2>
            <p style={styles.countText}>
              {compare.length === 1
                ? "Choose one more book to compare side by side."
                : `${compare[0].title} vs ${compare[1].title}`}
            </p>
          </div>

          <div style={styles.compareTrayActions}>
            <button
              style={styles.smallButton}
              disabled={compare.length < 2}
              onClick={() => setCompareOpen(true)}
            >
              Open Compare
            </button>
            <button style={styles.deleteButton} onClick={() => setCompare([])}>
              Clear
            </button>
          </div>
        </section>
      )}

      {currentPage === "scan" && selectedBook &&
        (() => {
          const theme = getTheme(selectedBook);
          const detailSaveStatus = getScopedSaveStatus(
            saveStatus,
            selectedBook,
            "details"
          );
          const detailsSaved = hasSavedDetails(selectedBook);

          return (
            <div style={styles.modal}>
              <div
                style={{
                  ...styles.modalContent,
                  border: `4px solid ${theme.border}`,
                }}
              >
                <div style={styles.modalHeader}>
                  <div style={{ ...styles.modalIcon, background: theme.imageBg }}>
                    <span className="detail-orbit" style={styles.detailOrbit} />
                    <span className="detail-book-core" style={styles.detailBookCore} />
                    <span className="detail-lens-core" style={styles.detailLensCore} />
                    <span className="detail-spark-one" style={styles.detailSparkOne} />
                    <span className="detail-spark-two" style={styles.detailSparkTwo} />
                  </div>

                  <div>
                    <h2 style={{ ...styles.modalTitle, color: theme.title }}>
                      {selectedBook.title}
                    </h2>

                    <p
                      style={{
                        ...styles.badge,
                        ...getShelfPickStyle(selectedBook.shelfPick),
                      }}
                    >
                      {selectedBook.shelfPick}
                    </p>
                  </div>
                </div>

                {renderCollapsibleSection({
                  id: "detailAuthor",
                  title: "Author",
                  meta: selectedBook.author,
                  defaultOpen: true,
                  children: (
                    <p style={styles.detailText}>
                      {selectedBook.authorBio || "Author information unavailable."}
                    </p>
                  ),
                  style: styles.detailCollapse,
                })}

                <div style={styles.detailGrid}>
                  <div style={styles.detailMiniCard}>
                    <b>⭐ Rating</b>
                    <p>{selectedBook.rating}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>🔎 Source</b>
                    <p>{selectedBook.ratingSource || "Estimated"}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>🎨 Genre</b>
                    <p>{selectedBook.genre}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>🎯 Age</b>
                    <p>{selectedBook.ageRecommendation}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>📈 Level</b>
                    <p>{selectedBook.readingLevel}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>🏫 Grade</b>
                    <p>{selectedBook.gradeBand || "Not listed"}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>✅ Confidence</b>
                    <p>{selectedBook.scanConfidence || getScanConfidence(selectedBook).label}</p>
                  </div>

                  <div style={styles.detailMiniCard}>
                    <b>📁 Folder</b>
                    <p>{bookFolders[getBookKey(selectedBook)] || "Want to read"}</p>
                  </div>
                </div>

                {renderCollapsibleSection({
                  id: "detailNotes",
                  title: "Notes",
                  meta: selectedBook.genre || "Book",
                  defaultOpen: true,
                  children: (
                    <div style={styles.detailNoteGrid}>
                      <p style={styles.detailText}>
                        <b>Why read it?</b>
                        <br />
                        {selectedBook.whyRead}
                      </p>
                      <p style={styles.detailText}>
                        <b>Summary</b>
                        <br />
                        {selectedBook.summary}
                      </p>
                      <p style={styles.detailText}>
                        <b>Suitability</b>
                        <br />
                        {getContentGuidance(selectedBook)}
                      </p>
                    </div>
                  ),
                  style: styles.detailCollapse,
                })}

                {similarBooksView &&
                  renderCollapsibleSection({
                    id: "detailSimilarBooks",
                    title:
                      similarBooksView === "shelf"
                        ? "Similar books on this shelf"
                        : "Similar books in general",
                    meta: `${
                      similarBooksView === "shelf"
                        ? shelfSimilarBooks.length
                        : similarBooks.length
                    }`,
                    defaultOpen: true,
                    headerAction: (
                      <button
                        type="button"
                        style={styles.collapsibleCloseButton}
                        onClick={() => setSimilarBooksView(null)}
                        aria-label="Close similar books"
                        title="Close similar books"
                      >
                        X
                      </button>
                    ),
                    children:
                      similarBooksView === "shelf" ? (
                        shelfSimilarBooks.length === 0 ? (
                          <p style={styles.countText}>
                            No close shelf matches were found in this scan.
                          </p>
                        ) : (
                          <div style={styles.grid}>
                            {shelfSimilarBooks.map((book, index) =>
                              renderBookCard(book, index, {
                                prefix: "shelf-similar",
                                compact: true,
                              })
                            )}
                          </div>
                        )
                      ) : similarBooksState?.status === "loading" ? (
                        <p style={styles.countText}>
                          Finding similar books across Google Books...
                        </p>
                      ) : similarBooks.length === 0 ? (
                        <p style={styles.countText}>
                          {similarBooksState?.message ||
                            "No global similar books were found for this title right now."}
                        </p>
                      ) : (
                        <div style={styles.grid}>
                          {similarBooks.map((book, index) =>
                            renderBookCard(book, index, {
                              prefix: "similar",
                              compact: true,
                            })
                          )}
                        </div>
                      ),
                    style: styles.detailCollapse,
                  })}

                {detailSaveStatus && (
                  <p style={styles.saveStatus}>{detailSaveStatus}</p>
                )}

                <div style={styles.previewActionRow}>
                  <button
                    style={{
                      ...styles.secondaryButton,
                      ...(detailsSaved ? styles.savedButton : {}),
                    }}
                    onClick={() => downloadBookDetails(selectedBook)}
                  >
                    {detailsSaved ? "Saved Details" : "Save Details"}
                  </button>

                  <button
                    style={{
                      ...styles.secondaryButton,
                      ...(similarBooksView === "shelf" ? styles.selectedButton : {}),
                    }}
                    onClick={() => {
                      setSimilarBooksView((currentView) =>
                        currentView === "shelf" ? null : "shelf"
                      );
                    }}
                  >
                    Similar on shelf
                  </button>

                  <button
                    style={{
                      ...styles.secondaryButton,
                      ...(similarBooksView === "global" ? styles.selectedButton : {}),
                    }}
                    onClick={() => {
                      const nextOpen = similarBooksView !== "global";
                      setSimilarBooksView(nextOpen ? "global" : null);
                      if (
                        nextOpen &&
                        selectedBook &&
                        selectedBookKey &&
                        !similarBooksCache[selectedBookKey]?.status
                      ) {
                        loadSimilarBooks(selectedBook);
                      }
                    }}
                  >
                    Similar in general
                  </button>

                  <button
                    style={{ ...styles.closeButton, marginTop: 0 }}
                    onClick={() => setSelectedBook(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {loading && (
        <div style={styles.processingOverlay}>
          <section
            style={styles.processingPanel}
            role="status"
            aria-live="polite"
            aria-label="Processing bookshelf photo"
          >
            <div className="scan-processing-orbit" aria-hidden="true">
              <span className="scan-processing-core" />
            </div>
            <div style={styles.processingCopy}>
              <h2 style={styles.processingTitle}>Building your book list...</h2>
              <p style={styles.processingText}>
                Lumina is reading the shelf, matching titles, and preparing recommendations.
              </p>
            </div>
          </section>
        </div>
      )}

      {currentPage === "scan" && compareOpen && compare.length > 0 && (
        <div style={styles.modal}>
          <div style={styles.compareModalContent}>
            <div style={styles.previewHeader}>
              <div>
                <h2 style={styles.modalTitle}>Compare Books</h2>
                <p style={styles.previewSubtitle}>
                  {compare.length < 2
                    ? "Pick one more book to unlock side-by-side comparison."
                    : "Ratings, levels, age, and summaries side by side."}
                </p>
              </div>

              <button
                style={styles.closeIconButton}
                onClick={() => setCompareOpen(false)}
                aria-label="Close compare"
              >
                X
              </button>
            </div>

            <div style={styles.compareTableScroll}>
              <div style={styles.compareTable}>
                <div className="compare-row" style={styles.compareRow}>
                  <div style={styles.compareLabel}>Book</div>
                  {compare.map((book) => (
                    <div
                      key={`${book.title}-compare-title`}
                      style={styles.compareValueStrong}
                    >
                      {book.title}
                    </div>
                  ))}
                </div>
                {renderCompareRow("Author", "author")}
                {renderCompareRow("Rating", "rating")}
                {renderCompareRow("Genre", "genre")}
                {renderCompareRow("Level", "readingLevel")}
                {renderCompareRow("Grade", "gradeBand")}
                {renderCompareRow("Age", "ageRecommendation")}
                {renderCompareRow("Why read", "whyRead")}
                {renderCompareRow("Summary", "summary")}
              </div>
            </div>

            <div style={styles.previewActionRow}>
              <button
                style={styles.secondaryButton}
                onClick={() => setCompare([])}
              >
                Clear Compare
              </button>
              <button
                style={{ ...styles.closeButton, marginTop: 0 }}
                onClick={() => setCompareOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {libraryCardLoginPromptOpen && (
        <div style={styles.modal}>
          <div style={styles.promptModalContent}>
            <div style={styles.promptIcon} aria-hidden="true">▤</div>
            <h2 style={styles.modalTitle}>Log in to save library cards</h2>
            <p style={styles.previewSubtitle}>
              Sign in to add your library card barcode and keep it synced with
              your Lumina account.
            </p>
            <div style={styles.previewActionRow}>
              <button
                type="button"
                style={styles.googleSignInButton}
                onClick={() => {
                  setLibraryCardLoginPromptOpen(false);
                  handleGoogleLogin();
                }}
                disabled={authLoading || !isFirebaseConfigured}
              >
                <span style={styles.googleSignInIcon} aria-hidden="true">G</span>
                <span>Continue with Google</span>
              </button>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => {
                  setLibraryCardLoginPromptOpen(false);
                  setAuthMode("signin");
                  setCurrentPage("account");
                }}
              >
                Use email login
              </button>
              <button
                type="button"
                style={styles.authTextButton}
                onClick={() => setLibraryCardLoginPromptOpen(false)}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {folderModal.isOpen && (
        <div style={styles.modal}>
          <form style={styles.promptModalContent} onSubmit={saveFolderFromModal}>
            <div style={styles.promptIcon} aria-hidden="true">▤</div>
            <h2 style={styles.modalTitle}>Add folder</h2>
            <p style={styles.previewSubtitle}>
              {folderModal.book
                ? `Create a folder for ${folderModal.book.title}.`
                : "Create a folder to organize saved books."}
            </p>
            <label style={styles.filterLabel}>
              <span>Folder name</span>
              <input
                style={styles.filterControl}
                value={folderModal.name}
                placeholder="Summer reads"
                autoFocus
                onChange={(event) =>
                  setFolderModal((currentModal) => ({
                    ...currentModal,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <div style={styles.previewActionRow}>
              <button
                type="submit"
                style={styles.authPrimaryButton}
                disabled={!folderModal.name.trim()}
              >
                Save folder
              </button>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={closeFolderModal}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {selectedLibraryCard && (
        <div style={styles.modal}>
          <div style={styles.libraryCardModalContent}>
            <div style={styles.previewHeader}>
              <div>
                <h2 style={styles.modalTitle}>{selectedLibraryCard.name}</h2>
                <p style={styles.previewSubtitle}>Library card</p>
              </div>

              <button
                style={styles.closeIconButton}
                onClick={() => setSelectedLibraryCard(null)}
                aria-label="Close library card"
              >
                X
              </button>
            </div>

            {selectedLibraryCard.imageDataUrl ? (
              <img
                src={selectedLibraryCard.imageDataUrl}
                alt={`${selectedLibraryCard.name} full library card`}
                style={styles.libraryCardFullPhoto}
              />
            ) : (
              <p style={styles.countText}>No card photo saved.</p>
            )}

            {renderBarcodeSvg(selectedLibraryCard.cardNumber)}

            <div style={styles.previewActionRow}>
              <button
                style={{ ...styles.closeButton, marginTop: 0 }}
                onClick={() => setSelectedLibraryCard(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {currentPage === "scan" && previewModal && (
        <div style={styles.modal}>
          <div style={styles.previewModalContent}>
            <div style={styles.previewHeader}>
              <div>
                <h2 style={styles.modalTitle}>
                  {previewModal.book?.title || "Book preview"}
                </h2>
                <p style={styles.previewSubtitle}>
                  {previewModal.status === "ready"
                    ? "Google Books preview"
                    : previewModal.message}
                </p>
              </div>

              <button
                style={styles.closeIconButton}
                onClick={closePreview}
                aria-label="Close preview"
              >
                X
              </button>
            </div>

            {previewModal.status === "ready" ? (
              <>
                <iframe
                  title={`${previewModal.book?.title || "Book"} preview`}
                  src={previewModal.embedUrl}
                  style={styles.previewFrame}
                  onError={() =>
                    setPreviewModal((currentModal) => ({
                      ...currentModal,
                      status: "error",
                      message:
                        "Google Books could not display this preview inside the app.",
                    }))
                  }
                />
                <p style={styles.previewHelpText}>
                  If the pages do not appear, Google Books may not allow an
                  embedded preview for this title.
                </p>
              </>
            ) : (
              <div style={styles.previewMessage}>
                <p>{previewModal.message}</p>
              </div>
            )}

            {getScopedSaveStatus(saveStatus, previewModal.book, "preview") && (
              <p style={styles.saveStatus}>
                {getScopedSaveStatus(saveStatus, previewModal.book, "preview")}
              </p>
            )}

            <div style={styles.previewActionRow}>
              {previewModal.source === "saved" ? (
                <button
                  style={styles.secondaryButton}
                  onClick={showPreviewBookDetails}
                >
                  Details
                </button>
              ) : (
                <button
                  style={{
                    ...styles.secondaryButton,
                    ...(previewModal.book && hasSavedPreview(previewModal.book)
                      ? styles.savedButton
                      : {}),
                  }}
                  onClick={downloadPreviewDetails}
                >
                  {previewModal.book && hasSavedPreview(previewModal.book)
                    ? "Saved Preview"
                    : "Save Preview Details"}
                </button>
              )}

              <button
                style={{ ...styles.closeButton, marginTop: 0 }}
                onClick={closePreview}
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      <nav style={styles.bottomTabs} aria-label="App pages">
        {[
          ["scan", "⌕", "Scan", "#2563eb", "rgba(37, 99, 235, 0.13)"],
          ["saved", "▤", "Saved", "#18794e", "rgba(24, 121, 78, 0.13)"],
          ["account", "◉", "Account", "#b45309", "rgba(245, 158, 11, 0.15)"],
        ].map(([pageId, icon, label, accent, accentBg]) => {
          const isActive = currentPage === pageId;

          return (
            <button
              key={pageId}
              type="button"
              style={{
                ...styles.bottomTabButton,
                color: isActive ? accent : "#64748b",
                ...(isActive
                  ? {
                      ...styles.bottomTabButtonActive,
                      background: accentBg,
                      border: `1px solid ${accent}`,
                    }
                  : {}),
              }}
              onClick={() => setCurrentPage(pageId)}
            >
              <span style={{ ...styles.bottomTabIcon, color: accent }}>{icon}</span>
              <span style={styles.bottomTabLabel}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

const styles = {
  page: {
    position: "relative",
    isolation: "isolate",
    overflowX: "hidden",
    minHeight: "100vh",
    width: "100%",
    boxSizing: "border-box",
    maxWidth: "1000px",
    margin: "auto",
    padding: "clamp(14px, 4vw, 24px) clamp(14px, 4vw, 24px) 112px",
    fontFamily:
      '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background:
      "linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(248, 250, 252, 0.9))",
    color: "#4f5f73",
    backdropFilter: "blur(12px)",
  },
  hero: {
    background:
      "radial-gradient(circle at 16% 10%, rgba(37, 99, 235, 0.18), transparent 13rem), radial-gradient(circle at 86% 18%, rgba(245, 158, 11, 0.14), transparent 12rem), linear-gradient(135deg, rgba(255, 255, 255, 0.88), rgba(239, 246, 255, 0.72) 56%, rgba(255, 255, 255, 0.9))",
    borderRadius: "8px",
    padding: "clamp(22px, 6vw, 32px) clamp(16px, 5vw, 24px)",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "center",
    flexWrap: "wrap",
    minWidth: 0,
    maxWidth: "100%",
    boxShadow: "0 28px 90px rgba(31, 45, 61, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.78)",
    color: "#172033",
    border: "1px solid rgba(37, 99, 235, 0.16)",
    backdropFilter: "blur(22px)",
  },
  heroText: {
    flex: "1 1 260px",
    minWidth: 0,
  },
  brandButton: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    minWidth: 0,
    maxWidth: "100%",
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
  },
  brandMark: {
    position: "relative",
    width: "54px",
    height: "54px",
    borderRadius: "8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background:
      "linear-gradient(145deg, rgba(37, 99, 235, 0.22), rgba(255, 255, 255, 0.92))",
    boxShadow:
      "0 0 0 1px rgba(230, 234, 240, 0.18), 0 12px 32px rgba(37, 99, 235, 0.28)",
    overflow: "hidden",
    flex: "0 0 auto",
  },
  logoBook: {
    position: "absolute",
    left: "12px",
    bottom: "12px",
    width: "24px",
    height: "28px",
    borderRadius: "3px 7px 7px 3px",
    background: "linear-gradient(135deg, #2563eb 0%, #18794e 100%)",
    boxShadow: "inset 4px 0 0 rgba(255, 255, 255, 0.24)",
  },
  logoSpine: {
    position: "absolute",
    left: "18px",
    bottom: "17px",
    width: "3px",
    height: "18px",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.72)",
  },
  logoLens: {
    position: "absolute",
    right: "10px",
    top: "11px",
    width: "19px",
    height: "19px",
    borderRadius: "999px",
    border: "3px solid #f59e0b",
    background: "rgba(17, 18, 20, 0.7)",
  },
  logoBeam: {
    position: "absolute",
    right: "5px",
    top: "31px",
    width: "18px",
    height: "4px",
    borderRadius: "999px",
    background: "#dc2626",
    transform: "rotate(43deg)",
    transformOrigin: "left center",
  },
  title: {
    margin: 0,
    fontSize: "clamp(28px, 6vw, 38px)",
    color: "#172033",
    lineHeight: 1.15,
    wordBreak: "break-word",
    fontWeight: "650",
    letterSpacing: 0,
  },
  subtitle: {
    color: "#4f5f73",
    fontSize: "16px",
    lineHeight: 1.5,
    marginTop: "12px",
    marginBottom: 0,
  },
  heroArt: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    width: "112px",
    height: "58px",
    borderRadius: "8px",
    border: "1px solid rgba(37, 99, 235, 0.2)",
    background:
      "linear-gradient(135deg, rgba(255, 255, 255, 0.68), rgba(239, 246, 255, 0.72))",
    color: "#243044",
    fontSize: "14px",
    fontWeight: "650",
    flex: "0 0 auto",
    maxWidth: "100%",
    minWidth: 0,
    boxShadow: "0 18px 44px rgba(37, 99, 235, 0.12)",
  },
  agentDot: {
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    background: "#2563eb",
    boxShadow: "0 0 0 4px rgba(37, 99, 235, 0.14)",
  },
  homeGreetingPanel: {
    margin: "18px 0 0",
    padding: "16px",
    borderRadius: "8px",
    background:
      "linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(232, 240, 254, 0.72))",
    border: "1px solid rgba(37, 99, 235, 0.16)",
    textAlign: "left",
    boxShadow: "0 18px 48px rgba(31, 45, 61, 0.08)",
  },
  homeGreetingTitle: {
    margin: 0,
    color: "#172033",
    fontSize: "20px",
    lineHeight: 1.25,
    fontWeight: "750",
  },
  homeGreetingText: {
    margin: "6px 0 0",
    color: "#4f5f73",
    fontSize: "14px",
    lineHeight: 1.45,
  },
  uploadBox: {
    display: "flex",
    gap: "14px",
    flexWrap: "wrap",
    margin: "24px 0",
    minWidth: 0,
  },
  pageNav: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    margin: "16px 0 6px",
    minWidth: 0,
    maxWidth: "100%",
  },
  bottomTabs: {
    position: "fixed",
    left: "50%",
    bottom: "max(12px, env(safe-area-inset-bottom))",
    transform: "translateX(-50%)",
    width: "min(94vw, 560px)",
    minHeight: "78px",
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "10px",
    padding: "9px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    background: "rgba(255, 255, 255, 0.94)",
    boxShadow: "0 18px 48px rgba(31, 45, 61, 0.18)",
    backdropFilter: "blur(18px)",
    zIndex: 1200,
  },
  bottomTabButton: {
    minWidth: 0,
    minHeight: "60px",
    display: "grid",
    justifyItems: "center",
    alignContent: "center",
    gap: "4px",
    padding: "7px 6px",
    borderRadius: "8px",
    border: "1px solid transparent",
    background: "transparent",
    color: "#718096",
    cursor: "pointer",
    fontWeight: "780",
  },
  bottomTabButtonActive: {
    border: "1px solid rgba(37, 99, 235, 0.24)",
    background: "rgba(37, 99, 235, 0.12)",
    color: "#1d4ed8",
  },
  bottomTabIcon: {
    fontSize: "31px",
    lineHeight: 1,
    fontWeight: "850",
  },
  bottomTabLabel: {
    fontSize: "13px",
    lineHeight: 1.1,
    fontWeight: "800",
  },
  folderToolbar: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "10px",
    alignItems: "start",
    margin: "16px 0",
  },
  folderTabs: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    minWidth: 0,
  },
  navButton: {
    minWidth: 0,
    minHeight: "36px",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    background: "rgba(255, 255, 255, 0.92)",
    color: "#243044",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "13px",
    whiteSpace: "normal",
  },
  navButtonActive: {
    background: "rgba(37, 99, 235, 0.18)",
    border: "1px solid rgba(37, 99, 235, 0.42)",
    color: "#1d4ed8",
  },
  cameraButton: {
    flex: "1 1 min(100%, 150px)",
    minWidth: 0,
    textAlign: "center",
    background: "#2563eb",
    color: "#ffffff",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid #2563eb",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s",
    boxShadow: "0 12px 30px rgba(37, 99, 235, 0.28)",
  },
  scanButtonNeedsAuth: {
    opacity: 0.78,
    border: "1px solid rgba(245, 158, 11, 0.36)",
    boxShadow: "none",
  },
  voiceStatus: {
    margin: "10px 0 14px",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid rgba(34, 49, 71, 0.1)",
    color: "#243044",
    fontSize: "13px",
    fontWeight: "650",
    textAlign: "left",
  },
  filterPanel: {
    margin: "0 0 24px",
    padding: "14px",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.94)",
    border: "1px solid rgba(34, 49, 71, 0.1)",
    boxShadow: "0 14px 34px rgba(31, 45, 61, 0.09)",
    textAlign: "left",
  },
  filterHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "12px",
  },
  filterTitleButton: {
    minHeight: "36px",
    padding: "6px 8px",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    border: "none",
    background: "transparent",
    color: "#172033",
    cursor: "pointer",
    textAlign: "left",
  },
  filterTitle: {
    margin: 0,
    color: "#172033",
    fontSize: "18px",
    lineHeight: 1.2,
    fontWeight: "650",
  },
  filterCountBadge: {
    minWidth: "24px",
    height: "24px",
    padding: "0 7px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(37, 99, 235, 0.18)",
    color: "#1d4ed8",
    border: "1px solid rgba(37, 99, 235, 0.32)",
    fontSize: "12px",
    fontWeight: "750",
  },
  filterChevron: {
    color: "#718096",
    fontSize: "11px",
    fontWeight: "750",
  },
  filterHeaderActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flex: "0 0 auto",
  },
  filterSummary: {
    margin: "10px 0 0",
    color: "#718096",
    fontSize: "13px",
    lineHeight: 1.35,
  },
  filterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
    gap: "10px",
  },
  filterLabel: {
    display: "grid",
    gap: "6px",
    color: "#4f5f73",
    fontSize: "12px",
    fontWeight: "750",
  },
  passwordHint: {
    color: "#718096",
    fontSize: "12px",
    fontWeight: "650",
    lineHeight: 1.4,
  },
  filterControl: {
    width: "100%",
    minWidth: 0,
    minHeight: "40px",
    padding: "9px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    background: "#f6f8fb",
    color: "#243044",
    outlineColor: "#2563eb",
    fontSize: "14px",
    fontWeight: "600",
    boxSizing: "border-box",
  },
  clearFilterButton: {
    minHeight: "34px",
    padding: "7px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    background: "rgba(34, 49, 71, 0.06)",
    color: "#243044",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "13px",
  },
  authPanel: {
    margin: "24px 0",
    padding: "18px",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.96)",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    boxShadow: "0 18px 42px rgba(31, 45, 61, 0.1)",
    textAlign: "left",
  },
  authHeader: {
    marginBottom: "16px",
  },
  authTitle: {
    margin: "0 0 6px",
    color: "#172033",
    fontSize: "24px",
    lineHeight: 1.2,
    fontWeight: "700",
  },
  authSubtitle: {
    color: "#4f5f73",
    fontSize: "14px",
    lineHeight: 1.5,
  },
  authNotice: {
    margin: "0 0 14px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(245, 158, 11, 0.34)",
    background: "rgba(245, 158, 11, 0.1)",
    color: "#92400e",
    fontSize: "13px",
    fontWeight: "650",
  },
  authForm: {
    display: "grid",
    gap: "12px",
  },
  authPrimaryButton: {
    minHeight: "42px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #2563eb",
    background: "#2563eb",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: "750",
  },
  authSecondaryButton: {
    minHeight: "40px",
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.14)",
    background: "rgba(34, 49, 71, 0.06)",
    color: "#243044",
    cursor: "pointer",
    fontWeight: "700",
  },
  googleSignInButton: {
    minHeight: "42px",
    padding: "9px 14px",
    borderRadius: "8px",
    border: "1px solid #d7e0ec",
    background: "#ffffff",
    color: "#172033",
    cursor: "pointer",
    fontWeight: "750",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    boxShadow: "0 8px 20px rgba(31, 45, 61, 0.08)",
  },
  googleSignInIcon: {
    width: "22px",
    height: "22px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#2563eb",
    background:
      "conic-gradient(from 0deg, #2563eb, #18794e, #f59e0b, #dc2626, #2563eb)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    fontSize: "18px",
    fontWeight: "900",
    lineHeight: 1,
  },
  authTextButton: {
    padding: "6px 0",
    border: "none",
    background: "transparent",
    color: "#2563eb",
    cursor: "pointer",
    fontWeight: "700",
    textAlign: "left",
  },
  authActionRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "12px",
  },
  authFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "12px",
  },
  authMessage: {
    margin: "12px 0 0",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(24, 121, 78, 0.34)",
    background: "rgba(24, 121, 78, 0.12)",
    color: "#18794e",
    fontSize: "13px",
    fontWeight: "650",
  },
  libraryCardBody: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
    gap: "16px",
    alignItems: "start",
    minWidth: 0,
  },
  libraryCardForm: {
    display: "grid",
    gap: "12px",
  },
  libraryCardActions: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "10px",
    minWidth: 0,
  },
  libraryCardScanButton: {
    minHeight: "42px",
    boxSizing: "border-box",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
  },
  libraryCardList: {
    display: "grid",
    gap: "12px",
  },
  walletAddHeader: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    borderRadius: "8px",
    background: "rgba(34, 49, 71, 0.05)",
    border: "1px solid rgba(34, 49, 71, 0.1)",
  },
  walletAddIcon: {
    width: "38px",
    height: "38px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#2563eb",
    color: "#ffffff",
    fontSize: "24px",
    fontWeight: "700",
    flex: "0 0 auto",
  },
  walletAddTitle: {
    margin: 0,
    color: "#172033",
    fontSize: "16px",
    lineHeight: 1.2,
  },
  libraryCardTile: {
    display: "grid",
    gap: "10px",
  },
  libraryCardWalletButton: {
    position: "relative",
    minHeight: "154px",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: "18px",
    borderRadius: "8px",
    background:
      "linear-gradient(135deg, #ffffff 0%, #eef5ff 52%, #f8fafc 100%)",
    border: "1px solid rgba(34, 49, 71, 0.14)",
    boxShadow: "0 18px 38px rgba(31, 45, 61, 0.13)",
    color: "#172033",
    cursor: "pointer",
    overflow: "hidden",
    textAlign: "left",
  },
  walletAccent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "8px",
    background:
      "linear-gradient(180deg, #2563eb, #1d4ed8 54%, #18794e)",
  },
  walletEyebrow: {
    margin: "0 0 18px",
    color: "#5f6f86",
    fontSize: "12px",
    fontWeight: "750",
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  walletMaskedNumber: {
    margin: "18px 0 0",
    color: "#243044",
    fontSize: "15px",
    fontWeight: "700",
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  walletTapHint: {
    position: "absolute",
    right: "14px",
    bottom: "12px",
    color: "#2563eb",
    fontSize: "13px",
    fontWeight: "750",
  },
  libraryCardTileActions: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  libraryCardName: {
    margin: 0,
    color: "#172033",
    fontSize: "22px",
    lineHeight: 1.2,
    overflowWrap: "anywhere",
  },
  libraryCardBarcode: {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    height: "112px",
    borderRadius: "8px",
    border: "8px solid #ffffff",
    background: "#ffffff",
    boxSizing: "border-box",
  },
  libraryCardPhotoPreview: {
    padding: "10px",
    borderRadius: "8px",
    background: "rgba(34, 49, 71, 0.05)",
    border: "1px solid rgba(34, 49, 71, 0.1)",
  },
  libraryCardPhoto: {
    display: "block",
    width: "100%",
    maxHeight: "240px",
    objectFit: "contain",
    borderRadius: "8px",
    background: "#ffffff",
    border: "1px solid rgba(34, 49, 71, 0.14)",
    marginTop: "12px",
  },
  libraryCardModalContent: {
    width: "min(94vw, 560px)",
    maxWidth: "100%",
    boxSizing: "border-box",
    maxHeight: "90vh",
    overflow: "auto",
    background: "#ffffff",
    borderRadius: "8px",
    padding: "18px",
    border: "1px solid #dde5f0",
    boxShadow: "0 26px 70px rgba(0,0,0,0.45)",
    color: "#243044",
    textAlign: "left",
  },
  libraryCardFullPhoto: {
    display: "block",
    width: "100%",
    maxHeight: "52vh",
    objectFit: "contain",
    borderRadius: "8px",
    background: "#ffffff",
    border: "1px solid rgba(230, 234, 240, 0.16)",
    marginBottom: "14px",
  },
  pagePanel: {
    margin: "20px 0",
    padding: "14px",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid rgba(34, 49, 71, 0.1)",
    boxShadow: "0 14px 32px rgba(31, 45, 61, 0.08)",
    textAlign: "left",
  },
  collapsibleSection: {
    margin: "14px 0",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.96)",
    border: "1px solid rgba(34, 49, 71, 0.11)",
    overflow: "hidden",
    textAlign: "left",
  },
  collapsibleHeader: {
    width: "100%",
    minHeight: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "12px 14px",
    border: "none",
    background: "rgba(34, 49, 71, 0.035)",
    color: "#172033",
    cursor: "pointer",
    textAlign: "left",
  },
  collapsibleHeaderWithAction: {
    display: "flex",
    alignItems: "stretch",
    background: "rgba(34, 49, 71, 0.035)",
  },
  collapsibleHeaderToggle: {
    flex: "1 1 auto",
    minWidth: 0,
    background: "transparent",
  },
  collapsibleTitle: {
    minWidth: 0,
    color: "#172033",
    fontSize: "16px",
    fontWeight: "760",
    overflowWrap: "anywhere",
  },
  collapsibleMeta: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    color: "#718096",
    fontSize: "12px",
    fontWeight: "750",
    whiteSpace: "nowrap",
  },
  collapsibleChevron: {
    color: "#2563eb",
    fontSize: "11px",
  },
  collapsibleCloseButton: {
    width: "36px",
    height: "36px",
    alignSelf: "center",
    marginRight: "10px",
    borderRadius: "6px",
    border: "1px solid rgba(34, 49, 71, 0.14)",
    background: "#ffffff",
    color: "#172033",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: "800",
    lineHeight: 1,
    flex: "0 0 auto",
  },
  collapsibleBody: {
    padding: "14px",
  },
  developerLinkRow: {
    display: "flex",
    justifyContent: "flex-start",
    margin: "0 0 14px",
  },
  developerLinkButton: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "38px",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(37, 99, 235, 0.42)",
    background: "rgba(37, 99, 235, 0.18)",
    color: "#1d4ed8",
    textDecoration: "none",
    cursor: "pointer",
    fontWeight: "750",
    fontSize: "13px",
  },
  developerStatsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "10px",
    marginBottom: "14px",
  },
  developerStatCard: {
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.1)",
    background: "#f6f8fb",
  },
  developerStatLabel: {
    display: "block",
    color: "#718096",
    fontSize: "12px",
    fontWeight: "750",
    marginBottom: "6px",
  },
  developerStatValue: {
    display: "block",
    color: "#172033",
    fontSize: "28px",
    lineHeight: 1.1,
  },
  developerStatValueSmall: {
    display: "block",
    color: "#172033",
    fontSize: "14px",
    lineHeight: 1.3,
    overflowWrap: "anywhere",
  },
  developerIpList: {
    display: "grid",
    gap: "8px",
  },
  developerIpRow: {
    display: "grid",
    gap: "3px",
    color: "#172033",
    fontSize: "13px",
    lineHeight: 1.3,
    overflowWrap: "anywhere",
  },
  detailCollapse: {
    margin: "12px 0",
    background: "#f8fafc",
    border: "1px solid #dde5f0",
  },
  detailText: {
    margin: 0,
    color: "#38475f",
    lineHeight: 1.5,
    overflowWrap: "anywhere",
  },
  detailNoteGrid: {
    display: "grid",
    gap: "12px",
  },
  preview: {
    width: "100%",
    maxHeight: "350px",
    objectFit: "cover",
    borderRadius: "8px",
    marginBottom: "20px",
    border: "1px solid #d7e0ec",
    boxShadow: "0 16px 36px rgba(0,0,0,0.22)",
  },
  loading: {
    fontWeight: "600",
    color: "#2563eb",
  },
  processingOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "22px",
    background: "rgba(15, 23, 42, 0.34)",
    backdropFilter: "blur(8px)",
  },
  processingPanel: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    gap: "16px",
    width: "min(100%, 430px)",
    margin: 0,
    padding: "18px",
    borderRadius: "8px",
    border: "1px solid rgba(37, 99, 235, 0.22)",
    background:
      "linear-gradient(135deg, rgba(239, 246, 255, 0.96), rgba(255, 255, 255, 0.98))",
    boxShadow: "0 18px 42px rgba(31, 45, 61, 0.12)",
    textAlign: "left",
  },
  processingCopy: {
    minWidth: 0,
  },
  processingTitle: {
    margin: 0,
    color: "#172033",
    fontSize: "20px",
    lineHeight: 1.2,
    fontWeight: "760",
  },
  processingText: {
    margin: "6px 0 0",
    color: "#4f5f73",
    fontSize: "14px",
    lineHeight: 1.45,
  },
  error: {
    color: "#b91c1c",
    fontWeight: "600",
  },
  filterComposer: {
    width: "100%",
    minWidth: "min(100%, 280px)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.12)",
    background: "#ffffff",
  },
  filterSearchInput: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    border: "none",
    fontSize: "16px",
    background: "transparent",
    color: "#243044",
    outline: "none",
  },
  iconComposerButton: {
    width: "36px",
    height: "36px",
    flex: "0 0 36px",
    borderRadius: "8px",
    border: "1px solid rgba(245, 158, 11, 0.34)",
    background: "rgba(245, 158, 11, 0.12)",
    color: "#92400e",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: "750",
  },
  iconComposerButtonActive: {
    background: "rgba(220, 38, 38, 0.2)",
    color: "#b91c1c",
    border: "1px solid rgba(220, 38, 38, 0.48)",
    boxShadow: "0 0 0 4px rgba(220, 38, 38, 0.14)",
  },
  sendComposerButton: {
    width: "36px",
    height: "36px",
    flex: "0 0 36px",
    borderRadius: "8px",
    border: "1px solid #2563eb",
    background: "#2563eb",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "20px",
    lineHeight: 1,
    fontWeight: "800",
  },
  sectionTitle: {
    color: "#172033",
    marginTop: "32px",
    marginBottom: "14px",
    fontWeight: "650",
    clear: "both",
  },
  countText: {
    color: "#718096",
    fontWeight: "500",
  },
  savedFilesSection: {
    margin: "24px 0",
    padding: "16px",
    minWidth: 0,
    maxWidth: "100%",
    boxSizing: "border-box",
    borderRadius: "8px",
    background: "#ffffff",
    border: "1px solid #dde5f0",
    boxShadow: "0 12px 28px rgba(31, 45, 61, 0.08)",
    textAlign: "left",
  },
  savedFilesTop: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "10px",
  },
  savedFilesArt: {
    position: "relative",
    width: "64px",
    height: "56px",
    border: "1px solid rgba(37, 99, 235, 0.24)",
    borderRadius: "8px",
    background: "linear-gradient(145deg, rgba(26, 115, 232, 0.18), rgba(23, 23, 23, 0.88))",
    boxShadow: "0 14px 32px rgba(31, 45, 61, 0.12)",
    cursor: "pointer",
    overflow: "hidden",
    flex: "0 0 auto",
  },
  savedArtBookOne: {
    position: "absolute",
    left: "13px",
    bottom: "10px",
    width: "13px",
    height: "32px",
    borderRadius: "3px",
    background: "linear-gradient(180deg, #2563eb, #2563eb)",
  },
  savedArtBookTwo: {
    position: "absolute",
    left: "27px",
    bottom: "10px",
    width: "13px",
    height: "38px",
    borderRadius: "3px",
    background: "linear-gradient(180deg, #f59e0b, #92400e)",
  },
  savedArtBookThree: {
    position: "absolute",
    left: "41px",
    bottom: "10px",
    width: "13px",
    height: "28px",
    borderRadius: "3px",
    background: "linear-gradient(180deg, #18794e, #A7D7B8)",
  },
  savedArtSpark: {
    position: "absolute",
    right: "8px",
    top: "7px",
    width: "8px",
    height: "8px",
    borderRadius: "999px",
    background: "#dc2626",
    boxShadow: "0 0 18px #dc2626",
  },
  fileCountBadge: {
    minWidth: "28px",
    height: "28px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(26, 115, 232, 0.16)",
    color: "#2563eb",
    fontWeight: "700",
    fontSize: "13px",
  },
  saveStatus: {
    padding: "10px 12px",
    margin: "8px 0 12px",
    borderRadius: "8px",
    background: "rgba(24, 121, 78, 0.12)",
    border: "1px solid rgba(24, 121, 78, 0.34)",
    color: "#18794e",
    fontWeight: "600",
  },
  savedFileList: {
    display: "grid",
    gap: "10px",
  },
  savedFileItem: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, auto)",
    alignItems: "center",
    gap: "12px",
    minWidth: 0,
    padding: "12px",
    borderRadius: "8px",
    background: "#f8fafc",
    border: "1px solid #dde5f0",
    color: "#243044",
  },
  savedFileInfo: {
    minWidth: 0,
  },
  savedFileNameButton: {
    display: "inline",
    maxWidth: "100%",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "#243044",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "700",
    textAlign: "left",
    overflowWrap: "anywhere",
  },
  savedFileActions: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",
    alignItems: "center",
    justifyContent: "stretch",
    minWidth: 0,
  },
  noPreviewBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(245, 158, 11, 0.28)",
    background: "rgba(245, 158, 11, 0.1)",
    color: "#92400e",
    fontWeight: "600",
    fontSize: "13px",
    textAlign: "center",
  },
  deleteButton: {
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid rgba(220, 38, 38, 0.35)",
    background: "rgba(220, 38, 38, 0.14)",
    color: "#b91c1c",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "14px",
  },
  savedFileMeta: {
    marginTop: "4px",
    color: "#718096",
    fontSize: "13px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
    columnGap: "20px",
    rowGap: "30px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderRadius: "8px",
    padding: "20px",
    boxShadow: "0 16px 36px rgba(31, 45, 61, 0.1)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    color: "#5f6f86",
    minHeight: "100%",
    textAlign: "left",
  },
  cardTitle: {
    fontSize: "22px",
    margin: "0 0 10px",
    overflowWrap: "anywhere",
    lineHeight: 1.2,
  },
  bookImage: {
    position: "relative",
    height: "90px",
    borderRadius: "8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "42px",
    marginBottom: "12px",
    border: "1px solid rgba(255, 255, 255, 0.06)",
    overflow: "hidden",
    background: "linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(24, 121, 78, 0.14), rgba(245, 158, 11, 0.12))",
  },
  cardBookOne: {
    position: "absolute",
    left: "calc(50% - 30px)",
    bottom: "20px",
    width: "18px",
    height: "38px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #2563eb, #2563eb)",
    transform: "rotate(-8deg)",
  },
  cardBookTwo: {
    position: "absolute",
    left: "calc(50% - 10px)",
    bottom: "18px",
    width: "18px",
    height: "44px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #f59e0b, #92400e)",
  },
  cardBookThree: {
    position: "absolute",
    left: "calc(50% + 10px)",
    bottom: "20px",
    width: "18px",
    height: "36px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #18794e, #A7D7B8)",
    transform: "rotate(7deg)",
  },
  cardLens: {
    position: "absolute",
    right: "calc(50% - 38px)",
    top: "18px",
    width: "20px",
    height: "20px",
    borderRadius: "999px",
    border: "3px solid #dc2626",
    background: "rgba(17, 18, 20, 0.65)",
    boxShadow: "0 0 18px rgba(220, 38, 38, 0.36)",
  },
  rating: {
    color: "#92400e",
    fontWeight: "600",
  },
  badge: {
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: "4px",
    fontWeight: "600",
    fontSize: "12px",
    alignSelf: "flex-start",
    marginTop: "12px",
  },
  metaPillRow: {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
    justifyContent: "center",
    margin: "0 0 10px",
  },
  metaPill: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "24px",
    padding: "4px 8px",
    borderRadius: "999px",
    background: "rgba(37, 99, 235, 0.14)",
    border: "1px solid rgba(37, 99, 235, 0.3)",
    color: "#1d4ed8",
    fontSize: "12px",
    fontWeight: "750",
  },
  inlineSelect: {
    minHeight: "36px",
    padding: "7px 8px",
    borderRadius: "8px",
    border: "1px solid rgba(34, 49, 71, 0.14)",
    background: "#f6f8fb",
    color: "#243044",
    fontWeight: "700",
  },
  buttonRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))",
    gap: "8px",
    alignItems: "stretch",
    marginTop: "auto",
    paddingTop: "16px",
  },
  smallButton: {
    width: "100%",
    minHeight: "38px",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid #d7e0ec",
    background: "#f8fafc",
    color: "#243044",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "13px",
    lineHeight: 1.2,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    transition: "background 0.2s",
  },
  iconButton: {
    fontSize: "18px",
    lineHeight: 1,
  },
  favoriteButton: {
    border: "1px solid rgba(220, 38, 38, 0.26)",
    background: "rgba(220, 38, 38, 0.06)",
    color: "#dc2626",
    fontSize: "19px",
    lineHeight: 1,
    boxShadow: "0 8px 20px rgba(220, 38, 38, 0.08)",
  },
  favoriteButtonSaved: {
    border: "1px solid rgba(220, 38, 38, 0.48)",
    background: "linear-gradient(135deg, #dc2626, #b91c1c)",
    color: "#ffffff",
    boxShadow: "0 12px 28px rgba(220, 38, 38, 0.24)",
  },
  savedButton: {
    border: "1px solid rgba(24, 121, 78, 0.44)",
    background: "rgba(24, 121, 78, 0.16)",
    color: "#18794e",
  },
  selectedButton: {
    border: "1px solid rgba(37, 99, 235, 0.46)",
    background: "rgba(26, 115, 232, 0.18)",
    color: "#1d4ed8",
  },
  disabledButton: {
    border: "1px solid rgba(154, 160, 166, 0.22)",
    background: "rgba(154, 160, 166, 0.1)",
    color: "#718096",
    cursor: "not-allowed",
  },
  compareTray: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    margin: "28px 0",
    padding: "16px",
    borderRadius: "8px",
    background: "#ffffff",
    border: "1px solid #dde5f0",
    boxShadow: "0 12px 28px rgba(31, 45, 61, 0.08)",
    textAlign: "left",
  },
  compareTrayActions: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  compareTable: {
    display: "grid",
    gap: "8px",
    minWidth: 0,
  },
  compareTableScroll: {
    maxHeight: "min(54vh, 520px)",
    overflow: "auto",
    paddingRight: "2px",
  },
  compareRow: {
    display: "grid",
    gridTemplateColumns: "minmax(72px, 100px) repeat(2, minmax(0, 1fr))",
    gap: "8px",
    alignItems: "stretch",
    minWidth: 0,
  },
  compareLabel: {
    padding: "10px",
    borderRadius: "8px",
    background: "#f8fafc",
    border: "1px solid #dde5f0",
    color: "#718096",
    fontWeight: "700",
  },
  compareValue: {
    padding: "10px",
    borderRadius: "8px",
    background: "#f8fafc",
    border: "1px solid #dde5f0",
    color: "#243044",
    overflowWrap: "anywhere",
  },
  compareValueStrong: {
    padding: "10px",
    borderRadius: "8px",
    background: "rgba(26, 115, 232, 0.14)",
    border: "1px solid rgba(37, 99, 235, 0.3)",
    color: "#243044",
    fontWeight: "800",
    overflowWrap: "anywhere",
  },
  modal: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
    overflowY: "auto",
    overflowX: "hidden",
    zIndex: 1000,
  },
  modalContent: {
    background: "#ffffff",
    padding: "28px",
    borderRadius: "8px",
    maxWidth: "620px",
    width: "100%",
    boxSizing: "border-box",
    boxShadow: "0 28px 70px rgba(31, 45, 61, 0.18)",
    color: "#5f6f86",
  },
  compareModalContent: {
    background: "#ffffff",
    padding: "18px",
    borderRadius: "8px",
    maxWidth: "760px",
    width: "min(100%, 760px)",
    boxSizing: "border-box",
    maxHeight: "88vh",
    boxShadow: "0 28px 70px rgba(31, 45, 61, 0.18)",
    color: "#5f6f86",
    border: "1px solid #dde5f0",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  previewModalContent: {
    background: "#ffffff",
    padding: "20px",
    borderRadius: "8px",
    maxWidth: "900px",
    width: "100%",
    boxSizing: "border-box",
    maxHeight: "92vh",
    boxShadow: "0 28px 70px rgba(31, 45, 61, 0.18)",
    color: "#5f6f86",
    border: "1px solid #dde5f0",
    overflow: "auto",
  },
  promptModalContent: {
    background: "#ffffff",
    padding: "24px",
    borderRadius: "8px",
    maxWidth: "420px",
    width: "min(100%, 420px)",
    boxSizing: "border-box",
    boxShadow: "0 28px 70px rgba(31, 45, 61, 0.18)",
    color: "#243044",
    border: "1px solid #dde5f0",
    textAlign: "left",
  },
  promptIcon: {
    width: "54px",
    height: "54px",
    borderRadius: "8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "14px",
    color: "#18794e",
    background: "rgba(24, 121, 78, 0.12)",
    border: "1px solid rgba(24, 121, 78, 0.22)",
    fontSize: "30px",
    fontWeight: "850",
  },
  modalHeader: {
    display: "flex",
    gap: "16px",
    alignItems: "center",
    marginBottom: "16px",
  },
  modalIcon: {
    position: "relative",
    width: "72px",
    height: "72px",
    borderRadius: "12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "36px",
    overflow: "hidden",
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
  },
  detailOrbit: {
    position: "absolute",
    width: "58px",
    height: "34px",
    borderRadius: "999px",
    border: "2px solid rgba(37, 99, 235, 0.48)",
    transform: "rotate(-24deg)",
  },
  detailBookCore: {
    position: "absolute",
    left: "22px",
    top: "18px",
    width: "21px",
    height: "32px",
    borderRadius: "3px 7px 7px 3px",
    background: "linear-gradient(135deg, #2563eb, #18794e)",
    boxShadow:
      "inset 4px 0 0 rgba(255, 255, 255, 0.24), 0 10px 24px rgba(37, 99, 235, 0.28)",
  },
  detailLensCore: {
    position: "absolute",
    right: "16px",
    top: "15px",
    width: "18px",
    height: "18px",
    borderRadius: "999px",
    border: "3px solid #f59e0b",
    background: "rgba(17, 18, 20, 0.74)",
  },
  detailSparkOne: {
    position: "absolute",
    left: "12px",
    top: "13px",
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    background: "#dc2626",
    boxShadow: "0 0 18px #dc2626",
  },
  detailSparkTwo: {
    position: "absolute",
    right: "14px",
    bottom: "13px",
    width: "8px",
    height: "8px",
    borderRadius: "999px",
    background: "#A7D7B8",
    boxShadow: "0 0 18px #A7D7B8",
  },
  modalTitle: {
    margin: 0,
    fontSize: "24px",
    fontWeight: "700",
  },
  previewHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "16px",
    marginBottom: "14px",
    flex: "0 0 auto",
  },
  previewSubtitle: {
    marginTop: "6px",
    color: "#718096",
    fontSize: "14px",
  },
  closeIconButton: {
    width: "40px",
    height: "40px",
    borderRadius: "6px",
    border: "1px solid rgba(248, 249, 250, 0.28)",
    background: "#ffffff",
    color: "#172033",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "18px",
    flex: "0 0 auto",
    boxShadow: "0 8px 20px rgba(31, 45, 61, 0.12)",
  },
  previewFrame: {
    width: "100%",
    height: "min(68vh, 680px)",
    minHeight: "min(420px, 58vh)",
    border: "1px solid #d7e0ec",
    borderRadius: "8px",
    background: "#f8fafc",
  },
  previewMessage: {
    minHeight: "240px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    borderRadius: "8px",
    background: "#f8fafc",
    border: "1px solid #dde5f0",
    color: "#243044",
    textAlign: "center",
  },
  previewHelpText: {
    marginTop: "10px",
    color: "#718096",
    fontSize: "13px",
  },
  previewActionRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "10px",
    marginTop: "16px",
  },
  secondaryButton: {
    width: "100%",
    background: "#f8fafc",
    color: "#243044",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #d7e0ec",
    cursor: "pointer",
    fontWeight: "600",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: "12px",
  },
  detailMiniCard: {
    background: "#f8fafc",
    borderRadius: "8px",
    padding: "12px",
    border: "1px solid #dde5f0",
  },
  closeButton: {
    width: "100%",
    background: "#1d4ed8",
    color: "#ffffff",
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontWeight: "600",
    marginTop: "16px",
  },
};
