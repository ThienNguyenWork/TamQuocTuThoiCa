import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { NGAN_NHI_MIGRATION_SQL } from './migrationSql.js';

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
  statusType: 'connected' | 'tables_pending_migration' | 'credentials_missing' | 'connection_error';
  migrationSql?: string;
  projectRef?: string;
}

export interface UnansweredQuestionRecord {
  id: string;
  question: string;
  normalizedQuestion: string;
  occurrenceCount: number;
  category: string;
  createdAt: string;
  lastSeenAt: string;
  status: 'pending' | 'reviewed' | 'resolved';
  reason?: string;
  suggestedAnswer?: string;
}

// In-memory fallback structures
interface InMemorySession {
  id: string;
  sessionTokenHash: string;
  createdAt: string;
  lastActivityAt: string;
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
  private statusType: 'connected' | 'tables_pending_migration' | 'credentials_missing' | 'connection_error' = 'credentials_missing';
  private connectionError: string | null = null;
  private lastCheckTime: number = 0;
  private isChecking: boolean = false;
  private projectRef: string = '';

  // In-memory fallback caches
  private memorySessions: Map<string, InMemorySession> = new Map();
  private memoryMessages: Map<string, ChatMessageRecord[]> = new Map();
  private memoryUnanswered: Map<string, UnansweredQuestionRecord> = new Map();
  private memoryFeedback: InMemoryFeedback[] = [];

  constructor() {
    this.initSupabase();
  }

  private initSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey && !supabaseUrl.includes('your-project-ref')) {
      try {
        const match = supabaseUrl.match(/https:\/\/([a-z0-9_-]+)\.supabase\.co/i);
        if (match) {
          this.projectRef = match[1];
        }

        this.client = createClient(supabaseUrl, supabaseKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        });
        this.isConfigured = true;
        this.testConnection(true);
      } catch (err) {
        this.isConfigured = false;
        this.statusType = 'connection_error';
        this.connectionError = err instanceof Error ? err.message : String(err);
      }
    } else {
      this.isConfigured = false;
      this.statusType = 'credentials_missing';
      this.connectionError = 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured.';
    }
  }

  public async testConnection(forceRecheck = false): Promise<boolean> {
    if (!this.client || !this.isConfigured) {
      this.isConnected = false;
      this.statusType = 'credentials_missing';
      return false;
    }

    const now = Date.now();
    if (!forceRecheck && now - this.lastCheckTime < 15000) {
      return this.isConnected;
    }

    if (this.isChecking) {
      return this.isConnected;
    }

    this.isChecking = true;
    this.lastCheckTime = now;

    try {
      const { error } = await this.client.from('chat_sessions').select('id').limit(1);

      if (error) {
        if (error.code === 'PGRST205' || error.message?.includes('schema cache') || error.message?.includes('Could not find the table')) {
          this.isConnected = false;
          this.statusType = 'tables_pending_migration';
          this.connectionError = 'Bảng public.chat_sessions chưa được tạo trong Supabase. Cần chạy SQL Migration.';
          return false;
        }

        this.isConnected = false;
        this.statusType = 'connection_error';
        this.connectionError = error.message;
        return false;
      }

      this.isConnected = true;
      this.statusType = 'connected';
      this.connectionError = null;
      return true;
    } catch (err) {
      this.isConnected = false;
      this.statusType = 'connection_error';
      this.connectionError = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      this.isChecking = false;
    }
  }

  public async getStatus(forceRecheck = false): Promise<SupabaseStatus> {
    const urlConfigured = !!process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('your-project-ref');
    const keyConfigured = !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

    if (this.isConfigured && this.client) {
      const active = await this.testConnection(forceRecheck);

      let message = '';
      if (active) {
        message = 'Kết nối Supabase PostgreSQL thành công. Dữ liệu đang được đồng bộ thời gian thực.';
      } else if (this.statusType === 'tables_pending_migration') {
        message = 'Đã kết nối Supabase project, chờ chạy migration SQL để tạo các bảng dữ liệu.';
      } else {
        message = `Kết nối Supabase gặp sự cố: ${this.connectionError || 'Vui lòng kiểm tra lại cấu hình'}`;
      }

      return {
        connected: active,
        urlConfigured,
        keyConfigured,
        message,
        mode: active ? 'supabase' : 'in_memory_fallback',
        statusType: this.statusType,
        migrationSql: NGAN_NHI_MIGRATION_SQL,
        projectRef: this.projectRef,
      };
    }

    return {
      connected: false,
      urlConfigured,
      keyConfigured,
      message: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Ứng dụng đang lưu trữ phiên hội thoại trong bộ nhớ đệm an toàn.',
      mode: 'in_memory_fallback',
      statusType: 'credentials_missing',
      migrationSql: NGAN_NHI_MIGRATION_SQL,
    };
  }

  public getMigrationSql(): string {
    return NGAN_NHI_MIGRATION_SQL;
  }

  public async getOrCreateSession(sessionTokenHash: string): Promise<{ id: string; isNew: boolean }> {
    const now = new Date().toISOString();

    if (this.isConfigured && this.client && this.isConnected) {
      try {
        const { data: existing, error: selectError } = await this.client
          .from('chat_sessions')
          .select('id')
          .eq('session_token_hash', sessionTokenHash)
          .maybeSingle();

        if (existing && !selectError) {
          await this.client
            .from('chat_sessions')
            .update({ last_activity_at: now })
            .eq('id', existing.id);

          return { id: existing.id, isNew: false };
        }

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

        if (!insertError && inserted) {
          return { id: inserted.id, isNew: true };
        }
      } catch {
        // Fall back gracefully
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

    if (this.isConfigured && this.client && this.isConnected) {
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
      } catch {
        // Fall back gracefully
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

  public async recordUnansweredQuestion(params: {
    question: string;
    normalizedQuestion: string;
    category?: string;
    reason?: string;
    suggestedAnswer?: string;
  }): Promise<{ success: boolean; isDatabasePersisted: boolean }> {
    const { question, normalizedQuestion, category = 'general', reason, suggestedAnswer } = params;
    const now = new Date().toISOString();
    const reasonPayload = `[Category: ${category}] ${reason || 'Not in verified knowledge base'}${
      suggestedAnswer ? ` | Suggestion: ${suggestedAnswer.slice(0, 300)}` : ''
    }`;

    if (this.isConfigured && this.client && this.isConnected) {
      try {
        const { error: rpcError } = await this.client.rpc('record_unanswered_question', {
          p_question: question,
          p_normalized: normalizedQuestion,
          p_reason: reasonPayload,
        });

        if (!rpcError) {
          return { success: true, isDatabasePersisted: true };
        }

        const { data: existing, error: selectErr } = await this.client
          .from('unanswered_questions')
          .select('id, occurrence_count')
          .eq('normalized_question', normalizedQuestion)
          .maybeSingle();

        if (!selectErr) {
          if (existing) {
            const { error: updateErr } = await this.client
              .from('unanswered_questions')
              .update({
                occurrence_count: (existing.occurrence_count || 1) + 1,
                last_seen_at: now,
                question,
                reason: reasonPayload,
              })
              .eq('id', existing.id);
            if (!updateErr) {
              return { success: true, isDatabasePersisted: true };
            }
          } else {
            const { error: insertErr } = await this.client.from('unanswered_questions').insert({
              id: crypto.randomUUID(),
              question,
              normalized_question: normalizedQuestion,
              occurrence_count: 1,
              created_at: now,
              last_seen_at: now,
              status: 'pending',
              reason: reasonPayload,
            });
            if (!insertErr) {
              return { success: true, isDatabasePersisted: true };
            }
          }
        }
      } catch {
        // Fall back gracefully
      }
    }

    // In-memory fallback
    const existingMemory = this.memoryUnanswered.get(normalizedQuestion);
    if (existingMemory) {
      existingMemory.occurrenceCount += 1;
      existingMemory.lastSeenAt = now;
      existingMemory.question = question;
      existingMemory.category = category;
      if (reason) existingMemory.reason = reason;
      if (suggestedAnswer) existingMemory.suggestedAnswer = suggestedAnswer;
    } else {
      this.memoryUnanswered.set(normalizedQuestion, {
        id: crypto.randomUUID(),
        question,
        normalizedQuestion,
        occurrenceCount: 1,
        category,
        createdAt: now,
        lastSeenAt: now,
        status: 'pending',
        reason,
        suggestedAnswer,
      });
    }
    return { success: true, isDatabasePersisted: false };
  }

  public async getUnansweredQuestions(): Promise<UnansweredQuestionRecord[]> {
    if (this.isConfigured && this.client && this.isConnected) {
      try {
        const { data, error } = await this.client
          .from('unanswered_questions')
          .select('*')
          .order('occurrence_count', { ascending: false })
          .limit(50);

        if (!error && data) {
          return data.map((d: any) => {
            let cat = 'general';
            let sug: string | undefined = undefined;
            if (d.reason) {
              const catMatch = d.reason.match(/\[Category:\s*([^\]]+)\]/);
              if (catMatch) cat = catMatch[1];
              const sugMatch = d.reason.match(/\|\s*Suggestion:\s*(.+)$/);
              if (sugMatch) sug = sugMatch[1];
            }
            return {
              id: d.id,
              question: d.question,
              normalizedQuestion: d.normalized_question,
              occurrenceCount: d.occurrence_count || 1,
              category: cat,
              createdAt: d.created_at,
              lastSeenAt: d.last_seen_at,
              status: d.status || 'pending',
              reason: d.reason,
              suggestedAnswer: sug,
            };
          });
        }
      } catch {
        // Fall back to memory
      }
    }

    return Array.from(this.memoryUnanswered.values()).sort(
      (a, b) => b.occurrenceCount - a.occurrenceCount
    );
  }

  public async saveFeedback(messageId: string, feedbackType: 'helpful' | 'not_helpful'): Promise<boolean> {
    const now = new Date().toISOString();

    if (this.isConfigured && this.client && this.isConnected) {
      try {
        const { error } = await this.client.from('answer_feedback').insert({
          id: crypto.randomUUID(),
          message_id: messageId,
          feedback_type: feedbackType,
          created_at: now,
        });
        if (!error) return true;
      } catch {
        // Fall back
      }
    }

    this.memoryFeedback.push({
      id: crypto.randomUUID(),
      messageId,
      feedbackType,
      createdAt: now,
    });
    return true;
  }

  public async getSessionMessages(sessionId: string): Promise<ChatMessageRecord[]> {
    if (this.isConfigured && this.client && this.isConnected) {
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
      } catch {
        // Fall back
      }
    }

    return this.memoryMessages.get(sessionId) || [];
  }
}

export const dbService = new DatabaseService();
