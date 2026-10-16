/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Sparkles,
  BookOpen,
  Database,
  ThumbsUp,
  ThumbsDown,
  Copy,
  Check,
  RefreshCw,
  Info,
  ShieldCheck,
  HelpCircle,
  X,
  Compass,
  Scroll
} from 'lucide-react';

interface KnowledgeRef {
  id: string;
  category: string;
  question: string;
  source?: string;
  lastUpdated?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  matchedKnowledge?: KnowledgeRef[];
  answerStatus?: 'grounded' | 'unsupported' | 'clarification' | 'error';
  matchScore?: number | null;
  feedback?: 'helpful' | 'not_helpful';
}

interface SystemHealth {
  status: string;
  knowledgeBase: {
    totalEntries: number;
    hasErrors: boolean;
    errors: string[];
    categories: string[];
  };
  database: {
    connected: boolean;
    urlConfigured: boolean;
    keyConfigured: boolean;
    message: string;
    mode: 'supabase' | 'in_memory_fallback';
  };
  gemini: {
    configured: boolean;
    model: string;
  };
}

const NGAN_NHI_AVATAR = '/src/assets/images/ngan_nhi_avatar_1792130055214.jpg';
const NGAN_NHI_BANNER = '/src/assets/images/ngan_nhi_banner_1792130055936.jpg';

const QUICK_PROMPTS = [
  {
    title: 'Đội hình tân thủ',
    query: 'Người mới nên xây dựng đội hình như thế nào?',
    category: 'Chiến thuật',
  },
  {
    title: 'Cơ chế Tứ Thời',
    query: 'Cơ chế Tứ Thời (Xuân, Hạ, Thu, Đông) hoạt động như thế nào?',
    category: 'Cơ chế game',
  },
  {
    title: 'Cày KNB miễn phí',
    query: 'Làm sao để kiếm Kim Nguyên Bảo (KNB) miễn phí hiệu quả nhất?',
    category: 'Tài nguyên',
  },
  {
    title: 'Top võ tướng',
    query: 'Những tướng nào mạnh nhất đáng nuôi trong giai đoạn đầu và giữa game?',
    category: 'Võ tướng',
  },
  {
    title: 'Mã Giftcode',
    query: 'Cách nhập Giftcode và các mã tân thủ mới nhất của game là gì?',
    category: 'Quà tặng',
  },
  {
    title: 'Gia nhập Bang Hội',
    query: 'Tham gia Bang Hội (Quân Đoàn) mang lại những lợi ích gì?',
    category: 'Bang hội',
  },
];

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [salutation, setSalutation] = useState<'auto' | 'anh' | 'chi' | 'neutral'>('auto');
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load session, system health, and history on mount
  useEffect(() => {
    fetchHealth();
    fetchHistory();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setSystemHealth(data);
      }
    } catch (err) {
      console.warn('Failed to load system health:', err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/chat/history');
      if (res.ok) {
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          setMessages(
            data.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt,
              matchedKnowledge: m.matchedKnowledgeIds?.map((id: string) => ({
                id,
                category: 'Kiểm duyệt',
                question: 'Mục tri thức đã duyệt',
              })),
              answerStatus: m.answerStatus,
              matchScore: m.matchScore,
            }))
          );
        } else {
          // Default initial friendly greeting from Ngân Nhi
          setMessages([
            {
              id: 'welcome_01',
              role: 'assistant',
              content:
                'Dạ, Ngân Nhi xin kính chào quý huynh đệ tỷ muội đã ghé thăm Tam Quốc Tứ Thời Ca!\n\nEm là trợ thủ AI đồng hành, được trang bị cẩm nang tri thức chiến lược đã qua kiểm duyệt kỹ lưỡng. Huynh tỷ cần tham khảo về cách xếp đội hình tân thủ, cơ chế bốn mùa Xuân Hạ Thu Đông, mẹo cày Kim Nguyên Bảo, hay mã Giftcode... cứ nhắn hỏi em nhé!',
              createdAt: new Date().toISOString(),
              answerStatus: 'grounded',
            },
          ]);
        }
      }
    } catch (err) {
      console.warn('Failed to load history:', err);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text || isLoading) return;

    setErrorMessage(null);
    setInputText('');

    const userMsgId = 'user_' + Date.now();
    const tempUserMsg: Message = {
      id: userMsgId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempUserMsg]);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: text,
          preferredSalutation: salutation === 'auto' ? undefined : salutation,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Lỗi máy chủ (${res.status})`);
      }

      const data = await res.json();

      const assistantMsg: Message = {
        id: data.messageId,
        role: 'assistant',
        content: data.content,
        createdAt: data.createdAt,
        matchedKnowledge: data.matchedKnowledge,
        answerStatus: data.answerStatus,
        matchScore: data.matchScore,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const msg = err.message || 'Không thể kết nối đến máy chủ. Xin vui lòng thử lại.';
      setErrorMessage(msg);
      setMessages((prev) => [
        ...prev,
        {
          id: 'err_' + Date.now(),
          role: 'assistant',
          content: `Dạ thưa quý đại hiệp, hệ thống tạm thời gặp trục trặc kỹ thuật (${msg}). Ngân Nhi xin cáo lỗi và mong quý đại hiệp thử lại sau giây lát ạ.`,
          createdAt: new Date().toISOString(),
          answerStatus: 'error',
        },
      ]);
    } finally {
      setIsLoading(false);
      // Refresh health info to reflect new logs/counts
      fetchHealth();
    }
  };

  const handleFeedback = async (messageId: string, feedbackType: 'helpful' | 'not_helpful') => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, feedback: feedbackType } : m))
    );

    try {
      await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, feedbackType }),
      });
    } catch (err) {
      console.warn('Failed to submit feedback:', err);
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const formatMessageText = (content: string) => {
    // Process markdown-like formatting simply and cleanly
    return content.split('\n').map((line, idx) => {
      if (!line.trim()) {
        return <div key={idx} className="h-2" />;
      }

      // Format bold text
      const parts = line.split(/(\*\*.*?\*\*)/g);
      return (
        <p key={idx} className="leading-relaxed">
          {parts.map((part, pIdx) => {
            if (part.startsWith('**') && part.endsWith('**')) {
              return (
                <strong key={pIdx} className="font-semibold text-amber-200">
                  {part.slice(2, -2)}
                </strong>
              );
            }
            if (part.startsWith('- ') || part.startsWith('• ')) {
              return (
                <span key={pIdx} className="block pl-3 text-stone-200">
                  • {part.slice(2)}
                </span>
              );
            }
            return part;
          })}
        </p>
      );
    });
  };

  return (
    <div className="flex flex-col min-h-screen bg-stone-950 text-stone-100 font-sans selection:bg-amber-600/30 selection:text-amber-200">
      {/* Top Bar Header */}
      <header className="sticky top-0 z-30 border-b border-stone-800/80 bg-stone-950/90 backdrop-blur-md px-4 sm:px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          {/* Brand & Persona Identifier */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <img
                src={NGAN_NHI_AVATAR}
                alt="Ngân Nhi - Tam Quốc Tứ Thời Ca"
                className="w-10 h-10 rounded-full object-cover ring-2 ring-amber-500/50 shadow-md shadow-amber-900/30"
                referrerPolicy="no-referrer"
              />
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full ring-2 ring-stone-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-lg font-bold tracking-wide text-amber-300">
                  Ngân Nhi
                </h1>
                <span className="text-xs px-2 py-0.5 rounded bg-amber-950/60 text-amber-400 border border-amber-800/50 font-medium">
                  Tam Quốc Tứ Thời Ca
                </span>
              </div>
              <p className="text-xs text-stone-400">
                Trợ thủ AI · Cơ sở tri thức đã kiểm duyệt
              </p>
            </div>
          </div>

          {/* Controls & Status Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Salutation Preference Toggle */}
            <div className="hidden sm:flex items-center gap-1 bg-stone-900 border border-stone-800 rounded-lg p-1 text-xs">
              <span className="text-stone-400 px-2 py-1 select-none">Xưng hô:</span>
              {(['auto', 'anh', 'chi'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSalutation(mode)}
                  className={`px-2 py-1 rounded transition-colors ${
                    salutation === mode
                      ? 'bg-amber-600/30 text-amber-300 border border-amber-600/40 font-medium'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  {mode === 'auto' ? 'Tự động' : mode === 'anh' ? 'Anh' : 'Chị'}
                </button>
              ))}
            </div>

            {/* System Info / Status Modal Button */}
            <button
              onClick={() => setShowInfoModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-800 bg-stone-900 hover:bg-stone-800 hover:border-amber-700/50 text-stone-300 hover:text-amber-300 text-xs transition-all shadow-sm"
              title="Xem kiến trúc tri thức và trạng thái Supabase"
            >
              <Database className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden md:inline">Hệ Thống</span>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-between">
        {/* Banner Card shown at start */}
        {messages.length <= 1 && (
          <div className="mb-6 rounded-2xl overflow-hidden border border-amber-900/30 bg-stone-900/80 shadow-xl relative">
            <div className="h-40 sm:h-52 w-full overflow-hidden relative">
              <img
                src={NGAN_NHI_BANNER}
                alt="Tam Quốc Tứ Thời Ca"
                className="w-full h-full object-cover object-center filter brightness-90 contrast-105"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/40 to-transparent" />
              <div className="absolute bottom-3 left-4 sm:left-6 right-4 flex items-end justify-between">
                <div>
                  <h2 className="font-display text-xl sm:text-2xl font-bold text-amber-200 tracking-wide drop-shadow-md">
                    Bốn Mùa Chuyển Dịch · Định Bát Hoang
                  </h2>
                  <p className="text-xs sm:text-sm text-stone-300 drop-shadow mt-0.5">
                    Hỏi đáp chiến thuật, trận pháp Tứ Thời và cẩm nang võ tướng chuẩn xác
                  </p>
                </div>
              </div>
            </div>

            {/* Quick Questions Grid */}
            <div className="p-4 sm:p-5 border-t border-stone-800 bg-stone-900/40">
              <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-amber-400 uppercase tracking-wider">
                <Compass className="w-3.5 h-3.5" />
                <span>Câu hỏi thường gặp trong game</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {QUICK_PROMPTS.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => handleSendMessage(p.query)}
                    className="flex flex-col text-left p-3 rounded-xl border border-stone-800 bg-stone-900/80 hover:bg-stone-800 hover:border-amber-500/40 transition-all text-xs group"
                  >
                    <span className="text-[10px] text-amber-500/80 font-medium mb-1">
                      {p.category}
                    </span>
                    <span className="font-medium text-stone-200 group-hover:text-amber-200 line-clamp-2">
                      {p.query}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Message Thread */}
        <div className="flex-1 space-y-6 pb-28">
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            const isGrounded = msg.answerStatus === 'grounded';
            const isUnsupported = msg.answerStatus === 'unsupported';

            return (
              <div
                key={msg.id}
                className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {!isUser && (
                  <img
                    src={NGAN_NHI_AVATAR}
                    alt="Ngân Nhi"
                    className="w-9 h-9 rounded-full object-cover ring-2 ring-amber-500/40 shrink-0 self-start shadow-sm mt-1"
                    referrerPolicy="no-referrer"
                  />
                )}

                <div
                  className={`flex flex-col max-w-[88%] sm:max-w-[78%] ${
                    isUser ? 'items-end' : 'items-start'
                  }`}
                >
                  {/* Sender Name & Meta */}
                  <div className="flex items-center gap-2 text-[11px] text-stone-400 mb-1 px-1">
                    <span className="font-medium">
                      {isUser ? 'Bạn' : 'Ngân Nhi'}
                    </span>
                    <span>·</span>
                    <span>
                      {new Date(msg.createdAt).toLocaleTimeString('vi-VN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {!isUser && isGrounded && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-1.5 py-0.2 rounded">
                        <ShieldCheck className="w-2.5 h-2.5" />
                        Tri thức kiểm duyệt
                      </span>
                    )}
                    {!isUser && isUnsupported && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/90 bg-amber-950/60 border border-amber-800/40 px-1.5 py-0.2 rounded">
                        <HelpCircle className="w-2.5 h-2.5" />
                        Chờ nghiên cứu thêm
                      </span>
                    )}
                  </div>

                  {/* Message Bubble */}
                  <div
                    className={`rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 text-sm sm:text-[14.5px] leading-relaxed shadow-md ${
                      isUser
                        ? 'bg-amber-600/90 text-stone-950 font-medium rounded-tr-none shadow-amber-950/20'
                        : 'bg-stone-900 border border-stone-800/90 text-stone-200 rounded-tl-none shadow-black/40'
                    }`}
                  >
                    <div className="space-y-2">
                      {formatMessageText(msg.content)}
                    </div>

                    {/* Matched Knowledge Citation Box */}
                    {!isUser && msg.matchedKnowledge && msg.matchedKnowledge.length > 0 && (
                      <div className="mt-3 pt-2.5 border-t border-stone-800/80 text-[11px] text-stone-400">
                        <div className="flex items-center gap-1 text-amber-400/90 font-medium mb-1">
                          <BookOpen className="w-3 h-3" />
                          <span>Cơ sở tri thức tham chiếu:</span>
                        </div>
                        <ul className="space-y-1 pl-2">
                          {msg.matchedKnowledge.map((k, kIdx) => (
                            <li key={kIdx} className="flex items-start gap-1.5">
                              <span className="text-amber-500 font-mono">[{k.id}]</span>
                              <span className="text-stone-300">{k.question}</span>
                              {k.source && (
                                <span className="text-stone-500 italic">({k.source})</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Message Action Toolbar (Assistant only) */}
                  {!isUser && (
                    <div className="flex items-center gap-2 mt-1.5 px-1 text-xs text-stone-400">
                      <button
                        onClick={() => handleCopy(msg.content, msg.id)}
                        className="p-1 hover:text-stone-200 transition-colors flex items-center gap-1"
                        title="Sao chép câu trả lời"
                      >
                        {copiedId === msg.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-[11px] text-emerald-400">Đã sao chép</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span className="text-[11px]">Sao chép</span>
                          </>
                        )}
                      </button>

                      <span className="text-stone-600">|</span>

                      <button
                        onClick={() => handleFeedback(msg.id, 'helpful')}
                        className={`p-1 hover:text-amber-300 transition-colors flex items-center gap-1 ${
                          msg.feedback === 'helpful' ? 'text-amber-400 font-medium' : ''
                        }`}
                        title="Hữu ích"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                        <span className="text-[11px]">Hữu ích</span>
                      </button>

                      <button
                        onClick={() => handleFeedback(msg.id, 'not_helpful')}
                        className={`p-1 hover:text-red-300 transition-colors flex items-center gap-1 ${
                          msg.feedback === 'not_helpful' ? 'text-red-400 font-medium' : ''
                        }`}
                        title="Chưa hài lòng"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Typing / Reasoning Indicator */}
          {isLoading && (
            <div className="flex gap-3 items-start">
              <img
                src={NGAN_NHI_AVATAR}
                alt="Ngân Nhi"
                className="w-9 h-9 rounded-full object-cover ring-2 ring-amber-500/40 shrink-0 shadow-sm mt-1"
                referrerPolicy="no-referrer"
              />
              <div className="rounded-2xl rounded-tl-none px-4 py-3 bg-stone-900 border border-stone-800 text-stone-300 text-sm flex items-center gap-2 shadow-md">
                <span className="inline-block w-2 h-2 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="inline-block w-2 h-2 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="inline-block w-2 h-2 bg-amber-400 rounded-full animate-bounce"></span>
                <span className="text-xs text-stone-400 pl-2">
                  Ngân Nhi đang tra cứu cẩm nang và chuẩn bị câu trả lời...
                </span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Floating Bottom Input Area */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-stone-950/95 backdrop-blur-lg border-t border-stone-800/80 px-4 py-3 sm:py-4 shadow-2xl">
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          {/* Mobile Salutation Selector */}
          <div className="flex sm:hidden items-center justify-between text-xs text-stone-400">
            <span>Xưng hô với bạn:</span>
            <div className="flex items-center gap-1 bg-stone-900 border border-stone-800 rounded p-0.5">
              {(['auto', 'anh', 'chi'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSalutation(mode)}
                  className={`px-2 py-0.5 rounded text-[11px] ${
                    salutation === mode
                      ? 'bg-amber-600/30 text-amber-300 font-medium'
                      : 'text-stone-400'
                  }`}
                >
                  {mode === 'auto' ? 'Tự động' : mode === 'anh' ? 'Anh' : 'Chị'}
                </button>
              ))}
            </div>
          </div>

          {/* Input Box Form */}
          <div className="flex items-end gap-2 bg-stone-900/90 border border-stone-800 focus-within:border-amber-500/60 rounded-xl p-1.5 sm:p-2 transition-all shadow-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Hỏi Ngân Nhi về tướng, cách xếp đội hình, bốn mùa Tứ Thời, KNB, Giftcode..."
              className="flex-1 bg-transparent border-0 outline-none resize-none text-stone-100 placeholder-stone-500 text-sm max-h-32 px-2 py-1 leading-normal"
              disabled={isLoading}
            />

            <button
              onClick={() => handleSendMessage()}
              disabled={isLoading || !inputText.trim()}
              className="p-2 sm:px-4 sm:py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 font-medium text-xs flex items-center gap-1.5 transition-all shadow-md shrink-0"
              title="Gửi câu hỏi (Enter)"
            >
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">Gửi</span>
            </button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-stone-500 px-1">
            <span>
              Cơ sở tri thức quản lý qua mã nguồn (<code className="text-amber-500/80">gameKnowledge.json</code>).
            </span>
            <span>Enter để gửi · Shift+Enter xuống dòng</span>
          </div>
        </div>
      </div>

      {/* System Health & Architecture Modal */}
      {showInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-xl w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <Scroll className="w-5 h-5 text-amber-400" />
                <h3 className="font-display text-lg font-bold text-amber-300">
                  Kiến Trúc Hệ Thống Ngân Nhi AI
                </h3>
              </div>
              <button
                onClick={() => setShowInfoModal(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-stone-100 hover:bg-stone-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Architecture Overview */}
            <div className="space-y-4 text-xs sm:text-sm text-stone-300">
              <div className="bg-stone-950/80 p-3.5 rounded-xl border border-stone-800/80 space-y-1.5">
                <div className="flex items-center justify-between font-semibold text-amber-300">
                  <span className="flex items-center gap-1.5">
                    <BookOpen className="w-4 h-4 text-amber-400" />
                    1. Tri thức quản lý qua code (Authoritative Base)
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                    {systemHealth?.knowledgeBase.totalEntries ?? 0} mục đã duyệt
                  </span>
                </div>
                <p className="text-xs text-stone-400">
                  Tất cả câu hỏi & câu trả lời chuẩn xác được lưu trong file{' '}
                  <code className="text-amber-300">src/data/gameKnowledge.json</code>. Khi bạn sửa file này và deploy, kiến thức mới lập tức có hiệu lực mà không cần can thiệp DB thủ công.
                </p>
              </div>

              <div className="bg-stone-950/80 p-3.5 rounded-xl border border-stone-800/80 space-y-2">
                <div className="flex items-center justify-between font-semibold text-amber-300">
                  <span className="flex items-center gap-1.5">
                    <Database className="w-4 h-4 text-amber-400" />
                    2. Supabase PostgreSQL (Lưu trữ hội thoại)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={fetchHealth}
                      className="p-1 text-stone-400 hover:text-amber-300 rounded hover:bg-stone-800"
                      title="Kiểm tra lại kết nối"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <span
                      className={`text-xs px-2 py-0.5 rounded border ${
                        systemHealth?.database.connected
                          ? 'bg-emerald-950 text-emerald-400 border-emerald-800/40'
                          : 'bg-amber-950 text-amber-400 border-amber-800/40'
                      }`}
                    >
                      {systemHealth?.database.connected
                        ? 'Supabase Đã Kết Nối'
                        : 'Credentials OK (Cần Chạy SQL Migration)'}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-stone-400">
                  {systemHealth?.database.message}
                </p>
                <div className="text-[11px] text-stone-400 pt-1 border-t border-stone-800/60 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span>File migration: <code className="text-amber-300">supabase/migrations/20261016000000_init_ngan_nhi.sql</code></span>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/migration/sql');
                          const data = await res.json();
                          if (data.sql) {
                            navigator.clipboard.writeText(data.sql);
                            alert('Đã sao chép toàn bộ mã SQL Migration vào Clipboard! Bạn chỉ cần dán vào Supabase SQL Editor và bấm Run.');
                          }
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                      className="px-2 py-0.5 rounded bg-amber-600/30 hover:bg-amber-600/50 border border-amber-600/50 text-amber-300 text-[10px] font-medium transition-colors"
                    >
                      Sao chép SQL Migration
                    </button>
                  </div>
                  <span className="text-[10px] text-stone-500">
                    Mở Supabase Dashboard &gt; SQL Editor &gt; New Query &gt; Dán mã SQL và bấm "Run" để hoàn tất tạo 4 bảng.
                  </span>
                </div>
              </div>

              <div className="bg-stone-950/80 p-3.5 rounded-xl border border-stone-800/80 space-y-1.5">
                <div className="flex items-center justify-between font-semibold text-amber-300">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    3. Gemini API Grounding (AI chống ảo giác)
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800/40">
                    {systemHealth?.gemini.model || 'gemini-3.8-flash'}
                  </span>
                </div>
                <p className="text-xs text-stone-400">
                  Ngân Nhi chỉ tinh chỉnh diễn đạt câu trả lời theo đúng tôn chỉ nhân vật và xưng hô (anh/chị), hoàn toàn KHÔNG tự bịa đặt cơ chế hoặc chỉ số game chưa được kiểm duyệt.
                </p>
              </div>

              {/* Instructions to publish knowledge */}
              <div className="bg-amber-950/20 border border-amber-800/30 rounded-xl p-3 text-xs space-y-1">
                <div className="font-semibold text-amber-300">
                  Cách thêm hoặc cập nhật câu trả lời mới:
                </div>
                <ol className="list-decimal list-inside space-y-1 text-stone-300 text-[11px]">
                  <li>Mở file <code className="text-amber-200">src/data/gameKnowledge.json</code>.</li>
                  <li>Thêm mục mới với <code className="text-amber-200">id, question, alternativeQuestions, answer, keywords</code>.</li>
                  <li>Commit & Deploy ứng dụng lên Vercel / Cloud Run.</li>
                  <li>Tri thức mới sẽ sẵn sàng ngay lập tức cho mọi người chơi!</li>
                </ol>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowInfoModal(false)}
                className="px-4 py-2 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium"
              >
                Đã hiểu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
