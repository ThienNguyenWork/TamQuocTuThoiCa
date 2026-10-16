import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  matchedKnowledgeIds: string[];
  answerStatus: 'grounded' | 'unsupported' | 'clarification' | 'error';
  matchScore: number | null;
}

export interface SupabaseStatus {
  connected: boolean;
  urlConfigured: boolean;
  keyConfigured: boolean;
  message: string;
  mode: 'supabase' | 'in_memory_fallback';
}

// In-memory fallback structures for when Supabase is not configured or temporarily unreachable
interface InMemorySession {
  id: string;
  sessionTokenHash: string;
  createdAt: string;
  lastActivityAt: string;
}

interface InMemoryUnanswered {
  id: string;
  question: string;
  normalizedQuestion: string;
  occurrenceCount: number;
  createdAt: string;
  lastSeenAt: string;
  status: 'pending' | 'reviewed' | 'resolved';
  reason?: string;
}

interface InMemoryFeedback {
  id: string;
  messageId: string;
  feedbackType: 'helpful' | 'not_helpful';
  createdAt: string;
}

class DatabaseService {
  private client: SupabaseClient | null = null;
  private isConfigured: boolean = false;
  private isConnected: boolean = false;
  private connectionError: string | null = null;

  // In-memory fallback caches
  private memorySessions: Map<string, InMemorySession> = new Map();
  private memoryMessages: Map<string, ChatMessageRecord[]> = new Map();
  private memoryUnanswered: Map<string, InMemoryUnanswered> = new Map();
  private memoryFeedback: InMemoryFeedback[] = [];

  constructor() {
    this.initSupabase();
  }

  private initSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey && !supabaseUrl.includes('your-project-ref')) {
      try {
        this.client = createClient(supabaseUrl, supabaseKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        });
        this.isConfigured = true;
        // Verify connectivity asynchronously
        this.testConnection();
      } catch (err) {
        this.isConfigured = false;
        this.connectionError = err instanceof Error ? err.message : String(err);
        console.warn('[Supabase] Failed to initialize client:', this.connectionError);
      }
    } else {
      this.isConfigured = false;
      this.connectionError = 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured in environment.';
      console.log('[Supabase] Running in local in-memory persistence mode (Supabase credentials not yet configured).');
    }
  }

  public async testConnection(): Promise<boolean> {
    if (!this.client || !this.isConfigured) {
      this.isConnected = false;
      return false;
    }
    try {
      // Test read from chat_sessions limit 1
      const { error } = await this.client.from('chat_sessions').select('id').limit(1);
      if (error) {
        // Table may not exist yet or permissions issue
        this.isConnected = false;
        this.connectionError = `Supabase query check: ${error.message} (Code: ${error.code})`;
        console.warn('[Supabase] Connection check returned error:', this.connectionError);
        return false;
      }
      this.isConnected = true;
      this.connectionError = null;
      console.log('[Supabase] Successfully connected to Supabase PostgreSQL database.');
      return true;
    } catch (err) {
      this.isConnected = false;
      this.connectionError = err instanceof Error ? err.message : String(err);
      console.warn('[Supabase] Connection test failed:', this.connectionError);
      return false;
    }
  }

  public async getStatus(): Promise<SupabaseStatus> {
    const urlConfigured = !!process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('your-project-ref');
    const keyConfigured = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

    if (this.isConfigured && this.client) {
      const active = await this.testConnection();
      return {
        connected: active,
        urlConfigured,
        keyConfigured,
        message: active
          ? 'Kết nối Supabase PostgreSQL thành công. Dữ liệu đang được đồng bộ thời gian thực.'
          : `Đã cấu hình Supabase nhưng kiểm tra bảng chưa hoàn tất: ${this.connectionError || 'Vui lòng chạy file migration SQL'}`,
        mode: active ? 'supabase' : 'in_memory_fallback',
      };
    }

    return {
      connected: false,
      urlConfigured,
      keyConfigured,
      message: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Ứng dụng đang lưu trữ phiên hội thoại trong bộ nhớ đệm an toàn.',
      mode: 'in_memory_fallback',
    };
  }

  public async getOrCreateSession(sessionTokenHash: string): Promise<{ id: string; isNew: boolean }> {
    const now = new Date().toISOString();

    if (this.isConfigured && this.client) {
      try {
        // Check if exists
        const { data: existing, error: selectError } = await this.client
          .from('chat_sessions')
          .select('id')
          .eq('session_token_hash', sessionTokenHash)
          .maybeSingle();

        if (existing && !selectError) {
          // Update last_activity_at
          await this.client
            .from('chat_sessions')
            .update({ last_activity_at: now })
            .eq('id', existing.id);

          return { id: existing.id, isNew: false };
        }

        // Create new session
        const newId = crypto.randomUUID();
        const { data: inserted, error: insertError } = await this.client
          .from('chat_sessions')
          .insert({
            id: newId,
            session_token_hash: sessionTokenHash,
            created_at: now,
            last_activity_at: now,
          })
          .select('id')
          .single();

        if (insertError) {
          console.warn('[Supabase] Insert session error, using fallback:', insertError.message);
        } else if (inserted) {
          return { id: inserted.id, isNew: true };
        }
      } catch (err) {
        console.warn('[Supabase] Session query failed, using in-memory session:', err);
      }
    }

    // In-memory fallback
    for (const [id, sess] of this.memorySessions.entries()) {
      if (sess.sessionTokenHash === sessionTokenHash) {
        sess.lastActivityAt = now;
        return { id, isNew: false };
      }
    }

    const fallbackId = crypto.randomUUID();
    this.memorySessions.set(fallbackId, {
      id: fallbackId,
      sessionTokenHash,
      createdAt: now,
      lastActivityAt: now,
    });
    this.memoryMessages.set(fallbackId, []);
    return { id: fallbackId, isNew: true };
  }

  public async saveChatMessage(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    matchedKnowledgeIds?: string[];
    answerStatus: 'grounded' | 'unsupported' | 'clarification' | 'error';
    matchScore?: number | null;
  }): Promise<{ id: string; createdAt: string }> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const matchedIds = params.matchedKnowledgeIds || [];
    const score = params.matchScore ?? null;

    if (this.isConfigured && this.client) {
      try {
        const { data, error } = await this.client
          .from('chat_messages')
          .insert({
            id,
            session_id: params.sessionId,
            role: params.role,
            content: params.content,
            created_at: createdAt,
            matched_knowledge_ids: matchedIds,
            answer_status: params.answerStatus,
            match_score: score,
          })
          .select('id, created_at')
          .single();

        if (!error && data) {
          return { id: data.id, createdAt: data.created_at };
        }
        console.warn('[Supabase] Message insert failed:', error?.message);
      } catch (err) {
        console.warn('[Supabase] Exception saving chat message:', err);
      }
    }

    // In-memory fallback
    const msgRecord: ChatMessageRecord = {
      id,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      createdAt,
      matchedKnowledgeIds: matchedIds,
      answerStatus: params.answerStatus,
      matchScore: score,
    };

    const sessionList = this.memoryMessages.get(params.sessionId) || [];
    sessionList.push(msgRecord);
    this.memoryMessages.set(params.sessionId, sessionList);

    return { id, createdAt };
  }

  public async recordUnansweredQuestion(
    question: string,
    normalizedQuestion: string,
    reason?: string
  ): Promise<boolean> {
    const now = new Date().toISOString();

    if (this.isConfigured && this.client) {
      try {
        // Try calling RPC function if created
        const { error: rpcError } = await this.client.rpc('record_unanswered_question', {
          p_question: question,
          p_normalized: normalizedQuestion,
          p_reason: reason || 'Not sufficiently matched with verified knowledge base',
        });

        if (!rpcError) {
          return true;
        }

        // Fallback to table upsert if RPC not present
        const { data: existing } = await this.client
          .from('unanswered_questions')
          .select('id, occurrence_count')
          .eq('normalized_question', normalizedQuestion)
          .maybeSingle();

        if (existing) {
          await this.client
            .from('unanswered_questions')
            .update({
              occurrence_count: (existing.occurrence_count || 1) + 1,
              last_seen_at: now,
              question,
              reason: reason || 'Not matched with verified knowledge base',
            })
            .eq('id', existing.id);
        } else {
          await this.client.from('unanswered_questions').insert({
            id: crypto.randomUUID(),
            question,
            normalized_question: normalizedQuestion,
            occurrence_count: 1,
            created_at: now,
            last_seen_at: now,
            status: 'pending',
            reason: reason || 'Not matched with verified knowledge base',
          });
        }
        return true;
      } catch (err) {
        console.warn('[Supabase] Error recording unanswered question:', err);
      }
    }

    // In-memory fallback
    const existingMemory = this.memoryUnanswered.get(normalizedQuestion);
    if (existingMemory) {
      existingMemory.occurrenceCount += 1;
      existingMemory.lastSeenAt = now;
      existingMemory.question = question;
      if (reason) existingMemory.reason = reason;
    } else {
      this.memoryUnanswered.set(normalizedQuestion, {
        id: crypto.randomUUID(),
        question,
        normalizedQuestion,
        occurrenceCount: 1,
        createdAt: now,
        lastSeenAt: now,
        status: 'pending',
        reason,
      });
    }
    return true;
  }

  public async saveFeedback(messageId: string, feedbackType: 'helpful' | 'not_helpful'): Promise<boolean> {
    const now = new Date().toISOString();

    if (this.isConfigured && this.client) {
      try {
        const { error } = await this.client.from('answer_feedback').insert({
          id: crypto.randomUUID(),
          message_id: messageId,
          feedback_type: feedbackType,
          created_at: now,
        });
        if (!error) return true;
        console.warn('[Supabase] Feedback insert error:', error.message);
      } catch (err) {
        console.warn('[Supabase] Exception saving feedback:', err);
      }
    }

    // In-memory fallback
    this.memoryFeedback.push({
      id: crypto.randomUUID(),
      messageId,
      feedbackType,
      createdAt: now,
    });
    return true;
  }

  public async getSessionMessages(sessionId: string): Promise<ChatMessageRecord[]> {
    if (this.isConfigured && this.client) {
      try {
        const { data, error } = await this.client
          .from('chat_messages')
          .select('id, session_id, role, content, created_at, matched_knowledge_ids, answer_status, match_score')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true });

        if (!error && data) {
          return data.map((d) => ({
            id: d.id,
            sessionId: d.session_id,
            role: d.role,
            content: d.content,
            createdAt: d.created_at,
            matchedKnowledgeIds: d.matched_knowledge_ids || [],
            answerStatus: d.answer_status,
            matchScore: d.match_score !== null ? Number(d.match_score) : null,
          }));
        }
      } catch (err) {
        console.warn('[Supabase] Exception fetching session messages:', err);
      }
    }

    return this.memoryMessages.get(sessionId) || [];
  }
}

export const dbService = new DatabaseService();
