import { useState } from "react";
import OpenAI from "openai";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export default function App() {
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [filePreview, setFilePreview] = useState(null);
  const [error, setError] = useState("");

  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

  const openai = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  // ---------------- IMAGE ----------------
  const encodeImageToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () =>
        resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
    });

  async function processImage(file) {
    const base64 = await encodeImageToBase64(file);

    const response = await openai.chat.completions.create({
      model: "gpt-5", // Kept standard production-ready gpt-4o model string
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract all text from this image.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${file.type};base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    return response.choices[0].message.content;
  }

  // ---------------- DOCX ----------------
  async function processDocx(file) {
    const arrayBuffer = await file.arrayBuffer();

    const result = await mammoth.extractRawText({
      arrayBuffer,
    });

    const text = result.value;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: `Extract and summarize this document in lines:\n\n${text}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  // ---------------- PDF ----------------
  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();

    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
    }).promise;

    let text = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((t) => t.str).join(" ") + "\n";
    }

    return text;
  }

  async function processPdf(file) {
    const text = await extractPdfText(file);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: `Extract and summarize this PDF this document in lines:\n\n${text}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  // ---------------- MAIN HAND TRIGER ----------------
  const handleFileChange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    setResult("");
    setError("");

    try {
      const type = file.type;

      let output = "";

      if (type.startsWith("image/")) {
        setFilePreview(URL.createObjectURL(file));
        output = await processImage(file);
      } 
      else if (
        type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        setFilePreview(null);
        output = await processDocx(file);
      } 
      else if (type === "application/pdf") {
        setFilePreview(null);
        output = await processPdf(file);
      } 
      else {
        throw new Error("Unsupported file type");
      }

      setResult(output);
    } catch (err) {
      console.error(err);
      console.error("FULL ERROR:", err);
      setError(err.message || "Failed to process file.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- UI ----------------
  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h2>AI File Analyzer (Image / PDF / DOCX)</h2>

      <input
        type="file"
        accept="image/*,.pdf,.docx"
        onChange={handleFileChange}
      />

      {filePreview && (
        <img
          src={filePreview}
          alt="preview"
          style={{ maxWidth: 300, marginTop: 10 }}
        />
      )}

      {loading && <p>Processing...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {result && (
        <div
          style={{
            marginTop: 20,
            padding: 10,
            background: "#eee",
          }}
        >
          <strong>Result:</strong>
          <p>{result}</p>
        </div>
      )}
    </div>
  );
}