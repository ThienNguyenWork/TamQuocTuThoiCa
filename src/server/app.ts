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

// Categorization helper for unanswered game questions
export function categorizeGameQuestion(text: string): string {
  const clean = text.toLowerCase();
  if (/code|giftcode|ma qua|qua tang/i.test(clean)) return 'giftcodes';
  if (/nap|the|tien|sohacoin|chuyen khoan|ngan hang/i.test(clean)) return 'top_ups';
  if (/su kien|event|dua top|sinh nhat|lich trinh|server moi|khi nao ra/i.test(clean)) return 'events';
  if (/doi hinh|build team|xep team|tran phap/i.test(clean)) return 'formations';
  if (/tuong|nhan vat|ssr|hero|co de|quan vu|trieu van|lu bo|tuong than/i.test(clean)) return 'characters';
  if (/loi|lag|mat ket noi|khong vao duoc|mat nick|tai khoan|ho tro|ky thuat/i.test(clean)) return 'technical';
  if (/knb|vang|trang bi|than binh|bang hoi|quan doan|tu thoi|mua|nhiem vu/i.test(clean)) return 'gameplay';
  return 'general';
}

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

  // Retrieve prior session messages for conversational context & follow-ups
  const sessionMessages = await dbService.getSessionMessages(session.id);
  const recentContext = sessionMessages
    .slice(-3)
    .map((m) => m.content)
    .join(' ');

  // 1. Save user question
  await dbService.saveChatMessage({
    sessionId: session.id,
    role: 'user',
    content: cleanQuestion,
    answerStatus: 'grounded',
  });

  // 2. Intent Classification: Greetings, Thanks, Acknowledgments, Social interactions
  const intentResult = classifyUserIntent(cleanQuestion, salutation);

  if (intentResult.isSocial && intentResult.directAnswer) {
    const assistantAnswer = intentResult.directAnswer;

    // Save assistant response to chat_messages (social messages are NEVER recorded as unanswered)
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

  // 3. Search verified knowledge base (using query and recent conversation context)
  const searchResults = defaultKnowledgeManager.search(cleanQuestion, 4, recentContext);
  const MATCH_THRESHOLD = 0.35;

  const validMatches = searchResults.filter((r) => r.score >= MATCH_THRESHOLD);
  const isGrounded = validMatches.length > 0;
  const topMatch = searchResults[0];
  const matchScore = topMatch ? topMatch.score : 0;
  const matchedEntries = validMatches.map((m) => m.entry);
  const matchedIds = matchedEntries.map((m) => m.id);

  // 4. Generate grounded AI response or honest limitation notice
  let assistantAnswer = '';
  let usedGemini = false;

  if (isGrounded) {
    const historyPayload = sessionMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const result = await defaultGeminiService.generateGroundedAnswer({
      userQuestion: cleanQuestion,
      salutation,
      matchedEntries,
      conversationHistory: historyPayload,
    });

    assistantAnswer = result.answer;
    usedGemini = result.usedGemini;
  } else {
    // Genuine game question without verified answer
    const userPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'anh/chị';
    const category = categorizeGameQuestion(cleanQuestion);

    const normalized = cleanQuestion
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Generate an AI draft suggestion for reviewer without treating it as verified fact
    const suggestedDraft = await defaultGeminiService.generateSuggestedAnswer(cleanQuestion, category);

    const dbResult = await dbService.recordUnansweredQuestion({
      question: cleanQuestion,
      normalizedQuestion: normalized,
      category,
      reason: `Chưa có thông tin kiểm chứng trong cẩm nang (Điểm khớp: ${matchScore.toFixed(3)})`,
      suggestedAnswer: suggestedDraft,
    });

    // Provide a helpful, honest explanation from Gemini rather than a repetitive refusal
    const historyPayload = sessionMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const aiFallback = await defaultGeminiService.generateGroundedAnswer({
      userQuestion: cleanQuestion,
      salutation,
      matchedEntries: [],
      conversationHistory: historyPayload,
      isTimeSensitiveOrUnknown: true,
    });

    let fallbackText = aiFallback.answer;
    if (dbResult && dbResult.isDatabasePersisted) {
      fallbackText += `\n\n(Câu hỏi của ${userPronoun} đã được hệ thống lưu vào Supabase để đối chiếu và bổ sung vào cẩm nang tri thức ạ).`;
    } else {
      fallbackText += `\n\n(Câu hỏi của ${userPronoun} đã được ghi nhận trong bộ nhớ tạm để nghiên cứu bổ sung cẩm nang ạ).`;
    }

    assistantAnswer = fallbackText;
    usedGemini = aiFallback.usedGemini;
  }

  // 5. Save assistant response
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
// 5. Unanswered Questions Review Endpoint: /api/knowledge/unanswered
// Allows safe inspection of question gaps and AI suggestions for code-managed updating
// ==============================================================================
app.get('/api/knowledge/unanswered', async (_req: Request, res: Response) => {
  const unanswered = await dbService.getUnansweredQuestions();
  res.json({ count: unanswered.length, unanswered });
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
