// SQL Migration for Ngan Nhi Tam Quoc Tu Thoi Ca
export const NGAN_NHI_MIGRATION_SQL = `-- ==============================================================================
-- NGAN NHI - TAM QUOC TU THOI CA AI CHATBOT
-- Supabase PostgreSQL Schema & Security Policies
-- Migration: 20261016000000_init_ngan_nhi.sql
-- ==============================================================================

-- 1. Table: chat_sessions
-- Stores anonymous conversation sessions identified securely by session_token_hash
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_token_hash ON chat_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_activity ON chat_sessions(last_activity_at DESC);

-- 2. Table: chat_messages
-- Stores user questions and assistant responses linked to an anonymous session
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    matched_knowledge_ids TEXT[] DEFAULT '{}'::text[],
    answer_status TEXT NOT NULL DEFAULT 'unsupported' CHECK (answer_status IN ('grounded', 'unsupported', 'clarification', 'error')),
    match_score NUMERIC(5, 4) NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at ASC);

-- 3. Table: unanswered_questions
-- Stores questions that could not be answered confidently using the approved knowledge base.
-- Tracks repeated occurrences without unbounded duplicates.
CREATE TABLE IF NOT EXISTS unanswered_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question TEXT NOT NULL,
    normalized_question TEXT NOT NULL UNIQUE,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved')),
    reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_unanswered_normalized ON unanswered_questions(normalized_question);
CREATE INDEX IF NOT EXISTS idx_unanswered_occurrence ON unanswered_questions(occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_unanswered_status ON unanswered_questions(status);

-- 4. Table: answer_feedback
-- Stores user feedback (helpful / not_helpful) for assistant responses
CREATE TABLE IF NOT EXISTS answer_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('helpful', 'not_helpful')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_answer_feedback_message_id ON answer_feedback(message_id);

-- 5. Helper Function: Upsert Unanswered Question
-- Atomically increments occurrence_count and updates last_seen_at when the same normalized question recurs
CREATE OR REPLACE FUNCTION record_unanswered_question(
    p_question TEXT,
    p_normalized TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO unanswered_questions (question, normalized_question, occurrence_count, created_at, last_seen_at, status, reason)
    VALUES (p_question, p_normalized, 1, timezone('utc'::text, now()), timezone('utc'::text, now()), 'pending', p_reason)
    ON CONFLICT (normalized_question)
    DO UPDATE SET
        occurrence_count = unanswered_questions.occurrence_count + 1,
        last_seen_at = timezone('utc'::text, now()),
        question = EXCLUDED.question,
        reason = COALESCE(EXCLUDED.reason, unanswered_questions.reason);
END;
$$ LANGUAGE plpgsql;

-- 6. Row Level Security (RLS) Configuration
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE unanswered_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_feedback ENABLE ROW LEVEL SECURITY;
`;
