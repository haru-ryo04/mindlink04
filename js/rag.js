/**
 * MindLink - RAG (Retrieval-Augmented Generation) Module
 * ベクトル検索と類似度計算の管理
 */

const MindLinkRAG = (() => {
  
  // コサイン類似度の計算
  function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // 時間減衰係数
  // ・episode / 旧形式（sectionTypeなし）: 減衰なし（1.0）
  // ・research_thread: 緩やかな減衰（半減期 約70日）
  // ・user_knowledge / ai_growth / liked_topic / liked_insight: 標準減衰（半減期 約35日）
  // ・fitness_log: 標準減衰（半減期 約35日・exp(-0.02*d)）
  function temporalDecay(reflection) {
    if (!reflection.sectionType || reflection.sectionType === 'episode') return 1.0;
    const daysPassed = (Date.now() - reflection.createdAt) / (1000 * 60 * 60 * 24);
    if (reflection.sectionType === 'research_thread') {
      return Math.exp(-0.01 * daysPassed); // 半減期 約70日（継続的関心は長く保持）
    }
    if (reflection.sectionType === 'fitness_log') {
      return Math.exp(-0.02 * daysPassed); // 半減期 約35日（フィットネス記録）
    }
    // user_knowledge / ai_growth / liked_topic / liked_insight はすべて標準減衰
    return Math.exp(-0.02 * daysPassed); // 半減期 約35日
  }

  // 関連する省察(Reflection)の検索
  async function searchReflections(query, topK = 3, precomputedEmbedding = null) {
    try {
      if (!precomputedEmbedding && (!window.MindLinkAPI || !window.MindLinkAPI.getEmbedding)) return [];
      
      const queryEmbedding = precomputedEmbedding || await window.MindLinkAPI.getEmbedding(query);
      const reflections = await MindLinkStorage.getReflections();
      
      if (reflections.length === 0) return [];

      // 埋め込みデータを持っているものだけで計算
      const scored = reflections
        .filter(r => r.embedding && Array.isArray(r.embedding))
        .map(r => ({
          ...r,
          score: cosineSimilarity(queryEmbedding, r.embedding) * temporalDecay(r)
        }));

      // スコア順に並び替え
      scored.sort((a, b) => b.score - a.score);
      
      // 上位K件を返す
      return scored.slice(0, topK);
    } catch (e) {
      console.error('[MindLink RAG] Search error:', e);
      return [];
    }
  }

  // 関連する個別記憶(Memory)の検索
  async function searchMemories(query, topK = 3) {
    try {
      if (!window.MindLinkAPI || !window.MindLinkAPI.getEmbedding) return [];
      
      const queryEmbedding = await window.MindLinkAPI.getEmbedding(query);
      const memories = MindLinkStorage.getMemories();
      
      if (memories.length === 0) return [];

      let scored = [];
      for (const m of memories) {
        let embedding = m.embedding;
        // 埋め込みデータがない場合は、初回検索時にオンザフライで生成して保存
        if (!embedding || !Array.isArray(embedding)) {
          try {
            embedding = await window.MindLinkAPI.getEmbedding(m.content);
            MindLinkStorage.updateMemory(m.id, { embedding });
          } catch (embedErr) {
            console.warn('[MindLink RAG] Memory embedding generation failed:', embedErr);
            continue;
          }
        }
        
        scored.push({
          ...m,
          score: cosineSimilarity(queryEmbedding, embedding)
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch (e) {
      console.error('[MindLink RAG] Memory Search error:', e);
      return [];
    }
  }

  // 未解決スレッド・継続的関心の検索
  async function searchResearchThreads(query, topK = 3, precomputedEmbedding = null) {
    try {
      if (!precomputedEmbedding && (!window.MindLinkAPI || !window.MindLinkAPI.getEmbedding)) return [];

      const queryEmbedding = precomputedEmbedding || await window.MindLinkAPI.getEmbedding(query);
      const reflections = await MindLinkStorage.getReflections();

      const threads = reflections.filter(r =>
        r.sectionType === 'research_thread' && r.embedding && Array.isArray(r.embedding)
      );
      if (threads.length === 0) return [];

      const scored = threads.map(r => ({
        ...r,
        score: cosineSimilarity(queryEmbedding, r.embedding) * temporalDecay(r)
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch (e) {
      console.error('[MindLink RAG] Research threads search error:', e);
      return [];
    }
  }

  return {
    cosineSimilarity,
    searchReflections,
    searchMemories,
    searchResearchThreads
  };
})();

window.MindLinkRAG = MindLinkRAG;
