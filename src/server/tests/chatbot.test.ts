import { classifyUserIntent } from '../intentClassifier.js';
import { defaultKnowledgeManager } from '../knowledgeManager.js';
import { defaultGeminiService, detectSalutation } from '../geminiService.js';
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
  console.log('--- STARTING NGAN NHI CHATBOT BEHAVIOR & KNOWLEDGE TESTS ---\n');

  // Test 1: "Xin chào" receives a greeting, not an unanswered-question response
  const t1Intent = classifyUserIntent('Xin chào', 'neutral');
  assert(
    t1Intent.isSocial === true && t1Intent.intent === 'greeting',
    'Test 1: "Xin chào" classifies as greeting'
  );
  assert(
    !!t1Intent.directAnswer && t1Intent.directAnswer.includes('Ngân Nhi xin chào') && !t1Intent.directAnswer.includes('chưa có thông tin'),
    'Test 1b: "Xin chào" gives friendly greeting without unanswered text'
  );

  // Test 2: "Hi" receives a greeting
  const t2Intent = classifyUserIntent('Hi', 'neutral');
  assert(
    t2Intent.isSocial === true && t2Intent.intent === 'greeting',
    'Test 2: "Hi" receives a greeting'
  );

  // Test 3: "Cảm ơn em" receives a natural acknowledgment
  const t3Intent = classifyUserIntent('Cảm ơn em', 'neutral');
  assert(
    t3Intent.isSocial === true && t3Intent.intent === 'thanks' && !!t3Intent.directAnswer && t3Intent.directAnswer.includes('không có gì'),
    'Test 3: "Cảm ơn em" receives natural acknowledgment'
  );

  // Test 4: "Anh muốn hỏi về giftcode" receives a relevant follow-up or giftcode guidance
  const t4Intent = classifyUserIntent('Anh muốn hỏi về giftcode', 'anh');
  assert(
    t4Intent.isSocial === true &&
    t4Intent.intent === 'clarification_giftcode' &&
    !!t4Intent.directAnswer &&
    t4Intent.directAnswer.includes('danh sách giftcode hay cần hướng dẫn cách nhập code') &&
    t4Intent.directAnswer.includes('anh'),
    'Test 4: "Anh muốn hỏi về giftcode" receives clarifying question addressing user as "anh"'
  );

  // Test 5: "Cho tôi toàn bộ code" retrieves the supplied list
  const t5Matches = defaultKnowledgeManager.search('Cho tôi toàn bộ code', 3);
  const t5Top = t5Matches[0];
  assert(
    !!t5Top && t5Top.entry.id === 'giftcode_full_list' && t5Top.score >= 0.5,
    'Test 5: "Cho tôi toàn bộ code" matches giftcode_full_list'
  );
  assert(
    t5Top?.entry.answer.includes('TONTHUONGHUONG888') && t5Top?.entry.answer.includes('MUNGQUOCKHANH'),
    'Test 5b: giftcode_full_list contains the required 28 codes'
  );

  // Test 6: "Nhập code ở đâu?" retrieves redemption instructions
  const t6Matches = defaultKnowledgeManager.search('Nhập code ở đâu?', 3);
  const t6Top = t6Matches[0];
  assert(
    !!t6Top && t6Top.entry.id === 'giftcode_redemption_guide' && t6Top.entry.answer.includes('https://nap.sohagame.vn'),
    'Test 6: "Nhập code ở đâu?" retrieves redemption instructions'
  );

  // Test 7: "Code sinh nhật cần điều kiện gì?" retrieves birthday eligibility rules
  const t7Matches = defaultKnowledgeManager.search('Code sinh nhật cần điều kiện gì?', 3);
  const t7Top = t7Matches[0];
  assert(
    !!t7Top && t7Top.entry.id === 'giftcode_birthday' && t7Top.entry.answer.includes('1.000.000 VNĐ') && t7Top.entry.answer.includes('taikhoan.sohagame.vn'),
    'Test 7: "Code sinh nhật cần điều kiện gì?" retrieves birthday eligibility rules'
  );

  // Test 8: "Tôi chưa nhận được code" retrieves the delayed-delivery guidance
  const t8Matches = defaultKnowledgeManager.search('Tôi chưa nhận được code', 3);
  const t8Top = t8Matches[0];
  assert(
    !!t8Top && t8Top.entry.id === 'giftcode_delayed_delivery' && t8Top.entry.answer.includes('30 phút đến 2 giờ'),
    'Test 8: "Tôi chưa nhận được code" retrieves delayed-delivery guidance'
  );

  // Test 9: "Cổ Đế dùng ở 1.1 rồi có dùng ở 1.2 được không?" retrieves the correct restriction
  const t9Matches = defaultKnowledgeManager.search('Cổ Đế dùng ở 1.1 rồi có dùng ở 1.2 được không?', 3);
  const t9Top = t9Matches[0];
  assert(
    !!t9Top && t9Top.entry.id === 'tech_code_de_restriction' && t9Top.entry.answer.includes('không thể tiếp tục sử dụng ở chương x.2'),
    'Test 9: "Cổ Đế dùng ở 1.1 rồi có dùng ở 1.2 được không?" retrieves Cổ Đế restriction'
  );

  // Test 10: "Cách nạp SohaCoin bằng chuyển khoản?" retrieves the correct steps
  const t10Matches = defaultKnowledgeManager.search('Cách nạp SohaCoin bằng chuyển khoản?', 3);
  const t10Top = t10Matches[0];
  assert(
    !!t10Top && t10Top.entry.id === 'payment_bank_transfer' && t10Top.entry.answer.includes('Chuyển khoản trực tiếp'),
    'Test 10: "Cách nạp SohaCoin bằng chuyển khoản?" retrieves bank transfer steps'
  );

  // Test 11: Question with no matching verified knowledge handled honestly without fabrication
  const t11Matches = defaultKnowledgeManager.search('Game có tính năng cưới vợ sinh con kết hôn không?', 3);
  const t11Valid = t11Matches.filter((m) => m.score >= 0.35);
  assert(
    t11Valid.length === 0,
    'Test 11: Unsupported question has 0 valid matches above threshold'
  );
  const t11Answer = await defaultGeminiService.generateGroundedAnswer({
    userQuestion: 'Game có tính năng cưới vợ sinh con kết hôn không?',
    salutation: 'neutral',
    matchedEntries: [],
  });
  assert(
    t11Answer.answer.includes('chưa có đủ thông tin đã kiểm chứng') && t11Answer.answer.includes('không muốn cung cấp thông tin sai'),
    'Test 11b: Fallback answer is honest and does not fabricate game rules'
  );

  // Test 12: The Anh/Chị selector produces consistent forms of address
  const t12GreetingAnh = classifyUserIntent('Xin chào', 'anh');
  const t12GreetingChi = classifyUserIntent('Xin chào', 'chi');
  assert(
    Boolean(t12GreetingAnh.directAnswer?.includes('chào anh ạ') && !t12GreetingAnh.directAnswer?.includes('chị')),
    'Test 12a: Explicit "anh" selector produces "anh" address'
  );
  assert(
    Boolean(t12GreetingChi.directAnswer?.includes('chào chị ạ') && !t12GreetingChi.directAnswer?.includes('anh/chị')),
    'Test 12b: Explicit "chi" selector produces "chị" address'
  );

  const t12cSalutation = detectSalutation('Chị cần hỗ trợ nạp tiền.');
  const t12cResult = classifyUserIntent('Chị cần hỗ trợ nạp tiền.', t12cSalutation);
  assert(
    t12cSalutation === 'chi' &&
    Boolean(t12cResult.directAnswer?.includes('Dạ thưa chị') && t12cResult.directAnswer?.includes('Chị muốn tìm hiểu')),
    'Test 12c: Natural text with "chị" automatically detects pronoun and addresses as "chị"'
  );

  // Test 13: No privileged API key is exposed in the client bundle
  const distDir = path.resolve(process.cwd(), 'dist');
  let exposedSecrets = false;
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(path.join(distDir, 'assets'));
    for (const file of files) {
      if (file.endsWith('.js')) {
        const content = fs.readFileSync(path.join(distDir, 'assets', file), 'utf-8');
        if (content.includes('service_role') || content.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') || content.includes('SUPABASE_SERVICE_ROLE_KEY')) {
          exposedSecrets = true;
          break;
        }
      }
    }
  }
  assert(
    !exposedSecrets,
    'Test 13: Client bundle does not contain any secret keys or service role tokens'
  );

  console.log(`\n--- TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ---`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
