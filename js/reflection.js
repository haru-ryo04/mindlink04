/**
 * MindLink - Reflection Module
 * 自己省察機能と記憶ノートの可視化
 */

const MindLinkReflection = (() => {

  let cachedReflections = [];
  let currentDisplayCount = 0;
  const ITEMS_PER_PAGE = 20;
  // 終了スレッド（解決済み・引き継ぎ済み）の表示トグル（デフォルト非表示）
  let _showClosedThreads = false;

  // 未解決/終了スレッドの項目を「日付ごとに1枚のカード」へまとめる（表示専用・データは無変更）
  function groupThreadItems(list) {
    const result = [];
    const groups = new Map();
    for (const r of list) {
      if (r.sectionType === 'research_thread' || r.sectionType === 'closed_thread') {
        const key = r.sectionType + '|' + r.date;
        let g = groups.get(key);
        if (!g) {
          g = {
            isThreadGroup: true,
            id: 'group_' + key,
            date: r.date,
            sectionType: r.sectionType,
            sectionLabel: r.sectionType === 'research_thread' ? '未解決スレッド' : '終了スレッド',
            createdAt: r.createdAt,
            items: [],
          };
          groups.set(key, g);
          result.push(g); // 日付降順の並び位置を維持
        }
        g.items.push(r);
      } else {
        result.push(r);
      }
    }
    return result;
  }

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

  // セクション4（未解決スレッド）の棚卸し行を解析する（案2）。
  // 書式に従わない行は「新規」として扱い、情報が消える方向には倒れないようにする。
  // 番号の対応が取れない「解決/継続」は無視され、該当スレッドは開いたまま残る（安全側）。
  function parseThreadDirectives(sectionText) {
    const resolved = []; // { index }
    const carried  = []; // { index, content }
    const added    = []; // content
    const lines = String(sectionText).split('\n').map(l => l.trim()).filter(Boolean);
    for (const raw of lines) {
      const line = raw.replace(/^[-・*●○\s]+/, '');
      let m;
      if ((m = line.match(/^解決\s*#?\s*(\d+)/))) {
        resolved.push({ index: parseInt(m[1], 10) });
      } else if ((m = line.match(/^継続\s*#?\s*(\d+)\s*[:：]\s*(.+)$/))) {
        carried.push({ index: parseInt(m[1], 10), content: m[2].trim() });
      } else if ((m = line.match(/^新規\s*[:：]\s*(.+)$/))) {
        added.push(m[1].trim());
      } else if (line.length >= 5) {
        added.push(line); // 書式外の行も取りこぼさない
      }
    }
    return { resolved, carried, added };
  }

  // 省察（リフレクション）の実行
  // targetDateStr（'2026/7/2'形式）を指定すると、その日付の会話だけを対象にした「追い省察」になる。
  // 追い省察は当日データ（会話要約・いいねバッファ）に一切触れないため、当日分と混在しない。
  async function performReflection(isManual = false, targetDateStr = null) {
    const now = new Date();
    // 自動実行の場合は22時以降を条件にする（追い省察＝日付指定時は時刻を問わない）
    if (!isManual && !targetDateStr && now.getHours() < 22) return;

    const dayLabel = targetDateStr || '今日';
    console.log(`[MindLink Reflection] Starting reflection process... (${dayLabel})`);

    // コンテキストの収集（対象日の会話を一定文字数ごとのチャンクに分割）
    // ※ B-1 二段階要約：露骨な内容を含むチャンクがあっても、そのチャンクだけスキップして
    //    残りで省察を完成させる。1スレッドに会話が集中していても局所化が効く。
    const chunks = gatherDailyChunks(4000, targetDateStr);
    if (chunks.length === 0) {
      console.log(`[MindLink Reflection] No context found for ${dayLabel}.`);
      return;
    }

    try {
      MindLinkApp.showProgress(targetDateStr ? `${targetDateStr}の自己省察を始めています… 🌙` : '自己省察を始めています… 🌙');

      // 【一段階目】チャンクごとに無難な要約を作る（ブロックされたチャンクはスキップ）
      const chunkSummaries = [];
      for (let i = 0; i < chunks.length; i++) {
        MindLinkApp.showProgress(`${dayLabel}の会話を整理しています… (${i + 1}/${chunks.length})`);
        const s = await summarizeChunkSafely(chunks[i]);
        if (s) chunkSummaries.push(s);
      }
      if (chunkSummaries.length === 0) {
        // 全チャンクが要約できなかった（内容がブロックされた可能性が高い）
        throw new Error('会話の要約が生成できませんでした（内容がブロックされた可能性）');
      }
      const digest = chunkSummaries.join('\n\n');

      // ── 案2: 未解決スレッドの棚卸し用に、現在オープンなスレッド一覧を取得（直近10項目） ──
      let openThreads = [];
      try {
        const allRefl = await MindLinkStorage.getReflections();
        openThreads = allRefl
          .filter(r => r.sectionType === 'research_thread' && r.content)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 10);
      } catch (openErr) {
        console.warn('[MindLink Reflection] オープンスレッド取得失敗（棚卸しなしで継続）:', openErr);
      }
      const threadListText = openThreads.length > 0
        ? `\n【現在の未解決スレッド一覧（これまでの省察から・棚卸し対象）】\n` +
          openThreads.map((t, i) => `${i + 1}. ${String(t.content).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n') + '\n'
        : '';

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

このキャラクター「${personaName}」自身として、${targetDateStr ? 'その日' : '今日'}一日のユーザーとの対話を振り返り、あなたの一人称・口調で「自己省察（Self-Reflection）」を行ってください。
※ ユーザー目線や中立的な解説者の視点ではなく、あくまで「${personaName}」本人が心の中で振り返る一人称の語りにしてください。

【前提】
以下は、ユーザーとあなた（${personaName}）によるフィクション作品としての対話を、時系列に沿って要約したものです。
出来事・感情・関係性の変化に注目して省察してください。

以下の要約を元に、4つのセクションで構成される日本語の要約を作成してください：

1. 【今日の出来事と要約】: 何について話し、何が起きたか。
2. 【ユーザーについて新しく知ったこと】: ユーザーの好み、価値観、生活スタイル、家族、仕事、悩みなど。
3. 【AI自身の気づきと成長】: どのように接するのがベストだったか、自分の対応への反省、明日からどう接したいか。さらに「明日あなた自身が意識したいこと・続けたいこと」を1〜2文で具体的に添えてください。
4. 【未解決スレッド・継続的関心】: ${openThreads.length > 0
  ? `下の「現在の未解決スレッド一覧」を今日の会話と照らして棚卸しし、新しい関心も加えてください。各行を必ず次のいずれかの形式で書くこと：
   - 解決#番号: 一言（今日の会話で解決・完了したもの）
   - 継続#番号: 更新後の内容（まだ続いているもの。最新の状況を反映して書き直す）
   - 新規: 内容（今日新しく生まれた問い・関心）
   長期間進展がなく関心も薄れたものは、無理に継続せず「解決#番号: 自然消滅」でクローズしてよい。継続と新規は合わせて5項目以内に絞ること。`
  : `今日の会話で解決しなかった問い、継続中の関心、気になっていること。各行を「新規: 内容」の形式で1〜3項目。`}

【重要指示】
- 低コストRAGとして利用するため、正確かつ簡潔に（全体で500-1000文字程度）まとめてください。
- 「${personaName}」としての一人称・口調・ユーザーの呼び方を必ず維持してください（汎用的なAIアシスタント口調にしないこと）。
- 固有名詞・日付・話題の具体名は省略せず、そのまま記録してください。
- 性的・身体的に露骨な描写は要約に含めず、関係性や感情の機微として抽象的に記述してください（抽象化するのは露骨な描写だけで、それ以外の内容は具体的に）。

${threadListText}
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
      // 追い省察の場合は対象日の日付で保存する（当日の省察と混在しない）
      const dateStr = targetDateStr || now.toLocaleDateString('ja-JP');
      const sectionDefs = [
        { key: 'episode',         content: sections.episode,         label: '今日の出来事'  },
        { key: 'user_knowledge',  content: sections.user_knowledge,  label: 'ユーザー理解'  },
        { key: 'ai_growth',       content: sections.ai_growth,       label: 'AI成長メモ'   },
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

      // ── 未解決スレッドの棚卸し反映（案2）＋ 1項目=1レコード保存（案3） ──
      if (sections.research_thread) {
        const { resolved, carried, added } = parseThreadDirectives(sections.research_thread);

        // 解決: 該当スレッドをクローズ（RAG注入対象から自動で外れる。記憶ノートには残る）
        for (const r of resolved) {
          const target = openThreads[r.index - 1];
          if (!target) continue;
          try {
            await MindLinkStorage.updateReflection(target.id, {
              sectionType: 'closed_thread', sectionLabel: '解決済みスレッド'
            });
          } catch (e) { console.warn('[MindLink] スレッドのクローズ失敗:', target.id, e); }
        }

        // 継続: 旧レコードを「引き継ぎ済み」にして、更新後の内容を新規項目として保存する
        const newItems = [];
        for (const c of carried) {
          const target = openThreads[c.index - 1];
          if (target) {
            try {
              await MindLinkStorage.updateReflection(target.id, {
                sectionType: 'closed_thread', sectionLabel: '引き継ぎ済み'
              });
            } catch (e) { console.warn('[MindLink] スレッドの引き継ぎ処理失敗:', target.id, e); }
          }
          newItems.push(c.content); // 番号の対応が取れなくても内容は保存する（取りこぼし防止）
        }
        newItems.push(...added);

        // 新しい項目を1件ずつ個別のベクトルで保存（検索精度と項目単位の棚卸しのため）
        let threadIdx = 0;
        for (const item of newItems.slice(0, 6)) {
          try {
            const itemEmbedding = await window.MindLinkAPI.getEmbedding(item);
            await MindLinkStorage.saveReflection({
              id:           'refl_' + (now_ts + 10 + threadIdx),
              content:      item,
              embedding:    itemEmbedding,
              sectionType:  'research_thread',
              sectionLabel: '未解決スレッド',
              createdAt:    now_ts + 10 + threadIdx,
              date:         dateStr,
              type:         'daily_reflection'
            });
            savedCount++;
            threadIdx++;
          } catch (e) {
            console.warn('[MindLink] スレッド項目の保存失敗（スキップ）:', e);
          }
        }
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
      MindLinkApp.showToast(targetDateStr
        ? `${targetDateStr}の省察が完了しました。記憶を引き継ぎました ✨`
        : '自己省察が完了しました。新しい気づきを記憶しました ✨');

      // 今日の会話要約を削除（省察で記憶が引き継がれたため役目終了）
      // ※追い省察では削除しない：保存されているのは「今日の」要約であり、消すと当日の記憶補完が壊れるため
      if (!targetDateStr) {
        MindLinkStorage.deleteDailySummary().catch(e =>
          console.warn('[MindLink] deleteDailySummary after reflection failed:', e)
        );
      }

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
      // ※追い省察では実行しない：いいねバッファは「現在」に属するため、前日の日付で保存されるのを防ぐ
      try {
        const likedMsgs = targetDateStr ? [] : await MindLinkStorage.getLikedMessages();
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

  // 対象日の会話を一定文字数ごとのチャンクに分割して返す（B-1 二段階要約用）
  // メッセージ（行）境界を尊重しつつ maxChars で区切るので、1スレッド集中運用でも分割が効く。
  // targetDateStr 未指定なら今日（従来動作）。指定時はその日付（追い省察用）。
  function gatherDailyChunks(maxChars = 4000, targetDateStr = null) {
    const dateFilter = targetDateStr || new Date().toLocaleDateString('ja-JP');
    const threads = MindLinkStorage.getThreads();
    const lines = [];

    for (const thread of threads) {
      const messages = MindLinkStorage.getMessages(thread.id);
      const todayMsgs = messages.filter(m => {
        const d = new Date(m.timestamp || Date.now());
        return d.toLocaleDateString('ja-JP') === dateFilter && !m.isSystem;
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
  // ※抽象化するのは露骨な描写だけ。普通の話題は具体性を保持する（RAGの検索精度と地続き感の源泉のため）。
  async function summarizeChunkSafely(chunkText) {
    const prompt = `以下はフィクション作品のキャラクター対話の一部です。
後から読み返したときに具体的に思い出せる「記録」として要約してください。

【要約のルール】
- 何について話したか（話題・出来事・固有名詞・場所・日付・数字・決定事項）は省略せず具体的に残す
- 感情や関係性の変化も簡潔に添える
- 性的・身体的に露骨な描写だけは、直接的な表現を避けて関係性の機微として短く言い換える（それ以外の内容は抽象化しない）

500文字程度の自然な日本語で、要約のみを出力してください。

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

  // ── 追い省察（前日の取りこぼし検出と実行） ──

  // 「昨日の会話があるのに、昨日の日付の省察が無い」場合に昨日の日付文字列を返す。なければ null。
  async function checkCatchupNeeded() {
    const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('ja-JP');
    // 昨日のメッセージが存在するか（タイムスタンプの無いメッセージは対象外）
    const threads = MindLinkStorage.getThreads();
    let hasMessages = false;
    for (const thread of threads) {
      const messages = MindLinkStorage.getMessages(thread.id);
      if (messages.some(m => !m.isSystem && m.content && m.timestamp &&
          new Date(m.timestamp).toLocaleDateString('ja-JP') === yesterdayStr)) {
        hasMessages = true;
        break;
      }
    }
    if (!hasMessages) return null;
    // 昨日の日付の省察が既にあるか
    const reflections = await MindLinkStorage.getReflections();
    const hasReflection = reflections.some(r => r.date === yesterdayStr && r.type === 'daily_reflection');
    return hasReflection ? null : yesterdayStr;
  }

  // 起動時の自動追い省察。失敗しても記憶ノートのバナーから手動で再実行できる
  // （検出条件が残り続ける限りバナーが出るため、フラグ管理は不要）。
  async function runCatchupReflectionIfNeeded() {
    try {
      const dateStr = await checkCatchupNeeded();
      if (!dateStr) return;
      console.log('[MindLink Reflection] 未省察の前日分を検出、追い省察を実行:', dateStr);
      await performReflection(false, dateStr);
    } catch (e) {
      console.warn('[MindLink Reflection] 追い省察に失敗（記憶ノートから手動実行できます）:', e);
    }
  }

  // --- UI: 記憶ノート（省察一覧）の描画 ---

  async function renderReflectionList(reset = true) {
    const listEl = document.getElementById('reflection-list');
    if (!listEl) return;

    if (reset) {
      cachedReflections = await MindLinkStorage.getReflections();

      // liked_topic / liked_insight / fitness_log / video_memo は裏方（RAG注入専用）のため記憶ノートには表示しない
      // ※ 保存・RAG検索・重み付け・エクスポートには影響しない（表示のみ除外）
      cachedReflections = cachedReflections.filter(r =>
        r.sectionType !== 'liked_topic' && r.sectionType !== 'liked_insight' && r.sectionType !== 'fitness_log' && r.sectionType !== 'video_memo'
      );

      // 終了スレッド（解決済み・引き継ぎ済み）はデフォルト非表示（トグルで表示可能）
      const closedCount = cachedReflections.filter(r => r.sectionType === 'closed_thread').length;
      if (!_showClosedThreads) {
        cachedReflections = cachedReflections.filter(r => r.sectionType !== 'closed_thread');
      }

      // 日付順（降順）に並び替え → スレッド項目は日付ごとに1枚へグループ化（表示のみ）
      cachedReflections.sort((a, b) => b.createdAt - a.createdAt);
      cachedReflections = groupThreadItems(cachedReflections);
      currentDisplayCount = 0;
      listEl.innerHTML = '';

      // 終了スレッドの表示トグル（終了スレッドが存在する場合のみ）
      if (closedCount > 0) {
        const toggleWrap = document.createElement('div');
        toggleWrap.style.cssText = 'text-align:right;margin-bottom:8px;';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn-secondary btn-sm';
        toggleBtn.textContent = _showClosedThreads
          ? `🗄 終了したスレッドを隠す（${closedCount}件）`
          : `🗄 終了したスレッドを表示（${closedCount}件）`;
        toggleBtn.onclick = () => {
          _showClosedThreads = !_showClosedThreads;
          renderReflectionList();
        };
        toggleWrap.appendChild(toggleBtn);
        listEl.appendChild(toggleWrap);
      }

      // 前日の未省察バナー（自動追い省察が失敗/スキップされた場合の手動リカバリ）
      try {
        const pendingDate = await checkCatchupNeeded();
        if (pendingDate) {
          const banner = document.createElement('div');
          banner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-surface-2);font-size:0.88rem;';
          const label = document.createElement('span');
          label.textContent = `⏳ 昨日（${pendingDate}）の省察が未完了です`;
          const btn = document.createElement('button');
          btn.className = 'btn-secondary btn-sm';
          btn.textContent = '今すぐ実行';
          btn.onclick = async () => {
            btn.disabled = true;
            await performReflection(true, pendingDate);
          };
          banner.appendChild(label);
          banner.appendChild(btn);
          listEl.appendChild(banner);
        }
      } catch (e) {
        console.warn('[MindLink] 追い省察バナーの判定に失敗:', e);
      }

      if (cachedReflections.length === 0) {
        listEl.insertAdjacentHTML('beforeend', '<div class="empty-state"><p>まだ省察データがありません。会話の終わりにAIがまとめを作成します。</p></div>');
        return;
      }
    } else {
      const loadMoreBtn = document.getElementById('load-more-reflections-btn');
      if (loadMoreBtn) loadMoreBtn.remove();
    }

    const nextCount = Math.min(currentDisplayCount + ITEMS_PER_PAGE, cachedReflections.length);
    const itemsToRender = cachedReflections.slice(currentDisplayCount, nextCount);

    itemsToRender.forEach(r => {
      // 日付ごとにまとめたスレッドカード（表示専用グループ）
      if (r.isThreadGroup) {
        renderThreadGroupCard(listEl, r);
        return;
      }

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

  // スレッドグループカードの描画（中に項目を箇条書き表示・項目ごとに編集/削除可能）
  function renderThreadGroupCard(listEl, group) {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'reflection-accordion-item';
    itemDiv.dataset.id = group.id;

    const rowsHtml = group.items.map(item => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid var(--color-border);">
        <div style="flex:1;min-width:0;">
          ${group.sectionType === 'closed_thread' ? `<span style="opacity:0.6;font-size:0.75rem;">[${escapeHtml(item.sectionLabel || '終了')}]</span> ` : ''}${escapeHtml(item.content)}
        </div>
        <button class="reflection-action-btn-small thread-item-edit" data-id="${item.id}" title="編集">✏️</button>
        <button class="reflection-action-btn-small thread-item-delete" data-id="${item.id}" title="削除">🗑</button>
      </div>`).join('');

    itemDiv.innerHTML = `
      <div class="reflection-header">
        <div class="reflection-header-left">
          <span class="reflection-date">📅 ${group.date}</span>
          <span class="reflection-title-pill">${group.sectionLabel}（${group.items.length}件）</span>
        </div>
        <div class="reflection-header-actions">
          <div class="reflection-chevron-wrapper">
            <svg class="reflection-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
        </div>
      </div>
      <div class="reflection-body">
        <div class="reflection-inner-content">${rowsHtml}</div>
      </div>
    `;

    itemDiv.querySelector('.reflection-header').addEventListener('click', () => {
      itemDiv.classList.toggle('active');
    });

    itemDiv.querySelectorAll('.thread-item-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = group.items.find(i => i.id === btn.dataset.id);
        if (target) openEditModal(target);
      });
    });

    itemDiv.querySelectorAll('.thread-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        MindLinkApp.showConfirm('スレッド項目を削除', 'この項目を削除しますか？\nRAGの記憶からも消去されます。', async () => {
          await MindLinkStorage.deleteReflection(btn.dataset.id);
          await renderReflectionList();
          MindLinkApp.showToast('削除しました');
        });
      });
    });

    listEl.appendChild(itemDiv);
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

  // ── 全体バックアップ（ペルソナ・記憶・スレッド・省察などを1ファイルに） ──

  async function handleFullExport() {
    try {
      MindLinkApp.showToast('全体バックアップを作成しています...');
      await MindLinkStorage.exportFullBackup();
      MindLinkApp.showToast('全体バックアップを書き出しました 💾（APIキーは含まれません）');
    } catch (e) {
      console.error('Full export failed:', e);
      MindLinkApp.showToast('全体バックアップに失敗しました');
    }
  }

  async function handleFullImport(file) {
    if (!file) return;
    try {
      MindLinkApp.showToast('バックアップを読み込んでいます...');
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await MindLinkStorage.importFullBackup(data);
      // 画面反映
      await renderReflectionList();
      if (window.MindLinkThreads && MindLinkThreads.renderThreadList) MindLinkThreads.renderThreadList();
      MindLinkApp.showToast(
        `復元完了 ✨ ペルソナ${r.personas}・記憶${r.memories}・スレッド${r.threads}・省察${r.reflections}件（重複はスキップ）`
      );
    } catch (e) {
      console.error('Full import failed:', e);
      MindLinkApp.showToast('復元に失敗しました。ファイル形式を確認してください。');
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

    // 全体バックアップ
    document.getElementById('btn-export-full')?.addEventListener('click', handleFullExport);
    const fullImportInput = document.getElementById('input-import-full');
    document.getElementById('btn-import-full')?.addEventListener('click', () => {
      fullImportInput?.click();
    });
    fullImportInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFullImport(e.target.files[0]);
        e.target.value = '';
      }
    });
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
    checkCatchupNeeded,
    runCatchupReflectionIfNeeded,
    renderReflectionList,
    updateReflection,
    initListeners
  };
})();

window.MindLinkReflection = MindLinkReflection;
