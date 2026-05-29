import { GoogleGenAI } from "@google/genai";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey,
});

const MODEL_NAME = "gemini-2.5-flash";

const encodeFileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.readAsDataURL(file);

    reader.onload = () => {
      resolve(reader.result.split(",")[1]);
    };

    reader.onerror = reject;
  });

function cleanJsonText(text) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

function safeParseJson(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch  {
    console.error("Invalid JSON from Gemini:", text);

    return {
      analysis:
        "Gemini returned a response, but it was not valid JSON.",
      books: [],
    };
  }
}

export async function processImageWithGemini(file, prompt) {
  const base64Data = await encodeFileToBase64(file);

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: {
              data: base64Data,
              mimeType: file.type,
            },
          },
        ],
      },
    ],
  });

  return safeParseJson(response.text);
}

export async function processTextWithGemini(
  extractedText,
  fileType = "document",
  prompt
) {
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `
${prompt}

Uploaded file type:
${fileType}

Extracted content:
${extractedText}
`,
  });

  return safeParseJson(response.text);
}