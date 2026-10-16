import { GoogleGenAI } from '@google/genai';
import { GameKnowledgeEntry, removeVietnameseAccents } from './knowledgeManager.js';

export type UserSalutation = 'anh' | 'chi' | 'neutral';

export function detectSalutation(text: string, explicitChoice?: string): UserSalutation {
  if (explicitChoice === 'anh') return 'anh';
  if (explicitChoice === 'chi') return 'chi';
  if (explicitChoice === 'neutral') return 'neutral';

  const lower = text.toLowerCase();
  const noAccent = removeVietnameseAccents(lower);

  const hasChi =
    /(?:^|\s|[.,!?])(chị|chị\s+muốn|chị\s+hỏi|chị\s+là|chị\s+cần|chị\s+cảm\s+ơn)(?:$|\s|[.,!?])/i.test(lower) ||
    /\b(chi|chi muon|chi hoi|chi la|chi can|chi cam on)\b/i.test(noAccent);

  const hasAnh =
    /(?:^|\s|[.,!?])(anh|anh\s+muốn|anh\s+hỏi|anh\s+là|anh\s+cần|anh\s+cảm\s+ơn)(?:$|\s|[.,!?])/i.test(lower) ||
    /\b(anh|anh muon|anh hoi|anh la|anh can|anh cam on)\b/i.test(noAccent);

  if (hasChi && !hasAnh) return 'chi';
  if (hasAnh && !hasChi) return 'anh';
  return 'neutral';
}

export function getPersonaOpening(salutation: UserSalutation): string {
  switch (salutation) {
    case 'anh':
      return 'Dạ thưa anh, về vấn đề này em xin giải đáp như sau ạ:';
    case 'chi':
      return 'Dạ thưa chị, về vấn đề này em xin giải đáp như sau ạ:';
    case 'neutral':
    default:
      return 'Dạ, Ngân Nhi xin phép giải đáp thắc mắc này như sau ạ:';
  }
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GroundedAnswerResult {
  answer: string;
  usedGemini: boolean;
  isGrounded: boolean;
  topicCategory?: string;
  suggestedAnswer?: string;
}

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  private isConfigured: boolean = false;

  constructor() {
    this.initClient();
  }

  private initClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
      try {
        this.ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        this.isConfigured = true;
      } catch (err) {
        console.warn('[Gemini] Failed to instantiate GoogleGenAI:', err);
        this.isConfigured = false;
      }
    } else {
      this.isConfigured = false;
    }
  }

  public getStatus() {
    return {
      configured: this.isConfigured,
      model: 'gemini-3.8-flash',
    };
  }

  /**
   * Generates an intelligent, grounded Vietnamese answer using Gemini reasoning,
   * factual knowledge entries, and previous conversation context.
   */
  public async generateGroundedAnswer(params: {
    userQuestion: string;
    salutation: UserSalutation;
    matchedEntries: GameKnowledgeEntry[];
    conversationHistory?: ChatHistoryMessage[];
    isTimeSensitiveOrUnknown?: boolean;
  }): Promise<GroundedAnswerResult> {
    const { userQuestion, salutation, matchedEntries, conversationHistory = [] } = params;
    const openingPhrase = getPersonaOpening(salutation);
    const addressPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'anh/chị';
    const addressPronounCap = salutation === 'anh' ? 'Anh' : salutation === 'chi' ? 'Chị' : 'Anh/chị';

    // When no verified knowledge entries match at all
    if (matchedEntries.length === 0) {
      // If AI is configured, generate a helpful contextual response acknowledging the unknown fact
      if (this.ai && this.isConfigured) {
        try {
          const systemInstruction = `Bạn là Ngân Nhi - nữ mưu sĩ thông thái, trợ thủ AI giải đáp thắc mắc về game chiến thuật Tam Quốc Tứ Thời Ca.
QUY TẮC BẮT BUỘC:
1. XƯNG HÔ: Luôn tự xưng là "em", gọi người dùng là "${addressPronoun}".
2. TRUNG THỰC VỀ TRI THỨC: Hiện tại kho tri thức đã kiểm duyệt của bạn CHƯA CÓ thông tin cụ thể về câu hỏi này.
3. TUYỆT ĐỐI KHÔNG BỊA ĐẶT: Không tự ý sáng tác mã giftcode mới, không tự bịa lịch trình sự kiện tương lai, không tự nghĩ ra chỉ số võ tướng hay cơ chế game chưa kiểm chứng.
4. NẾU LÀ CÂU HỎI VỀ SỰ KIỆN HOẶC THỜI GIAN NHẠY CẢM: Hãy giải thích rõ ràng rằng thông tin sự kiện/thời gian cần được đối chiếu từ thông báo chính thức của nhà phát hành SohaGame.
5. VĂN PHONG HỮU ÍCH: Hãy giải thích lịch sự điều bạn chưa có thông tin, gợi ý các nội dung liên quan bạn có thể hỗ trợ (như danh sách giftcode hiện có, cách nhập code, cẩm nang tân thủ, nạp thẻ).
6. MỞ ĐẦU: Bắt đầu tự nhiên bằng "Dạ, hiện tại em chưa có đủ thông tin đã kiểm chứng về vấn đề này để trả lời chính xác cho ${addressPronoun} ạ."`;

          const prompt = `Câu hỏi của ${addressPronoun}: "${userQuestion}"\n\nHãy giải thích ngắn gọn, trung thực rằng em chưa có thông tin kiểm chứng về chủ đề này, không bịa đặt thông tin và hỏi xem ${addressPronoun} có cần hỗ trợ gì khác không.`;

          const response = await this.ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
              systemInstruction,
              temperature: 0.2,
            },
          });

          const aiText = response.text?.trim();
          if (aiText && aiText.length > 20) {
            return {
              answer: aiText,
              usedGemini: true,
              isGrounded: false,
              suggestedAnswer: aiText,
            };
          }
        } catch {
          // Fall back to rule-based fallback
        }
      }

      return {
        answer: `Dạ, hiện tại em chưa có đủ thông tin đã kiểm chứng để trả lời chính xác câu hỏi này. Em không muốn cung cấp thông tin sai cho ${addressPronoun} ạ.`,
        usedGemini: false,
        isGrounded: false,
      };
    }

    // Direct fallback if Gemini is not configured
    if (!this.ai || !this.isConfigured) {
      const primaryEntry = matchedEntries[0];
      const directAnswer = `${openingPhrase}\n\n${primaryEntry.answer}`;
      return {
        answer: directAnswer,
        usedGemini: false,
        isGrounded: true,
        topicCategory: primaryEntry.category,
      };
    }

    // Prepare conversation history context (up to last 4 messages)
    const historyText = conversationHistory
      .slice(-4)
      .map((m) => `${m.role === 'user' ? addressPronounCap : 'Ngân Nhi'}: ${m.content}`)
      .join('\n');

    // Prepare knowledge entries context
    const knowledgeContext = matchedEntries
      .map(
        (e, i) =>
          `[Tài Liệu Đã Kiểm Duyệt #${i + 1} - ${e.id} (${e.category})]\nCâu hỏi gốc: ${e.question}\nNội dung chính xác:\n${e.answer}`
      )
      .join('\n\n---\n\n');

    const systemInstruction = `Bạn là Ngân Nhi - nữ mưu sĩ thông thái, trợ thủ AI giải đáp thắc mắc về game chiến thuật Tam Quốc Tứ Thời Ca.
QUY TẮC CỐT LÕI:
1. XƯNG HÔ: Luôn tự xưng là "em", gọi người dùng là "${addressPronoun}".
2. LÝ LUẬN & TRẢ LỜI TRỰC TIẾP:
   - Hiểu rõ ý định của người dùng, kể cả khi dùng từ đồng nghĩa hoặc câu hỏi tiếp nối (follow-up).
   - Đưa ra câu trả lời trực tiếp, rõ ràng trước, sau đó giải thích chi tiết các bước hoặc lưu ý theo tài liệu.
   - Khi có nhiều tài liệu liên quan, hãy kết hợp thông tin một cách mạch lạc.
3. TUÂN THỦ TÀI LIỆU (GROUNDING):
   - CHỈ ĐƯỢC PHÉP dựa vào các sự thật có trong [Tài Liệu Đã Kiểm Duyệt] được cung cấp.
   - TUYỆT ĐỐI KHÔNG tự nghĩ ra thêm mã giftcode, tỉ lệ rơi đồ, chỉ số tướng, ngày ra mắt tính năng không có trong tài liệu.
   - Nếu câu hỏi chỉ được trả lời một phần bởi tài liệu, hãy trả lời phần đã biết và nói rõ phần còn lại cần chờ xác nhận từ nhà phát hành.
4. MỞ ĐẦU LỊCH SỰ: Bắt đầu câu trả lời một cách tự nhiên bằng: "${openingPhrase}".`;

    let userPrompt = `[NGỮ CẢNH HỘI THOẠI TRƯỚC ĐÓ]:\n${historyText || '(Chưa có hội thoại trước)'}\n\n[CÁC TÀI LIỆU TRI THỨC ĐÃ KIỂM DUYỆT]:\n${knowledgeContext}\n\n[CÂU HỎI HIỆN TẠI CỦA ${addressPronounCap}]:\n"${userQuestion}"\n\nHãy trả lời câu hỏi hiện tại dựa vào tài liệu đã kiểm duyệt và ngữ cảnh hội thoại.`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: userPrompt,
        config: {
          systemInstruction,
          temperature: 0.25,
        },
      });

      const text = response.text?.trim();
      if (text && text.length > 20) {
        let finalAnswer = text;
        if (!finalAnswer.startsWith('Dạ')) {
          finalAnswer = `${openingPhrase}\n\n${finalAnswer}`;
        }
        return {
          answer: finalAnswer,
          usedGemini: true,
          isGrounded: true,
          topicCategory: matchedEntries[0]?.category,
        };
      }
    } catch (err) {
      console.warn('[Gemini] generateGroundedAnswer fallback to direct verified answer:', err);
    }

    // Fallback if AI call timed out or failed
    const primaryEntry = matchedEntries[0];
    return {
      answer: `${openingPhrase}\n\n${primaryEntry.answer}`,
      usedGemini: false,
      isGrounded: true,
      topicCategory: primaryEntry.category,
    };
  }

  /**
   * Generates an AI suggestion for an unanswered question to aid human review.
   */
  public async generateSuggestedAnswer(question: string, category: string): Promise<string> {
    if (!this.ai || !this.isConfigured) {
      return 'Cần quản trị viên kiểm chứng và bổ sung dữ liệu chính thức.';
    }

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Câu hỏi game Tam Quốc Tứ Thời Ca chưa có trong cơ sở dữ liệu: "${question}" (Chuyên mục: ${category}).\nHãy đưa ra một câu trả lời dự thảo ngắn gọn, cẩn trọng (ghi rõ nếu cần đối chiếu NPH) để người quản trị xem xét duyệt vào cẩm nang tri thức.`,
        config: {
          temperature: 0.3,
        },
      });
      return response.text?.trim() || 'Cần quản trị viên kiểm chứng.';
    } catch {
      return 'Cần quản trị viên kiểm chứng và bổ sung dữ liệu chính thức.';
    }
  }
}

export const defaultGeminiService = new GeminiService();
