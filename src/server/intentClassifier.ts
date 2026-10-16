import { normalizeText, removeVietnameseAccents } from './knowledgeManager.js';
import { UserSalutation } from './geminiService.js';

export type MessageIntent =
  | 'greeting'
  | 'thanks'
  | 'farewell'
  | 'acknowledgment'
  | 'identity'
  | 'clarification_giftcode'
  | 'clarification_payment'
  | 'clarification_support'
  | 'game_question';

export interface IntentClassificationResult {
  intent: MessageIntent;
  directAnswer?: string;
  isSocial: boolean;
}

export function classifyUserIntent(
  rawText: string,
  salutation: UserSalutation
): IntentClassificationResult {
  const clean = normalizeText(rawText);
  const noAccent = removeVietnameseAccents(clean).toLowerCase().replace(/\s+/g, ' ').trim();

  // Address labels
  const userPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'anh/chị';
  const userPronounCap = salutation === 'anh' ? 'Anh' : salutation === 'chi' ? 'Chị' : 'Anh/chị';
  const politeGreeting = salutation === 'anh' ? 'Dạ thưa anh,' : salutation === 'chi' ? 'Dạ thưa chị,' : 'Dạ,';

  // 1. Clarification Intents (Check before pure greetings)
  // Clarification: Generic giftcode inquiry without asking for specific list or redemption steps
  const giftcodeInquiryRegex = /^(anh|chi|em|toi|minh)?\s*(muon|can|cho)?\s*hoi\s*(ve\s*)?(giftcode|gift\s*code|code)\s*(a|em|nhe|ha\s*em)?$/i;
  if (
    giftcodeInquiryRegex.test(noAccent) ||
    noAccent === 'anh muon hoi ve giftcode' ||
    noAccent === 'chi muon hoi ve giftcode' ||
    noAccent === 'hoi ve giftcode' ||
    noAccent === 'tu van giftcode'
  ) {
    return {
      intent: 'clarification_giftcode',
      directAnswer: `${politeGreeting} ${userPronoun} muốn tìm danh sách giftcode hay cần hướng dẫn cách nhập code ạ?`,
      isSocial: true,
    };
  }

  // Clarification: Generic payment inquiry
  const paymentInquiryRegex = /^(anh|chi|em|toi|minh)?\s*(can|muon)\s*(ho\s*tro|tim\s*hieu)?\s*nap\s*(tien|game|the)?\s*(a|em|nhe|ha\s*em)?$/i;
  if (
    paymentInquiryRegex.test(noAccent) ||
    noAccent === 'chi can ho tro nap tien' ||
    noAccent === 'anh can ho tro nap tien' ||
    noAccent === 'can ho tro nap tien' ||
    noAccent === 'ho tro nap tien'
  ) {
    return {
      intent: 'clarification_payment',
      directAnswer: `${politeGreeting} em có thể hướng dẫn ${userPronoun} cách nạp tiền vào game ạ. ${userPronounCap} muốn tìm hiểu cách nạp SohaCoin hay chuyển khoản ngân hàng ạ?`,
      isSocial: true,
    };
  }

  // Clarification: Generic support inquiry
  if (
    noAccent === 'bao loi game' ||
    noAccent === 'can ho tro ky thuat' ||
    noAccent === 'ho tro ky thuat' ||
    noAccent === 'anh muon bao loi' ||
    noAccent === 'chi muon bao loi'
  ) {
    return {
      intent: 'clarification_support',
      directAnswer: `${politeGreeting} ${userPronoun} đang gặp sự cố gì trong game ạ? Em có thể hướng dẫn ${userPronoun} cách cung cấp thông tin gửi đến bộ phận kỹ thuật để được kiểm tra và xử lý nhanh nhất ạ.`,
      isSocial: true,
    };
  }

  // 2. Greetings
  // Handles: "xin chào", "chào em", "hello", "hi", "alo", "em ơi", "ngân nhi ơi", "anh chào em", "chào buổi sáng", etc.
  const isGreeting =
    /^(xin\s*chao|chao|hello|hi|alo|helo|hai)(\s+(em|ngan\s*nhi|ban|moi\s*nguoi|e|nhe|nha|a))?$/i.test(noAccent) ||
    /^(anh|chi|em|minh)\s+(chao\s*(em|ngan\s*nhi|e)?|xin\s*chao)(\s*(a|nhe|nha))?$/i.test(noAccent) ||
    /^(em|ngan\s*nhi)\s+oi(\s*(a|nhe|nha))?$/i.test(noAccent) ||
    /^(chao\s+buoi\s+(sang|trua|chieu|toi)|good\s+(morning|afternoon|evening))(\s*(a|nhe|nha))?$/i.test(noAccent);

  if (isGreeting) {
    return {
      intent: 'greeting',
      directAnswer: `Dạ, Ngân Nhi xin chào ${userPronoun} ạ! Hôm nay ${userPronoun} muốn tìm hiểu điều gì về Tam Quốc Tứ Thời Ca ạ?`,
      isSocial: true,
    };
  }

  // 3. Thanks and Appreciation
  // Handles: "anh cảm ơn", "chị cảm ơn", "cảm ơn em", "cảm ơn nhé", "cảm ơn nha", "cảm ơn", "thank you", "thanks", "tks", etc.
  const isThanks =
    /^(anh|chi|em|minh)?\s*(cam\s*on|thank\s*you|thanks|tks|cam\s*on\s*nhieu|da\s*cam\s*on)(\s+(em|ngan\s*nhi|ban|nhe|nha|nhieu|a|nhieu\s*nha|e))?$/i.test(
      noAccent
    ) ||
    noAccent === 'anh cam on' ||
    noAccent === 'chi cam on' ||
    noAccent === 'cam on em' ||
    noAccent === 'cam on nhe' ||
    noAccent === 'cam on' ||
    noAccent === 'thank you' ||
    noAccent === 'thanks em';

  if (isThanks) {
    return {
      intent: 'thanks',
      directAnswer: `Dạ, không có gì đâu ${userPronoun} ạ! ${userPronounCap} cần em hỗ trợ thêm về Tam Quốc Tứ Thời Ca thì cứ hỏi em nhé.`,
      isSocial: true,
    };
  }

  // 4. Confirmations and Acknowledgments
  // Handles: "ok em", "ok", "oki", "oke", "được rồi", "hay quá", "tuyệt vời", "tuyệt quá", "chuẩn rồi", "rõ rồi em", "dạ vâng", "vâng ạ", etc.
  const isSimpleOk = /^(ok|oki|oke|okie|okey)(\s+(em|ngan\s*nhi|nhe|nha|a|e))?$/i.test(noAccent);
  if (isSimpleOk) {
    return {
      intent: 'acknowledgment',
      directAnswer: 'Dạ vâng ạ!',
      isSocial: true,
    };
  }

  const isPositiveAck =
    /^(duoc\s*roi|da\s*ro|ro\s*roi|hieu\s*roi|chuan\s*roi|da\s*vang|vang\s*a|vang\s*em|vang)(\s+(em|ngan\s*nhi|nhe|nha|a))?$/i.test(
      noAccent
    ) ||
    noAccent === 'duoc roi' ||
    noAccent === 'duoc roi em' ||
    noAccent === 'ro roi em';

  if (isPositiveAck) {
    return {
      intent: 'acknowledgment',
      directAnswer: `Dạ vâng ạ! Nếu cần hỗ trợ thêm thông tin gì về Tam Quốc Tứ Thời Ca, ${userPronoun} cứ nhắn em nhé.`,
      isSocial: true,
    };
  }

  const isCompliment =
    /^(hay\s*qua|tuyet\s*voi|tuyet\s*qua|hay\s*lam|tot\s*qua|hay\s*that|hop\s*ly)(\s+(em|ngan\s*nhi|nhe|nha|a))?$/i.test(
      noAccent
    ) ||
    noAccent === 'hay qua' ||
    noAccent === 'tuyet voi' ||
    noAccent === 'hay lam';

  if (isCompliment) {
    return {
      intent: 'acknowledgment',
      directAnswer: `Dạ, cảm ơn ${userPronoun} ạ! Chúc ${userPronoun} trải nghiệm game Tam Quốc Tứ Thời Ca thật vui vẻ và bách chiến bách thắng nhé!`,
      isSocial: true,
    };
  }

  // 5. Farewell
  // Handles: "tạm biệt", "bye", "bye em", "tạm biệt em", "hẹn gặp lại", "chúc ngủ ngon", etc.
  const isFarewell =
    /^(tam\s*biet|bye(\s*bye)?|goodbye|bai\s*bai|hen\s*gap\s*lai|chuc\s*ngu\s*ngon)(\s+(em|ngan\s*nhi|nhe|nha|a|moi\s*nguoi))?$/i.test(
      noAccent
    ) ||
    noAccent === 'tam biet' ||
    noAccent === 'bye' ||
    noAccent === 'bye em' ||
    noAccent === 'tam biet em';

  if (isFarewell) {
    return {
      intent: 'farewell',
      directAnswer: `Dạ, Ngân Nhi chúc ${userPronoun} chơi game vui vẻ và hẹn gặp lại ạ!`,
      isSocial: true,
    };
  }

  // 6. Bot Identity
  if (
    noAccent === 'em la ai' ||
    noAccent === 'ban la ai' ||
    noAccent === 'ngan nhi la ai' ||
    noAccent === 'gioi thieu ve em' ||
    noAccent === 'em ten gi'
  ) {
    return {
      intent: 'identity',
      directAnswer: `Dạ, em là Ngân Nhi - nữ mưu sĩ và trợ thủ AI đồng hành của Tam Quốc Tứ Thời Ca ạ! Em có thể giúp ${userPronoun} tra cứu các thông tin về danh sách Giftcode, cách thức nhập code, hướng dẫn các sự kiện nhận thưởng, cơ chế trận pháp bốn mùa Tứ Thời, chiến thuật đội hình và các phương thức nạp thẻ bảo vệ tài khoản an toàn ạ.`,
      isSocial: true,
    };
  }

  // Default: Game-related question to be answered using knowledge retrieval and AI reasoning
  return {
    intent: 'game_question',
    isSocial: false,
  };
}
