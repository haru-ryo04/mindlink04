/**
 * MindLink - Gemini API Module
 * Verbatim Parts Preservation Model
 */

const MindLinkAPI = (() => {
  console.log('[MindLink API] v14 (Time Insight Optimized) Loaded');
  const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

  function getEffectiveModel(threadId) {
    if (threadId) {
      const thread = MindLinkStorage.getThread(threadId);
      if (thread && thread.model) return thread.model;
    }
    return 'gemini-2.5-flash';
  }

  /**
   * テキストをベクトル化 (Embedding)
   */
  async function getEmbedding(text) {
    const apiKey = await MindLinkAuth.getApiKey('gemini');
    if (!apiKey) throw new Error('APIキー未設定');

    // Embedding は gemini-embedding-2 のみを使用する。
    // 旧モデル(gemini-embedding-001)へのフォールバックは次元数が異なり、
    // 保存済みベクトルと混在すると類似度計算が壊れるため行わない。
    // 失敗時はエラーを投げ、呼び出し側(RAG)は空配列で受けてチャットを継続する。
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Embedding Error (Status ${response.status})`);
    }

    const data = await response.json();
    return data.embedding.values;
  }

  /**
   * 要約・省察の生成
   */
  async function getSummary(prompt, usePro = false) {
    const apiKey = await MindLinkAuth.getApiKey('gemini');
    if (!apiKey) throw new Error('APIキー未設定');

    const settings = MindLinkStorage.getSettings();
    const model = usePro ? 'gemini-3.1-flash-lite' : (settings.summaryModel || 'gemini-2.5-flash');
    const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `要約生成エラー (HTTP ${response.status})`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      // HTTP 200 でも本文が空になるケース（セーフティブロック等）の原因を可視化する。
      // ・promptFeedback.blockReason : 入力プロンプト自体がブロックされた
      // ・candidates[0].finishReason : 出力が SAFETY / RECITATION / MAX_TOKENS 等で停止
      const blockReason  = data?.promptFeedback?.blockReason;
      const finishReason = data?.candidates?.[0]?.finishReason;
      let detail;
      if (blockReason)       detail = `入力がブロックされました (${blockReason})`;
      else if (finishReason) detail = `応答が生成されませんでした (${finishReason})`;
      else                   detail = '応答が空でした';
      throw new Error(`要約生成に失敗: ${detail}`);
    }
    return text;
  }

  /**
   * 添付ファイル・URLの内容を200文字で要約
   */
  async function summarizeAttachment(attachment) {
    const apiKey = await MindLinkAuth.getApiKey('gemini');
    if (!apiKey) throw new Error('APIキー未設定');

    const settings = MindLinkStorage.getSettings();
    const model = settings.summaryModel || 'gemini-3.1-flash-lite';
    const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

    const parts = [];

    if (attachment.data && attachment.data.includes(',')) {
      // 画像・PDF・ファイル（Base64）
      parts.push({
        inlineData: {
          mimeType: attachment.type || 'image/jpeg',
          data: attachment.data.split(',')[1],
        }
      });
      parts.push({ text: 'この添付ファイルの内容を200文字以内で簡潔に要約してください。ファイル名・種類・主な内容を含めてください。' });
    } else if (attachment.url) {
      // URLコンテキスト
      parts.push({ text: `以下のURLの内容を200文字以内で簡潔に要約してください。\nURL: ${attachment.url}` });
    } else {
      return null;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  }

  /**
   * 今日の会話要約を生成・IndexedDBに上書き保存（バックグラウンド処理）
   */
  async function generateDailySummary() {
    try {
      const apiKey = await MindLinkAuth.getApiKey();
      if (!apiKey) return;

      const threads = MindLinkStorage.getThreads();
      const today = new Date().toLocaleDateString('ja-JP');
      let dailyLog = '';

      for (const thread of threads) {
        const messages = MindLinkStorage.getMessages(thread.id);
        const todayMsgs = messages.filter(m => {
          const d = new Date(m.timestamp || Date.now());
          return d.toLocaleDateString('ja-JP') === today && !m.isSystem && m.content;
        });
        if (todayMsgs.length > 0) {
          dailyLog += `\n[「${thread.title}」の会話]\n`;
          dailyLog += todayMsgs.map(m =>
            `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 200)}`
          ).join('\n');
        }
      }

      if (!dailyLog.trim()) return;

      const settings = MindLinkStorage.getSettings();
      const model = settings.summaryModel || 'gemini-3.1-flash-lite';
      const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;
      const prompt = `以下の会話を要約してください。\n必ず以下の3セクションで構造化すること：\n\n📅 今日の出来事\n記念日・イベント・特別な出来事を具体的に記述。\n日付・固有名詞・場所は省略しない。\n\n💬 会話の流れ\nどんな話題で盛り上がったか、重要なやりとりや決定事項。\n\n💕 感情メモ\nユーザーの気持ち・感情の変化、あなたとの会話の雰囲気・トーン。\n\n合計500文字以内。箇条書き推奨。\n\n${dailyLog.slice(0, 8000)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
        })
      });

      if (!response.ok) return;
      const data = await response.json();
      const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (summary) {
        await MindLinkStorage.saveDailySummary(summary);
        console.log('[MindLink] Daily summary updated.');
      }
    } catch (e) {
      console.warn('[MindLink] generateDailySummary error:', e);
    }
  }

  /**
   * メッセージ整形 (Verbatim Mode)
   */
  // 指数バックオフ用のスリープ
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ロール統合用ヘルパー
  function mergeRoles(turns) {
    const merged = [];
    for (const turn of turns) {
      if (!turn.parts || turn.parts.length === 0) continue;
      if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
        merged[merged.length - 1].parts = [...merged[merged.length - 1].parts, ...turn.parts];
      } else {
        merged.push({ role: turn.role, parts: [...turn.parts] });
      }
    }
    return merged;
  }

  function formatMessages(messages) {
    if (!messages || messages.length === 0) {
      console.warn('[MindLink API] formatMessages: empty messages — using fallback turn');
      return [{ role: 'user', parts: [{ text: 'こんにちは' }] }];
    }

    // 1. 各メッセージをロールとパーツに変換
    let turns = messages.map(msg => {
      let parts = [];
      
      // テキスト内容
      if (msg.content && msg.content.trim()) {
        parts.push({ text: msg.content });
      }

      // 添付ファイル (画像, PDF, テキスト)
      if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
          if (att.data && att.data.includes(',')) {
            let finalMimeType = att.type || 'image/jpeg';
            // Markdownファイルをテキストとして認識させる
            if (finalMimeType.includes('markdown') || finalMimeType === '') {
                finalMimeType = 'text/plain';
            }
            parts.push({ 
              inlineData: { 
                mimeType: finalMimeType, 
                data: att.data.split(',')[1] 
              } 
            });
          }
        });
      }

      // 関数呼び出し
      if (msg.functionCalls) {
        msg.functionCalls.forEach(c => parts.push({ functionCall: c }));
      }
      
      // 関数応答
      if (msg.functionResponses) {
        msg.functionResponses.forEach(r => {
          parts.push({
            functionResponse: {
              name: r.functionName || r.functionResponse?.name,
              response: r.response || r.functionResponse?.response
            }
          });
        });
      }

      // 既存パーツがあればマージ
      if (msg.parts && msg.parts.length > 0) {
        parts = [...parts, ...msg.parts];
      }

      // ロールの決定
      let role = (msg.role === 'assistant') ? 'model' : 'user';
      if (msg.role === 'function' || msg.role === 'tool' || parts.some(p => p.functionResponse)) {
        role = 'function';
      }

      return { role, parts };
    });

    // 2. 有効なパーツを持つターンのみ保持
    turns = turns.filter(t => t.parts.length > 0);

    // 3. ロールの統合
    let merged = mergeRoles(turns);

    // 4. API制約：user ロールで開始
    while (merged.length > 0 && merged[0].role !== 'user') {
      merged.shift();
    }

    // 5. 最終フォールバック：merged が空でも必ず user ターンを1つ返す
    //    （iOS PWA で履歴が壊れ contents が空になる事故を防ぐ最後の砦）
    if (merged.length === 0) {
      // 直近の有効な user メッセージの本文を優先的に拾う
      const lastUser = [...messages].reverse().find(m => m.role === 'user' && m.content && m.content.trim());
      const fallbackText = lastUser
        ? lastUser.content.trim()
        : (messages[messages.length - 1]?.content?.trim() || 'こんにちは');
      console.warn('[MindLink API] formatMessages: merged empty — using fallback text', {
        fallbackText, originalCount: messages.length
      });
      return [{ role: 'user', parts: [{ text: fallbackText }] }];
    }

    return merged;
  }



  async function streamChat({ messages, persona, onChunk, onComplete, onError, signal }) {
    const settings = MindLinkStorage.getSettings();
    const apiKey = await MindLinkAuth.getApiKey();
    if (!apiKey) return onError('APIキー未設定');

    const threadId = MindLinkThreads.getCurrentThreadId();
    const requestedModel = getEffectiveModel(threadId);

    // 今日の会話要約を事前取得（プロンプト注入用・ループ外で1回のみ）
    const _dailySummary = await MindLinkStorage.getDailySummary();
    const dailySummaryPrompt = _dailySummary
      ? `\n\n【優先度3：今日の会話の流れ（同日内の記憶補完）】\n※ コンテキストウィンドウを超えた本日の会話要約です。現在の会話を優先しつつ、今日の文脈理解の参考にしてください。\n${_dailySummary}`
      : '';

    // フォールバック用のモデルチェーン
    // url_context（URL読み取り）を維持するため、対応モデル（3系）のみに限定。
    // ・2.5系は url_context 非対応のため除外（URLを読めず誤動作する）
    // ・3.1-pro は高コストのため自動フォールバックには含めない
    // → 安価で安定した gemini-3.1-flash-lite を唯一の落ち先にする
    const fallbackChain = [
      requestedModel,
      'gemini-3.1-flash-lite'
    ];

    // ツールループ用：現在のメッセージ列・追加済みIDを管理
    let currentMessages = [...messages];
    const allAddedMessageIds = [];
    let lastError = null;
    let webSearchUsed = false; // Web検索（custom_search / googleSearch Grounding）使用フラグ

    // ツール呼び出しが発生するたびにループを継続する
    toolLoop: while (true) {

      for (let modelIdx = 0; modelIdx < fallbackChain.length; modelIdx++) {
        const actualModel = fallbackChain[modelIdx];
        const maxRetries = 5; // 503多発時に備えて余裕を持たせる

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // tryの外に宣言してcatch内からアクセス可能にする
          let fullText = '';
          let allParts = [];
          let finishReason = null;
          // ── アイドルタイムアウト（30秒）用 ──
          const TIMEOUT_MS = 90000; // url_context（URL読み取り）は初動が遅いため余裕を持たせる
          let timedOut = false;
          let idleTimer = null;
          const timeoutController = new AbortController();
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, TIMEOUT_MS);
          };
          // 外部signal（停止ボタン）が発火したら内部controllerもabortして両立させる
          const onExternalAbort = () => timeoutController.abort();
          if (signal) {
            if (signal.aborted) timeoutController.abort();
            else signal.addEventListener('abort', onExternalAbort, { once: true });
          }
          try {
            if (signal?.aborted) return;

            if (attempt > 0) {
              const backoffMs = Math.pow(2, attempt) * 2000; // ベース2秒（2s, 4s, 8s, 16s...）
              const retryMsg = `> ⚠️ [系統] サーバー混雑のため再試行中 (${attempt}/${maxRetries - 1}) — ${backoffMs / 1000}秒後に再送信...`;
              onChunk(retryMsg, retryMsg);
              await sleep(backoffMs);
            }

            const formattedMessages = formatMessages(currentMessages);
            const url = `${BASE_URL}/models/${actualModel}:streamGenerateContent?key=${apiKey}&alt=sse`;

            const isGemini2_5 = actualModel.includes('gemini-2.5');
            const tools = [];
            let hasFunctionDeclarations = false;
            // グラウンディング（googleSearch）は全モデルで付与（gemini-2.5系も公式にサポート）
            tools.push({ googleSearch: {} });
            // url_context は gemini-2.5系では googleSearch と同時付与できない（公式制約）ため除外。
            // function_declarations（custom_search等の関数ツール）も tool context circulation
            // 非対応の gemini-2.5系では引き続き除外する。
            if (!isGemini2_5) {
              tools.push({ url_context: {} });
              if (window.MindLinkGoogleServices) {
                const cx = settings.searchEngineId;
                // cx 未設定時は custom_search を除外（モデルが呼ぼうとして失敗するのを防ぐ）
                const declarations = cx
                  ? window.MindLinkGoogleServices.TOOL_DECLARATIONS
                  : window.MindLinkGoogleServices.TOOL_DECLARATIONS.filter(t => t.name !== 'custom_search');
                if (declarations.length > 0) {
                  tools.push({ function_declarations: declarations });
                  hasFunctionDeclarations = true;
                }
              }
            }

            const nowJST = new Date();
            // JSTの時刻文字列（表示用）
            const timeStr = new Intl.DateTimeFormat('ja-JP', {
              timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
              weekday: 'short', hour: '2-digit', minute: '2-digit'
            }).format(nowJST);

            // JSTの時間帯ラベルをJavaScript側で計算して直接埋め込む（モデルのUTC誤認防止）
            // % 24 で深夜0時を「24」と返すブラウザの互換性問題を回避
            const jstHour = parseInt(new Intl.DateTimeFormat('ja-JP', {
              timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false
            }).format(nowJST), 10) % 24;
            let timeOfDay;
            if (jstHour >= 5 && jstHour < 8)       timeOfDay = '早朝';
            else if (jstHour >= 8 && jstHour < 12)  timeOfDay = '午前中';
            else if (jstHour >= 12 && jstHour < 14) timeOfDay = 'お昼ごろ';
            else if (jstHour >= 14 && jstHour < 17) timeOfDay = '午後';
            else if (jstHour >= 17 && jstHour < 19) timeOfDay = '夕方';
            else if (jstHour >= 19 && jstHour < 23) timeOfDay = '夜';
            else                                     timeOfDay = '深夜〜明け方';

            // システム指示：時刻はあくまで内部参照用
            const timeInstruction = `
【現在時刻（システム計測・日本標準時）】
- 正確な現在時刻: ${timeStr}
- 時間帯: ${timeOfDay}
※ この情報はシステムがリアルタイムで計算した正確な値です。自分で時刻を推測・計算しないでください。

【時刻の使い方】
- ユーザーから現在時刻を直接尋ねられた場合のみ、上記の時刻をそのまま答えてください。
- それ以外の場面では、時刻を読み上げる必要はありません。
  ただし、上記の時間帯を常に意識した上で、会話の文脈に合わせて自然に時間感覚を表現してください。
- 時間帯に合わない表現（夜なのに朝の雰囲気、朝なのに夜の雰囲気）は使わないでください。`.trim();

            const finalMessages = [...formattedMessages];

            const body = {
              contents: finalMessages,
              generationConfig: {
                temperature: parseFloat(settings.temperature) || 0.7,
                maxOutputTokens: parseInt(settings.maxTokens) || 4096,
              }
            };

            if (tools.length > 0) {
              body.tools = tools;
              const toolConfig = {};
              // include_server_side_tool_invocations は tool call context circulation を要するが
              // gemini-2.5系は非対応（"Tool call context circulation is not enabled" エラー）のため
              // 非2.5系のみ有効化する。2.5系は googleSearch 単独でグラウンディングが動作する。
              if (!isGemini2_5) {
                toolConfig.include_server_side_tool_invocations = true;
              }
              // function_calling_config は関数ツール（function_declarations）を付与した時のみ設定
              if (hasFunctionDeclarations) {
                toolConfig.function_calling_config = { mode: "AUTO" };
              }
              // 空でなければ付与（2.5系は googleSearch のみで tool_config 不要）
              if (Object.keys(toolConfig).length > 0) {
                body.tool_config = toolConfig;
              }
            }

            let profilePrompt = "";
            if (settings.userName || settings.userBio) {
              profilePrompt = `\n\n【優先度1：対話相手（ユーザー）の情報（絶対的事実）】\n※以下はあなたが会話している相手（ユーザー）の情報です。あなた自身（AI）の情報ではありません。混同しないでください。\n`;
              if (settings.userName) profilePrompt += `・ユーザーの呼び名: ${settings.userName}\n`;
              if (settings.userBio) profilePrompt += `・ユーザーのプロフィール/自己紹介: ${settings.userBio}\n`;
            }

            const allMemories = MindLinkStorage.getMemories();
            let finalMemories = [];
            if (allMemories.length > 0) {
              const importantMemories = allMemories.filter(m => m.tags.includes('重要') || m.category === 'important');
              const seenIds = new Set();
              for (const m of importantMemories) {
                finalMemories.push(m);
                seenIds.add(m.id);
              }
              if (window.MindLinkRAG && window.MindLinkRAG.searchMemories) {
                const lastUserMsg = [...formattedMessages].reverse().find(m => m.role === 'user');
                const queryText = lastUserMsg ? lastUserMsg.parts.map(p => p.text || "").join(" ") : "";
                if (queryText) {
                  const relevantMemories = await window.MindLinkRAG.searchMemories(queryText, 3);
                  for (const m of relevantMemories) {
                    if (!seenIds.has(m.id)) {
                      finalMemories.push(m);
                      seenIds.add(m.id);
                    }
                  }
                }
              }
            }
            let memoryPrompt = finalMemories.length > 0 ? ("\n\n【優先度5：個別記憶（※1位の情報を正としてください）】\n" + finalMemories.map(m => `- ${m.content}`).join('\n')) : "";

            const basePromptText = (persona && (persona.systemPrompt || persona.prompt)) ? (persona.systemPrompt || persona.prompt) : "あなたは親切なAIです。";
            const basePrompt = `\n\n【優先度1：あなた（AI）自身の役割・人格・カスタム指示】\n※以下はあなた自身の設定です。ユーザーの情報と混同しないでください。\n${basePromptText}`;

            const technicalAutonomyInstruction = `
\n\n【優先度1：システム機能の利用ルール】
1. 追伸・連投機能: 言い忘れや、少し時間を置いてから追伸を送る必要がある場合、\`[CONTINUE]\`を付けて指示を出してください。
2. メモリ機能: ユーザーに関する重要な情報を \`add_memory\` ツールで保存してください。
3. 自己省察: 今日一日の会話の締めくくりとして、あなたの内面的な成長やユーザーへの深い理解を整理したい場合は、反映メニューから省察を実行してください。
4. カレンダー機能（自律的に活用してください）:
   - 【参照・確認】会話の中で日程・予定・スケジュールに関連する話題が出たら、明示的に求められなくても \`list_app_calendar_events\` を自律的に呼び出して予定を確認し、会話に自然に織り込んでください。（例: 「来週ヒマ？」「〇〇行きたいな」「病院行かないと」など）
   - 【追加・変更・削除】予定の登録・修正・削除は、まずユーザーに「〇〇を予定に追加しようか？」と確認を取ってから \`add_app_calendar_event\`・\`update_calendar_event\`・\`delete_app_calendar_event\` を実行してください。ユーザーが同意した場合のみ実行します。
5. Spotify機能（Spotifyに接続済みの場合のみ使用）:
   - 【再生操作】「〇〇かけて」「〇〇流して」と言われたら \`spotify_play_track\` で即座に検索・再生してください。確認なしで実行してOKです。
   - 【停止・再開】「止めて」「一時停止」→ \`spotify_pause\`、「再開して」「続けて」→ \`spotify_resume\` を使用。
   - 【スキップ】「次の曲」→ \`spotify_next_track\`、「前の曲」→ \`spotify_previous_track\`。
   - 【音量】「音量上げて」→ 現在より+20程度で \`spotify_set_volume\`、「音量下げて」→ -20程度。「音量〇〇にして」→ 指定値で設定。
   - 【確認】「今何聴いてる？」「今の曲は？」→ \`spotify_get_current_track\` で最新情報を取得して答える。
   - Spotifyが未連携・未ログインの場合は「Spotifyが連携されていないためできません」と伝えてください。`.trim();

            const searchInstruction = `\n\n【優先度1：検索機能の使い分けルール】
■ 通常のウェブ検索（最新情報・ニュース・一般的な調べ物）
→ googleSearch グラウンディングを使用してください（自動で行われます）。

■ 特定サイト検索（「〇〇サイトで調べて」「公式サイトを検索して」「〇〇のページを探して」など）
→ custom_search ツールを使用し、site パラメータに対象ドメインを指定してください（cx設定時のみ利用可能）。

■ URL読み取り（ユーザーがURLを共有した場合）
→ url_context ツールでページ内容を自動読み取りし、要約・翻訳・質問への回答を行ってください。

■ 場所・店舗の周辺検索
→ まず get_current_location で現在地を取得し、search_nearby_places で検索してください。`;


            let ragPrompt = "";
            if (window.MindLinkRAG) {
              const lastUserMsg = [...formattedMessages].reverse().find(m => m.role === 'user');
              const queryText = lastUserMsg ? lastUserMsg.parts.map(p => p.text || "").join(" ") : "";
              if (queryText) {
                try {
                  // Embeddingは1回だけ生成し、両検索で使い回す（API二重呼び出しの解消）
                  const queryEmbedding = await window.MindLinkAPI.getEmbedding(queryText);
                  // searchResearchThreads が未定義（古いrag.js等）でも継続できるよう存在チェック
                  const hasResearchThreads = typeof window.MindLinkRAG.searchResearchThreads === 'function';
                  const [refs, researchThreads] = await Promise.all([
                    window.MindLinkRAG.searchReflections(queryText, 6, queryEmbedding),
                    hasResearchThreads
                      ? window.MindLinkRAG.searchResearchThreads(queryText, 2, queryEmbedding)
                      : Promise.resolve([]),
                  ]);
                  if (refs.length > 0 || researchThreads.length > 0) {
                    const knowledge = refs.filter(r => ['user_knowledge', 'ai_growth', 'liked_topic', 'liked_insight'].includes(r.sectionType)).slice(0, 4);
                    const episodes  = refs.filter(r => r.sectionType === 'episode' || !r.sectionType).slice(0, 2);
                    const fitness   = refs.filter(r => r.sectionType === 'fitness_log').slice(0, 3);
                    const ragParts  = [];
                    if (knowledge.length > 0) ragParts.push('【最新のユーザー理解・関心・気づき（新しい情報を優先）】\n' + knowledge.map(r => `* ${r.content}`).join('\n'));
                    if (fitness.length   > 0) ragParts.push('【最近のフィットネス記録（体重・体脂肪・筋トレ・有酸素など。聞かれたら自然に触れてよい）】\n' + fitness.map(r => `* ${r.content}`).join('\n'));
                    if (episodes.length  > 0) ragParts.push('【過去の思い出・出来事（参考情報）】\n'     + episodes.map(r => `* ${r.content}`).join('\n'));
                    if (researchThreads.length > 0) ragParts.push('【未解決スレッド・継続的関心（過去に気になっていたこと）】\n' + researchThreads.map(r => `* ${r.content}`).join('\n'));
                    if (ragParts.length  > 0) ragPrompt = '\n\n【優先度3：過去の自己省察（※古い情報の可能性があるため参考程度）】\n' + ragParts.join('\n\n');
                  }
                } catch (ragErr) {
                  // RAG構築失敗時はragPromptを空のままにし、streamChatを継続させる
                  console.warn('[MindLink] RAG prompt build failed:', ragErr);
                }
              }
            }

            const boldInstruction = "\n\n【読みやすさと魅力向上のルール】\nメッセージ全体の2割程度を目安に、以下の内容を **太字** (Markdownの `**`) で装飾してください。";

            // Spotify: 再生中の曲情報（変化があった場合のみキャッシュ済み）
            let spotifyPrompt = "";
            if (window.MindLinkSpotify) {
              const track = MindLinkSpotify.getTrackForPrompt();
              if (track && track.isPlaying) {
                spotifyPrompt = `\n\n【現在のBGM】\nユーザーは今「${track.trackName}」（${track.artistName} / ${track.albumName}）を聴いています。\n「今何聴いてるの？」などの質問に自然に答えられます。流れに合わせて音楽の話題に触れても構いません。`;
              }
            }

            const finalPromptText = [
              "【システム全体ルールの優先順位】\n必ず以下の優先順位に従って矛盾を排除して回答してください：\n1位: あなた（AI）自身の役割・人格、および対話相手（ユーザー）の情報（絶対的事実）\n2位: 今日の会話の流れ（同日内記憶補完・当日限り）\n3位: 自己省察RAG（ユーザーの関心・気づき含む）\n4位: 個別記憶（長期記憶）",
              profilePrompt,
              basePrompt,
              technicalAutonomyInstruction,
              searchInstruction,
              dailySummaryPrompt,
              ragPrompt,
              memoryPrompt,
              spotifyPrompt,
              boldInstruction,
              "\n\n\n",
              timeInstruction
            ].filter(Boolean).join('');

            body.systemInstruction = {
              parts: [{ text: finalPromptText }]
            };

            // safetySettingsは明示的に設定せず、APIのデフォルト動的判断（文脈考慮）に委ねる

            // ── 送信直前バリデーション（iOS PWA で contents が空になる事故を防ぐ） ──
            // 有効な user ターン（text / inlineData / functionResponse のいずれかを持つ）が
            // 最低1つ無い場合は、Gemini に空 contents を投げる前にここで中止する。
            const hasValidUserTurn = Array.isArray(body.contents)
              && body.contents.length > 0
              && body.contents.some(c => c.role === 'user'
                  && Array.isArray(c.parts) && c.parts.length > 0
                  && c.parts.some(p => (p.text && p.text.trim()) || p.inlineData || p.functionResponse));

            if (!hasValidUserTurn) {
              const diag = {
                reason: 'empty_or_invalid_contents',
                contentsCount: body.contents?.length ?? 0,
                originalMessagesCount: currentMessages.length,
                model: actualModel,
                timestamp: new Date().toISOString(),
              };
              console.error('[MindLink API] Aborting send: contents has no valid user turn', diag, body.contents);
              if (window.__mindlinkDiag?.recordSendFailure) {
                window.__mindlinkDiag.recordSendFailure(diag);
              }
              throw new Error('送信内容が空のため中止しました。会話履歴が破損している可能性があります。上部の診断バナーから詳細を確認できます。');
            }

            // 送信内容のサマリーを診断用に記録（直近1回分・揮発、PWA単体調査用）
            if (window.__mindlinkDiag?.recordSend) {
              window.__mindlinkDiag.recordSend({
                threadId,
                model: actualModel,
                originalMessagesCount: currentMessages.length,
                finalContentsCount: body.contents.length,
                userTurnCount: body.contents.filter(c => c.role === 'user').length,
                modelTurnCount: body.contents.filter(c => c.role === 'model').length,
                hasSystemInstruction: !!body.systemInstruction,
                timestamp: new Date().toISOString(),
              });
            }

            // 接続自体が固まる場合に備え、fetch開始前にタイマーを始動
            resetIdle();
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: timeoutController.signal
            });

            if (!response.ok) {
              const errJson = await response.clone().json().catch(() => ({}));
              const errMsg = errJson.error?.message || `HTTP ${response.status}`;
              if (response.status === 429 || response.status === 503 || errMsg.includes('High Demand')) {
                lastError = errMsg;
                continue;
              }
              if (response.status === 400) {
                console.error('[MindLink API] 400 Error Details:', errJson);
                console.log('[MindLink API] History sent to API:', JSON.stringify(body.contents, null, 2));
              }
              throw new Error(errMsg);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            // fullText / allParts / finishReason はtry外で宣言済み

            while (true) {
              const { done, value } = await reader.read();
              resetIdle(); // トークン受信のたびにアイドルタイマーをリセット

              if (value) {
                buffer += decoder.decode(value, { stream: true });
              }
              if (done) {
                buffer += decoder.decode(); // text flush
                // 不完全な末尾は強制改行で擬似補完しない（重複パースの原因になるため）
              }

              // SSEのパース：Gemini APIは `\n` 単独区切りで送ってくるためそれに合わせる
              // （不完全な末尾は次ループに自然に持ち越される）
              let sepIdx;
              while ((sepIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, sepIdx).trim();
                buffer = buffer.substring(sepIdx + 1);

                if (!line.startsWith('data: ')) continue;

                const jsonStr = line.substring(6).trim();
                if (jsonStr === '[DONE]') continue;

                try {
                  const data = JSON.parse(jsonStr);
                  const candidates = data.candidates || [];
                  for (const candidate of candidates) {
                    // finishReasonを追跡（SAFETY / RECITATION / MAX_TOKENS / STOP）
                    if (candidate.finishReason) finishReason = candidate.finishReason;
                    // Google Search Grounding 検出
                    if (candidate.groundingMetadata?.webSearchQueries?.length > 0) {
                      webSearchUsed = true;
                    }
                    const chunksParts = candidate.content?.parts || [];
                    allParts = [...allParts, ...chunksParts];
                    for (const p of chunksParts) {
                      if (p.text) {
                        fullText += p.text;
                        onChunk(p.text, fullText);
                      }
                    }
                  }
                } catch (e) {
                  // 完全に読み込めていない可能性があるのでログに留める
                  console.warn('[MindLink API] SSE Chunk parse error (skipping):', e);
                }
              }

              if (done) break;
            }
            // ストリーム完了：以降のツール実行中はアイドル監視を止める
            if (idleTimer) clearTimeout(idleTimer);

            // ── ツール呼び出し処理（再帰なし・ループで継続） ──
            const pendingCalls = allParts.filter(p => p.functionCall).map(p => p.functionCall);
            // custom_search が呼ばれた場合は webSearchUsed フラグを立てる
            if (pendingCalls.some(c => c.name === 'custom_search')) {
              webSearchUsed = true;
            }
            if (pendingCalls.length > 0) {
              const functionResponses = [];
              for (const call of pendingCalls) {
                try {
                  onChunk(`\n> [系統] \`${call.name}\` 実行中...`, fullText);
                  const result = await window.MindLinkGoogleServices.callFunction(call.name, call.args);
                  functionResponses.push({
                    functionResponse: { name: call.name, response: { content: result } }
                  });
                } catch (err) {
                  functionResponses.push({
                    functionResponse: { name: call.name, response: { error: err.message } }
                  });
                }
              }

              const assistantMsg = {
                id: 'ai_' + Date.now(),
                role: 'assistant',
                content: fullText,
                parts: allParts,
                timestamp: Date.now(),
                isSystem: true
              };
              if (threadId) MindLinkStorage.addMessage(threadId, assistantMsg);

              const responseMsg = {
                id: 'sys_' + Date.now(),
                role: 'function',
                content: '',
                parts: functionResponses,
                timestamp: Date.now() + 1,
                isSystem: true
              };
              if (threadId) MindLinkStorage.addMessage(threadId, responseMsg);

              // 追加したメッセージIDを記録（エラー時のロールバック用）
              allAddedMessageIds.push(assistantMsg.id, responseMsg.id);
              // 次のループで使うメッセージ列を更新
              currentMessages = [...currentMessages, assistantMsg, responseMsg];
              // ツールループの先頭に戻り、同じリクエスト内で続きを処理
              console.log(`[MindLink API] Tool calls complete (${pendingCalls.map(c => c.name).join(', ')}), continuing in same request...`);
              continue toolLoop;
            }

            return onComplete(fullText, webSearchUsed ? ['__web_search__'] : [], actualModel, finishReason);

          } catch (e) {
            if (e.name === 'AbortError') {
              // 停止ボタン（外部signal）による中断 → 従来通り終了
              if (signal?.aborted) return;
              // アイドル/接続タイムアウトによる中断 → returnせず次モデルへフォールバック
              if (timedOut) {
                console.warn(`[MindLink API] Idle/connection timeout (${TIMEOUT_MS / 1000}s) on ${actualModel} — falling back`);
                lastError = `応答タイムアウト（${TIMEOUT_MS / 1000}秒）`;
              } else {
                return; // 想定外のabortは従来通り終了
              }
            } else {
              console.error(`[MindLink API] Attempt fail (${actualModel}):`, e);
              lastError = e.message;
            }

            // ツール実行後のエラー：追加済みメッセージをロールバック
            if (allAddedMessageIds.length > 0 && threadId) {
              console.warn('[MindLink API] Tool execution failed, rolling back turns:', allAddedMessageIds);
              try {
                const currentMsgs = MindLinkStorage.getMessages(threadId);
                const filtered = currentMsgs.filter(m => !allAddedMessageIds.includes(m.id));
                MindLinkStorage.setMessages(threadId, filtered);
              } catch (rollbackErr) {
                console.error('Rollback failed:', rollbackErr);
              }
            }

            // ストリーミング中断を検知：文字が届いていれば部分回答として完結させる
            if (fullText.length > 30) {
              console.warn('[MindLink API] Mid-stream cut — completing with partial content');
              return onComplete(
                fullText + '\n\n*(⚠️ 通信が途切れたため応答が不完全です)*',
                [], actualModel, 'NETWORK_CUT'
              );
            }

            // 文字が届いていない場合はリトライ対象か判定
            const isRetriable = e instanceof TypeError ||
              lastError.includes('High Demand') ||
              lastError.includes('429') ||
              lastError.includes('503') ||
              lastError.includes('network') ||
              lastError.includes('fetch');
            if (!isRetriable) {
              break;
            }
          } finally {
            // タイマー解除・外部signalリスナー除去（メモリリーク防止）
            if (idleTimer) clearTimeout(idleTimer);
            if (signal) signal.removeEventListener('abort', onExternalAbort);
          }
        }
      }

      // フォールバックチェーンを全て試しても解決しなかった場合はループ終了
      break;
    }

    onError(`すべての復旧試行に失敗しました。理由: ${lastError}`);
  }

  /**
   * スレッドのタイトルを自動生成
   */
  async function generateTitle(userMsg, aiMsg) {
    try {
      const apiKey = await MindLinkAuth.getApiKey('gemini');
      if (!apiKey) return null;
      
      const prompt = `以下の会話内容から、短く魅力的なスレッドのタイトル（最大15文字以内）を1つ生成してください。
タイトルのみを出力し、余計な説明や記号は含めないでください。

ユーザー: ${userMsg.slice(0, 100)}
AI: ${aiMsg.slice(0, 100)}`;

      const url = `${BASE_URL}/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 20 }
        })
      });
      
      if (!response.ok) return null;
      const data = await response.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/["'「」]/g, '');
    } catch (e) {
      console.warn('Title generation failed:', e);
      return null;
    }
  }

  async function testConnection() {
    try {
      const apiKey = await MindLinkAuth.getApiKey('gemini');
      if (!apiKey) return { success: false, message: 'APIキーが設定されていません' };
      
      const url = `${BASE_URL}/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      });
      
      if (response.ok) return { success: true, message: '接続成功 ✨' };
      const err = await response.json();
      return { success: false, message: `接続失敗: ${err.error?.message || response.statusText}` };
    } catch (e) {
      return { success: false, message: `エラー: ${e.message}` };
    }
  }

  return { streamChat, getEmbedding, getSummary, generateDailySummary, summarizeAttachment, testConnection, generateTitle, formatMessages };
})();

window.MindLinkAPI = MindLinkAPI;
