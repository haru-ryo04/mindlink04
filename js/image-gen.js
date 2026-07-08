/**
 * MindLink - Image Generation Module
 * 会話内function calling経由の画像生成（Nano Banana系モデル）
 *
 * 設計方針:
 * ・生成はユーザーの明示的な依頼時のみ（ペルソナの自発生成は禁止）
 * ・画像本体はIndexedDB（generatedImages）に保存し、メッセージには参照IDのみ
 *   → localStorageを圧迫せず、以降のAPI送信履歴からも自動的に除外される
 * ・失敗時は自動リトライせず、ペルソナの言葉＋トーストの二重報告
 */

const MindLinkImageGen = (() => {
  const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
  const GENERATION_TIMEOUT_MS = 90000; // 4K生成は遅いため長めに設定
  const MAX_REFS_PER_GENERATION = 3;

  // UI表示名 ⇔ モデルコード対応表（設定画面のセレクトにも使用）
  const MODEL_OPTIONS = [
    { code: 'gemini-3.1-flash-image',      label: 'Nano Banana 2' },
    { code: 'gemini-3-pro-image',          label: 'Nano Banana Pro' },
    { code: 'gemini-3.1-flash-lite-image', label: 'Nano Banana lite' },
  ];

  const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

  // ── ツール定義（参照画像の名前一覧を動的に埋め込む） ──
  async function getToolDeclaration() {
    let namesNote = '';
    try {
      const refs = await MindLinkStorage.getReferenceImages();
      if (refs.length > 0) {
        namesNote = ` 利用可能な参照画像: ${refs.map(r => `「${r.name}」`).join('、')}。この名前の人物・キャラクターを描く場合は reference_names に指定すると外見が反映されます。`;
      }
    } catch (e) { /* 参照画像が読めなくてもツール自体は使える */ }
    return {
      name: 'generate_image',
      description: `画像を生成してチャットに表示します。ユーザーが「画像生成して」「絵にして」「描いて見せて」など明示的に画像生成を依頼した場合のみ使用してください。あなた（AI）の判断で自発的に使ってはいけません。${namesNote}`,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '画像生成プロンプト。会話の文脈を踏まえ、被写体・構図・雰囲気・スタイルを具体的に記述する。人物を描く場合、参照画像の服装はコピーされないため、シーンに合った服装・アクセサリー・小物を毎回具体的に記述すること（例: 海なら夏のワンピース、夜のディナーならドレス）。'
          },
          reference_names: {
            type: 'array',
            items: { type: 'string' },
            description: '使用する参照画像の名前（最大3つ）。指定した人物・キャラクターの外見が生成に反映される。'
          },
          aspect_ratio: {
            type: 'string',
            enum: ASPECT_RATIOS,
            description: 'ユーザーが比率・縦横を指定した場合のみ設定（例: 縦長→9:16、横長→16:9）。未指定なら設定画面のデフォルトが使われる。'
          },
          edit_last: {
            type: 'boolean',
            description: '直前に生成した画像への修正依頼（「背景を夜にして」等）の場合はtrue。新規生成はfalseまたは省略。'
          }
        },
        required: ['prompt']
      }
    };
  }

  // ── システムプロンプト注入用: ピン留め参照画像の説明文（テキストのみ・低コスト） ──
  async function buildPromptContext() {
    try {
      const refs = await MindLinkStorage.getReferenceImages();
      if (refs.length === 0) return '';
      const pinned = refs.filter(r => r.isPinned);
      if (pinned.length === 0) return '';
      const lines = ['\n\n【参照画像（画像生成で名前指定できる人物・キャラクター）】'];
      for (const p of pinned) {
        lines.push(`・「${p.name}」: ${p.description || '（説明なし）'}`);
      }
      const others = refs.filter(r => !r.isPinned).map(r => `「${r.name}」`);
      if (others.length > 0) lines.push(`・その他に登録されている参照画像: ${others.join('、')}`);
      return lines.join('\n');
    } catch (e) {
      return '';
    }
  }

  // ── ヘルパー ──
  function splitDataUrl(dataUrl) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return null;
    return { mimeType: m[1], data: m[2] };
  }

  // スレッド内で最後に生成された画像（メッセージと添付）を探す
  function findLastGeneratedImage(threadId) {
    const messages = MindLinkStorage.getMessages(threadId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const att = (messages[i].attachments || []).find(a => a.type === 'generated-image');
      if (att) return { message: messages[i], attachment: att };
    }
    return null;
  }

  function showToastSafe(text) {
    try { window.MindLinkApp?.showToast(text); } catch (e) { /* noop */ }
  }

  // HTTPエラー → トースト文言＋ペルソナへ返す説明（自動リトライはしない方針）
  function mapHttpError(status, apiMsg) {
    if (status === 429) return {
      toast: '画像生成失敗: 混雑中（429）',
      result: '画像生成サービスが混雑していて生成できませんでした。自動では再試行しないので、「いま混んでいるみたいだから、少し時間を置いてからまた頼んでほしい」という趣旨をあなたの口調で自然に伝えてください。'
    };
    if (status === 503) return {
      toast: '画像生成失敗: サーバー過負荷（503）',
      result: '画像生成サーバーが過負荷で生成できませんでした。「いま混んでいるみたいだから、少し時間を置いてからまた頼んでほしい」という趣旨をあなたの口調で自然に伝えてください。'
    };
    if (status === 404) return {
      toast: '画像生成失敗: モデルが利用できません（設定を確認）',
      result: '選択中の画像生成モデルが利用できませんでした。設定画面の「画像生成」で別のモデル（Nano Banana系）に切り替えるようユーザーに案内してください。'
    };
    return {
      toast: `画像生成失敗: HTTP ${status} ${String(apiMsg || '').slice(0, 40)}`,
      result: `画像生成に失敗しました（${apiMsg || 'HTTP ' + status}）。その旨をあなたの口調で伝えてください。`
    };
  }

  // 画像モデルの呼び出し（1回分・生fetch）
  async function callImageModel({ model, parts, aspectRatio, imageSize, apiKey, abortSignal }) {
    const generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
    };
    const imageConfig = {};
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (imageSize)   imageConfig.imageSize = imageSize;
    if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;

    const response = await fetch(`${BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig
      }),
      signal: abortSignal
    });
    return response;
  }

  /**
   * generate_image ツールの実行本体（api.jsのツールループから呼ばれる）
   * 戻り値はそのまま functionResponse としてペルソナに渡る。
   * ユーザーの停止（外部signal）は AbortError を上位へ投げる。
   */
  async function executeToolCall(args, threadId, signal) {
    const settings = MindLinkStorage.getSettings();
    const apiKey = await MindLinkAuth.getApiKey();
    if (!apiKey) return { error: 'APIキーが設定されていません。設定画面での登録をユーザーに案内してください。' };
    if (!args || !args.prompt) return { error: '画像生成プロンプトが空でした。もう一度、内容を具体的にして呼び出してください。' };

    const model = settings.imageModel || 'gemini-3.1-flash-image';
    const aspectRatio = ASPECT_RATIOS.includes(args.aspect_ratio)
      ? args.aspect_ratio
      : (settings.imageAspectRatio || '1:1');
    // Nano Banana lite は1K固定（2K/4K非対応・公式ドキュメント確認済み）のため解像度指定を送らない
    const imageSize = model.includes('lite') ? null : (settings.imageResolution || '2K');

    // タイムアウト＋外部停止signalの合成
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timeoutId); throw new DOMException('Aborted', 'AbortError'); }
      signal.addEventListener('abort', onExternalAbort);
    }

    try {
      // ── リクエストparts構築（参照画像 → 編集対象 → プロンプトの順） ──
      const parts = [];
      const usedRefs = [];
      const refNames = Array.isArray(args.reference_names)
        ? args.reference_names.slice(0, MAX_REFS_PER_GENERATION)
        : [];
      if (refNames.length > 0) {
        const refs = await MindLinkStorage.getReferenceImages();
        for (const name of refNames) {
          const ref = refs.find(r => r.name === name);
          if (!ref) continue;
          const img = splitDataUrl(ref.data);
          if (!img) continue;
          parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          usedRefs.push({ name: ref.name, bodyNote: (ref.bodyNote || '').trim() });
        }
      }

      // 編集モード: 直前の生成画像を1回だけ添付
      let editTarget = null;
      if (args.edit_last) {
        editTarget = findLastGeneratedImage(threadId);
        if (!editTarget) {
          return { error: '編集対象の画像がこのスレッドに見つかりませんでした。新規生成として依頼し直してください。' };
        }
        const record = await MindLinkStorage.getGeneratedImage(editTarget.attachment.imageId);
        const img = record && record.data ? splitDataUrl(record.data) : null;
        if (!img) {
          return { error: '編集対象の画像は保存期間（7日）を過ぎて削除されています。編集はできないため、新規生成として依頼し直すようユーザーに伝えてください。' };
        }
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }

      // 参照画像がある場合は「顔・髪型のみ参照」の固定指示をシステム側で必ず注入する。
      // （服装・小物が参照写真のままワンパターン化するのを防ぎ、シーンに合わせた
      //   コーディネートをプロンプト記述に委ねる。体型メモがあれば人物ごとに反映）
      let finalPrompt = args.prompt;
      if (usedRefs.length > 0) {
        const traits = usedRefs
          .filter(r => r.bodyNote)
          .map(r => `・「${r.name}」の体型・肌などの特徴: ${r.bodyNote}（この特徴を必ず反映すること）`)
          .join('\n');
        finalPrompt = `【人物参照画像の使い方（厳守）】
添付した人物の参照画像は、その人物の顔立ちと髪型の参照としてのみ使用すること。
服装・アクセサリー・持ち物・背景は参照画像からコピーせず、下のプロンプトの記述に従って新しく描くこと。
${traits ? traits + '\n' : ''}
【プロンプト】
${args.prompt}`;
      }
      parts.push({ text: finalPrompt });

      // ── 生成呼び出し（解像度非対応モデルの場合のみ、解像度なしで1回だけ再送） ──
      let response = await callImageModel({ model, parts, aspectRatio, imageSize, apiKey, abortSignal: controller.signal });
      if (response.status === 400) {
        const errJson = await response.clone().json().catch(() => ({}));
        const emsg = errJson.error?.message || '';
        if (/image_?size|image_?config/i.test(emsg)) {
          console.warn('[MindLink ImageGen] 解像度指定が非対応の可能性 — 指定なしで再送:', emsg);
          showToastSafe(`このモデルは解像度${imageSize}非対応の可能性 → 指定なしで再試行`);
          response = await callImageModel({ model, parts, aspectRatio, imageSize: null, apiKey, abortSignal: controller.signal });
        }
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        const mapped = mapHttpError(response.status, errJson.error?.message);
        showToastSafe(mapped.toast);
        return { error: mapped.result };
      }

      const data = await response.json();

      // ── 応答パース ──
      const candidate = data.candidates?.[0];
      const respParts = candidate?.content?.parts || [];
      const imagePart = respParts.find(p => p.inlineData && p.inlineData.data);

      if (!imagePart) {
        // 画像なし: ブロックまたはテキストのみの応答
        const blockReason = data.promptFeedback?.blockReason || candidate?.finishReason;
        const textPart = respParts.find(p => p.text)?.text || '';
        const isBlocked = ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(blockReason)
          || data.promptFeedback?.blockReason;
        if (isBlocked) {
          showToastSafe('画像生成失敗: コンテンツがブロックされました');
          return { error: 'この内容の画像は安全性ポリシーによりブロックされ生成できませんでした。再試行はせず、表現を変えれば描けるかもしれないことをあなたの口調で伝えてください。' };
        }
        showToastSafe('画像生成失敗: 画像が返されませんでした');
        return { error: `画像が生成されませんでした。${textPart ? 'モデルからの応答: ' + textPart.slice(0, 200) : '理由: ' + (blockReason || '不明')}` };
      }

      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const dataUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;

      // ── IndexedDBへ保存（localStorageには参照IDのみ） ──
      const savedImage = await MindLinkStorage.saveGeneratedImage({
        threadId,
        mimeType,
        data: dataUrl,
        prompt: args.prompt,
      });

      const shortPrompt = args.prompt.length > 80 ? args.prompt.slice(0, 80) + '…' : args.prompt;

      if (editTarget) {
        // ── 編集: 古い画像メッセージを削除し、編集後の画像を会話の最下部に新規表示 ──
        // 元の位置での差し替えだと画面の上方で起きて気づけないため、
        // 「置き換え」を「古い方を消して最下部に出し直す」形で実現する（画像は常に1枚のまま）。
        const captionText = `🎨（画像生成・編集済み: ${shortPrompt}）`;
        const msgs = MindLinkStorage.getMessages(threadId);
        MindLinkStorage.setMessages(threadId, msgs.filter(m => m.id !== editTarget.message.id));
        MindLinkStorage.deleteGeneratedImage(editTarget.attachment.imageId).catch(() => {});
        // 画面上の古いバブルを取り除く（chat.js側のヘルパー・未定義でも動作継続）
        try { window.MindLinkChat?.removeMessageFromView?.(editTarget.message.id); } catch (e) { /* noop */ }

        const editedMsg = {
          id: 'img_' + Date.now(),
          role: 'assistant',
          content: captionText,
          attachments: [{ type: 'generated-image', imageId: savedImage.id, mimeType }],
          timestamp: Date.now(),
        };
        MindLinkStorage.addMessage(threadId, editedMsg);
        try {
          if (window.MindLinkChat?.appendMessage) {
            const thread = MindLinkStorage.getThread(threadId);
            const persona = MindLinkStorage.getPersona(thread?.personaId) || MindLinkStorage.getDefaultPersona();
            window.MindLinkChat.appendMessage(editedMsg, persona);
          }
        } catch (e) {
          console.warn('[MindLink ImageGen] 編集画像メッセージ表示に失敗（データは保存済み）:', e);
        }
        return {
          success: true,
          message: '直前の画像を編集し、新しいバージョンに置き換えました（古い方は削除済み）。',
          prompt_used: args.prompt,
          note: '編集後の画像はすでにユーザーに見えています。内容を踏まえて自然に会話を続けてください。'
        };
      }

      // ── 新規生成: 画像メッセージとして表示・保存 ──
      const captionText = `🎨（画像生成: ${shortPrompt}）`;
      const imgMsg = {
        id: 'img_' + Date.now(),
        role: 'assistant',
        content: captionText,
        attachments: [{ type: 'generated-image', imageId: savedImage.id, mimeType }],
        timestamp: Date.now(),
      };
      MindLinkStorage.addMessage(threadId, imgMsg);
      try {
        if (window.MindLinkChat?.appendMessage) {
          const thread = MindLinkStorage.getThread(threadId);
          const persona = MindLinkStorage.getPersona(thread?.personaId) || MindLinkStorage.getDefaultPersona();
          window.MindLinkChat.appendMessage(imgMsg, persona);
        }
      } catch (e) {
        console.warn('[MindLink ImageGen] 画像メッセージ表示に失敗（データは保存済み）:', e);
      }

      return {
        success: true,
        message: '画像を生成してチャットに表示しました。' + (usedRefs.length > 0 ? `（参照画像: ${usedRefs.map(r => r.name).join('、')}）` : ''),
        prompt_used: args.prompt,
        note: '画像はすでにユーザーに見えています。内容を踏まえて自然に会話を続けてください。画像の再掲や再生成は、ユーザーに頼まれない限り不要です。'
      };

    } catch (e) {
      if (e.name === 'AbortError') {
        // ユーザーの停止ボタン → 上位（api.js）で通常の停止処理をさせる
        if (signal?.aborted) throw e;
        // こちら都合のタイムアウト
        showToastSafe('画像生成失敗: 時間切れ（90秒）');
        return { error: '画像生成が90秒以内に完了しませんでした。時間を置いてからの再依頼をユーザーに案内してください。' };
      }
      console.error('[MindLink ImageGen] 生成エラー:', e);
      showToastSafe('画像生成失敗: ' + String(e.message || e).slice(0, 60));
      return { error: '画像生成に失敗しました: ' + String(e.message || e) };
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── 参照画像の外見説明を自動生成（ライブラリ追加時に1回だけ・安価なモデル使用） ──
  async function describeReferenceImage(dataUrl) {
    const apiKey = await MindLinkAuth.getApiKey();
    if (!apiKey) throw new Error('APIキーが設定されていません');
    const img = splitDataUrl(dataUrl);
    if (!img) throw new Error('画像データの形式が不正です');
    const settings = MindLinkStorage.getSettings();
    const model = settings.summaryModel || 'gemini-3.1-flash-lite';
    const response = await fetch(`${BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: img.mimeType, data: img.data } },
            { text: 'この画像に写っている人物・キャラクターの外見的特徴（髪型・髪色・目の色・服装・体型・雰囲気など）を100文字程度の日本語で説明してください。説明文のみを出力してください。' }
          ]
        }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
      })
    });
    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  // ── 起動時: 7日を過ぎた生成画像本体を自動整理（ベストエフォート） ──
  function scheduleCleanup() {
    setTimeout(() => {
      try {
        MindLinkStorage.cleanupOldGeneratedImages(7).catch(e =>
          console.warn('[MindLink ImageGen] 自動整理に失敗:', e)
        );
      } catch (e) { /* noop */ }
    }, 3000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleCleanup);
  } else {
    scheduleCleanup();
  }

  return {
    MODEL_OPTIONS,
    ASPECT_RATIOS,
    getToolDeclaration,
    buildPromptContext,
    executeToolCall,
    describeReferenceImage,
  };
})();

window.MindLinkImageGen = MindLinkImageGen;
