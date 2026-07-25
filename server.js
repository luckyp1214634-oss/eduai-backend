require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '8mb' })); // room for base64 images

const PORT = process.env.PORT || 3000;
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// ---- Rate limiting (basic abuse protection) ----
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,                  // 60 requests / hour / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ---- App-level auth ----
// This is NOT full user login — it's a shared "this request came from our
// app" secret. It stops randoms from hitting the endpoint and burning your
// AI quota. Real per-user auth (Firebase Auth / JWT) can be layered on top
// of this later without changing this contract.
function checkAppAuth(req, res, next) {
  const secret = req.header('X-App-Secret');
  if (!secret || secret !== APP_SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send('EduAI backend is running.');
});

app.post('/api/doubt-solve', checkAppAuth, async (req, res) => {
  try {
    const { question, imageBase64 } = req.body || {};

    if ((!question || typeof question !== 'string' || question.trim().length === 0) && !imageBase64) {
      return res.status(400).json({ success: false, error: 'Question or image is required.' });
    }
    if (question && question.length > 2000) {
      return res.status(400).json({ success: false, error: 'Question too long.' });
    }
    if (imageBase64 && imageBase64.length > 6000000) {
      return res.status(400).json({ success: false, error: 'Image too large.' });
    }

    const systemPrompt =
      "You are a helpful study tutor for JEE, NEET and Class 11-12 students in India. " +
      "If an image is attached, read the question from the image. " +
      "Answer with a clear step-by-step solution. " +
      "IMPORTANT FORMATTING RULES: reply in plain readable text only. Do NOT use markdown symbols " +
      "like #, ##, ###, **, or LaTeX delimiters like $ or $$. Use simple labels like 'Step 1:' on " +
      "their own line, and write math expressions in plain text (e.g. x^2 + 3x = 5). " +
      "STRICT TOPIC RULE: ONLY answer questions related to JEE/NEET/Class 11-12 academic subjects " +
      "(Physics, Chemistry, Maths, Biology, etc). If the question is unrelated to these academic " +
      "subjects — including entertainment, celebrities, adult content, or any non-academic personal " +
      "question — respond with EXACTLY this and nothing else: OFF_TOPIC_QUESTION";

    let promptText = systemPrompt;
    if (question) {
      promptText += "\n\nQuestion: " + question;
    }

    const parts = [{ text: promptText }];
    if (imageBase64) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error('Gemini API error:', JSON.stringify(data));
      return res.status(502).json({ success: false, error: 'AI service error, please try again.' });
    }

    const answer =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!answer) {
      console.error('Unexpected Gemini response shape:', JSON.stringify(data));
      return res.status(502).json({ success: false, error: 'No answer received, please try again.' });
    }

    return res.json({ success: true, answer: answer });
  } catch (err) {
    console.error('doubt-solve error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

app.listen(PORT, () => {
  console.log('EduAI backend listening on port', PORT);
});
