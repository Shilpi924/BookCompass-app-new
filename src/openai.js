// src/openaiService.js
import OpenAI from "openai";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";

// Initialize OpenAI safely
const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
const openai = new OpenAI({
  apiKey,
  dangerouslyAllowBrowser: true, // Fine for local testing/development
});

/**
 * Helper: Convert a file into a Base64 string for image processing
 */
const encodeImageToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
  });

/**
 * Helper: Extract raw text layout from a PDF file locally
 */
async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((t) => t.str).join(" ") + "\n";
  }
  return text;
}

/**
 * Process an Image with OpenAI Vision (GPT-4o)
 */
export async function processImageWithOpenAI(file) {
  const base64 = await encodeImageToBase64(file);

  const response = await openai.chat.completions.create({
    model: "gpt-4o", // Changed from 'gpt-5' to 'gpt-4o' to use a standard valid production model
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Extract all text from this image." },
          {
            type: "image_url",
            image_url: { url: `data:${file.type};base64,${base64}` },
          },
        ],
      },
    ],
  });

  return response.choices[0].message.content;
}

/**
 * Process a DOCX Word document with OpenAI
 */
export async function processDocxWithOpenAI(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
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

/**
 * Process a PDF document with OpenAI
 */
export async function processPdfWithOpenAI(file) {
  const text = await extractPdfText(file);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Extract and summarize this PDF document in lines:\n\n${text}`,
      },
    ],
  });

  return response.choices[0].message.content;
}