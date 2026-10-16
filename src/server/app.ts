import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defaultKnowledgeManager } from './knowledgeManager.js';
import { dbService } from './supabaseClient.js';
import { defaultGeminiService, detectSalutation, UserSalutation } from './geminiService.js';
import { classifyUserIntent } from './intentClassifier.js';

dotenv.config();

export const app = express();
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// In-memory rate limiter per IP/Session: max 25 req / min
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 25;

export function checkRateLimit(key: string): boolean {
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
export function getSessionToken(req: Request, res: Response): { token: string; tokenHash: string } {
  let token = req.cookies?.ngan_nhi_session_token || (req.headers['x-session-token'] as string | undefined);
  if (!token || typeof token !== 'string' || token.length < 16) {
    token = crypto.randomUUID() + '-' + crypto.randomBytes(8).toString('hex');
    res.cookie('ngan_nhi_session_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

// ==============================================================================
// 1. Health & Database Status Endpoints
// ==============================================================================
app.get('/api/health', async (req: Request, res: Response) => {
  const forceRecheck = req.query.recheck === 'true';
  const kbStatus = defaultKnowledgeManager.getStatus();
  const dbStatus = await dbService.getStatus(forceRecheck);
  const geminiStatus = defaultGeminiService.getStatus();

  res.status(200).json({
    status: 'ok',
    message: 'Ngan Nhi Tam Quoc Tu Thoi Ca Backend is running',
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

app.get('/api/supabase/status', async (req: Request, res: Response) => {
  const forceRecheck = req.query.recheck === 'true';
  const dbStatus = await dbService.getStatus(forceRecheck);
  res.json(dbStatus);
});

app.post('/api/supabase/check', async (_req: Request, res: Response) => {
  const dbStatus = await dbService.getStatus(true);
  res.json(dbStatus);
});

app.get('/api/supabase/migration-sql', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(dbService.getMigrationSql());
});

// ==============================================================================
// 2. Session Endpoint: /api/session
// ==============================================================================
app.get('/api/session', async (req: Request, res: Response) => {
  const { token, tokenHash } = getSessionToken(req, res);
  const session = await dbService.getOrCreateSession(tokenHash);

  res.json({
    sessionId: session.id,
    sessionToken: token,
    isNew: session.isNew,
  });
});

// ==============================================================================
// 3. History Endpoints: /api/history & /api/chat/history
// Only returns conversation history for the current session token (session isolation)
// ==============================================================================
const handleHistory = async (req: Request, res: Response) => {
  const { tokenHash } = getSessionToken(req, res);
  const session = await dbService.getOrCreateSession(tokenHash);
  const messages = await dbService.getSessionMessages(session.id);
  res.json({ messages });
};

app.get('/api/history', handleHistory);
app.get('/api/chat/history', handleHistory);

// ==============================================================================
// 4. Chat Endpoint: /api/chat
// ==============================================================================
app.post('/api/chat', async (req: Request, res: Response) => {
  const { token, tokenHash } = getSessionToken(req, res);

  const rateLimitKey = `${req.ip || 'anon'}_${tokenHash}`;
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

  const session = await dbService.getOrCreateSession(tokenHash);

  // 1. Save user question
  await dbService.saveChatMessage({
    sessionId: session.id,
    role: 'user',
    content: cleanQuestion,
    answerStatus: 'grounded',
  });

  // 1. Intent Classification: Greetings, Social Conversation, and Clarifications
  const intentResult = classifyUserIntent(cleanQuestion, salutation);

  if (intentResult.isSocial && intentResult.directAnswer) {
    const assistantAnswer = intentResult.directAnswer;

    // Save assistant response to chat_messages (social interactions are NOT unanswered questions)
    const savedAssistantMsg = await dbService.saveChatMessage({
      sessionId: session.id,
      role: 'assistant',
      content: assistantAnswer,
      matchedKnowledgeIds: [],
      answerStatus: 'grounded',
      matchScore: 1.0,
    });

    res.json({
      messageId: savedAssistantMsg.id,
      role: 'assistant',
      content: assistantAnswer,
      createdAt: savedAssistantMsg.createdAt,
      matchedKnowledge: [],
      answerStatus: 'grounded',
      matchScore: 1.0,
      salutation,
      usedGemini: false,
      intent: intentResult.intent,
    });
    return;
  }

  // 2. Search verified knowledge base for game questions
  const searchResults = defaultKnowledgeManager.search(cleanQuestion, 3);
  const MATCH_THRESHOLD = 0.35;

  const validMatches = searchResults.filter((r) => r.score >= MATCH_THRESHOLD);
  const isGrounded = validMatches.length > 0;
  const topMatch = searchResults[0];
  const matchScore = topMatch ? topMatch.score : 0;
  const matchedEntries = validMatches.map((m) => m.entry);
  const matchedIds = matchedEntries.map((m) => m.id);

  // 3. Generate grounded response or honest unsupported notice
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
    // Genuine game question without verified answer
    const userPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'anh/chị';

    const normalized = cleanQuestion
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    const dbResult = await dbService.recordUnansweredQuestion(
      cleanQuestion,
      normalized,
      `Match score ${matchScore.toFixed(3)} below threshold ${MATCH_THRESHOLD}`
    );

    let fallbackText = `Dạ, hiện tại em chưa có đủ thông tin đã kiểm chứng để trả lời chính xác câu hỏi này. Em không muốn cung cấp thông tin sai cho ${userPronoun} ạ.`;
    if (dbResult && dbResult.isDatabasePersisted) {
      fallbackText += `\n\n(Câu hỏi của ${userPronoun} đã được hệ thống ghi nhận lại để kiểm tra và cập nhật sau ạ).`;
    }
    assistantAnswer = fallbackText;
  }

  // 4. Save assistant response
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
    intent: 'game_question',
  });
});

// ==============================================================================
// 5. Feedback Endpoints: /api/chat/feedback & /api/feedback
// ==============================================================================
const handleFeedback = async (req: Request, res: Response) => {
  const { messageId, feedbackType } = req.body;
  if (!messageId || !['helpful', 'not_helpful'].includes(feedbackType)) {
    res.status(400).json({ error: 'Invalid feedback parameters.' });
    return;
  }

  const success = await dbService.saveFeedback(messageId, feedbackType);
  res.json({ success });
};

app.post('/api/chat/feedback', handleFeedback);
app.post('/api/feedback', handleFeedback);

// ==============================================================================
// 6. Knowledge Summary & Reload
// ==============================================================================
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

app.post('/api/knowledge/reload', (_req: Request, res: Response) => {
  const result = defaultKnowledgeManager.reloadKnowledge();
  res.json(result);
});

// ==============================================================================
// 7. Migration SQL
// ==============================================================================
app.get('/api/migration/sql', (_req: Request, res: Response) => {
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261016000000_init_ngan_nhi.sql');
  try {
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      res.json({ sql, projectUrl: process.env.SUPABASE_URL || '' });
      return;
    }
  } catch (err) {
    // fallback
  }
  res.json({
    sql: '-- Run the migration from supabase/migrations/20261016000000_init_ngan_nhi.sql in Supabase SQL editor',
    projectUrl: process.env.SUPABASE_URL || '',
  });
});

export default app;
