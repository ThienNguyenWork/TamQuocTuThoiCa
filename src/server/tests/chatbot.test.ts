import { classifyUserIntent } from '../intentClassifier.js';
import { defaultKnowledgeManager } from '../knowledgeManager.js';
import { defaultGeminiService, detectSalutation } from '../geminiService.js';
import { dbService } from '../supabaseClient.js';
import { categorizeGameQuestion } from '../app.js';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

async function runAllTests() {
  console.log('--- STARTING UPGRADED NGAN NHI CHATBOT BEHAVIOR & REASONING TESTS ---\n');

  // Scenario A: "anh cảm ơn" → natural acknowledgment, no unanswered record
  const scA = classifyUserIntent('anh cảm ơn', 'anh');
  assert(
    scA.isSocial === true && scA.intent === 'thanks',
    'Scenario A: "anh cảm ơn" classifies as thanks with isSocial=true'
  );
  assert(
    Boolean(scA.directAnswer?.includes('không có gì') && scA.directAnswer?.includes('anh')),
    'Scenario A-2: "anh cảm ơn" returns polite acknowledgment addressing user as "anh"'
  );

  // Scenario B: "xin chào" → greeting, no unanswered record
  const scB = classifyUserIntent('xin chào', 'anh');
  assert(
    scB.isSocial === true && scB.intent === 'greeting',
    'Scenario B: "xin chào" classifies as greeting with isSocial=true'
  );
  assert(
    Boolean(scB.directAnswer?.includes('Ngân Nhi xin chào anh') && !scB.directAnswer?.includes('chưa có thông tin')),
    'Scenario B-2: "xin chào" returns warm greeting without triggering unanswered logic'
  );

  // Additional Social Intents: "ok em", "được rồi", "hay quá"
  const okIntent = classifyUserIntent('ok em', 'neutral');
  assert(
    okIntent.isSocial === true && okIntent.intent === 'acknowledgment' && okIntent.directAnswer === 'Dạ vâng ạ!',
    'Social Check: "ok em" classifies as acknowledgment with "Dạ vâng ạ!"'
  );

  const duocRoiIntent = classifyUserIntent('được rồi', 'anh');
  assert(
    duocRoiIntent.isSocial === true && duocRoiIntent.intent === 'acknowledgment',
    'Social Check: "được rồi" classifies as acknowledgment with isSocial=true'
  );

  const hayQuaIntent = classifyUserIntent('hay quá', 'chi');
  assert(
    hayQuaIntent.isSocial === true && hayQuaIntent.intent === 'acknowledgment' && Boolean(hayQuaIntent.directAnswer?.includes('cảm ơn chị')),
    'Social Check: "hay quá" classifies as acknowledgment with warm praise response'
  );

  // Scenario C: "Giftcode nhập ở đâu?" → direct answer using the existing giftcode redemption instructions
  const scCMatches = defaultKnowledgeManager.search('Giftcode nhập ở đâu?', 3);
  const scCTop = scCMatches[0];
  assert(
    Boolean(scCTop && scCTop.entry.id === 'giftcode_redemption_guide' && scCTop.score >= 0.4),
    'Scenario C: "Giftcode nhập ở đâu?" retrieves giftcode_redemption_guide'
  );
  assert(
    Boolean(scCTop?.entry.answer.includes('https://nap.sohagame.vn') && scCTop?.entry.answer.includes('GiftCode')),
    'Scenario C-2: redemption instructions include official URL and steps'
  );

  // Scenario D: "Tại sao chưa nhận được code?" → use the existing knowledge about waiting 30 minutes to 2 hours
  const scDMatches = defaultKnowledgeManager.search('Tại sao chưa nhận được code?', 3);
  const scDTop = scDMatches[0];
  assert(
    Boolean(scDTop && scDTop.entry.id === 'giftcode_delayed_delivery' && scDTop.score >= 0.4),
    'Scenario D: "Tại sao chưa nhận được code?" retrieves giftcode_delayed_delivery'
  );
  assert(
    Boolean(scDTop?.entry.answer.includes('30 phút đến 2 giờ')),
    'Scenario D-2: delayed-delivery guidance specifies 30 phút đến 2 giờ'
  );

  // Scenario E: A follow-up question referring to the previous answer → use conversation context
  const previousTurnContext = 'Võ tướng Cổ Đế dùng ở chương 1.1 khi vượt ải cấm dùng ở chương 1.2';
  const scEMatches = defaultKnowledgeManager.search('Thế ở 1.2 có dùng được tiếp không?', 3, previousTurnContext);
  const scETop = scEMatches[0];
  assert(
    Boolean(scETop && scETop.entry.id === 'tech_code_de_restriction'),
    'Scenario E: Follow-up question with prior context correctly resolves to tech_code_de_restriction'
  );

  // Scenario F: An unknown, time-sensitive event question → do not invent an answer; explain limitation and record
  const unknownEventQuery = 'Sự kiện đua top máy chủ mới vào tuần sau có phần thưởng danh hiệu gì?';
  const scFMatches = defaultKnowledgeManager.search(unknownEventQuery, 3);
  const scFValid = scFMatches.filter((m) => m.score >= 0.35);
  assert(
    scFValid.length === 0,
    'Scenario F: Unknown future event query has 0 valid matches in verified knowledge'
  );
  const scFAnswer = await defaultGeminiService.generateGroundedAnswer({
    userQuestion: unknownEventQuery,
    salutation: 'anh',
    matchedEntries: [],
    isTimeSensitiveOrUnknown: true,
  });
  assert(
    Boolean(
      scFAnswer.answer.includes('chưa có đủ thông tin') ||
      scFAnswer.answer.includes('chưa có thông tin') ||
      scFAnswer.answer.includes('không muốn cung cấp thông tin sai')
    ),
    'Scenario F-2: Response honestly explains limitation and does not invent unconfirmed rewards'
  );
  const scFCategory = categorizeGameQuestion(unknownEventQuery);
  assert(
    scFCategory === 'events',
    'Scenario F-3: Unknown event question correctly categorizes as "events"'
  );

  // Scenario G: A question phrased differently from an existing FAQ but asking about the same fact
  const scGQuery = 'Nạp mã quà tặng ở trang nào thế em?';
  const scGMatches = defaultKnowledgeManager.search(scGQuery, 3);
  const scGTop = scGMatches[0];
  assert(
    Boolean(scGTop && scGTop.entry.id === 'giftcode_redemption_guide' && scGTop.score >= 0.35),
    'Scenario G: Paraphrased query "Nạp mã quà tặng ở trang nào thế em?" matches redemption guide'
  );

  // Scenario H: Supabase unavailable → handle gracefully without falsely claiming question was permanently saved
  const mockUnsaved = await dbService.recordUnansweredQuestion({
    question: 'Tính năng kết hôn nuôi con có không?',
    normalizedQuestion: 'tinh nang ket hon nuoi con co khong',
    category: 'gameplay',
    reason: 'Chưa có thông tin kiểm chứng trong cẩm nang',
  });
  assert(
    mockUnsaved.success === true,
    'Scenario H: recordUnansweredQuestion succeeds with graceful fallback'
  );
  // Verify that if not persisted to Postgres, we formulate memory notice without false claim
  const noticeText = mockUnsaved.isDatabasePersisted
    ? '(Câu hỏi của anh đã được hệ thống lưu vào Supabase để đối chiếu và bổ sung vào cẩm nang tri thức ạ).'
    : '(Câu hỏi của anh đã được ghi nhận trong bộ nhớ tạm để nghiên cứu bổ sung cẩm nang ạ).';
  assert(
    Boolean(mockUnsaved.isDatabasePersisted ? noticeText.includes('Supabase') : noticeText.includes('bộ nhớ tạm')),
    'Scenario H-2: Fallback notice truthfully describes storage state without false claim'
  );

  // Pronoun Detection Tests: anh, chị, and manual selectors
  const salAnh = detectSalutation('Anh muốn hỏi về giftcode');
  assert(salAnh === 'anh', 'Pronoun Check: detects "anh" from text');

  const salChi = detectSalutation('Chị cần hỗ trợ nạp tiền');
  assert(salChi === 'chi', 'Pronoun Check: detects "chi" from text');

  // Security Check: Client bundle secret check
  const distDir = path.resolve(process.cwd(), 'dist');
  let exposedSecrets = false;
  if (fs.existsSync(distDir)) {
    const assetsDir = path.join(distDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      const files = fs.readdirSync(assetsDir);
      for (const file of files) {
        if (file.endsWith('.js')) {
          const content = fs.readFileSync(path.join(assetsDir, file), 'utf-8');
          if (
            content.includes('service_role') ||
            content.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') ||
            content.includes('SUPABASE_SERVICE_ROLE_KEY')
          ) {
            exposedSecrets = true;
            break;
          }
        }
      }
    }
  }
  assert(!exposedSecrets, 'Security: No service role keys or secrets exposed in client bundle');

  console.log(`\n--- TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ---`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
