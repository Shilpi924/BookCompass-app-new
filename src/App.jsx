import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { GoogleGenAI } from "@google/genai";
import { analytics, logEvent } from "./firebase";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
const googleBooksApiKey = import.meta.env.GOOGLE_BOOKS_API_KEY;
let ai = null;
try {
  if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
  }
} catch (e) {
  console.warn("GoogleGenAI initialization skipped:", e.message);
}
const MODEL_NAME = "gemini-2.5-flash-lite";
const GOOGLE_BOOKS_PREVIEW_TIMEOUT_MS = 10000;

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

export default function App() {
  useEffect(() => {
    logEvent(analytics, "app_opened");
  }, []);

  const [imagePreview, setImagePreview] = useState(null);
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [readingList, setReadingList] = useState(() => {
    return readStoredJson("readingList", []);
  });

  const [selectedBook, setSelectedBook] = useState(null);
  const [compare, setCompare] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [previewCache, setPreviewCache] = useState({});
  const [previewModal, setPreviewModal] = useState(null);
  const previewRequestId = useRef(0);
  const [saveStatus, setSaveStatus] = useState(null);
  const [idleBursts, setIdleBursts] = useState([]);
  const [savedArtActive, setSavedArtActive] = useState(false);
  const [savedFiles, setSavedFiles] = useState(() => {
    return normalizeSavedFiles(readStoredJson("savedPreviewFiles", []));
  });
  const savedFileIdsRef = useRef(new Set(savedFiles.map((file) => file.id)));

  useEffect(() => {
    localStorage.setItem("readingList", JSON.stringify(readingList));
  }, [readingList]);

  useEffect(() => {
    localStorage.setItem("savedPreviewFiles", JSON.stringify(savedFiles));
    savedFileIdsRef.current = new Set(savedFiles.map((file) => file.id));
  }, [savedFiles]);

  async function handleImage(file) {
    if (!file) return;
    if (!ai) {
      setError("Gemini API key is not configured. Please add VITE_GEMINI_API_KEY to your .env file.");
      return;
    }

    setError("");
    setLoading(true);
    setBooks([]);
    setPreviewCache({});
    setAnswer("");
    setSearch("");
    setImagePreview(URL.createObjectURL(file));

    try {
      const base64 = await encodeFileToBase64(file);

      const result = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [
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
- Do not invent too many books.
- Only include books you can reasonably detect.
- Keep summaries short.
                `,
              },
              {
                inlineData: {
                  mimeType: file.type,
                  data: base64,
                },
              },
            ],
          },
        ],
      });

      const text =
        result.text ||
        result.candidates?.[0]?.content?.parts?.[0]?.text ||
        "";

      const parsed = safeParseJson(text);

      if (!parsed?.books || !Array.isArray(parsed.books)) {
        throw new Error("No books returned from Gemini");
      }

      setBooks(parsed.books);
    } catch (err) {
      console.error("SCAN ERROR:", err);
      setError(
        err?.message ||
          "Could not scan the bookshelf. Try a clearer photo of book spines."
      );
    } finally {
      setLoading(false);
    }
  }

  const filteredBooks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return books;

    return books.filter((book) => {
      const searchableText = [
        book.title,
        book.author,
        book.authorBio,
        book.genre,
        book.summary,
        book.shelfPick,
        book.readingLevel,
        book.gradeBand,
        book.ageRecommendation,
        book.whyRead,
        book.ratingSource,
        String(book.rating || ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchableText.includes(q);
    });
  }, [books, search]);

  const topBooks = useMemo(() => {
    return [...filteredBooks]
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 3);
  }, [filteredBooks]);

  const detectedBooks = useMemo(() => {
    const topBookKeys = new Set(topBooks.map(getBookKey));
    return filteredBooks.filter((book) => !topBookKeys.has(getBookKey(book)));
  }, [filteredBooks, topBooks]);

  function isBookInReadingList(book) {
    return readingList.some((savedBook) => getBookKey(savedBook) === getBookKey(book));
  }

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

  function getPreviewButtonState(book) {
    const cachedPreview = previewCache[getBookKey(book)];

    if (cachedPreview?.status === "ready") {
      return {
        label: hasSavedPreview(book) ? "Saved Preview" : "Preview",
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
        label: hasSavedPreview(book) ? "Saved Preview" : "Preview",
        disabled: false,
        saved: hasSavedPreview(book),
      };
    }

    return {
      label: hasSavedPreview(book) ? "Saved Preview" : "Preview",
      disabled: false,
      saved: hasSavedPreview(book),
    };
  }

  function addToReadingList(book) {
    const exists = isBookInReadingList(book);

    if (!exists) {
      setReadingList([...readingList, book]);
    }

    setSaveStatus({
      message: exists
        ? `${book.title} is already saved as a favorite.`
        : `${book.title} saved as a favorite.`,
      bookKey: getSavedFileKey(book.title, "favorite"),
      type: "favorite",
    });
  }

  function removeFromReadingList(title) {
    setReadingList(readingList.filter((b) => b.title !== title));
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

    books.forEach((book) => {
      const key = getBookKey(book);
      if (!key || previewCache[key]) return;

      setPreviewCache((currentCache) => {
        if (currentCache[key]) return currentCache;

        return {
          ...currentCache,
          [key]: {
            status: "loading",
            message: "Checking preview availability...",
          },
        };
      });

      findBookPreview(book).then((previewResult) => {
        if (cancelled) return;

        setPreviewCache((currentCache) => ({
          ...currentCache,
          [key]: previewResult,
        }));
      });
    });

    return () => {
      cancelled = true;
    };
  }, [books, findBookPreview, previewCache]);

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

    if (previewCache[key]) {
      setPreviewModal({ book, ...previewCache[key] });
      return;
    }

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

    if (!alreadySaved) {
      savedFileIdsRef.current.add(savedKey);
      setSavedFiles((currentFiles) => [savedFile, ...currentFiles]);
    }

    setSaveStatus({
      message: alreadySaved
        ? `${displayName || fileName} is already saved on this phone.`
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
    if (!ai) {
      setAnswer("Gemini API key is not configured. Please add VITE_GEMINI_API_KEY to your .env file.");
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

    try {
      const result = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `
You are a friendly AI librarian for kids, families, and teens.

Books detected:
${JSON.stringify(books, null, 2)}

User question:
${question}

Answer in a cheerful, helpful, short way. Recommend books only from the detected list.
        `,
      });

      const text =
        result.text ||
        result.candidates?.[0]?.content?.parts?.[0]?.text ||
        "";

      setAnswer(text);
    } catch (err) {
      console.error("AI Librarian error:", err);
      setAnswer("Sorry, I could not answer that question right now.");
    } finally {
      setLoading(false);
    }
  }

  function renderBookCard(book, index, options = {}) {
    const theme = getTheme(book);
    const favoriteSaved = isBookInReadingList(book);
    const previewButton = getPreviewButtonState(book);
    const compareSelected = compare.some((selectedBook) => getBookKey(selectedBook) === getBookKey(book));

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

        <h3 style={{ color: theme.title, fontSize: "22px", margin: "0 0 10px" }}>{book.title}</h3>

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
                  ...(favoriteSaved ? styles.savedButton : {}),
                }}
                onClick={() => addToReadingList(book)}
              >
                {favoriteSaved ? "Saved Fav" : "❤️ Save"}
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

  function renderSavedFiles(sectionKey) {
    const savedFileBooks = getSavedBookGroups(savedFiles).map((savedBook) => ({
      ...savedBook,
      source: "file",
    }));
    const savedFileBookKeys = new Set(
      savedFileBooks.map((savedBook) => getBookKey(savedBook.catalogBook))
    );
    const favoriteBooks = readingList
      .filter((book) => !savedFileBookKeys.has(getBookKey(book)))
      .map((book) => ({
        id: `favorite-${getBookKey(book)}`,
        bookTitle: book.title,
        catalogBook: book,
        preview: previewCache[getBookKey(book)]?.status === "ready"
          ? previewCache[getBookKey(book)]
          : null,
        location: "Favorite",
        savedAt: book.savedAt || new Date().toISOString(),
        source: "favorite",
      }));
    const savedBooks = [...savedFileBooks, ...favoriteBooks];

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
              Saved Books
            </h2>
            <span style={styles.fileCountBadge}>{savedBooks.length}</span>
          </div>
        </div>

        {saveStatus?.message && sectionKey === "home" && (
          <p style={styles.saveStatus}>{saveStatus.message}</p>
        )}

        {savedBooks.length === 0 ? (
          <p style={styles.countText}>
            No saved books yet. Tap Save on a book card, or save preview/details
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
                    {savedBook.location} · {new Date(savedBook.savedAt).toLocaleString()}
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
                    onClick={() =>
                      savedBook.source === "favorite"
                        ? removeFromReadingList(savedBook.bookTitle)
                        : deleteSavedBook(savedBook)
                    }
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

  return (
    <div style={styles.page}>
      <div className="idle-background" aria-hidden="true">
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
          <div style={styles.brandRow}>
            <div style={styles.brandMark} aria-hidden="true">
              <span style={styles.logoBook} />
              <span style={styles.logoSpine} />
              <span style={styles.logoLens} />
              <span style={styles.logoBeam} />
            </div>
            <h1 style={styles.title}>Lumina</h1>
          </div>
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
              style={styles.search}
              placeholder="🔍 Filter books..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

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

          <h2 style={styles.sectionTitle}>📖 Detected Books</h2>

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

      {compare.length > 0 && (
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

      <h2 style={styles.sectionTitle}>❤️ Reading List</h2>

      {readingList.length === 0 ? (
        <p style={styles.countText}>No saved books yet.</p>
      ) : (
        readingList.map((book, index) => (
          <div key={`${book.title}-saved-${index}`} style={styles.listItem}>
            <span>📘 {book.title}</span>
            <button
              style={styles.removeButton}
              onClick={() => removeFromReadingList(book.title)}
            >
              Remove
            </button>
          </div>
        ))
      )}

      {selectedBook &&
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

      {compareOpen && compare.length > 0 && (
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

      {previewModal && (
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
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: "linear-gradient(180deg, rgba(32, 33, 36, 0.98), rgba(23, 23, 23, 0.98))",
    color: "#bdc1c6",
  },
  hero: {
    background:
      "linear-gradient(135deg, rgba(26, 115, 232, 0.16), rgba(32, 33, 36, 0.96) 46%, rgba(15, 15, 16, 0.96)), linear-gradient(90deg, rgba(66, 133, 244, 0.2), rgba(52, 168, 83, 0.14), rgba(251, 188, 5, 0.12), rgba(234, 67, 53, 0.13))",
    borderRadius: "8px",
    padding: "clamp(22px, 6vw, 32px) clamp(16px, 5vw, 24px)",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "center",
    flexWrap: "wrap",
    boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
    color: "#ffffff",
    border: "1px solid rgba(255, 255, 255, 0.08)",
  },
  heroText: {
    flex: "1 1 260px",
    minWidth: 0,
  },
  brandRow: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  brandMark: {
    position: "relative",
    width: "54px",
    height: "54px",
    borderRadius: "8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(145deg, rgba(26, 115, 232, 0.34), rgba(32, 33, 36, 0.88))",
    boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.2), 0 12px 32px rgba(66, 133, 244, 0.28)",
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
    color: "#bdc1c6",
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
    border: "1px solid rgba(138, 180, 248, 0.32)",
    background: "rgba(18, 18, 20, 0.54)",
    color: "#d8e2f3",
    fontSize: "14px",
    fontWeight: "650",
    flex: "0 0 auto",
  },
  agentDot: {
    width: "10px",
    height: "10px",
    borderRadius: "999px",
    background: "#34a853",
    boxShadow: "0 0 0 4px rgba(52, 168, 83, 0.14)",
  },
  uploadBox: {
    display: "flex",
    gap: "14px",
    flexWrap: "wrap",
    margin: "24px 0",
  },
  cameraButton: {
    flex: "1 1 150px",
    textAlign: "center",
    background: "#1a73e8",
    color: "#ffffff",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid #1a73e8",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s",
    boxShadow: "0 10px 24px rgba(26, 115, 232, 0.24)",
  },
  galleryButton: {
    flex: "1 1 180px",
    textAlign: "center",
    background: "#202124",
    color: "#e8eaed",
    padding: "12px 20px",
    borderRadius: "8px",
    border: "1px solid #3c4043",
    cursor: "pointer",
    fontWeight: "650",
    transition: "background 0.2s",
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
    fontWeight: "650",
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
    borderRadius: "8px",
    padding: "20px",
    boxShadow: "0 16px 36px rgba(0, 0, 0, 0.18)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    color: "#bdc1c6",
    minHeight: "100%",
    textAlign: "left",
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
  buttonRow: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",
    marginTop: "auto",
    paddingTop: "16px",
  },
  smallButton: {
    width: "100%",
    minHeight: "38px",
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid #3c4043",
    background: "#171717",
    color: "#e8eaed",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "14px",
    transition: "background 0.2s",
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
  listItem: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    padding: "12px 16px",
    borderRadius: "8px",
    background: "#202124",
    marginBottom: "8px",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.14)",
    border: "1px solid #34373d",
    color: "#e8eaed",
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
  removeButton: {
    border: "none",
    background: "rgba(234, 67, 53, 0.16)",
    color: "#f28b82",
    borderRadius: "6px",
    padding: "6px 12px",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "14px",
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
