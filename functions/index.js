import admin from 'firebase-admin';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';

admin.initializeApp();

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const claudeModel = defineString('CLAUDE_MODEL', {
  default: 'claude-sonnet-4-5',
});
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const API_USAGE_COLLECTION = 'developerApiUsage';
const API_USAGE_EVENTS_COLLECTION = 'developerApiUsageEvents';

function getTodayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getTokenCount(result, key) {
  return Number(result?.usageMetadata?.[key] || 0);
}

function getProviderErrorMessage(provider, response) {
  const message =
    response?.result?.error?.message ||
    response?.result?.error?.error?.message ||
    response?.result?.message ||
    '';

  return message || `${provider} could not process the request.`;
}

function getProviderErrorCode(status) {
  if (status === 400) return 'invalid-argument';
  if (status === 401 || status === 403) return 'failed-precondition';
  if (status === 429) return 'resource-exhausted';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

async function recordUsageSafely(payload) {
  try {
    await saveGlobalUsage(payload);
  } catch (error) {
    console.error('Developer API usage write failed', {
      provider: payload.provider,
      status: payload.status,
      callType: payload.callType,
      error: error?.message || String(error),
    });
  }
}

function isGeminiQuotaError(status, result) {
  const code = String(result?.error?.status || result?.error?.code || '').toLowerCase();
  const message = String(result?.error?.message || '').toLowerCase();

  return (
    status === 429 ||
    code.includes('resource_exhausted') ||
    code.includes('quota') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('resource exhausted')
  );
}


function toAnthropicContent(contents) {
  const contentBlocks = [];

  for (const content of contents || []) {
    for (const part of content?.parts || []) {
      if (part.text) {
        contentBlocks.push({ type: 'text', text: part.text });
      }
      if (part.inlineData?.data) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.inlineData.mimeType || 'image/jpeg',
            data: part.inlineData.data,
          },
        });
      }
    }
  }

  return contentBlocks;
}

function getMaxTokens(generationConfig = {}) {
  const configuredMax = Number(generationConfig.maxOutputTokens || 0);
  return Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.min(configuredMax, 8192)
    : 4096;
}

function normalizeClaudeResult(result, model) {
  const text = (result?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
    .trim();
  const inputTokens = Number(result?.usage?.input_tokens || 0);
  const outputTokens = Number(result?.usage?.output_tokens || 0);

  return {
    provider: 'claude',
    model,
    text,
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
  };
}

async function saveGlobalUsage({ auth, callType, status, result, provider, model }) {
  if (!auth?.uid) return;

  const db = admin.firestore();
  const dateKey = getTodayKey();
  const promptTokens = getTokenCount(result, 'promptTokenCount');
  const outputTokens = getTokenCount(result, 'candidatesTokenCount');
  const totalTokens = getTokenCount(result, 'totalTokenCount') || promptTokens + outputTokens;
  const isSuccess = status === 'Success';
  const userEmail = auth.token?.email || 'unknown';
  const eventPayload = {
    date: dateKey,
    callType,
    status,
    provider,
    model,
    promptTokens,
    outputTokens,
    totalTokens,
    userId: auth.uid,
    userEmail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await Promise.all([
    db.collection(API_USAGE_EVENTS_COLLECTION).add(eventPayload),
    db.collection(API_USAGE_COLLECTION).doc(dateKey).set(
      {
        date: dateKey,
        apiCalls: admin.firestore.FieldValue.increment(1),
        promptTokens: admin.firestore.FieldValue.increment(promptTokens),
        outputTokens: admin.firestore.FieldValue.increment(outputTokens),
        totalTokens: admin.firestore.FieldValue.increment(totalTokens),
        successCalls: admin.firestore.FieldValue.increment(isSuccess ? 1 : 0),
        failedCalls: admin.firestore.FieldValue.increment(isSuccess ? 0 : 1),
        lastCallType: callType,
        lastStatus: status,
        lastProvider: provider,
        lastModel: model,
        lastUserEmail: userEmail,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
  ]);
}

async function callGemini({ contents, generationConfig }) {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Gemini API key is not configured.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
    }
  );
  const responseText = await response.text();
  let result;

  try {
    result = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    result = undefined;
  }

  return { ok: response.ok, status: response.status, result };
}

async function callClaude({ contents, generationConfig }) {
  const apiKey = anthropicApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Claude API key is not configured.');
  }

  const model = claudeModel.value();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: getMaxTokens(generationConfig),
      messages: [
        {
          role: 'user',
          content: toAnthropicContent(contents),
        },
      ],
    }),
  });
  const responseText = await response.text();
  let result;

  try {
    result = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    result = undefined;
  }

  return {
    ok: response.ok,
    status: response.status,
    result: response.ok ? normalizeClaudeResult(result, model) : result,
    model,
  };
}

export const generateGeminiContent = onCall(
  {
    region: 'us-central1',
    invoker: 'public',
    secrets: [geminiApiKey, anthropicApiKey],
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in to use AI scanning.');
    }

    const { contents, generationConfig = {}, callType = 'AI call' } =
      request.data || {};

    if (!Array.isArray(contents) || contents.length === 0) {
      throw new HttpsError('invalid-argument', 'AI contents are required.');
    }

    const gemini = await callGemini({ contents, generationConfig });

    if (gemini.ok) {
      await recordUsageSafely({
        auth: request.auth,
        callType,
        status: 'Success',
        result: gemini.result,
        provider: 'gemini',
        model: GEMINI_MODEL,
      });
      return { ...gemini.result, provider: 'gemini', model: GEMINI_MODEL };
    }

    if (!isGeminiQuotaError(gemini.status, gemini.result)) {
      await recordUsageSafely({
        auth: request.auth,
        callType,
        status: 'Failed',
        result: gemini.result,
        provider: 'gemini',
        model: GEMINI_MODEL,
      });
      throw new HttpsError(
        getProviderErrorCode(gemini.status),
        getProviderErrorMessage('Gemini', gemini)
      );
    }

    const claude = await callClaude({ contents, generationConfig });

    if (!claude.ok) {
      await recordUsageSafely({
        auth: request.auth,
        callType,
        status: 'Failed',
        result: claude.result,
        provider: 'claude',
        model: claude.model || claudeModel.value(),
      });
      throw new HttpsError(
        getProviderErrorCode(claude.status),
        getProviderErrorMessage('Claude fallback', claude)
      );
    }

    await recordUsageSafely({
      auth: request.auth,
      callType,
      status: 'Success',
      result: claude.result,
      provider: 'claude',
      model: claude.model,
    });

    return { ...claude.result, fallbackFrom: 'gemini-quota' };
  }
);
