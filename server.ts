import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defaultKnowledgeManager } from './src/server/knowledgeManager.js';
import { dbService } from './src/server/supabaseClient.js';
import { defaultGeminiService, detectSalutation, UserSalutation } from './src/server/geminiService.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Simple in-memory rate limiting map: ipOrToken -> { count, resetTime }
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 25;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  entry.count += 1;
  return true;
}

// Session helper: Extract or create session token and compute secure hash
function getSessionToken(req: Request, res: Response): { token: string; tokenHash: string } {
  let token = req.cookies?.ngan_nhi_session_token || req.headers['x-session-token'];
  if (!token || typeof token !== 'string' || token.length < 16) {
    token = crypto.randomUUID() + '-' + crypto.randomBytes(8).toString('hex');
    // Set HTTP-only cookie with SameSite protection
    res.cookie('ngan_nhi_session_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

// ==============================================================================
// BACKEND API ENDPOINTS
// ==============================================================================

// 1. System Health & Diagnostic Status
app.get('/api/health', async (_req: Request, res: Response) => {
  const kbStatus = defaultKnowledgeManager.getStatus();
  const dbStatus = await dbService.getStatus();
  const geminiStatus = defaultGeminiService.getStatus();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    knowledgeBase: {
      totalEntries: kbStatus.totalEntries,
      hasErrors: kbStatus.hasErrors,
      errors: kbStatus.errors,
      categories: kbStatus.categories,
    },
    database: dbStatus,
    gemini: geminiStatus,
  });
});

// 2. Initialize or verify session
app.get('/api/session', async (req: Request, res: Response) => {
  const { token, tokenHash } = getSessionToken(req, res);
  const session = await dbService.getOrCreateSession(tokenHash);

  res.json({
    sessionId: session.id,
    sessionToken: token,
    isNew: session.isNew,
  });
});

// 3. Knowledge base summary & categories for suggestions
app.get('/api/knowledge/summary', (_req: Request, res: Response) => {
  const entries = defaultKnowledgeManager.getEntries();
  const summary = entries.map((e) => ({
    id: e.id,
    category: e.category,
    question: e.question,
    keywords: e.keywords,
  }));
  res.json({
    count: entries.length,
    entries: summary,
  });
});

// 4. Reload Knowledge base from disk
app.post('/api/knowledge/reload', (_req: Request, res: Response) => {
  const result = defaultKnowledgeManager.reloadKnowledge();
  res.json(result);
});

// 4b. Get Supabase Migration SQL
app.get('/api/migration/sql', (_req: Request, res: Response) => {
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261016000000_init_ngan_nhi.sql');
  try {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    res.json({ sql, projectUrl: process.env.SUPABASE_URL || '' });
  } catch (err) {
    res.status(500).json({ error: 'Migration file not found.' });
  }
});

// 5. Chat History for current session
app.get('/api/chat/history', async (req: Request, res: Response) => {
  const { tokenHash } = getSessionToken(req, res);
  const session = await dbService.getOrCreateSession(tokenHash);
  const messages = await dbService.getSessionMessages(session.id);
  res.json({ messages });
});

// 6. Submit User Question & Receive Grounded Persona Answer
app.post('/api/chat', async (req: Request, res: Response) => {
  const { token, tokenHash } = getSessionToken(req, res);

  // Rate Limiting
  const rateLimitKey = `${req.ip}_${tokenHash}`;
  if (!checkRateLimit(rateLimitKey)) {
    res.status(429).json({
      error: 'Quý đại hiệp đang gửi câu hỏi quá nhanh. Vui lòng đợi giây lát rồi thử lại nhé!',
    });
    return;
  }

  const { question, preferredSalutation } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    res.status(400).json({ error: 'Nội dung câu hỏi không được để trống.' });
    return;
  }

  const cleanQuestion = question.trim().slice(0, 1000);
  const salutation: UserSalutation = detectSalutation(cleanQuestion, preferredSalutation);

  // Retrieve session
  const session = await dbService.getOrCreateSession(tokenHash);

  // Step 1: Save User Question to Database
  await dbService.saveChatMessage({
    sessionId: session.id,
    role: 'user',
    content: cleanQuestion,
    answerStatus: 'grounded',
  });

  // Step 2: Search Verified Knowledge Base
  const searchResults = defaultKnowledgeManager.search(cleanQuestion, 3);
  const MATCH_THRESHOLD = 0.38; // Configurable relevance threshold

  const validMatches = searchResults.filter((r) => r.score >= MATCH_THRESHOLD);
  const isGrounded = validMatches.length > 0;
  const topMatch = searchResults[0];
  const matchScore = topMatch ? topMatch.score : 0;
  const matchedEntries = validMatches.map((m) => m.entry);
  const matchedIds = matchedEntries.map((m) => m.id);

  // Step 3: Answer Generation via Gemini or Persona Fallback
  let assistantAnswer = '';
  let usedGemini = false;

  if (isGrounded) {
    const result = await defaultGeminiService.generateGroundedAnswer({
      userQuestion: cleanQuestion,
      salutation,
      matchedEntries,
    });
    assistantAnswer = result.answer;
    usedGemini = result.usedGemini;
  } else {
    // Record unanswered question to database
    const normalized = cleanQuestion
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    await dbService.recordUnansweredQuestion(
      cleanQuestion,
      normalized,
      `Match score ${matchScore.toFixed(3)} below threshold ${MATCH_THRESHOLD}`
    );

    const result = await defaultGeminiService.generateGroundedAnswer({
      userQuestion: cleanQuestion,
      salutation,
      matchedEntries: [],
    });
    assistantAnswer = result.answer;
  }

  // Step 4: Save Assistant Response to Database
  const savedAssistantMsg = await dbService.saveChatMessage({
    sessionId: session.id,
    role: 'assistant',
    content: assistantAnswer,
    matchedKnowledgeIds: matchedIds,
    answerStatus: isGrounded ? 'grounded' : 'unsupported',
    matchScore: Number(matchScore.toFixed(4)),
  });

  res.json({
    messageId: savedAssistantMsg.id,
    role: 'assistant',
    content: assistantAnswer,
    createdAt: savedAssistantMsg.createdAt,
    matchedKnowledge: matchedEntries.map((e) => ({
      id: e.id,
      category: e.category,
      question: e.question,
      source: e.source,
      lastUpdated: e.lastUpdated,
    })),
    answerStatus: isGrounded ? 'grounded' : 'unsupported',
    matchScore,
    salutation,
    usedGemini,
  });
});

// 7. Feedback endpoint
app.post('/api/chat/feedback', async (req: Request, res: Response) => {
  const { messageId, feedbackType } = req.body;
  if (!messageId || !['helpful', 'not_helpful'].includes(feedbackType)) {
    res.status(400).json({ error: 'Invalid feedback parameters.' });
    return;
  }

  const success = await dbService.saveFeedback(messageId, feedbackType);
  res.json({ success });
});

// ==============================================================================
// VITE INTEGRATION (DEV & PROD)
// ==============================================================================
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production static serving
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Ngân Nhi AI Assistant server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
