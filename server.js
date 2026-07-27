require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '8mb' })); // room for base64 images

const PORT = process.env.PORT || 3000;
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // separate, stronger secret — only for seeding PYQs
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_AI_GENERATIONS_PER_DAY = parseInt(process.env.MAX_AI_GENERATIONS_PER_DAY || '30', 10);

// ---- Firebase Admin (Firestore) setup ----
// FIREBASE_SERVICE_ACCOUNT env var holds the full service account JSON as a
// single-line string (see .env.example / README for how to get this).
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('Firestore connected.');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — quiz question bank will not work yet.');
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e.message);
}

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

// Stronger secret for admin-only actions (seeding real PYQs). Never shipped
// inside the Android app — only used by you (or me, on your behalf) directly.
function checkAdminAuth(req, res, next) {
  const secret = req.header('X-Admin-Secret');
  if (!secret || !ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send('EduAI backend is running.');
});

// =====================================================================
// AI Doubt Solver (unchanged)
// =====================================================================
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

    const answer = await callGemini(parts);

    if (!answer) {
      return res.status(502).json({ success: false, error: 'No answer received, please try again.' });
    }

    return res.json({ success: true, answer: answer });
  } catch (err) {
    console.error('doubt-solve error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Quiz / Mock Test question bank — Firestore cache + AI top-up
// =====================================================================
//
// How this keeps API usage low:
//   1. Look in Firestore first for questions matching subject+topic+difficulty.
//   2. Only call Gemini for the SHORTFALL (e.g. asked for 10, DB has 6 -> only
//      generate 4), and in ONE request (not one call per question).
//   3. Newly generated questions are saved back to Firestore forever, so the
//      next person asking for the same topic costs ZERO API calls.
//   4. A daily cap (MAX_AI_GENERATIONS_PER_DAY) hard-stops AI generation once
//      hit — after that, only whatever's already cached (AI + PYQ) is served.

app.post('/api/quiz-questions', checkAppAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Question bank not configured yet.' });
  }

  try {
    const { subject, topic, difficulty, count } = req.body || {};
    const wantCount = Math.min(Math.max(parseInt(count, 10) || 10, 1), 20);

    if (!subject) {
      return res.status(400).json({ success: false, error: 'subject is required.' });
    }
    const diff = difficulty || 'medium';

    // 1. Look for existing cached questions (PYQ + previously AI-generated).
    let query = db.collection('questions')
      .where('subject', '==', subject)
      .where('difficulty', '==', diff);
    if (topic) {
      query = query.where('topic', '==', topic);
    }
    query = query.limit(60);

    const snapshot = await query.get();
    let existing = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    shuffleArray(existing);

    if (existing.length >= wantCount) {
      return res.json({ success: true, questions: existing.slice(0, wantCount), source: 'cache' });
    }

    if (!topic) {
      // No specific topic given — just serve whatever's cached across all
      // topics for this subject. AI top-up needs a topic to generate about.
      return res.json({ success: true, questions: existing, source: 'cache_only' });
    }

    // 2. Not enough cached — top up with AI, but only within the daily cap.
    const shortfall = wantCount - existing.length;
    const allowed = await tryReserveAIQuota(shortfall > 0 ? 1 : 0);

    if (!allowed) {
      return res.json({
        success: true,
        questions: existing,
        source: 'cache_only',
        note: 'AI daily limit khatam ho gaya hai — sirf jo pehle se store hain wahi mile. Kal try karo ya PYQ add karo.'
      });
    }

    const generated = await generateQuestionsWithAI(subject, topic, diff, shortfall);

    const batch = db.batch();
    const savedQuestions = [];
    for (const q of generated) {
      const ref = db.collection('questions').doc();
      const doc = {
        subject, topic, difficulty: diff,
        questionText: q.questionText,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || '',
        source: 'ai',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      batch.set(ref, doc);
      savedQuestions.push({ id: ref.id, ...doc });
    }
    await batch.commit();

    const combined = existing.concat(savedQuestions).slice(0, wantCount);
    return res.json({ success: true, questions: combined, source: 'cache_plus_ai' });

  } catch (err) {
    console.error('quiz-questions error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Admin-only: seed real PYQ questions (never called from the app itself)
// =====================================================================
app.post('/api/seed-questions', checkAdminAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Question bank not configured yet.' });
  }
  try {
    const { questions } = req.body || {};
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: 'questions array is required.' });
    }

    const batch = db.batch();
    for (const q of questions) {
      const ref = db.collection('questions').doc();
      batch.set(ref, {
        subject: q.subject,
        topic: q.topic,
        difficulty: q.difficulty || 'medium',
        questionText: q.questionText,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || '',
        source: 'pyq',
        year: q.year || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();

    return res.json({ success: true, inserted: questions.length });
  } catch (err) {
    console.error('seed-questions error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Helpers
// =====================================================================

async function callGemini(parts) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );
  const data = await response.json();
  if (!response.ok) {
    console.error('Gemini API error:', JSON.stringify(data));
    throw new Error('AI service error');
  }
  return data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
}

async function generateQuestionsWithAI(subject, topic, difficulty, count) {
  const prompt =
    `Generate ${count} multiple-choice questions for JEE/NEET/Class 11-12 students in India.\n` +
    `Subject: ${subject}\nTopic: ${topic}\nDifficulty: ${difficulty}\n\n` +
    `Respond with ONLY a valid JSON array, no markdown fences, no extra text, in exactly this shape:\n` +
    `[{"questionText":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]\n` +
    `correctIndex is 0-based (0,1,2,3). Keep questionText and options in plain text, no LaTeX, no markdown.`;

  const text = await callGemini([{ text: prompt }]);
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('AI did not return a JSON array');
  }
  return parsed;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Returns true if there's daily AI-generation quota left, and reserves `amount` of it. */
async function tryReserveAIQuota(amount) {
  if (amount <= 0) {
    return true; // nothing to generate, no quota needed
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ref = db.collection('meta').doc('ai_usage_' + today);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists ? (doc.data().count || 0) : 0;
    if (current >= MAX_AI_GENERATIONS_PER_DAY) {
      return false;
    }
    tx.set(ref, { count: current + amount }, { merge: true });
    return true;
  });
}

app.listen(PORT, () => {
  console.log('EduAI backend listening on port', PORT);
});
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

// Stronger secret for admin-only actions (seeding real PYQs). Never shipped
// inside the Android app — only used by you (or me, on your behalf) directly.
function checkAdminAuth(req, res, next) {
  const secret = req.header('X-Admin-Secret');
  if (!secret || !ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send('EduAI backend is running.');
});

// =====================================================================
// AI Doubt Solver (unchanged)
// =====================================================================
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

    const answer = await callGemini(parts);

    if (!answer) {
      return res.status(502).json({ success: false, error: 'No answer received, please try again.' });
    }

    return res.json({ success: true, answer: answer });
  } catch (err) {
    console.error('doubt-solve error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Quiz / Mock Test question bank — Firestore cache + AI top-up
// =====================================================================
//
// How this keeps API usage low:
//   1. Look in Firestore first for questions matching subject+topic+difficulty.
//   2. Only call Gemini for the SHORTFALL (e.g. asked for 10, DB has 6 -> only
//      generate 4), and in ONE request (not one call per question).
//   3. Newly generated questions are saved back to Firestore forever, so the
//      next person asking for the same topic costs ZERO API calls.
//   4. A daily cap (MAX_AI_GENERATIONS_PER_DAY) hard-stops AI generation once
//      hit — after that, only whatever's already cached (AI + PYQ) is served.

app.post('/api/quiz-questions', checkAppAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Question bank not configured yet.' });
  }

  try {
    const { subject, topic, difficulty, count } = req.body || {};
    const wantCount = Math.min(Math.max(parseInt(count, 10) || 10, 1), 20);

    if (!subject || !topic) {
      return res.status(400).json({ success: false, error: 'subject and topic are required.' });
    }
    const diff = difficulty || 'medium';

    // 1. Look for existing cached questions (PYQ + previously AI-generated).
    let query = db.collection('questions')
      .where('subject', '==', subject)
      .where('topic', '==', topic)
      .where('difficulty', '==', diff)
      .limit(60);

    const snapshot = await query.get();
    let existing = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    shuffleArray(existing);

    if (existing.length >= wantCount) {
      return res.json({ success: true, questions: existing.slice(0, wantCount), source: 'cache' });
    }

    // 2. Not enough cached — top up with AI, but only within the daily cap.
    const shortfall = wantCount - existing.length;
    const allowed = await tryReserveAIQuota(shortfall > 0 ? 1 : 0);

    if (!allowed) {
      return res.json({
        success: true,
        questions: existing,
        source: 'cache_only',
        note: 'AI daily limit khatam ho gaya hai — sirf jo pehle se store hain wahi mile. Kal try karo ya PYQ add karo.'
      });
    }

    const generated = await generateQuestionsWithAI(subject, topic, diff, shortfall);

    const batch = db.batch();
    const savedQuestions = [];
    for (const q of generated) {
      const ref = db.collection('questions').doc();
      const doc = {
        subject, topic, difficulty: diff,
        questionText: q.questionText,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || '',
        source: 'ai',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      batch.set(ref, doc);
      savedQuestions.push({ id: ref.id, ...doc });
    }
    await batch.commit();

    const combined = existing.concat(savedQuestions).slice(0, wantCount);
    return res.json({ success: true, questions: combined, source: 'cache_plus_ai' });

  } catch (err) {
    console.error('quiz-questions error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Admin-only: seed real PYQ questions (never called from the app itself)
// =====================================================================
app.post('/api/seed-questions', checkAdminAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Question bank not configured yet.' });
  }
  try {
    const { questions } = req.body || {};
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: 'questions array is required.' });
    }

    const batch = db.batch();
    for (const q of questions) {
      const ref = db.collection('questions').doc();
      batch.set(ref, {
        subject: q.subject,
        topic: q.topic,
        difficulty: q.difficulty || 'medium',
        questionText: q.questionText,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || '',
        source: 'pyq',
        year: q.year || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();

    return res.json({ success: true, inserted: questions.length });
  } catch (err) {
    console.error('seed-questions error:', err);
    return res.status(500).json({ success: false, error: 'Server error, please try again.' });
  }
});

// =====================================================================
// Helpers
// =====================================================================

async function callGemini(parts) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );
  const data = await response.json();
  if (!response.ok) {
    console.error('Gemini API error:', JSON.stringify(data));
    throw new Error('AI service error');
  }
  return data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
}

async function generateQuestionsWithAI(subject, topic, difficulty, count) {
  const prompt =
    `Generate ${count} multiple-choice questions for JEE/NEET/Class 11-12 students in India.\n` +
    `Subject: ${subject}\nTopic: ${topic}\nDifficulty: ${difficulty}\n\n` +
    `Respond with ONLY a valid JSON array, no markdown fences, no extra text, in exactly this shape:\n` +
    `[{"questionText":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]\n` +
    `correctIndex is 0-based (0,1,2,3). Keep questionText and options in plain text, no LaTeX, no markdown.`;

  const text = await callGemini([{ text: prompt }]);
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('AI did not return a JSON array');
  }
  return parsed;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Returns true if there's daily AI-generation quota left, and reserves `amount` of it. */
async function tryReserveAIQuota(amount) {
  if (amount <= 0) {
    return true; // nothing to generate, no quota needed
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ref = db.collection('meta').doc('ai_usage_' + today);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists ? (doc.data().count || 0) : 0;
    if (current >= MAX_AI_GENERATIONS_PER_DAY) {
      return false;
    }
    tx.set(ref, { count: current + amount }, { merge: true });
    return true;
  });
}

app.listen(PORT, () => {
  console.log('EduAI backend listening on port', PORT);
});
                 
