import { useMemo, useState, useEffect } from "react";
import { GoogleGenAI } from "@google/genai";
import { analytics, logEvent } from "./firebase";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });
const MODEL_NAME = "gemini-2.5-flash-lite";

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
      emoji: "🌈🦄",
      cardBg: "#fff0f7",
      imageBg: "linear-gradient(135deg, #ffd6e8, #fff7ad, #d8f3ff)",
      border: "#f9a8d4",
      title: "#db2777",
      badgeBg: "#ffe4f1",
      badgeText: "#be185d",
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
      emoji: "🚀🏰",
      cardBg: "#eef7ff",
      imageBg: "linear-gradient(135deg, #d8f3ff, #e0f2fe, #dcfce7)",
      border: "#93c5fd",
      title: "#2563eb",
      badgeBg: "#dbeafe",
      badgeText: "#1d4ed8",
    };
  }

  return {
    name: "teen",
    emoji: "📖✨",
    cardBg: "#f5f3ff",
    imageBg: "linear-gradient(135deg, #ede9fe, #fce7f3, #e0e7ff)",
    border: "#c4b5fd",
    title: "#6d28d9",
    badgeBg: "#ede9fe",
    badgeText: "#5b21b6",
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
    return JSON.parse(localStorage.getItem("readingList") || "[]");
  });

  const [selectedBook, setSelectedBook] = useState(null);
  const [compare, setCompare] = useState([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    localStorage.setItem("readingList", JSON.stringify(readingList));
  }, [readingList]);

  async function handleImage(file) {
    if (!file) return;

    setError("");
    setLoading(true);
    setBooks([]);
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

  function addToReadingList(book) {
    const exists = readingList.some((b) => b.title === book.title);
    if (!exists) setReadingList([...readingList, book]);
  }

  function removeFromReadingList(title) {
    setReadingList(readingList.filter((b) => b.title !== title));
  }

  function toggleCompare(book) {
    const exists = compare.some((b) => b.title === book.title);

    if (exists) {
      setCompare(compare.filter((b) => b.title !== book.title));
      return;
    }

    if (compare.length < 2) setCompare([...compare, book]);
  }

  async function askLibrarian() {
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

    return (
      <div
        key={`${book.title}-${options.prefix || "book"}-${index}`}
        style={{
          ...styles.card,
          background: theme.cardBg,
          border: `3px solid ${theme.border}`,
        }}
      >
        <div style={{ ...styles.bookImage, background: theme.imageBg }}>
          {theme.emoji}
        </div>

        <h3 style={{ color: theme.title, fontSize: "22px" }}>{book.title}</h3>

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

              <button style={styles.smallButton} onClick={() => addToReadingList(book)}>
                ❤️ Save
              </button>

              <button style={styles.smallButton} onClick={() => toggleCompare(book)}>
                ⚖️ Compare
              </button>
            </div>
          </>
        )}

        {options.topPick && (
          <p
            style={{
              ...styles.badge,
              background: theme.badgeBg,
              color: theme.badgeText,
            }}
          >
            {book.shelfPick}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.hero}>
        <div style={styles.heroText}>
          <h1 style={styles.title}>🧭📚 BookCompass</h1>
          <p style={styles.subtitle}>
            Snap a bookshelf and let BookCompass guide you to your next favorite
            book. Scan books, discover ratings, and find your next read.
          </p>
        </div>

        <div style={styles.heroArt}>📖✨</div>
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

      {loading && <p style={styles.loading}>✨ Working magic...</p>}
      {error && <p style={styles.error}>{error}</p>}

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
            Showing {filteredBooks.length} of {books.length} books
          </p>

          <div style={styles.grid}>
            {filteredBooks.length === 0 ? (
              <p style={styles.error}>No matching books found. Try another word.</p>
            ) : (
              filteredBooks.map((book, index) =>
                renderBookCard(book, index, { prefix: "detected" })
              )
            )}
          </div>
        </>
      )}

      {compare.length > 0 && (
        <>
          <h2 style={styles.sectionTitle}>⚖️ Compare Books</h2>
          <div style={styles.grid}>
            {compare.map((book, index) =>
              renderBookCard(book, index, { prefix: "compare", compact: true })
            )}
          </div>
        </>
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
                    {theme.emoji}
                  </div>

                  <div>
                    <h2 style={{ ...styles.modalTitle, color: theme.title }}>
                      {selectedBook.title}
                    </h2>

                    <p
                      style={{
                        ...styles.badge,
                        background: theme.badgeBg,
                        color: theme.badgeText,
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

                <button
                  style={styles.closeButton}
                  onClick={() => setSelectedBook(null)}
                >
                  Close ✨
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    maxWidth: "1000px",
    margin: "auto",
    padding: "22px",
    fontFamily: "Comic Sans MS, Arial, sans-serif",
    background:
      "linear-gradient(135deg, #fff1f8 0%, #eef7ff 45%, #f3ffe9 100%)",
    color: "#3f3f46",
  },
  hero: {
    background: "linear-gradient(135deg, #ffd6e8, #d8f3ff, #e4ffd4)",
    borderRadius: "28px",
    padding: "24px",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "center",
    flexWrap: "wrap",
    boxShadow: "0 8px 24px rgba(150, 120, 180, 0.2)",
  },
  heroText: {
    flex: "1 1 260px",
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: "clamp(28px, 6vw, 38px)",
    color: "#6d28d9",
    lineHeight: 1.15,
    wordBreak: "break-word",
  },
  subtitle: {
    color: "#555",
    fontSize: "16px",
    lineHeight: 1.5,
    marginBottom: 0,
  },
  heroArt: {
    fontSize: "clamp(38px, 10vw, 54px)",
    flex: "0 0 auto",
  },
  uploadBox: {
    display: "flex",
    gap: "14px",
    flexWrap: "wrap",
    margin: "22px 0",
  },
  cameraButton: {
    background: "#ffd6e8",
    color: "#7c2d12",
    padding: "14px 20px",
    borderRadius: "18px",
    border: "2px solid #f9a8d4",
    cursor: "pointer",
    fontWeight: "bold",
    boxShadow: "0 5px 12px rgba(249, 168, 212, 0.35)",
  },
  galleryButton: {
    background: "#d8f3ff",
    color: "#075985",
    padding: "14px 20px",
    borderRadius: "18px",
    border: "2px solid #7dd3fc",
    cursor: "pointer",
    fontWeight: "bold",
    boxShadow: "0 5px 12px rgba(125, 211, 252, 0.35)",
  },
  askButton: {
    background: "#c7f9cc",
    color: "#166534",
    padding: "12px 18px",
    borderRadius: "16px",
    border: "2px solid #86efac",
    cursor: "pointer",
    fontWeight: "bold",
  },
  preview: {
    width: "100%",
    maxHeight: "350px",
    objectFit: "cover",
    borderRadius: "24px",
    marginBottom: "20px",
    border: "4px solid white",
    boxShadow: "0 8px 18px rgba(0,0,0,0.12)",
  },
  loading: {
    fontWeight: "bold",
    color: "#7c3aed",
  },
  error: {
    color: "#dc2626",
    fontWeight: "bold",
  },
  searchRow: {
    display: "flex",
    gap: "10px",
    margin: "20px 0",
    flexWrap: "wrap",
  },
  search: {
    flex: 1,
    minWidth: "220px",
    padding: "13px",
    borderRadius: "16px",
    border: "2px solid #f9a8d4",
    fontSize: "16px",
    background: "#fff7fb",
  },
  askInput: {
    flex: 1,
    minWidth: "220px",
    padding: "13px",
    borderRadius: "16px",
    border: "2px solid #93c5fd",
    fontSize: "16px",
    background: "#f0f9ff",
  },
  answer: {
    padding: "16px",
    background: "#fff7cc",
    borderRadius: "20px",
    whiteSpace: "pre-wrap",
    marginBottom: "20px",
    border: "2px solid #fde68a",
  },
  sectionTitle: {
    color: "#6d28d9",
    marginTop: "28px",
  },
  countText: {
    color: "#666",
    fontWeight: "bold",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "18px",
  },
  card: {
    borderRadius: "24px",
    padding: "18px",
    boxShadow: "0 8px 18px rgba(140, 120, 180, 0.18)",
    transition: "all 0.25s ease",
  },
  bookImage: {
    height: "90px",
    borderRadius: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "42px",
    marginBottom: "12px",
  },
  rating: {
    color: "#b45309",
    fontWeight: "bold",
  },
  badge: {
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "14px",
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  smallButton: {
    padding: "9px 11px",
    borderRadius: "14px",
    border: "2px solid #ddd6fe",
    background: "#faf5ff",
    cursor: "pointer",
    fontWeight: "bold",
  },
  listItem: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    padding: "12px",
    borderRadius: "16px",
    background: "#fff",
    marginBottom: "8px",
    boxShadow: "0 3px 10px rgba(0,0,0,0.08)",
  },
  removeButton: {
    border: "none",
    background: "#fecaca",
    borderRadius: "12px",
    padding: "8px 10px",
    cursor: "pointer",
  },
  modal: {
    position: "fixed",
    inset: 0,
    background: "rgba(80, 60, 120, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
    overflowY: "auto",
  },
  modalContent: {
    background: "linear-gradient(135deg, #fff7fb, #f0f9ff)",
    padding: "24px",
    borderRadius: "28px",
    maxWidth: "620px",
    width: "100%",
    boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
  },
  modalHeader: {
    display: "flex",
    gap: "16px",
    alignItems: "center",
    marginBottom: "14px",
  },
  modalIcon: {
    width: "90px",
    height: "90px",
    borderRadius: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "46px",
  },
  modalTitle: {
    margin: 0,
  },
  detailBox: {
    background: "#ffffffcc",
    borderRadius: "20px",
    padding: "14px",
    margin: "12px 0",
    border: "2px solid #e9d5ff",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: "10px",
  },
  detailMiniCard: {
    background: "#fff7cc",
    borderRadius: "18px",
    padding: "12px",
    border: "2px solid #fde68a",
  },
  closeButton: {
    width: "100%",
    background: "#c7f9cc",
    color: "#166534",
    padding: "13px",
    borderRadius: "18px",
    border: "2px solid #86efac",
    cursor: "pointer",
    fontWeight: "bold",
    marginTop: "12px",
  },
};
