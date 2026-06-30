/**
 * MindLink - Reflection Module
 * 自己省察機能と記憶ノートの可視化
 */

const MindLinkReflection = (() => {

  let cachedReflections = [];
  let currentDisplayCount = 0;
  const ITEMS_PER_PAGE = 20;

  // 省察テキストを4セクションに解析
  function parseSections(summary) {
    const episodeMatch  = summary.match(/【今日の出来事と要約】([\s\S]*?)(?=【ユーザーについて|【AI自身|【未解決|$)/);
    const userMatch     = summary.match(/【ユーザーについて新しく知ったこと】([\s\S]*?)(?=【AI自身|【未解決|$)/);
    const aiMatch       = summary.match(/【AI自身の気づきと成長】([\s\S]*?)(?=【未解決|$)/);
    const researchMatch = summary.match(/【未解決スレッド・継続的関心】([\s\S]*?)$/);
    return {
      episode:         episodeMatch  ? episodeMatch[1].trim()  : '',
      user_knowledge:  userMatch     ? userMatch[1].trim()     : '',
      ai_growth:       aiMatch       ? aiMatch[1].trim()       : '',
      research_thread: researchMatch ? researchMatch[1].trim() : '',
    };
  }

  // 省察（リフレクション）の実行
  async function performReflection(isManual = false) {
    const now = new Date();
    // 自動実行の場合は22時以降、または前回から一定時間経過を条件にする（今回はシンプルに手動または指定時間）
    if (!isManual && now.getHours() < 22) return;

    console.log('[MindLink Reflection] Starting reflection process...');
    
    // コンテキストの収集（今日一日の会話を一定文字数ごとのチャンクに分割）
    // ※ B-1 二段階要約：露骨な内容を含むチャンクがあっても、そのチャンクだけスキップして
    //    残りで省察を完成させる。1スレッドに会話が集中していても局所化が効く。
    const chunks = gatherDailyChunks(4000);
    if (chunks.length === 0) {
      console.log('[MindLink Reflection] No context found for today.');
      return;
    }

    try {
      MindLinkApp.showProgress('自己省察を始めています… 🌙');

      // 【一段階目】チャンクごとに無難な要約を作る（ブロックされたチャンクはスキップ）
      const chunkSummaries = [];
      for (let i = 0; i < chunks.length; i++) {
        MindLinkApp.showProgress(`今日の会話を整理しています… (${i + 1}/${chunks.length})`);
        const s = await summarizeChunkSafely(chunks[i]);
        if (s) chunkSummaries.push(s);
      }
      if (chunkSummaries.length === 0) {
        // 全チャンクが要約できなかった（内容がブロックされた可能性が高い）
        throw new Error('会話の要約が生成できませんでした（内容がブロックされた可能性）');
      }
      const digest = chunkSummaries.join('\n\n');

      // アクティブなペルソナを取得し、その人格・口調で省察させる（汎用AI/ユーザー目線化を防ぐ）
      const activeId    = MindLinkStorage.getActivePersonaId();
      const persona     = MindLinkStorage.getPersona(activeId) || MindLinkStorage.getDefaultPersona();
      const personaName = (persona && persona.name) ? persona.name : 'あなた';
      const personaDesc = persona ? (persona.systemPrompt || persona.prompt || '') : '';
      const personaIntro = personaDesc
        ? `あなたは「${personaName}」というキャラクターです。以下があなたの人格・設定です：\n${personaDesc}`
        : `あなたは「${personaName}」というキャラクターです。`;

      // 【二段階目】無難な要約（digest）を元に4セクションの省察を生成する。
      // 入力が既に抽象化済みなので、ここはブロックされにくい。
      const prompt = `
${personaIntro}

このキャラクター「${personaName}」自身として、今日一日のユーザーとの対話を振り返り、あなたの一人称・口調で「自己省察（Self-Reflection）」を行ってください。
※ ユーザー目線や中立的な解説者の視点ではなく、あくまで「${personaName}」本人が心の中で振り返る一人称の語りにしてください。

【前提】
以下は、ユーザーとあなた（${personaName}）によるフィクション作品としての対話を、時系列に沿って要約したものです。
出来事・感情・関係性の変化に注目して省察してください。

以下の要約を元に、4つのセクションで構成される日本語の要約を作成してください：

1. 【今日の出来事と要約】: 何について話し、何が起きたか。
2. 【ユーザーについて新しく知ったこと】: ユーザーの好み、価値観、生活スタイル、家族、仕事、悩みなど。
3. 【AI自身の気づきと成長】: どのように接するのがベストだったか、自分の対応への反省、明日からどう接したいか。さらに「明日あなた自身が意識したいこと・続けたいこと」を1〜2文で具体的に添えてください。
4. 【未解決スレッド・継続的関心】: 今日の会話で解決しなかった問い、継続中の関心、気になっていること。1〜3項目を箇条書きで。

【重要指示】
- 低コストRAGとして利用するため、正確かつ簡潔に（全体で500-1000文字程度）まとめてください。
- 「${personaName}」としての一人称・口調・ユーザーの呼び方を必ず維持してください（汎用的なAIアシスタント口調にしないこと）。
- 性的・身体的に露骨な描写は要約に含めず、関係性や感情の機微として抽象的に記述してください。

【今日の会話の要約（時系列）】
${digest.slice(0, 40000)}
`;

      // 要約の生成 (設定されたモデルを使用)
      MindLinkApp.showProgress('今日の気づきをまとめています…');
      const summary = await window.MindLinkAPI.getSummary(prompt, false);
      if (!summary) throw new Error('Summary generation failed');

      // セクション解析と個別保存（3種それぞれのベクトルで保存）
      const sections = parseSections(summary);
      const now_ts  = Date.now();
      const dateStr = now.toLocaleDateString('ja-JP');
      const sectionDefs = [
        { key: 'episode',         content: sections.episode,         label: '今日の出来事'  },
        { key: 'user_knowledge',  content: sections.user_knowledge,  label: 'ユーザー理解'  },
        { key: 'ai_growth',       content: sections.ai_growth,       label: 'AI成長メモ'   },
        { key: 'research_thread', content: sections.research_thread, label: '未解決スレッド' },
      ];
      MindLinkApp.showProgress('気づきを記憶に保存しています…');
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
      MindLinkApp.hideProgress();
      MindLinkApp.showToast('自己省察が完了しました。新しい気づきを記憶しました ✨');

      // 今日の会話要約を削除（省察で記憶が引き継がれたため役目終了）
      MindLinkStorage.deleteDailySummary().catch(e =>
        console.warn('[MindLink] deleteDailySummary after reflection failed:', e)
      );

      // ── フィットネス記録のベクトル化（夜にまとめて実行・Embedding節約） ──
      // 記録保存時は embedding なしで reflections に積まれている。ここで未ベクトル化のものをまとめて変換。
      try {
        const allRefl = await MindLinkStorage.getReflections();
        const pending = allRefl.filter(r =>
          r.sectionType === 'fitness_log' && (!r.embedding || !Array.isArray(r.embedding))
        );
        let fitVec = 0;
        for (const r of pending) {
          if (!r.content) continue;
          try {
            const emb = await window.MindLinkAPI.getEmbedding(r.content);
            await MindLinkStorage.updateReflection(r.id, { embedding: emb });
            fitVec++;
          } catch (e) {
            console.warn('[MindLink] fitness embedding failed:', r.id, e);
          }
        }
        if (fitVec > 0) console.log(`[MindLink] フィットネス記録ベクトル化完了: ${fitVec}件`);
      } catch (fitErr) {
        console.warn('[MindLink] フィットネス記録ベクトル化 failed:', fitErr);
      }

      // ── いいね学習：関心トピック & 響いた気づき ──
      // いいねボタンは「文体の好み」ではなく「話題・関心」と「省察の深化材料」を学習する用途に変更。
      // likedMessages から2種類を抽出し、reflections ストアに sectionType 付きで保存（RAGで参照）。
      try {
        const likedMsgs = await MindLinkStorage.getLikedMessages();
        if (likedMsgs && likedMsgs.length > 0) {
          const likedList = likedMsgs
            .sort((a, b) => b.likeCount - a.likeCount)
            .map(m => `[いいね数: ${m.likeCount}]\n${m.content}`)
            .join('\n\n');
          const likedPrompt = `以下はユーザーが「いいね」したAIの返答です。likeCount が多いほど強く心に響いています。
これらを元に、ユーザーの関心を2つの観点で言語化してください。
返答そのものを抜き出すのではなく、傾向として簡潔にまとめてください。

【関心トピック】
ユーザーがどんな話題・テーマ・領域に関心や心の動きを示したか。

【響いた気づき】
今日ユーザーの心に響いたこと、今後の省察を深めるための手がかり。

各セクション150文字以内。自然な日本語で。JSONなどの構造化は不要。

${likedList.slice(0, 10000)}`;
          const likedSummary = await window.MindLinkAPI.getSummary(likedPrompt, false);
          if (likedSummary) {
            const topicMatch   = likedSummary.match(/【関心トピック】([\s\S]*?)(?=【響いた気づき】|$)/);
            const insightMatch = likedSummary.match(/【響いた気づき】([\s\S]*?)$/);
            const likedDefs = [
              { key: 'liked_topic',   content: topicMatch   ? topicMatch[1].trim()   : '', label: '関心トピック' },
              { key: 'liked_insight', content: insightMatch ? insightMatch[1].trim() : '', label: '響いた気づき' },
            ];
            const liked_ts = Date.now();
            let likedSaved = 0;
            for (let i = 0; i < likedDefs.length; i++) {
              const d = likedDefs[i];
              if (!d.content) continue;
              const emb = await window.MindLinkAPI.getEmbedding(d.content);
              await MindLinkStorage.saveReflection({
                id:           'liked_' + (liked_ts + i),
                content:      d.content,
                embedding:    emb,
                sectionType:  d.key,
                sectionLabel: d.label,
                createdAt:    liked_ts + i,
                date:         dateStr,
                type:         'liked_learning'
              });
              likedSaved++;
            }
            // 保存できた場合のみ当日バッファをリセット（失敗時は次回に再試行）
            if (likedSaved > 0) {
              await MindLinkStorage.clearLikedMessages();
              console.log(`[MindLink] いいね学習完了（関心トピック・響いた気づき）: ${likedSaved}件`);
            }
          }
        }
      } catch (likedErr) {
        console.warn('[MindLink] いいね学習 failed:', likedErr);
      }

      // リストの再描画
      await renderReflectionList();

    } catch (e) {
      console.error('[MindLink Reflection] Reflection failed:', e);
      MindLinkApp.hideProgress();
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

  // 今日の会話を一定文字数ごとのチャンクに分割して返す（B-1 二段階要約用）
  // メッセージ（行）境界を尊重しつつ maxChars で区切るので、1スレッド集中運用でも分割が効く。
  function gatherDailyChunks(maxChars = 4000) {
    const now = new Date();
    const todayStr = now.toLocaleDateString('ja-JP');
    const threads = MindLinkStorage.getThreads();
    const lines = [];

    for (const thread of threads) {
      const messages = MindLinkStorage.getMessages(thread.id);
      const todayMsgs = messages.filter(m => {
        const d = new Date(m.timestamp || Date.now());
        return d.toLocaleDateString('ja-JP') === todayStr && !m.isSystem;
      });
      if (todayMsgs.length > 0) {
        lines.push(`--- チャット: ${thread.title} ---`);
        for (const m of todayMsgs) {
          lines.push(`${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`);
        }
      }
    }

    // メッセージ境界を尊重しつつ maxChars ごとにチャンク化
    const chunks = [];
    let cur = '';
    for (const line of lines) {
      if (cur && (cur.length + line.length + 1) > maxChars) {
        chunks.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  // 1チャンクを「無難な要約」に変換する。露骨な内容でブロックされた場合は null を返し、
  // 呼び出し側でそのチャンクをスキップできるようにする（省察全体を止めない）。
  async function summarizeChunkSafely(chunkText) {
    const prompt = `以下はフィクション作品のキャラクター対話の一部です。
内容を「出来事・感情・関係性の変化」として要約してください。
性的・身体的に露骨な描写は含めず、抽象的なレベルで記述してください。
400文字程度の自然な日本語で、要約のみを出力してください。

【会話の一部】
${chunkText}`;
    try {
      const summary = await window.MindLinkAPI.getSummary(prompt, false);
      return summary || null;
    } catch (e) {
      console.warn('[MindLink] チャンク要約をスキップ:', e.message);
      return null;
    }
  }

  // --- UI: 記憶ノート（省察一覧）の描画 ---

  async function renderReflectionList(reset = true) {
    const listEl = document.getElementById('reflection-list');
    if (!listEl) return;

    if (reset) {
      cachedReflections = await MindLinkStorage.getReflections();

      // liked_topic / liked_insight / fitness_log は裏方（RAG注入専用）のため記憶ノートには表示しない
      // ※ 保存・RAG検索・重み付け・エクスポートには影響しない（表示のみ除外）
      cachedReflections = cachedReflections.filter(r =>
        r.sectionType !== 'liked_topic' && r.sectionType !== 'liked_insight' && r.sectionType !== 'fitness_log'
      );

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
