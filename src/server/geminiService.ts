import { GoogleGenAI } from '@google/genai';
import { GameKnowledgeEntry } from './knowledgeManager.js';

export type UserSalutation = 'anh' | 'chi' | 'neutral';

export function detectSalutation(text: string, explicitChoice?: string): UserSalutation {
  if (explicitChoice === 'anh') return 'anh';
  if (explicitChoice === 'chi') return 'chi';
  if (explicitChoice === 'neutral') return 'neutral';

  const lower = text.toLowerCase();
  // Check if user addresses as 'anh' or says 'anh muốn', 'anh hỏi', 'anh là'
  if (/\b(anh|anh muốn|anh hỏi|anh là|anh em)\b/i.test(lower) && !/\b(chị|em gái)\b/i.test(lower)) {
    return 'anh';
  }
  // Check if user addresses as 'chị'
  if (/\b(chị|chị muốn|chị hỏi|chị là)\b/i.test(lower) && !/\b(anh)\b/i.test(lower)) {
    return 'chi';
  }
  return 'neutral';
}

export function getPersonaOpening(salutation: UserSalutation): string {
  switch (salutation) {
    case 'anh':
      return 'Dạ thưa anh, về vấn đề này em xin trả lời như sau:';
    case 'chi':
      return 'Dạ thưa chị, về vấn đề này em xin trả lời như sau:';
    case 'neutral':
    default:
      return 'Dạ, về vấn đề này em xin giải đáp như sau:';
  }
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
      console.log('[Gemini] GEMINI_API_KEY is not set or placeholder. Fallback mode will use verified answers directly.');
    }
  }

  public getStatus() {
    return {
      configured: this.isConfigured,
      model: 'gemini-3.8-flash',
    };
  }

  /**
   * Generates a grounded response tailored to user question and Ngân Nhi persona.
   */
  public async generateGroundedAnswer(params: {
    userQuestion: string;
    salutation: UserSalutation;
    matchedEntries: GameKnowledgeEntry[];
  }): Promise<{ answer: string; usedGemini: boolean }> {
    const { userQuestion, salutation, matchedEntries } = params;
    const openingPhrase = getPersonaOpening(salutation);

    if (matchedEntries.length === 0) {
      return {
        answer: `${openingPhrase}\n\nHiện tại trong cơ sở tri thức đã kiểm duyệt của Tam Quốc Tứ Thời Ca, em chưa có thông tin chính xác về câu hỏi này của ${salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'quý đại hiệp'}.\n\nEm đã lưu lại câu hỏi này để các sư huynh/đội ngũ nghiên cứu chiến lược xác minh và cập nhật trong phiên bản kiến thức sớm nhất ạ!`,
        usedGemini: false,
      };
    }

    // Direct fallback answer if Gemini is not configured
    if (!this.ai || !this.isConfigured) {
      const primaryEntry = matchedEntries[0];
      const directAnswer = `${openingPhrase}\n\n${primaryEntry.answer}`;
      return { answer: directAnswer, usedGemini: false };
    }

    // Prepare prompt with strict grounding constraints
    const knowledgeContext = matchedEntries
      .map(
        (e, i) =>
          `[Nguồn Tri Thức Đã Kiểm Duyệt #${i + 1} - ${e.id}]\nChủ đề: ${e.question}\nNội dung chính xác:\n${e.answer}`
      )
      .join('\n\n---\n\n');

    const addressPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'quý đại hiệp';

    const systemInstruction = `Bạn là Ngân Nhi - nữ mưu sĩ thông thái, trợ thủ AI giải đáp thắc mắc về game chiến thuật Tam Quốc Tứ Thời Ca.
QUY TẮC BẮT BUỘC:
1. XƯNG HÔ: Tự xưng là "em", gọi người dùng là "${addressPronoun}".
2. CÂU MỞ ĐẦU CHÍNH XÁC: Câu đầu tiên của phản hồi PHẢI LÀ: "${openingPhrase}"
3. TÔN TRỌNG SỰ THẬT & KHÔNG BỊA ĐẶT: CHỈ ĐƯỢC PHÉP sử dụng thông tin từ [Nguồn Tri Thức Đã Kiểm Duyệt] được cung cấp bên dưới. TUYỆT ĐỐI KHÔNG tự nghĩ ra thêm chỉ số, cơ chế game, giftcode, lịch sự kiện hay tên tướng không có trong tài liệu.
4. KHÔNG MẠO NHẬN: Không tự xưng là nhà phát hành game chính thức hoặc đội ngũ hỗ trợ kỹ thuật chính thức.
5. VĂN PHONG: Nhã nhặn, tôn trọng, giải thích rõ ràng, súc tích và mạch lạc bằng tiếng Việt.
6. Nếu có nhiều tri thức liên quan, kết hợp chúng một cách logic và nhất quán.`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Câu hỏi của ${addressPronoun}: "${userQuestion}"\n\n${knowledgeContext}\n\nHãy trả lời câu hỏi trên dựa CHẶT CHẼ vào các thông tin đã kiểm duyệt, bắt đầu đúng bằng câu: "${openingPhrase}".`,
        config: {
          systemInstruction,
          temperature: 0.3, // Lower temperature to avoid hallucination
        },
      });

      const text = response.text?.trim();
      if (text && text.length > 20) {
        // Ensure opening phrase is present
        let finalAnswer = text;
        if (!finalAnswer.startsWith('Dạ')) {
          finalAnswer = `${openingPhrase}\n\n${finalAnswer}`;
        }
        return { answer: finalAnswer, usedGemini: true };
      }
    } catch (err) {
      console.warn('[Gemini] generateContent failed, falling back to direct verified answer:', err);
    }

    // Fallback if Gemini request failed
    const primaryEntry = matchedEntries[0];
    return {
      answer: `${openingPhrase}\n\n${primaryEntry.answer}`,
      usedGemini: false,
    };
  }
}

export const defaultGeminiService = new GeminiService();
