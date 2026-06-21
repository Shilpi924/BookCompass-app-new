import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
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
const configuredGeminiDailyLimit = Number(import.meta.env.VITE_GEMINI_DAILY_LIMIT);
const isGeminiConfigured = isFirebaseConfigured;
const MODEL_NAME = "gemini-2.5-flash-lite";
const GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS = 10000;
const GOOGLE_BOOKS_PREVIEW_STALE_MS = GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS + 3000;
const GEMINI_DAILY_LIMIT =
  Number.isFinite(configuredGeminiDailyLimit) && configuredGeminiDailyLimit > 0
    ? configuredGeminiDailyLimit
    : 1000;
const GEMINI_SCAN_RPM_LIMIT = 15;
const GEMINI_SCAN_DAILY_TOKEN_LIMIT = 100000;
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
const DEFAULT_FOLDERS = ["Want to read", "Read aloud", "For kids", "School", "Gift ideas", "Favorites"];
const LAUNCH_READINESS_ITEMS = [
  "Delete account flow",
  "Privacy policy",
  "Terms of use",
  "Data deletion page",
  "AI accuracy disclaimer",
  "Node 22 Functions upgrade",
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

  if (lowerMessage.includes("failed to fetch") || code.includes("unavailable")) {
    return "Lumina could not reach the scan service. Check your connection and try again.";
  }
  if (lowerMessage.includes("api key") || lowerMessage.includes("key not valid")) {
    return "Gemini is not configured on the server. Check the Firebase Function secret.";
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
      color: "#8ab4f8",
      border: "1px solid rgba(138, 180, 248, 0.32)",
    };
  }

  if (pick.includes("top rated")) {
    return {
      background: "rgba(251, 188, 5, 0.14)",
      color: "#fdd663",
      border: "1px solid rgba(251, 188, 5, 0.32)",
    };
  }

  if (pick.includes("hidden gem")) {
    return {
      background: "rgba(52, 168, 83, 0.14)",
      color: "#81c995",
      border: "1px solid rgba(52, 168, 83, 0.32)",
    };
  }

  if (pick.includes("beginner")) {
    return {
      background: "rgba(234, 67, 53, 0.14)",
      color: "#f28b82",
      border: "1px solid rgba(234, 67, 53, 0.32)",
    };
  }

  return {
    background: "rgba(154, 160, 166, 0.16)",
    color: "#e8eaed",
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
      cardBg: "#202124",
      imageBg: "linear-gradient(135deg, rgba(66, 133, 244, 0.18), rgba(52, 168, 83, 0.16))",
      border: "#34373d",
      title: "#f4f7fb",
      badgeBg: "rgba(66, 133, 244, 0.14)",
      badgeText: "#8ab4f8",
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
      cardBg: "#202124",
      imageBg: "linear-gradient(135deg, rgba(251, 188, 5, 0.18), rgba(234, 67, 53, 0.14))",
      border: "#34373d",
      title: "#f4f7fb",
      badgeBg: "rgba(251, 188, 5, 0.13)",
      badgeText: "#fdd663",
    };
  }

  return {
    name: "teen",
    cardBg: "#202124",
    imageBg: "linear-gradient(135deg, rgba(66, 133, 244, 0.18), rgba(168, 85, 247, 0.14))",
    border: "#34373d",
    title: "#f4f7fb",
    badgeBg: "rgba(52, 168, 83, 0.14)",
    badgeText: "#81c995",
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

export default function App() {
  useEffect(() => {
    logEvent(analytics, "app_opened");
  }, []);

  const [imagePreview, setImagePreview] = useState(null);
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(() =>
    normalizeFilters(readStoredJson("bookSearchFilters", DEFAULT_FILTERS))
  );
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
  const [developerStatsStatus, setDeveloperStatsStatus] = useState(
    isFirebaseConfigured ? "Loading Firebase stats..." : "Firebase is not configured yet."
  );
  const userDataLoadedRef = useRef(false);

  const [readingList, setReadingList] = useState(() => {
    return readStoredJson("readingList", []);
  });

  const [selectedBook, setSelectedBook] = useState(null);
  const [scanHistory, setScanHistory] = useState(() => readStoredJson("scanHistory", []));
  const [folders, setFolders] = useState(() => readStoredJson("bookFoldersList", DEFAULT_FOLDERS));
  const [bookFolders, setBookFolders] = useState(() => readStoredJson("bookFolderAssignments", {}));
  const [activeFolder, setActiveFolder] = useState("All");
  const [compare, setCompare] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [geminiUsage, setGeminiUsage] = useState(getInitialGeminiUsage);
  const [devQuotaOpen, setDevQuotaOpen] = useState(false);
  const [activeGeminiCalls, setActiveGeminiCalls] = useState(0);
  const [previewCache, setPreviewCache] = useState({});
  const [previewModal, setPreviewModal] = useState(null);
  const previewCacheRef = useRef({});
  const previewRequestId = useRef(0);
  const [saveStatus, setSaveStatus] = useState(null);
  const [idleBursts, setIdleBursts] = useState([]);
  const [savedArtActive, setSavedArtActive] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const recognitionRef = useRef(null);
  const [savedFiles, setSavedFiles] = useState(() => {
    return normalizeSavedFiles(readStoredJson("savedPreviewFiles", []));
  });
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
    localStorage.setItem("bookSearchFilters", JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    localStorage.setItem("scanHistory", JSON.stringify(scanHistory));
  }, [scanHistory]);

  useEffect(() => {
    localStorage.setItem("bookFoldersList", JSON.stringify(folders));
  }, [folders]);

  useEffect(() => {
    localStorage.setItem("bookFolderAssignments", JSON.stringify(bookFolders));
  }, [bookFolders]);

  useEffect(() => {
    localUserStateRef.current = {
      readingList,
      savedFiles,
      filters,
      books,
      geminiUsage,
    };
  }, [readingList, savedFiles, filters, books, geminiUsage, scanHistory, folders, bookFolders]);

  useEffect(() => {
    if (!auth || !db) {
      return undefined;
    }

    return onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      userDataLoadedRef.current = false;

      if (!firebaseUser) return;

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
          setReadingList(
            Array.isArray(cloudState.readingList) ? cloudState.readingList : []
          );
          setSavedFiles(normalizeSavedFiles(cloudState.savedFiles || []));
          setFilters(normalizeFilters(cloudState.filters));
          setBooks(Array.isArray(cloudState.books) ? cloudState.books.map(enrichScannedBook) : []);
          setScanHistory(Array.isArray(cloudState.scanHistory) ? cloudState.scanHistory : []);
          setFolders(Array.isArray(cloudState.folders) && cloudState.folders.length ? cloudState.folders : DEFAULT_FOLDERS);
          setBookFolders(cloudState.bookFolders && typeof cloudState.bookFolders === "object" ? cloudState.bookFolders : {});
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
    if (!user?.uid || !userDataLoadedRef.current) {
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
      }).catch((err) => {
        console.error("Could not save user app data:", err);
      });
    }, 500);

    return () => window.clearTimeout(saveTimer);
  }, [user, readingList, savedFiles, filters, books, geminiUsage, scanHistory, folders, bookFolders]);

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
        setDeveloperStatsStatus("Showing Firebase login analytics from recent auth events.");
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

        setDeveloperUsage((currentUsage) => ({
          ...currentUsage,
          ...eventTotals,
        }));
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
    setActiveGeminiCalls((currentCount) => currentCount + 1);
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
    setActiveGeminiCalls((currentCount) => Math.max(0, currentCount - 1));
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
      }

      await recordSuccessfulLogin(
        {
          ...credential.user,
          displayName: displayName || credential.user.displayName,
        },
        authMode === "signup" ? "email-signup" : "email"
      );
      logEvent(analytics, authMode === "signup" ? "sign_up" : "login", {
        method: "email",
      });
      setAuthMessage(
        authMode === "signup"
          ? "Account created. Check your email to verify your account."
          : credential.user.emailVerified
            ? "Signed in. Your saved list and filters will sync here."
            : "Signed in. Please verify your email for full account protection."
      );
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

    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        prompt: "select_account",
      });
      const credential = await signInWithPopup(auth, provider);
      await recordSuccessfulLogin(credential.user, "google");
      logEvent(analytics, "login", { method: "google" });
      setAuthMessage("Signed in with Google.");
      setCurrentPage("scan");
    } catch (err) {
      console.error("Google sign-in failed:", err);
      const code = err?.code || "";
      if (
        code.includes("popup-blocked") ||
        code.includes("popup-closed-by-user") ||
        code.includes("cancelled-popup-request") ||
        code.includes("web-storage-unsupported")
      ) {
        setAuthMessage("Opening Google sign-in in this tab...");
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({
          prompt: "select_account",
        });
        await signInWithRedirect(auth, provider);
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
      setAuthMessage("Verification email sent. Check your inbox.");
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

  async function handleImage(file) {
    if (!file) return;
    if (!isGeminiConfigured) {
      setError("Firebase is not configured yet.");
      return;
    }
    if (!user?.uid) {
      setError("Sign in to scan books with Gemini.");
      setCurrentPage("account");
      return;
    }
    if (!canStartScan(user)) {
      setError(getScanLimitMessage(user));
      return;
    }

    setError("");
    setLoading(true);
    setBooks([]);
    setPreviewCache({});
    setAnswer("");
    setSearch("");
    setVoiceStatus("");
    setVoiceListening(false);
    recognitionRef.current?.abort();
    setImagePreview(URL.createObjectURL(file));

    let geminiCallStarted = false;
    try {
      const base64 = await encodeFileToBase64(file);
      recordLocalScanUsage(user);
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
      setScanHistory((currentHistory) => [scanEntry, ...currentHistory].slice(0, 30));
      if (user?.uid) {
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

  function handleVoiceSearch() {
    if (voiceListening) {
      recognitionRef.current?.stop();
      setVoiceListening(false);
      setVoiceStatus("Voice search stopped.");
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceStatus("Voice search is not supported in this browser.");
      return;
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
      setVoiceStatus(
        blocked
          ? "Microphone permission is needed for voice search."
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

  function markBookReviewed(book) {
    const bookKey = getBookKey(book);
    if (!bookKey) return;

    const markReviewed = (candidateBook) =>
      getBookKey(candidateBook) === bookKey
        ? { ...candidateBook, reviewed: true, scanConfidence: "Reviewed" }
        : candidateBook;

    setBooks((currentBooks) => currentBooks.map(markReviewed));
    setReadingList((currentList) => currentList.map(markReviewed));
    setSelectedBook((currentBook) =>
      currentBook && getBookKey(currentBook) === bookKey ? markReviewed(currentBook) : currentBook
    );
  }

  function editBookTitle(book) {
    const bookKey = getBookKey(book);
    const nextTitle = window.prompt("Correct book title", book?.title || "");
    if (!bookKey || !nextTitle?.trim()) return;

    const updateTitle = (candidateBook) =>
      getBookKey(candidateBook) === bookKey
        ? { ...candidateBook, title: nextTitle.trim(), reviewed: true, scanConfidence: "Reviewed" }
        : candidateBook;

    setBooks((currentBooks) => currentBooks.map(updateTitle));
    setReadingList((currentList) => currentList.map(updateTitle));
    setSelectedBook((currentBook) =>
      currentBook && getBookKey(currentBook) === bookKey ? updateTitle(currentBook) : currentBook
    );
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

  async function askLibrarian() {
    if (!isGeminiConfigured) {
      setAnswer("Firebase is not configured yet.");
      return;
    }
    if (!user?.uid) {
      setAnswer("Sign in to ask the AI Librarian.");
      setCurrentPage("account");
      return;
    }
    if (!question.trim()) {
      setAnswer("Please type a question first.");
      return;
    }

    if (books.length === 0) {
      setAnswer("Please scan a bookshelf first.");
      return;
    }

    setLoading(true);
    setAnswer("");

    let geminiCallStarted = false;
    try {
      beginGeminiCall("AI Librarian");
      geminiCallStarted = true;
      const result = await generateGeminiContent([
        {
          role: "user",
          parts: [
            {
              text: `
You are a friendly AI librarian for kids, families, and teens.

Books detected:
${JSON.stringify(books, null, 2)}

User question:
${question}

Answer in a cheerful, helpful, short way. Recommend books only from the detected list.
        `,
            },
          ],
        },
      ], {}, "AI Librarian");

      const text = getGeminiText(result);

      finishGeminiCall("AI Librarian", "Success", getTotalTokenCount(result));
      geminiCallStarted = false;
      setAnswer(text);
    } catch (err) {
      console.error("AI Librarian error:", err);
      if (geminiCallStarted) {
        finishGeminiCall("AI Librarian", "Failed");
      }
      setAnswer(getFriendlyScanError(err));
    } finally {
      setLoading(false);
    }
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
          {book.reviewed && <span style={styles.metaPill}>Reviewed</span>}
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
              <button style={styles.smallButton} onClick={() => setSelectedBook(book)}>
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
                  ...styles.iconButton,
                  ...(favoriteSaved ? styles.savedButton : {}),
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
                onChange={(event) => assignBookFolder(book, event.target.value)}
                aria-label="Book folder"
              >
                {folders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>

              <button style={styles.smallButton} onClick={() => markBookReviewed(book)}>
                Review
              </button>

              <button style={styles.smallButton} onClick={() => editBookTitle(book)}>
                Edit
              </button>

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
          <h2 style={styles.filterTitle}>Filters</h2>
          <button
            type="button"
            style={styles.clearFilterButton}
            onClick={clearFilters}
            disabled={activeFilterCount === 0}
          >
            Clear
          </button>
        </div>

        <div style={styles.filterComposer}>
          <input
            style={styles.filterSearchInput}
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

        <div style={styles.filterGrid}>
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
        </div>
      </section>
    );
  }

  function renderLoginPage() {
    const isSignUp = authMode === "signup";

    if (user) {
      return (
        <section style={styles.authPanel}>
          <div style={styles.authHeader}>
            <h2 style={styles.authTitle}>Account</h2>
            <p style={styles.authSubtitle}>
              Signed in as {getUserDisplayName(user)}
              {user.email ? ` (${user.email})` : ""}.
            </p>
          </div>

          {!user.emailVerified && (
            <p style={styles.authNotice}>
              Your email is not verified yet. Verify it to protect the account
              and unlock full saved-list sync.
            </p>
          )}

          <div style={styles.authActionRow}>
            {!user.emailVerified && (
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

        {user && !user.emailVerified && (
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
            style={styles.authSecondaryButton}
            onClick={handleGoogleLogin}
            disabled={authLoading || !isFirebaseConfigured}
          >
            Continue with Google SSO
          </button>
          <button
            type="button"
            style={styles.authTextButton}
            onClick={handleForgotPassword}
            disabled={authLoading || !isFirebaseConfigured}
          >
            Forgot password
          </button>
          {user && !user.emailVerified && (
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

    return (
      <section style={styles.savedFilesSection}>
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

          <div style={styles.savedFilesHeader}>
            <h2 style={{ ...styles.sectionTitle, marginTop: 0 }}>
              Reading / Saved List
            </h2>
            <span style={styles.fileCountBadge}>{savedBooks.length}</span>
          </div>
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
      </section>
    );
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
    handleIdleBookTap(event, "#fbbc05");
    window.setTimeout(() => handleIdleBookTap(event, "#8ab4f8"), 120);
    window.setTimeout(() => handleIdleBookTap(event, "#81c995"), 220);
    window.setTimeout(() => setSavedArtActive(false), 520);
  }

  function resetPage() {
    setImagePreview(null);
    setBooks([]);
    setSearch("");
    setLoading(false);
    setError("");
    setSelectedBook(null);
    setCompare([]);
    setCompareOpen(false);
    setQuestion("");
    setAnswer("");
    setPreviewCache({});
    previewCacheRef.current = {};
    setPreviewModal(null);
    previewRequestId.current += 1;
    setSaveStatus(null);
    setVoiceStatus("");
    setVoiceListening(false);
    recognitionRef.current?.abort();
  }

  const recentRequestEvents = getRecentEvents(geminiUsage?.requestEvents);
  const geminiUsageCount = Number(geminiUsage?.count || 0);
  const geminiDailyTotalTokens = Number(geminiUsage?.promptTokens || 0);
  const geminiDailyTokenLimit = GEMINI_SCAN_DAILY_TOKEN_LIMIT;
  const geminiMinuteRequests = recentRequestEvents.length;
  const geminiUsagePercent = Math.min(
    100,
    Math.round((geminiUsageCount / GEMINI_DAILY_LIMIT) * 100)
  );
  const geminiRpmPercent = Math.min(
    100,
    Math.round((geminiMinuteRequests / GEMINI_SCAN_RPM_LIMIT) * 100)
  );
  const geminiTpmPercent = Math.min(
    100,
    Math.round((geminiDailyTotalTokens / geminiDailyTokenLimit) * 100)
  );
  const geminiRemaining = Math.max(0, GEMINI_DAILY_LIMIT - geminiUsageCount);
  const geminiRpmRemaining = Math.max(
    0,
    GEMINI_SCAN_RPM_LIMIT - geminiMinuteRequests
  );
  const geminiTpmRemaining = Math.max(
    0,
    geminiDailyTokenLimit - geminiDailyTotalTokens
  );
  const geminiLiveStatus =
    activeGeminiCalls > 0 ? "Running" : geminiUsage?.lastStatus || "Idle";
  const geminiLastType = geminiUsage?.lastType || "No calls yet";
  const geminiLastUpdated = getDisplayTime(geminiUsage?.lastUpdatedAt);
  const geminiWarning =
    geminiUsagePercent >= 90 || geminiRpmPercent >= 90 || geminiTpmPercent >= 90
      ? "Close to a configured scan limit. Pause before making more scans."
      : "Within the configured scan limits.";
  const signedInName = user ? getUserDisplayName(user) : "";
  const canOpenDeveloper = hasDeveloperAccess(user);
  const homeGreeting = user
    ? `Hi ${signedInName}, ${getTimeGreeting()}.`
    : "Welcome to Lumina.";
  const homeGreetingDetail = user
    ? "Your saved books, filters, and preview files are ready here."
    : "Sign in to sync your saved books and filters across devices.";

  const renderGeminiQuotaPanel = () => (
    <div style={{ ...styles.devUsageMeter, margin: "0 0 16px" }}>
      <button
        type="button"
        style={styles.devUsageToggle}
        onClick={() => setDevQuotaOpen((isOpen) => !isOpen)}
        aria-expanded={devQuotaOpen}
      >
        <span>Gemini scan quota</span>
        <span>
          {geminiUsageCount.toLocaleString()} requests · {geminiDailyTotalTokens.toLocaleString()}/
          {geminiDailyTokenLimit.toLocaleString()} tokens {devQuotaOpen ? "▲" : "▼"}
        </span>
      </button>

      {devQuotaOpen && (
        <>
          {[
            {
              label: "RPD",
              value: `${geminiUsageCount}/${GEMINI_DAILY_LIMIT}`,
              percent: geminiUsagePercent,
            },
            {
              label: "RPM",
              value: `${geminiMinuteRequests}/${GEMINI_SCAN_RPM_LIMIT}`,
              percent: geminiRpmPercent,
            },
            {
              label: "Tokens/day",
              value: `${geminiDailyTotalTokens.toLocaleString()}/${geminiDailyTokenLimit.toLocaleString()}`,
              percent: geminiTpmPercent,
            },
          ].map((meter) => (
            <div key={meter.label} style={styles.devQuotaRow}>
              <div style={styles.devQuotaLabelRow}>
                <span>{meter.label}</span>
                <span>{meter.value}</span>
              </div>
              <div style={styles.devUsageTrack} aria-hidden="true">
                <span
                  style={{
                    ...styles.devUsageFill,
                    width: `${meter.percent}%`,
                    ...(meter.percent >= 90 ? styles.devUsageFillWarning : {}),
                  }}
                />
              </div>
            </div>
          ))}
          <p style={styles.devUsageText}>
            {geminiWarning} Left: {geminiRemaining} day, {geminiRpmRemaining}
            /min, {`${geminiTpmRemaining.toLocaleString()} tokens today`}.
          </p>
          <div style={styles.devLiveStatusRow}>
            <span
              style={{
                ...styles.devStatusDot,
                ...(geminiLiveStatus === "Running"
                  ? styles.devStatusDotRunning
                  : {}),
                ...(geminiLiveStatus === "Failed"
                  ? styles.devStatusDotFailed
                  : {}),
              }}
            />
            <span>
              Live status: {geminiLiveStatus} · Last: {geminiLastType}
              {geminiLastUpdated ? ` at ${geminiLastUpdated}` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );

  function renderLibraryPage() {
    const folderTabs = ["All", ...folders];
    const libraryBooks = readingList.filter((book) => {
      if (activeFolder === "All") return true;
      return (bookFolders[getBookKey(book)] || "Want to read") === activeFolder;
    });

    return (
      <section style={styles.developerPanel}>
        <div style={styles.authHeader}>
          <h2 style={styles.authTitle}>Library</h2>
          <p style={styles.authSubtitle}>Saved books, folders, previews, and details in one place.</p>
        </div>
        <div style={styles.pageNav}>
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
        {libraryBooks.length === 0 ? (
          <p style={styles.countText}>No saved books in this folder yet.</p>
        ) : (
          <div style={styles.grid}>
            {libraryBooks.map((book, index) => renderBookCard(book, index, { prefix: "library" }))}
          </div>
        )}
        {renderSavedFiles("library")}
      </section>
    );
  }

  function renderHistoryPage() {
    return (
      <section style={styles.developerPanel}>
        <div style={styles.authHeader}>
          <h2 style={styles.authTitle}>Scan History</h2>
          <p style={styles.authSubtitle}>Review previous bookshelf scans and reopen detected books.</p>
        </div>
        {scanHistory.length === 0 ? (
          <p style={styles.countText}>No scans yet. Scan a shelf to build history.</p>
        ) : (
          <div style={styles.savedFileList}>
            {scanHistory.map((scan) => (
              <div key={scan.id} style={styles.savedFileItem}>
                <div style={styles.savedFileInfo}>
                  <strong>{scan.imageName || "Bookshelf scan"}</strong>
                  <p style={styles.savedFileMeta}>
                    {getDisplayTime(scan.createdAt)} · {scan.bookCount} books · {scan.provider || "gemini"} · {Number(scan.totalTokens || 0).toLocaleString()} tokens
                  </p>
                </div>
                <div style={styles.savedFileActions}>
                  <button
                    type="button"
                    style={styles.smallButton}
                    onClick={() => {
                      setBooks(Array.isArray(scan.books) ? scan.books : []);
                      setCurrentPage("scan");
                    }}
                  >
                    Reopen
                  </button>
                  <button
                    type="button"
                    style={styles.deleteButton}
                    onClick={() => setScanHistory((history) => history.filter((item) => item.id !== scan.id))}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderLaunchReadiness() {
    return (
      <section style={styles.developerPanel}>
        <div style={styles.authHeader}>
          <h2 style={styles.authTitle}>Launch Readiness</h2>
          <p style={styles.authSubtitle}>Google Play basics to finish before public release.</p>
        </div>
        <div style={styles.developerStatsGrid}>
          {LAUNCH_READINESS_ITEMS.map((item) => (
            <div key={item} style={styles.developerStatCard}>
              <span style={styles.developerStatLabel}>Checklist</span>
              <strong style={styles.developerStatValueSmall}>{item}</strong>
            </div>
          ))}
        </div>
      </section>
    );
  }

  function renderAccountPage() {
    return (
      <>
        {renderLoginPage()}
        {user && renderLaunchReadiness()}
        {canOpenDeveloper && renderDeveloperPage()}
      </>
    );
  }

  const renderDeveloperPage = () => (
    <section style={styles.developerPanel}>
      <div style={styles.authHeader}>
        <h2 style={styles.authTitle}>Developer</h2>
        <p style={styles.authSubtitle}>
          Temporary developer page for Firebase auth stats and Gemini usage.
        </p>
      </div>

      <div style={styles.developerLinkRow}>
        <a
          style={styles.developerLinkButton}
          href={firestoreConsoleUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open Firebase DB
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
      {developerStatsStatus && (
        <p style={styles.authNotice}>{developerStatsStatus}</p>
      )}

      {renderGeminiQuotaPanel()}
    </section>
  );

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
          onPointerDown={(event) => handleIdleBookTap(event, "#8ab4f8")}
        />
        <span
          className="idle-book idle-book-green"
          onPointerDown={(event) => handleIdleBookTap(event, "#81c995")}
        />
        <span
          className="idle-book idle-book-yellow"
          onPointerDown={(event) => handleIdleBookTap(event, "#fdd663")}
        />
        <span
          className="idle-book idle-book-red"
          onPointerDown={(event) => handleIdleBookTap(event, "#f28b82")}
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
          <p style={styles.subtitle}>
            Snap a bookshelf and let Lumina guide you to your next favorite
            book. Scan books, discover ratings, and find your next read.
          </p>
        </div>

        <div style={styles.heroArt}>
          <span style={styles.agentDot} />
          <span>AI shelf scan</span>
        </div>
      </div>

      <nav style={styles.pageNav} aria-label="App pages">
        {[
          ["scan", "Scan"],
          ["library", "Library"],
          ["history", "History"],
          ["account", "Account"],
        ].map(([pageId, label]) => (
          <button
            key={pageId}
            type="button"
            style={{
              ...styles.navButton,
              ...(currentPage === pageId ? styles.navButtonActive : {}),
            }}
            onClick={() => setCurrentPage(pageId)}
          >
            {label}
          </button>
        ))}
        {user && (
          <button type="button" style={styles.navButton} onClick={handleSignOut}>
            Sign Out
          </button>
        )}
      </nav>

      {currentPage === "account" && renderAccountPage()}
      {currentPage === "library" && renderLibraryPage()}
      {currentPage === "history" && renderHistoryPage()}

      {currentPage === "scan" && (
        <>
      <section style={styles.homeGreetingPanel}>
        <h2 style={styles.homeGreetingTitle}>{homeGreeting}</h2>
        <p style={styles.homeGreetingText}>{homeGreetingDetail}</p>
      </section>

      <div style={styles.uploadBox}>
        <label style={styles.cameraButton}>
          📷 Take Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => handleImage(e.target.files[0])}
          />
        </label>

        <label style={styles.galleryButton}>
          🖼️ Pick from Gallery
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleImage(e.target.files[0])}
          />
        </label>
      </div>

      {renderFilterControls()}

      {imagePreview && (
        <img src={imagePreview} alt="Bookshelf" style={styles.preview} />
      )}

      {loading && <p style={styles.loading}>Scanning bookshelf...</p>}
      {error && <p style={styles.error}>{error}</p>}

      {books.length === 0 && renderSavedFiles("home")}

      {books.length > 0 && (
        <>
          <div style={styles.searchRow}>
            <input
              style={styles.askInput}
              placeholder="🤖 Ask for recommendations..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askLibrarian();
              }}
            />

            <button style={styles.askButton} onClick={askLibrarian}>
              Ask
            </button>
          </div>

          {answer && <div style={styles.answer}>🤖 {answer}</div>}

          <h2 style={styles.sectionTitle}>🏆 Top Picks</h2>

          {topBooks.length === 0 ? (
            <p style={styles.error}>No top picks match your search.</p>
          ) : (
            <div style={styles.grid}>
              {topBooks.map((book, index) =>
                renderBookCard(book, index, { prefix: "top", topPick: true })
              )}
            </div>
          )}

          <h2 style={{ ...styles.sectionTitle, ...styles.detectedSectionTitle }}>
            📖 Detected Books
          </h2>

          <p style={styles.countText}>
            Showing {detectedBooks.length} books
          </p>

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

                <div style={styles.detailBox}>
                  <p>
                    <b>👤 Author:</b> {selectedBook.author}
                  </p>
                  <p>
                    <b>✨ About the Author:</b>
                    <br />
                    {selectedBook.authorBio || "Author information unavailable."}
                  </p>
                </div>

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

                <div style={styles.detailBox}>
                  <p>
                    <b>💡 Why read it?</b>
                    <br />
                    {selectedBook.whyRead}
                  </p>

                  <p>
                    <b>📖 Summary:</b>
                    <br />
                    {selectedBook.summary}
                  </p>

                  <p>
                    <b>🧭 Similar reads:</b>
                    <br />
                    Look for more {selectedBook.genre || "books"} with a {selectedBook.readingLevel || "similar"} reading level.
                  </p>

                  <p>
                    <b>🛡️ Suitability note:</b>
                    <br />
                    {getContentGuidance(selectedBook)}
                  </p>
                </div>

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

                  <button style={styles.secondaryButton} onClick={() => markBookReviewed(selectedBook)}>
                    Mark reviewed
                  </button>

                  <button style={styles.secondaryButton} onClick={() => editBookTitle(selectedBook)}>
                    Edit title
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
    </div>
  );
}

const styles = {
  page: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    minHeight: "100vh",
    maxWidth: "1000px",
    margin: "auto",
    padding: "clamp(14px, 4vw, 24px)",
    fontFamily:
      '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background:
      "linear-gradient(180deg, rgba(18, 19, 23, 0.9), rgba(24, 25, 29, 0.96))",
    color: "#cdd4dc",
  },
  hero: {
    background:
      "linear-gradient(135deg, rgba(50, 121, 249, 0.18), rgba(33, 34, 38, 0.92) 45%, rgba(18, 19, 23, 0.96)), linear-gradient(90deg, rgba(50, 121, 249, 0.22), rgba(52, 168, 83, 0.16), rgba(251, 188, 5, 0.12), rgba(234, 67, 53, 0.14))",
    borderRadius: "8px",
    padding: "clamp(22px, 6vw, 32px) clamp(16px, 5vw, 24px)",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "center",
    flexWrap: "wrap",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.36)",
    color: "#ffffff",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    backdropFilter: "blur(18px)",
  },
  heroText: {
    flex: "1 1 260px",
    minWidth: 0,
  },
  brandButton: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
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
      "linear-gradient(145deg, rgba(50, 121, 249, 0.34), rgba(33, 34, 38, 0.88))",
    boxShadow:
      "0 0 0 1px rgba(230, 234, 240, 0.18), 0 12px 32px rgba(50, 121, 249, 0.28)",
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
    background: "linear-gradient(135deg, #4285f4 0%, #34a853 100%)",
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
    border: "3px solid #fbbc05",
    background: "rgba(17, 18, 20, 0.7)",
  },
  logoBeam: {
    position: "absolute",
    right: "5px",
    top: "31px",
    width: "18px",
    height: "4px",
    borderRadius: "999px",
    background: "#ea4335",
    transform: "rotate(43deg)",
    transformOrigin: "left center",
  },
  title: {
    margin: 0,
    fontSize: "clamp(28px, 6vw, 38px)",
    color: "#f8fbff",
    lineHeight: 1.15,
    wordBreak: "break-word",
    fontWeight: "650",
    letterSpacing: 0,
  },
  subtitle: {
    color: "#cdd4dc",
    fontSize: "16px",
    lineHeight: 1.5,
    marginTop: "12px",
    marginBottom: 0,
  },
  heroArt: {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    minHeight: "40px",
    padding: "10px 14px",
    borderRadius: "999px",
    border: "1px solid rgba(230, 234, 240, 0.14)",
    background: "rgba(18, 19, 23, 0.62)",
    color: "#e6eaf0",
    fontSize: "14px",
    fontWeight: "650",
    flex: "0 0 auto",
  },
  agentDot: {
    width: "10px",
    height: "10px",
    borderRadius: "999px",
    background: "#3279f9",
    boxShadow: "0 0 0 4px rgba(50, 121, 249, 0.14)",
  },
  homeGreetingPanel: {
    margin: "18px 0 0",
    padding: "14px 16px",
    borderRadius: "8px",
    background: "rgba(52, 168, 83, 0.1)",
    border: "1px solid rgba(52, 168, 83, 0.24)",
    textAlign: "left",
  },
  homeGreetingTitle: {
    margin: 0,
    color: "#e6f4ea",
    fontSize: "20px",
    lineHeight: 1.25,
    fontWeight: "750",
  },
  homeGreetingText: {
    margin: "6px 0 0",
    color: "#cdd4dc",
    fontSize: "14px",
    lineHeight: 1.45,
  },
  uploadBox: {
    display: "flex",
    gap: "14px",
    flexWrap: "wrap",
    margin: "24px 0",
  },
  pageNav: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    margin: "16px 0 6px",
  },
  navButton: {
    minHeight: "36px",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    background: "rgba(33, 34, 38, 0.72)",
    color: "#e6eaf0",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "13px",
  },
  navButtonActive: {
    background: "rgba(50, 121, 249, 0.18)",
    border: "1px solid rgba(50, 121, 249, 0.42)",
    color: "#d8e7ff",
  },
  cameraButton: {
    flex: "1 1 150px",
    textAlign: "center",
    background: "#3279f9",
    color: "#ffffff",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid #3279f9",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s",
    boxShadow: "0 12px 30px rgba(50, 121, 249, 0.28)",
  },
  galleryButton: {
    flex: "1 1 180px",
    textAlign: "center",
    background: "rgba(33, 34, 38, 0.86)",
    color: "#e6eaf0",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s",
  },
  voiceButton: {
    flex: "1 1 160px",
    textAlign: "center",
    background: "rgba(251, 188, 5, 0.12)",
    color: "#fff4c2",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid rgba(251, 188, 5, 0.34)",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s, box-shadow 0.2s",
    boxShadow: "0 12px 30px rgba(251, 188, 5, 0.12)",
  },
  voiceButtonActive: {
    background: "rgba(234, 67, 53, 0.2)",
    color: "#fce8e6",
    border: "1px solid rgba(234, 67, 53, 0.48)",
    boxShadow: "0 0 0 4px rgba(234, 67, 53, 0.14)",
  },
  voiceStatus: {
    margin: "10px 0 14px",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "rgba(33, 34, 38, 0.72)",
    border: "1px solid rgba(230, 234, 240, 0.1)",
    color: "#e6eaf0",
    fontSize: "13px",
    fontWeight: "650",
    textAlign: "left",
  },
  filterPanel: {
    margin: "0 0 24px",
    padding: "14px",
    borderRadius: "8px",
    background: "rgba(33, 34, 38, 0.78)",
    border: "1px solid rgba(230, 234, 240, 0.1)",
    boxShadow: "0 14px 34px rgba(0, 0, 0, 0.16)",
    textAlign: "left",
  },
  filterHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "12px",
  },
  filterTitle: {
    margin: 0,
    color: "#f8f9fc",
    fontSize: "18px",
    lineHeight: 1.2,
    fontWeight: "650",
  },
  filterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
    gap: "10px",
  },
  filterLabel: {
    display: "grid",
    gap: "6px",
    color: "#cdd4dc",
    fontSize: "12px",
    fontWeight: "750",
  },
  passwordHint: {
    color: "#9aa0a6",
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
    border: "1px solid rgba(230, 234, 240, 0.12)",
    background: "#18191d",
    color: "#e6eaf0",
    outlineColor: "#3279f9",
    fontSize: "14px",
    fontWeight: "600",
    boxSizing: "border-box",
  },
  clearFilterButton: {
    minHeight: "34px",
    padding: "7px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    background: "rgba(230, 234, 240, 0.06)",
    color: "#e6eaf0",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "13px",
  },
  authPanel: {
    margin: "24px 0",
    padding: "18px",
    borderRadius: "8px",
    background: "rgba(33, 34, 38, 0.84)",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    boxShadow: "0 18px 42px rgba(0, 0, 0, 0.18)",
    textAlign: "left",
  },
  authHeader: {
    marginBottom: "16px",
  },
  authTitle: {
    margin: "0 0 6px",
    color: "#f8f9fc",
    fontSize: "24px",
    lineHeight: 1.2,
    fontWeight: "700",
  },
  authSubtitle: {
    color: "#cdd4dc",
    fontSize: "14px",
    lineHeight: 1.5,
  },
  authNotice: {
    margin: "0 0 14px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(251, 188, 5, 0.34)",
    background: "rgba(251, 188, 5, 0.1)",
    color: "#fdd663",
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
    border: "1px solid #3279f9",
    background: "#3279f9",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: "750",
  },
  authSecondaryButton: {
    minHeight: "40px",
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(230, 234, 240, 0.14)",
    background: "rgba(230, 234, 240, 0.06)",
    color: "#e6eaf0",
    cursor: "pointer",
    fontWeight: "700",
  },
  authTextButton: {
    padding: "6px 0",
    border: "none",
    background: "transparent",
    color: "#8ab4f8",
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
    border: "1px solid rgba(52, 168, 83, 0.34)",
    background: "rgba(52, 168, 83, 0.12)",
    color: "#ceead6",
    fontSize: "13px",
    fontWeight: "650",
  },
  developerPanel: {
    margin: "24px 0",
    padding: "18px",
    borderRadius: "8px",
    background: "rgba(33, 34, 38, 0.84)",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    boxShadow: "0 18px 42px rgba(0, 0, 0, 0.18)",
    textAlign: "left",
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
    border: "1px solid rgba(50, 121, 249, 0.42)",
    background: "rgba(50, 121, 249, 0.18)",
    color: "#d8e7ff",
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
    border: "1px solid rgba(230, 234, 240, 0.1)",
    background: "#18191d",
  },
  developerStatLabel: {
    display: "block",
    color: "#9aa0a6",
    fontSize: "12px",
    fontWeight: "750",
    marginBottom: "6px",
  },
  developerStatValue: {
    display: "block",
    color: "#f8f9fc",
    fontSize: "28px",
    lineHeight: 1.1,
  },
  developerStatValueSmall: {
    display: "block",
    color: "#f8f9fc",
    fontSize: "14px",
    lineHeight: 1.3,
    overflowWrap: "anywhere",
  },
  devUsageMeter: {
    margin: "-12px 0 16px",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px dashed rgba(251, 188, 5, 0.5)",
    background: "rgba(251, 188, 5, 0.08)",
    color: "#fdd663",
  },
  devUsageToggle: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "center",
    padding: 0,
    background: "transparent",
    border: "none",
    color: "#fdd663",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: "700",
    textAlign: "left",
  },
  devQuotaRow: {
    marginTop: "6px",
  },
  devQuotaLabelRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    color: "#fff8d7",
    fontSize: "11px",
    fontWeight: "800",
  },
  devUsageTrack: {
    position: "relative",
    height: "5px",
    marginTop: "4px",
    overflow: "hidden",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.16)",
  },
  devUsageFill: {
    display: "block",
    height: "100%",
    borderRadius: "999px",
    background: "linear-gradient(90deg, #34a853, #fbbc05)",
    transition: "width 0.2s ease",
  },
  devUsageFillWarning: {
    background: "linear-gradient(90deg, #fbbc05, #ea4335)",
  },
  devUsageText: {
    margin: "6px 0 0",
    color: "#fbe7a0",
    fontSize: "11px",
    lineHeight: 1.3,
  },
  devLiveStatusRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    color: "#f8fafd",
    fontSize: "11px",
    fontWeight: "650",
    lineHeight: 1.4,
  },
  devStatusDot: {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    background: "#34a853",
    boxShadow: "0 0 0 3px rgba(52, 168, 83, 0.14)",
    flex: "0 0 auto",
  },
  devStatusDotRunning: {
    background: "#fbbc05",
    boxShadow: "0 0 0 3px rgba(251, 188, 5, 0.18)",
  },
  devStatusDotFailed: {
    background: "#ea4335",
    boxShadow: "0 0 0 3px rgba(234, 67, 53, 0.18)",
  },
  askButton: {
    background: "#34a853",
    color: "#ffffff",
    padding: "12px 18px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontWeight: "600",
  },
  preview: {
    width: "100%",
    maxHeight: "350px",
    objectFit: "cover",
    borderRadius: "8px",
    marginBottom: "20px",
    border: "1px solid #3c4043",
    boxShadow: "0 16px 36px rgba(0,0,0,0.22)",
  },
  loading: {
    fontWeight: "600",
    color: "#8ab4f8",
  },
  error: {
    color: "#f28b82",
    fontWeight: "600",
  },
  searchRow: {
    display: "flex",
    gap: "10px",
    margin: "24px 0",
    flexWrap: "wrap",
  },
  search: {
    flex: 1,
    minWidth: "220px",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #3c4043",
    fontSize: "16px",
    background: "#202124",
    color: "#e8eaed",
    outlineColor: "#1a73e8",
  },
  filterComposer: {
    width: "100%",
    minWidth: "min(100%, 280px)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px",
    borderRadius: "8px",
    border: "1px solid rgba(230, 234, 240, 0.12)",
    background: "#202124",
  },
  filterSearchInput: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    border: "none",
    fontSize: "16px",
    background: "transparent",
    color: "#e8eaed",
    outline: "none",
  },
  iconComposerButton: {
    width: "36px",
    height: "36px",
    flex: "0 0 36px",
    borderRadius: "8px",
    border: "1px solid rgba(251, 188, 5, 0.34)",
    background: "rgba(251, 188, 5, 0.12)",
    color: "#fff4c2",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: "750",
  },
  iconComposerButtonActive: {
    background: "rgba(234, 67, 53, 0.2)",
    color: "#fce8e6",
    border: "1px solid rgba(234, 67, 53, 0.48)",
    boxShadow: "0 0 0 4px rgba(234, 67, 53, 0.14)",
  },
  sendComposerButton: {
    width: "36px",
    height: "36px",
    flex: "0 0 36px",
    borderRadius: "8px",
    border: "1px solid #3279f9",
    background: "#3279f9",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "20px",
    lineHeight: 1,
    fontWeight: "800",
  },
  askInput: {
    flex: 1,
    minWidth: "220px",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #3c4043",
    fontSize: "16px",
    background: "#202124",
    color: "#e8eaed",
    outlineColor: "#1a73e8",
  },
  answer: {
    padding: "16px",
    background: "rgba(52, 168, 83, 0.12)",
    borderRadius: "8px",
    whiteSpace: "pre-wrap",
    marginBottom: "24px",
    border: "1px solid rgba(52, 168, 83, 0.34)",
    color: "#ceead6",
  },
  sectionTitle: {
    color: "#f1f3f4",
    marginTop: "32px",
    marginBottom: "14px",
    fontWeight: "650",
    clear: "both",
  },
  detectedSectionTitle: {
    marginTop: "56px",
  },
  countText: {
    color: "#9aa0a6",
    fontWeight: "500",
  },
  savedFilesSection: {
    margin: "24px 0",
    padding: "16px",
    borderRadius: "8px",
    background: "#202124",
    border: "1px solid #34373d",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.14)",
    textAlign: "left",
  },
  savedFilesTop: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "10px",
  },
  savedFilesHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flex: 1,
  },
  savedFilesArt: {
    position: "relative",
    width: "64px",
    height: "56px",
    border: "1px solid rgba(138, 180, 248, 0.24)",
    borderRadius: "8px",
    background: "linear-gradient(145deg, rgba(26, 115, 232, 0.18), rgba(23, 23, 23, 0.88))",
    boxShadow: "0 14px 32px rgba(0, 0, 0, 0.22)",
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
    background: "linear-gradient(180deg, #4285f4, #8ab4f8)",
  },
  savedArtBookTwo: {
    position: "absolute",
    left: "27px",
    bottom: "10px",
    width: "13px",
    height: "38px",
    borderRadius: "3px",
    background: "linear-gradient(180deg, #fbbc05, #fdd663)",
  },
  savedArtBookThree: {
    position: "absolute",
    left: "41px",
    bottom: "10px",
    width: "13px",
    height: "28px",
    borderRadius: "3px",
    background: "linear-gradient(180deg, #34a853, #81c995)",
  },
  savedArtSpark: {
    position: "absolute",
    right: "8px",
    top: "7px",
    width: "8px",
    height: "8px",
    borderRadius: "999px",
    background: "#ea4335",
    boxShadow: "0 0 18px #ea4335",
  },
  fileCountBadge: {
    minWidth: "28px",
    height: "28px",
    borderRadius: "999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(26, 115, 232, 0.16)",
    color: "#8ab4f8",
    fontWeight: "700",
    fontSize: "13px",
  },
  saveStatus: {
    padding: "10px 12px",
    margin: "8px 0 12px",
    borderRadius: "8px",
    background: "rgba(52, 168, 83, 0.12)",
    border: "1px solid rgba(52, 168, 83, 0.34)",
    color: "#ceead6",
    fontWeight: "600",
  },
  savedFileList: {
    display: "grid",
    gap: "10px",
  },
  savedFileItem: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    borderRadius: "8px",
    background: "#171717",
    border: "1px solid #34373d",
    color: "#e8eaed",
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
    color: "#e8eaed",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "700",
    textAlign: "left",
    overflowWrap: "anywhere",
  },
  savedFileActions: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(92px, auto))",
    gap: "8px",
    alignItems: "center",
    justifyContent: "end",
  },
  savedActionSpacer: {
    minWidth: "92px",
    minHeight: "1px",
  },
  noPreviewBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "132px",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(251, 188, 5, 0.28)",
    background: "rgba(251, 188, 5, 0.1)",
    color: "#fdd663",
    fontWeight: "600",
    fontSize: "13px",
    textAlign: "center",
  },
  deleteButton: {
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid rgba(234, 67, 53, 0.35)",
    background: "rgba(234, 67, 53, 0.14)",
    color: "#f28b82",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "14px",
  },
  savedFileMeta: {
    marginTop: "4px",
    color: "#9aa0a6",
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
    boxShadow: "0 16px 36px rgba(0, 0, 0, 0.18)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    color: "#bdc1c6",
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
    background: "linear-gradient(135deg, rgba(66, 133, 244, 0.18), rgba(52, 168, 83, 0.14), rgba(251, 188, 5, 0.12))",
  },
  cardBookOne: {
    position: "absolute",
    left: "calc(50% - 30px)",
    bottom: "20px",
    width: "18px",
    height: "38px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #4285f4, #8ab4f8)",
    transform: "rotate(-8deg)",
  },
  cardBookTwo: {
    position: "absolute",
    left: "calc(50% - 10px)",
    bottom: "18px",
    width: "18px",
    height: "44px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #fbbc05, #fdd663)",
  },
  cardBookThree: {
    position: "absolute",
    left: "calc(50% + 10px)",
    bottom: "20px",
    width: "18px",
    height: "36px",
    borderRadius: "4px",
    background: "linear-gradient(180deg, #34a853, #81c995)",
    transform: "rotate(7deg)",
  },
  cardLens: {
    position: "absolute",
    right: "calc(50% - 38px)",
    top: "18px",
    width: "20px",
    height: "20px",
    borderRadius: "999px",
    border: "3px solid #ea4335",
    background: "rgba(17, 18, 20, 0.65)",
    boxShadow: "0 0 18px rgba(234, 67, 53, 0.36)",
  },
  rating: {
    color: "#fdd663",
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
    background: "rgba(50, 121, 249, 0.14)",
    border: "1px solid rgba(50, 121, 249, 0.3)",
    color: "#d8e7ff",
    fontSize: "12px",
    fontWeight: "750",
  },
  inlineSelect: {
    minHeight: "36px",
    padding: "7px 8px",
    borderRadius: "8px",
    border: "1px solid rgba(230, 234, 240, 0.14)",
    background: "#18191d",
    color: "#e6eaf0",
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
    border: "1px solid #3c4043",
    background: "#171717",
    color: "#e8eaed",
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
  savedButton: {
    border: "1px solid rgba(52, 168, 83, 0.44)",
    background: "rgba(52, 168, 83, 0.16)",
    color: "#ceead6",
  },
  selectedButton: {
    border: "1px solid rgba(138, 180, 248, 0.46)",
    background: "rgba(26, 115, 232, 0.18)",
    color: "#d2e3fc",
  },
  disabledButton: {
    border: "1px solid rgba(154, 160, 166, 0.22)",
    background: "rgba(154, 160, 166, 0.1)",
    color: "#9aa0a6",
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
    background: "#202124",
    border: "1px solid #34373d",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.14)",
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
  },
  compareTableScroll: {
    maxHeight: "min(54vh, 520px)",
    overflow: "auto",
    paddingRight: "2px",
  },
  compareRow: {
    display: "grid",
    gridTemplateColumns: "100px repeat(2, minmax(0, 1fr))",
    gap: "8px",
    alignItems: "stretch",
  },
  compareLabel: {
    padding: "10px",
    borderRadius: "8px",
    background: "#171717",
    border: "1px solid #34373d",
    color: "#9aa0a6",
    fontWeight: "700",
  },
  compareValue: {
    padding: "10px",
    borderRadius: "8px",
    background: "#171717",
    border: "1px solid #34373d",
    color: "#e8eaed",
    overflowWrap: "anywhere",
  },
  compareValueStrong: {
    padding: "10px",
    borderRadius: "8px",
    background: "rgba(26, 115, 232, 0.14)",
    border: "1px solid rgba(138, 180, 248, 0.3)",
    color: "#e8eaed",
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
    zIndex: 1000,
  },
  modalContent: {
    background: "#202124",
    padding: "28px",
    borderRadius: "8px",
    maxWidth: "620px",
    width: "100%",
    boxShadow: "0 28px 70px rgba(0, 0, 0, 0.42)",
    color: "#bdc1c6",
  },
  compareModalContent: {
    background: "#202124",
    padding: "18px",
    borderRadius: "8px",
    maxWidth: "760px",
    width: "min(100%, 760px)",
    maxHeight: "88vh",
    boxShadow: "0 28px 70px rgba(0, 0, 0, 0.42)",
    color: "#bdc1c6",
    border: "1px solid #34373d",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  previewModalContent: {
    background: "#202124",
    padding: "20px",
    borderRadius: "8px",
    maxWidth: "900px",
    width: "100%",
    maxHeight: "92vh",
    boxShadow: "0 28px 70px rgba(0, 0, 0, 0.42)",
    color: "#bdc1c6",
    border: "1px solid #34373d",
    overflow: "auto",
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
    border: "2px solid rgba(138, 180, 248, 0.48)",
    transform: "rotate(-24deg)",
  },
  detailBookCore: {
    position: "absolute",
    left: "22px",
    top: "18px",
    width: "21px",
    height: "32px",
    borderRadius: "3px 7px 7px 3px",
    background: "linear-gradient(135deg, #4285f4, #34a853)",
    boxShadow:
      "inset 4px 0 0 rgba(255, 255, 255, 0.24), 0 10px 24px rgba(66, 133, 244, 0.28)",
  },
  detailLensCore: {
    position: "absolute",
    right: "16px",
    top: "15px",
    width: "18px",
    height: "18px",
    borderRadius: "999px",
    border: "3px solid #fbbc05",
    background: "rgba(17, 18, 20, 0.74)",
  },
  detailSparkOne: {
    position: "absolute",
    left: "12px",
    top: "13px",
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    background: "#ea4335",
    boxShadow: "0 0 18px #ea4335",
  },
  detailSparkTwo: {
    position: "absolute",
    right: "14px",
    bottom: "13px",
    width: "8px",
    height: "8px",
    borderRadius: "999px",
    background: "#81c995",
    boxShadow: "0 0 18px #81c995",
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
    color: "#9aa0a6",
    fontSize: "14px",
  },
  closeIconButton: {
    width: "40px",
    height: "40px",
    borderRadius: "6px",
    border: "1px solid rgba(248, 249, 250, 0.28)",
    background: "#303134",
    color: "#f8fafd",
    cursor: "pointer",
    fontWeight: "700",
    fontSize: "18px",
    flex: "0 0 auto",
    boxShadow: "0 8px 20px rgba(0, 0, 0, 0.22)",
  },
  previewFrame: {
    width: "100%",
    height: "min(68vh, 680px)",
    minHeight: "min(420px, 58vh)",
    border: "1px solid #3c4043",
    borderRadius: "8px",
    background: "#171717",
  },
  previewMessage: {
    minHeight: "240px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    borderRadius: "8px",
    background: "#171717",
    border: "1px solid #34373d",
    color: "#e8eaed",
    textAlign: "center",
  },
  previewHelpText: {
    marginTop: "10px",
    color: "#9aa0a6",
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
    background: "#171717",
    color: "#e8eaed",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #3c4043",
    cursor: "pointer",
    fontWeight: "600",
  },
  detailBox: {
    background: "#171717",
    borderRadius: "8px",
    padding: "16px",
    margin: "12px 0",
    border: "1px solid #34373d",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: "12px",
  },
  detailMiniCard: {
    background: "#171717",
    borderRadius: "8px",
    padding: "12px",
    border: "1px solid #34373d",
  },
  closeButton: {
    width: "100%",
    background: "#1a73e8",
    color: "#ffffff",
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontWeight: "600",
    marginTop: "16px",
  },
};
