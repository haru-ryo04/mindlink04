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

  // 時間減衰係数（episode/旧形式は減衰なし、user_knowledge/ai_growthは指数減衰）
  function temporalDecay(reflection) {
    if (!reflection.sectionType || reflection.sectionType === 'episode') return 1.0;
    const daysPassed = (Date.now() - reflection.createdAt) / (1000 * 60 * 60 * 24);
    return Math.exp(-0.02 * daysPassed); // 半減期 約35日
  }

  // 関連する省察(Reflection)の検索
  async function searchReflections(query, topK = 3) {
    try {
      if (!window.MindLinkAPI || !window.MindLinkAPI.getEmbedding) return [];
      
      const queryEmbedding = await window.MindLinkAPI.getEmbedding(query);
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

  return {
    cosineSimilarity,
    searchReflections,
    searchMemories
  };
})();

window.MindLinkRAG = MindLinkRAG;
