import { normalizeText, removeVietnameseAccents } from './knowledgeManager.js';
import { UserSalutation } from './geminiService.js';

export type MessageIntent =
  | 'greeting'
  | 'thanks'
  | 'farewell'
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
  const noAccent = removeVietnameseAccents(clean);

  // Address labels
  const userPronoun = salutation === 'anh' ? 'anh' : salutation === 'chi' ? 'chị' : 'anh/chị';
  const politeGreeting = salutation === 'anh' ? 'Dạ thưa anh,' : salutation === 'chi' ? 'Dạ thưa chị,' : 'Dạ,';

  // 1. Clarification Intents (Check before pure greetings)
  // Clarification: Generic giftcode inquiry without asking for specific list or redemption steps
  const giftcodeInquiryRegex = /^(anh|chi|em|toi|minh)?\s*(muon|can|cho)?\s*hoi\s*(ve\s*)?(giftcode|gift\s*code|code)\s*(a|em|nhe|ha\s*em)?$/i;
  const giftcodeInquiryNoAccent = noAccent.replace(/\s+/g, ' ');
  if (
    giftcodeInquiryRegex.test(giftcodeInquiryNoAccent) ||
    giftcodeInquiryNoAccent === 'anh muon hoi ve giftcode' ||
    giftcodeInquiryNoAccent === 'chi muon hoi ve giftcode' ||
    giftcodeInquiryNoAccent === 'hoi ve giftcode' ||
    giftcodeInquiryNoAccent === 'tu van giftcode'
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
      directAnswer: `${politeGreeting} em có thể hướng dẫn ${userPronoun} cách nạp tiền vào game ạ. ${
        salutation === 'anh' ? 'Anh' : salutation === 'chi' ? 'Chị' : 'Anh/chị'
      } muốn tìm hiểu cách nạp SohaCoin hay chuyển khoản ngân hàng ạ?`,
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

  // 2. Pure Greetings
  const greetingPhrases = [
    'xin chao',
    'chao',
    'chao em',
    'chao ngan nhi',
    'xin chao ngan nhi',
    'hello',
    'hi',
    'hi em',
    'hi ngan nhi',
    'alo',
    'alo em',
    'em oi',
    'ngan nhi oi',
    'chao buoi sang',
    'good morning',
    'chao buoi toi',
    'good evening',
    'good afternoon',
    'chao ban',
    'helo',
    'he lo',
    'hai',
    'chao e',
  ];

  const isExactGreeting = greetingPhrases.some((g) => noAccent === g);
  const isGreetingPattern =
    /^(xin\s*chao|chao\s*(em|ngan\s*nhi|ban|e)?|hello|hi|alo|em\s*oi|good\s*(morning|evening|afternoon))(\s*(ngan\s*nhi|em|nhe|nha|a))?$/i.test(
      noAccent
    );

  if (isExactGreeting || isGreetingPattern) {
    return {
      intent: 'greeting',
      directAnswer: `Dạ, Ngân Nhi xin chào ${userPronoun} ạ! ${
        salutation === 'anh' ? 'Anh' : salutation === 'chi' ? 'Chị' : 'Anh/chị'
      } cần em hỗ trợ gì về Tam Quốc Tứ Thời Ca hôm nay ạ?`,
      isSocial: true,
    };
  }

  // 3. Thanks
  const thanksPhrases = [
    'cam on',
    'cam on em',
    'cam on nhe',
    'cam on nha',
    'cam on ngan nhi',
    'thank you',
    'thanks',
    'tks',
    'thank',
    'cam on ban',
    'da cam on',
    'cam on nhieu',
  ];

  const isThanks =
    thanksPhrases.some((t) => noAccent === t) ||
    /^(cam\s*on|thank\s*you|thanks|tks)(\s*(em|ngan\s*nhi|nhe|nha|nhieu|a))?$/i.test(noAccent);

  if (isThanks) {
    return {
      intent: 'thanks',
      directAnswer: `Dạ, không có gì ạ! ${
        salutation === 'anh' ? 'Anh' : salutation === 'chi' ? 'Chị' : 'Anh/chị'
      } cần hỗ trợ thêm gì thì cứ hỏi Ngân Nhi nhé.`,
      isSocial: true,
    };
  }

  // 4. Farewell
  const farewellPhrases = [
    'tam biet',
    'bye',
    'goodbye',
    'bye bye',
    'bai bai',
    'hen gap lai',
    'tam biet em',
    'chuc ngu ngon',
    'hen gap lai em',
    'chuc buoi toi vui ve',
  ];

  const isFarewell =
    farewellPhrases.some((f) => noAccent === f) ||
    /^(tam\s*biet|bye(\s*bye)?|goodbye|hen\s*gap\s*lai)(\s*(em|ngan\s*nhi|nhe|nha|a))?$/i.test(noAccent);

  if (isFarewell) {
    return {
      intent: 'farewell',
      directAnswer: `Dạ, Ngân Nhi chúc ${userPronoun} chơi game vui vẻ và hẹn gặp lại ạ!`,
      isSocial: true,
    };
  }

  // 5. Bot Identity
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

  // Default: Game-related question to be searched in the verified knowledge base
  return {
    intent: 'game_question',
    isSocial: false,
  };
}
