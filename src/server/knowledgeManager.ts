import fs from 'node:fs';
import path from 'node:path';
import bundledKnowledge from '../data/gameKnowledge.json' with { type: 'json' };

export interface GameKnowledgeEntry {
  id: string;
  category: string;
  question: string;
  alternativeQuestions: string[];
  answer: string;
  keywords: string[];
  source?: string;
  lastUpdated?: string;
}

export interface MatchResult {
  entry: GameKnowledgeEntry;
  score: number;
  matchType: 'exact' | 'alternative_exact' | 'high_similarity' | 'keyword_match' | 'partial';
  matchedPhrases: string[];
}

// Remove Vietnamese accents/diacritics for flexible fuzzy matching
export function removeVietnameseAccents(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'<>@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Gaming terminology mapping for Vietnamese mobile/RPG gaming context
const GAMING_SYNONYMS: Record<string, string[]> = {
  'tan thu': ['nguoi moi', 'newbie', 'khoi dau', 'dau game', 'moi choi', 'moi vao game', 'f2p'],
  'doi hinh': ['build team', 'xep team', 'doi hinh chuan', 'lineup', 'bo doi', 'dan tuong'],
  'knb': ['kim nguyen bao', 'vang', 'tien', 'gem', 'ngoc'],
  'giftcode': ['code', 'ma qua', 'ma qua tang', 'nhan code', 'ma code', 'gift code', 'giftcodes'],
  'tuong': ['vo tuong', 'hero', 'ssr', 'nhan vat', 'tuong than'],
  'tu thoi': ['bon mua', 'xuan ha thu dong', 'thoi tiet', 'mua', 'mua giai', 'tran phap'],
  'quan doan': ['bang hoi', 'bang', 'clan', 'guild'],
  'than binh': ['trang bi', 'vu khi', 'phap bao', 'do dac'],
  'nap': ['nap the', 'nap tien', 'thanh toan', 'nap game', 'sohacoin', 'chuyen khoan'],
  'co de': ['ai co de', 'chuong 1.1', 'chuong 1.2', 'gioi han co de'],
  'gia lap': ['mumu player', 'pc', 'may tinh', 'choi tren pc', 'gia lap pc'],
  'sinh nhat': ['qua sinh nhat', 'code sinh nhat', 'ngay sinh'],
};

export class KnowledgeManager {
  private entries: GameKnowledgeEntry[] = [];
  private filePath: string;
  private validationErrors: string[] = [];
  private lastLoadedTimestamp: number = 0;

  constructor(customPath?: string) {
    this.filePath = customPath || path.resolve(process.cwd(), 'src/data/gameKnowledge.json');
    this.reloadKnowledge();
  }

  public reloadKnowledge(): { success: boolean; count: number; errors: string[] } {
    this.validationErrors = [];
    try {
      let rawData: unknown = null;

      // Try reading from file path if it exists on disk
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        rawData = JSON.parse(content);
      } else if (Array.isArray(bundledKnowledge)) {
        // Fallback to statically bundled JSON for Serverless environments (Vercel)
        rawData = bundledKnowledge;
      } else {
        this.validationErrors.push(`Knowledge file not found at: ${this.filePath}`);
        this.entries = [];
        return { success: false, count: 0, errors: this.validationErrors };
      }

      if (!Array.isArray(rawData)) {
        this.validationErrors.push('Knowledge file must contain a JSON array of entries.');
        this.entries = [];
        return { success: false, count: 0, errors: this.validationErrors };
      }

      const validated: GameKnowledgeEntry[] = [];
      rawData.forEach((item, index) => {
        const itemPrefix = `Entry [${index}] (id: ${item.id || 'missing'})`;
        if (!item.id || typeof item.id !== 'string') {
          this.validationErrors.push(`${itemPrefix}: Missing or invalid "id".`);
          return;
        }
        if (!item.question || typeof item.question !== 'string') {
          this.validationErrors.push(`${itemPrefix}: Missing or invalid "question".`);
          return;
        }
        if (!item.answer || typeof item.answer !== 'string') {
          this.validationErrors.push(`${itemPrefix}: Missing or invalid "answer".`);
          return;
        }

        validated.push({
          id: item.id.trim(),
          category: String(item.category || 'general').trim(),
          question: item.question.trim(),
          alternativeQuestions: Array.isArray(item.alternativeQuestions)
            ? item.alternativeQuestions.map((q: unknown) => String(q).trim()).filter(Boolean)
            : [],
          answer: item.answer.trim(),
          keywords: Array.isArray(item.keywords)
            ? item.keywords.map((k: unknown) => String(k).trim()).filter(Boolean)
            : [],
          source: item.source ? String(item.source).trim() : '',
          lastUpdated: item.lastUpdated ? String(item.lastUpdated).trim() : new Date().toISOString().split('T')[0],
        });
      });

      this.entries = validated;
      this.lastLoadedTimestamp = Date.now();
      return {
        success: this.validationErrors.length === 0,
        count: this.entries.length,
        errors: this.validationErrors,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.validationErrors.push(`Failed to parse knowledge file: ${msg}`);
      return { success: false, count: 0, errors: this.validationErrors };
    }
  }

  public getEntries(): GameKnowledgeEntry[] {
    return this.entries;
  }

  public getValidationErrors(): string[] {
    return this.validationErrors;
  }

  public getStatus() {
    return {
      totalEntries: this.entries.length,
      hasErrors: this.validationErrors.length > 0,
      errors: this.validationErrors,
      lastLoadedTimestamp: this.lastLoadedTimestamp,
      categories: Array.from(new Set(this.entries.map((e) => e.category))),
    };
  }

  /**
   * Search knowledge base with Vietnamese tokenization, accent-insensitivity,
   * alternative questions, keyword matching and synonym expansion.
   */
  public search(query: string, limit: number = 3): MatchResult[] {
    const rawClean = normalizeText(query);
    const noAccentQuery = removeVietnameseAccents(rawClean);
    const queryTokens = new Set(noAccentQuery.split(' ').filter((t) => t.length > 1));

    if (!rawClean || this.entries.length === 0) {
      return [];
    }

    // Expand query tokens with synonyms
    const expandedQueryTokens = new Set<string>(queryTokens);
    for (const [canonical, syns] of Object.entries(GAMING_SYNONYMS)) {
      const canonicalTokens = canonical.split(' ');
      const hasCanonical = canonicalTokens.every((t) => queryTokens.has(t));
      if (hasCanonical) {
        syns.forEach((s) => s.split(' ').forEach((t) => expandedQueryTokens.add(t)));
      }
      for (const syn of syns) {
        const synTokens = syn.split(' ');
        if (synTokens.every((t) => queryTokens.has(t))) {
          canonicalTokens.forEach((t) => expandedQueryTokens.add(t));
        }
      }
    }

    const scoredResults: MatchResult[] = [];

    for (const entry of this.entries) {
      let maxScore = 0;
      let bestMatchType: MatchResult['matchType'] = 'partial';
      const matchedPhrases: string[] = [];

      // 1. Exact match with primary question
      const primaryClean = normalizeText(entry.question);
      const primaryNoAccent = removeVietnameseAccents(primaryClean);

      if (rawClean === primaryClean || noAccentQuery === primaryNoAccent) {
        maxScore = 1.0;
        bestMatchType = 'exact';
        matchedPhrases.push(entry.question);
      } else if (
        rawClean.includes(primaryClean) ||
        primaryClean.includes(rawClean) ||
        noAccentQuery.includes(primaryNoAccent) ||
        primaryNoAccent.includes(noAccentQuery)
      ) {
        maxScore = Math.max(maxScore, 0.88);
        bestMatchType = 'high_similarity';
        matchedPhrases.push(entry.question);
      }

      // 2. Alternative questions
      for (const alt of entry.alternativeQuestions) {
        const altClean = normalizeText(alt);
        const altNoAccent = removeVietnameseAccents(altClean);

        if (rawClean === altClean || noAccentQuery === altNoAccent) {
          maxScore = Math.max(maxScore, 0.98);
          bestMatchType = 'alternative_exact';
          matchedPhrases.push(alt);
          break;
        } else if (
          rawClean.includes(altClean) ||
          altClean.includes(rawClean) ||
          noAccentQuery.includes(altNoAccent) ||
          altNoAccent.includes(noAccentQuery)
        ) {
          maxScore = Math.max(maxScore, 0.82);
          matchedPhrases.push(alt);
        }
      }

      // 3. Token Overlap & Jaccard on primary and alternatives
      const allTargetTexts = [entry.question, ...entry.alternativeQuestions];
      for (const targetText of allTargetTexts) {
        const targetCleanNoAccent = removeVietnameseAccents(normalizeText(targetText));
        const targetTokens = new Set(targetCleanNoAccent.split(' ').filter((t) => t.length > 1));

        let intersectionCount = 0;
        for (const token of targetTokens) {
          if (expandedQueryTokens.has(token)) {
            intersectionCount++;
          }
        }

        const unionSize = new Set([...expandedQueryTokens, ...targetTokens]).size;
        const jaccard = unionSize > 0 ? intersectionCount / unionSize : 0;
        const overlapRatio = targetTokens.size > 0 ? intersectionCount / targetTokens.size : 0;

        const tokenScore = Math.min(0.85, jaccard * 0.45 + overlapRatio * 0.55);
        if (tokenScore > maxScore) {
          maxScore = tokenScore;
          bestMatchType = tokenScore >= 0.6 ? 'high_similarity' : 'partial';
          matchedPhrases.push(targetText);
        }
      }

      // 4. Keyword boosting
      let keywordHits = 0;
      for (const kw of entry.keywords) {
        const kwNoAccent = removeVietnameseAccents(normalizeText(kw));
        const kwTokens = kwNoAccent.split(' ');
        const isMultiWord = kwTokens.length > 1;

        if (isMultiWord) {
          if (noAccentQuery.includes(kwNoAccent)) {
            keywordHits += 1.5;
            matchedPhrases.push(kw);
          }
        } else {
          if (expandedQueryTokens.has(kwNoAccent)) {
            keywordHits += 1;
            matchedPhrases.push(kw);
          }
        }
      }

      if (keywordHits > 0) {
        const keywordScore = Math.min(0.8, (keywordHits / Math.max(entry.keywords.length, 2)) * 0.7 + 0.25);
        if (keywordScore > maxScore) {
          maxScore = keywordScore;
          bestMatchType = 'keyword_match';
        } else {
          // boost slightly if keywords match
          maxScore = Math.min(0.95, maxScore + keywordHits * 0.05);
        }
      }

      if (maxScore >= 0.25) {
        scoredResults.push({
          entry,
          score: Number(maxScore.toFixed(4)),
          matchType: bestMatchType,
          matchedPhrases: Array.from(new Set(matchedPhrases)),
        });
      }
    }

    // Sort descending by score
    scoredResults.sort((a, b) => b.score - a.score);
    return scoredResults.slice(0, limit);
  }
}

export const defaultKnowledgeManager = new KnowledgeManager();
