/**
 * MindLink - Reflection Module
 * 自己省察機能と記憶ノートの可視化
 */

const MindLinkReflection = (() => {

  let cachedReflections = [];
  let currentDisplayCount = 0;
  const ITEMS_PER_PAGE = 20;

  // 省察テキストを3セクションに解析
  function parseSections(summary) {
    const episodeMatch = summary.match(/【今日の出来事と要約】([\s\S]*?)(?=【ユーザーについて|【AI自身|$)/);
    const userMatch    = summary.match(/【ユーザーについて新しく知ったこと】([\s\S]*?)(?=【AI自身|$)/);
    const aiMatch      = summary.match(/【AI自身の気づきと成長】([\s\S]*?)$/);
    return {
      episode:        episodeMatch ? episodeMatch[1].trim() : '',
      user_knowledge: userMatch    ? userMatch[1].trim()    : '',
      ai_growth:      aiMatch      ? aiMatch[1].trim()      : '',
    };
  }

  // 省察（リフレクション）の実行
  async function performReflection(isManual = false) {
    const now = new Date();
    // 自動実行の場合は22時以降、または前回から一定時間経過を条件にする（今回はシンプルに手動または指定時間）
    if (!isManual && now.getHours() < 22) return;

    console.log('[MindLink Reflection] Starting reflection process...');
    
    // コンテキストの収集（今日一日の全スレッドの会話）
    const context = gatherDailyContext();
    if (!context) {
      console.log('[MindLink Reflection] No context found for today.');
      return;
    }

    const prompt = `
あなたはユーザーの親密なパートナーAIとして、今日一日の対話を振り返り、「自己省察（Self-Reflection）」を行ってください。
以下の会話記録を元に、3つのセクションで構成される日本語の要約を作成してください：

1. 【今日の出来事と要約】: 何について話し、何が起きたか。
2. 【ユーザーについて新しく知ったこと】: ユーザーの好み、価値観、生活スタイル、家族、仕事、悩みなど。
3. 【AI自身の気づきと成長】: どのように接するのがベストだったか、自分の対応への反省、明日からどう接したいか。

【重要指示】
- 低コストRAGとして利用するため、正確かつ簡潔に（全体で400-800文字程度）まとめてください。
- あなた自身のキャラクター性（名前や口調）を維持しつつ、内面的な気づきを深く掘り下げてください。

【今日の会話ログ】
${context.slice(0, 40000)}
`;

    try {
      MindLinkApp.showToast('自己省察を行っています... 🌙');
      
      // 要約の生成 (設定されたモデルを使用)
      const summary = await window.MindLinkAPI.getSummary(prompt, false);
      if (!summary) throw new Error('Summary generation failed');

      // セクション解析と個別保存（3種それぞれのベクトルで保存）
      const sections = parseSections(summary);
      const now_ts  = Date.now();
      const dateStr = now.toLocaleDateString('ja-JP');
      const sectionDefs = [
        { key: 'episode',        content: sections.episode,        label: '今日の出来事' },
        { key: 'user_knowledge', content: sections.user_knowledge, label: 'ユーザー理解' },
        { key: 'ai_growth',      content: sections.ai_growth,      label: 'AI成長メモ'  },
      ];
      let savedCount = 0;
      for (let i = 0; i < sectionDefs.length; i++) {
        const def = sectionDefs[i];
        if (!def.content) continue;
        const secEmbedding = await window.MindLinkAPI.getEmbedding(def.content);
        await MindLinkStorage.saveReflection({
          id:           'refl_' + (now_ts + i),
          content:      def.content,
          embedding:    secEmbedding,
          sectionType:  def.key,
          sectionLabel: def.label,
          createdAt:    now_ts + i,
          date:         dateStr,
          type:         'daily_reflection'
        });
        savedCount++;
      }
      // セクション解析失敗時のフォールバック：全文をエピソードとして保存
      if (savedCount === 0) {
        const embedding = await window.MindLinkAPI.getEmbedding(summary);
        await MindLinkStorage.saveReflection({
          id:        'refl_' + now_ts,
          content:   summary,
          embedding: embedding,
          createdAt: now_ts,
          date:      dateStr,
          type:      'daily_reflection'
        });
      }
      MindLinkApp.showToast('自己省察が完了しました。新しい気づきを記憶しました ✨');

      // 今日の会話要約を削除（省察で記憶が引き継がれたため役目終了）
      MindLinkStorage.deleteDailySummary().catch(e =>
        console.warn('[MindLink] deleteDailySummary after reflection failed:', e)
      );

      // ── 4つ目の省察：いいねスタイル学習 ──
      try {
        const likedMsgs = await MindLinkStorage.getLikedMessages();
        if (likedMsgs && likedMsgs.length > 0) {
          const likedList = likedMsgs
            .sort((a, b) => b.likeCount - a.likeCount)
            .map(m => `[いいね数: ${m.likeCount}]\n${m.content}`)
            .join('\n\n');
          const stylePrompt = `以下はユーザーがいいねしたAIの返答です。
likeCount が多いほど強く好まれています。
文章をそのまま抽出せず、
「どんな言い回し・語尾・テンポ・雰囲気が好まれているか」
を傾向として簡潔に言語化してください。
定型文にならないよう、スタイルの特徴だけを抽出してください。
JSONなどの構造化は不要。自然な日本語で200文字以内。

${likedList.slice(0, 10000)}`;
          const styleSummary = await window.MindLinkAPI.getSummary(stylePrompt, false);
          if (styleSummary) {
            const today = new Date().toISOString().slice(0, 10);
            await MindLinkStorage.saveLikedStyleSummary({ date: today, summary: styleSummary });
            await MindLinkStorage.clearLikedMessages();
            console.log('[MindLink] いいねスタイル学習完了:', styleSummary);
          }
        }
      } catch (styleErr) {
        console.warn('[MindLink] いいねスタイル省察 failed:', styleErr);
      }

      // ── 古いいいねスタイル要約を自動削除（重み0.09以下 = 約10日以上前） ──
      try {
        const pruned = await MindLinkStorage.pruneOldLikedStyleSummaries(0.09);
        if (pruned > 0) {
          console.log(`[MindLink] 古いスタイル要約を${pruned}件削除しました`);
        }
      } catch (pruneErr) {
        console.warn('[MindLink] スタイル要約の自動削除に失敗:', pruneErr);
      }

      // リストの再描画
      await renderReflectionList();

    } catch (e) {
      console.error('[MindLink Reflection] Reflection failed:', e);
      MindLinkApp.showToast('省察に失敗しました: ' + e.message);
    }
  }

  // 今日の会話コンテキストを収集
  function gatherDailyContext() {
    const now = new Date();
    const todayStr = now.toLocaleDateString('ja-JP');
    const threads = MindLinkStorage.getThreads();
    let dailyLog = "";

    for (const thread of threads) {
      const messages = MindLinkStorage.getMessages(thread.id);
      const todayMsgs = messages.filter(m => {
        const d = new Date(m.timestamp || Date.now());
        return d.toLocaleDateString('ja-JP') === todayStr && !m.isSystem;
      });

      if (todayMsgs.length > 0) {
        dailyLog += `\n--- チャット: ${thread.title} ---\n`;
        dailyLog += todayMsgs.map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
      }
    }
    return dailyLog.trim();
  }

  // --- UI: 記憶ノート（省察一覧）の描画 ---

  async function renderReflectionList(reset = true) {
    const listEl = document.getElementById('reflection-list');
    if (!listEl) return;

    if (reset) {
      cachedReflections = await MindLinkStorage.getReflections();
      
      // 日付順（降順）に並び替え
      cachedReflections.sort((a, b) => b.createdAt - a.createdAt);
      currentDisplayCount = 0;
      listEl.innerHTML = '';
      
      if (cachedReflections.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>まだ省察データがありません。会話の終わりにAIがまとめを作成します。</p></div>';
        return;
      }
    } else {
      const loadMoreBtn = document.getElementById('load-more-reflections-btn');
      if (loadMoreBtn) loadMoreBtn.remove();
    }

    const nextCount = Math.min(currentDisplayCount + ITEMS_PER_PAGE, cachedReflections.length);
    const itemsToRender = cachedReflections.slice(currentDisplayCount, nextCount);

    itemsToRender.forEach(r => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'reflection-accordion-item';
      itemDiv.dataset.id = r.id;
      
      itemDiv.innerHTML = `
        <div class="reflection-header">
          <div class="reflection-header-left">
            <span class="reflection-date">📅 ${r.date}</span>
            <span class="reflection-title-pill">${r.sectionLabel || '省察録'}</span>
          </div>
          <div class="reflection-header-actions">
            <button class="reflection-action-btn-small edit-btn" title="編集">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
            <button class="reflection-action-btn-small delete-btn" title="削除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
              </svg>
            </button>
            <div class="reflection-chevron-wrapper">
              <svg class="reflection-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
          </div>
        </div>
        <div class="reflection-body">
          <div class="reflection-inner-content">${escapeHtml(r.content)}</div>
        </div>
      `;

      // ヘッダー全体（アクションボタン以外）をクリックで開閉
      itemDiv.querySelector('.reflection-header').addEventListener('click', (e) => {
        if (e.target.closest('.reflection-action-btn-small')) return;
        itemDiv.classList.toggle('active');
      });

      // 編集ボタン
      itemDiv.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(r);
      });

      // 削除ボタン
      itemDiv.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        MindLinkApp.showConfirm('省察録を削除', 'この省察データを削除しますか？\nRAGの記憶からも消去されます。', async () => {
          await MindLinkStorage.deleteReflection(r.id);
          await renderReflectionList();
          if (window.MindLinkApp) window.MindLinkApp.showToast('省察録を削除しました');
        });
      });

      listEl.appendChild(itemDiv);
    });

    currentDisplayCount = nextCount;

    if (currentDisplayCount < cachedReflections.length) {
      const btnWrapper = document.createElement('div');
      btnWrapper.id = 'load-more-reflections-btn';
      btnWrapper.style.textAlign = 'center';
      btnWrapper.style.marginTop = '16px';
      btnWrapper.style.marginBottom = '20px';
      
      const btn = document.createElement('button');
      btn.className = 'btn-secondary btn-sm';
      btn.textContent = 'さらに読み込む...';
      btn.onclick = () => renderReflectionList(false);
      
      btnWrapper.appendChild(btn);
      listEl.appendChild(btnWrapper);
    }
  }

  function openEditModal(reflection) {
    const modal = document.getElementById('edit-reflection-modal');
    if (!modal) return;
    document.getElementById('edit-reflection-id').value = reflection.id;
    document.getElementById('edit-reflection-content').value = reflection.content;
    modal.classList.add('active');
  }

  async function updateReflection() {
    const id = document.getElementById('edit-reflection-id').value;
    const content = document.getElementById('edit-reflection-content').value.trim();
    if (!id || !content) return;

    MindLinkApp.showToast('記憶を再構築中...');
    try {
      const emb = await window.MindLinkAPI.getEmbedding(content);
      await MindLinkStorage.updateReflection(id, { content, embedding: emb });
      closeModal('edit-reflection-modal');
      await renderReflectionList();
      MindLinkApp.showToast('記憶を更新しました ✨');
    } catch (e) {
      await MindLinkStorage.updateReflection(id, { content });
      closeModal('edit-reflection-modal');
      await renderReflectionList();
      MindLinkApp.showToast('内容のみ更新しました（ベクトル化失敗）');
    }
  }

  // --- UI: Data Management (Export/Import) ---

  async function handleExport() {
    try {
      await MindLinkStorage.exportRAGData();
      MindLinkApp.showToast('記憶データを書き出しました 💾');
    } catch (e) {
      console.error('Export failed:', e);
      MindLinkApp.showToast('エクスポートに失敗しました');
    }
  }

  async function handleImport(file) {
    if (!file) return;
    try {
      MindLinkApp.showToast('記憶を読み込んでいます...');
      const result = await MindLinkStorage.importRAGData(file);
      await renderReflectionList();
      MindLinkApp.showToast(`${result.count}件の記憶を読み込みました ✨`);
    } catch (e) {
      console.error('Import failed:', e);
      MindLinkApp.showToast('インポートに失敗しました。ファイル形式を確認してください。');
    }
  }

  // Gemini Embedding 2 への一括移行
  async function handleMigrateEmbeddings() {
    const reflections = await MindLinkStorage.getReflections();
    const memories = MindLinkStorage.getMemories();
    const total = reflections.length + memories.length;

    if (total === 0) {
      MindLinkApp.showToast('移行対象のデータがありません');
      return;
    }

    const confirmed = confirm(
      `📊 移行対象:\n` +
      `  省察データ: ${reflections.length}件\n` +
      `  記憶データ: ${memories.length}件\n` +
      `  合計: ${total}件\n\n` +
      `Gemini Embedding 2（新モデル）に再変換します。\n` +
      `所要時間: 約${Math.ceil(total * 1.5)}秒\n` +
      `コスト: ほぼ無料（1円未満）\n\n` +
      `⚠️ 処理中はアプリを閉じないでください\n\n開始しますか？`
    );
    if (!confirmed) return;

    const btn = document.getElementById('btn-migrate-embeddings');
    if (btn) { btn.disabled = true; }

    let successCount = 0;
    let failCount = 0;

    // 省察データの再Embedding
    for (let i = 0; i < reflections.length; i++) {
      const r = reflections[i];
      if (!r.content) continue;
      if (btn) btn.textContent = `🔄 省察 ${i + 1}/${reflections.length}件目...`;
      try {
        const embedding = await window.MindLinkAPI.getEmbedding(r.content);
        await MindLinkStorage.updateReflection(r.id, { embedding });
        successCount++;
      } catch (e) {
        console.error('[Migrate] 省察失敗:', r.id, e);
        failCount++;
      }
      await new Promise(res => setTimeout(res, 300));
    }

    // 記憶データの再Embedding
    const freshMemories = MindLinkStorage.getMemories();
    for (let i = 0; i < freshMemories.length; i++) {
      const m = freshMemories[i];
      if (!m.content) continue;
      if (btn) btn.textContent = `🔄 記憶 ${i + 1}/${freshMemories.length}件目...`;
      try {
        const embedding = await window.MindLinkAPI.getEmbedding(m.content);
        MindLinkStorage.updateMemory(m.id, { embedding });
        successCount++;
      } catch (e) {
        console.error('[Migrate] 記憶失敗:', m.id, e);
        failCount++;
      }
      await new Promise(res => setTimeout(res, 300));
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = '✅ 移行完了';
      setTimeout(() => { btn.textContent = '🔄 Embedding移行'; }, 4000);
    }
    const failMsg = failCount > 0 ? ` / ${failCount}件失敗` : '';
    MindLinkApp.showToast(`移行完了 ✅ ${successCount}件成功${failMsg}`);
  }

  // 初期化: ボタンリスナーの登録
  function initListeners() {
    document.getElementById('btn-export-rag')?.addEventListener('click', handleExport);
    
    const importInput = document.getElementById('input-import-rag');
    document.getElementById('btn-import-rag')?.addEventListener('click', () => {
      importInput?.click();
    });

    importInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleImport(e.target.files[0]);
        e.target.value = ''; // Reset for same file re-import if needed
      }
    });

    document.getElementById('btn-migrate-embeddings')?.addEventListener('click', handleMigrateEmbeddings);
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return {
    performReflection,
    renderReflectionList,
    updateReflection,
    initListeners
  };
})();

window.MindLinkReflection = MindLinkReflection;
