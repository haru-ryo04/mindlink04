/**
 * MindLink - Chat Module
 * チャットUIとメッセージ処理
 */

const MindLinkChat = (() => {
  let _isStreaming = false;
  let _abortController = null;
  let _streamingMessageEl = null;
  let _attachedFiles = [];
  let _editingMessageId = null;

  const SEND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const STOP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/></svg>`;

  function setSendButtonState(isStreaming) {
    const btn = document.getElementById('btn-send');
    if (!btn) return;
    if (isStreaming) {
      btn.innerHTML = STOP_ICON;
      btn.style.color = '#ef4444';
      btn.disabled = false;
    } else {
      btn.innerHTML = SEND_ICON;
      btn.style.color = '';
      const msgInput = document.getElementById('message-input');
      btn.disabled = !msgInput || msgInput.value.trim().length === 0;
    }
  }

  // ストリーミング停止
  function stopStreaming() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    if (_isStreaming) {
      finalizeStreamingMessage();
      _isStreaming = false;
      setSendButtonState(false);
    }
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Markdown設定
  function setupMarkdown() {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
      });

      // カスタムレンダラー（コードブロックにコピーボタン追加）
      const renderer = new marked.Renderer();
      renderer.code = function(code, language) {
        const validLang = language && hljs?.getLanguage(language) ? language : 'plaintext';
        let highlighted;
        try {
          highlighted = typeof hljs !== 'undefined' 
            ? hljs.highlight(typeof code === 'object' ? code.text : code, { language: validLang }).value
            : escapeHtml(typeof code === 'object' ? code.text : code);
        } catch (_) {
          highlighted = escapeHtml(typeof code === 'object' ? code.text : code);
        }
        const codeText = typeof code === 'object' ? code.text : code;
        const encodedCode = encodeURIComponent(codeText);
        return `<div class="code-block-wrapper">
          <pre><code class="hljs language-${validLang}">${highlighted}</code></pre>
          <button class="code-copy-btn" data-code="${encodedCode}">コピー</button>
        </div>`;
      };
      marked.use({ renderer });
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
    try {
      return marked.parse(text);
    } catch (_) {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  // メッセージエリアリセット
  function clearMessages() {
    const area = document.getElementById('messages-area');
    if (!area) return;
    area.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.id = 'welcome-state';
    welcome.className = 'welcome-state';
    welcome.innerHTML = `
      <div class="welcome-icon">
        <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width="80" height="80">
          <defs>
            <radialGradient id="wg2" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#c4b5fd" stop-opacity="0.3"/>
              <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <circle cx="60" cy="60" r="55" fill="url(#wg2)"/>
          <path d="M70 20 C51 20, 38 34, 38 52 C38 70, 51 84, 70 84 C61 84, 49 76, 47 66 C43 57, 47 43, 56 37 C60 34, 66 23, 70 20Z" fill="#c4b5fd"/>
          <circle cx="82" cy="32" r="3.5" fill="#fbbf24" opacity="0.8"/>
          <circle cx="92" cy="50" r="2" fill="#fbbf24" opacity="0.6"/>
        </svg>
      </div>
      <h2 class="welcome-title">こんにちは！</h2>
      <p class="welcome-subtitle">AIとの会話を始めましょう</p>
      <div class="welcome-suggestions">
        <button class="suggestion-chip" data-suggestion="今日の気分を聞かせて">💭 今日の気分を聞かせて</button>
        <button class="suggestion-chip" data-suggestion="何かアイデアを出して">💡 何かアイデアを出して</button>
        <button class="suggestion-chip" data-suggestion="日本語で雑談しよう">🗣️ 日本語で雑談しよう</button>
      </div>
    `;
    area.appendChild(welcome);

    // サジェストチップのイベント
    welcome.querySelectorAll('.suggestion-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('message-input');
        if (input) {
          input.value = btn.dataset.suggestion;
          input.dispatchEvent(new Event('input'));
          sendMessage();
        }
      });
    });
  }

  // 既存メッセージ読み込み
  async function loadMessages(threadId) {
    clearMessages();
    const thread = MindLinkStorage.getThread(threadId);
    // アーカイブ済みは IndexedDB倉庫から、それ以外は localStorage から読む
    const messages = thread?.isArchived
      ? ((await MindLinkStorage.getArchivedMessages(threadId)) || [])
      : MindLinkStorage.getMessages(threadId);
    if (messages.length === 0) return;

    const persona = MindLinkStorage.getPersona(thread?.personaId) || MindLinkStorage.getDefaultPersona();
    const welcomeEl = document.getElementById('welcome-state');
    if (welcomeEl) welcomeEl.remove();

    messages.forEach(msg => {
      appendMessage(msg, persona, false);
    });

    scrollToBottom();
  }

  // メッセージ追加
  function appendMessage(msg, persona, animate = true) {
    // ツール呼び出し等、システム内部のメッセージは表示しない
    if (msg.isSystem) return null;

    const area = document.getElementById('messages-area');
    if (!area) return null;

    const welcomeEl = document.getElementById('welcome-state');
    if (welcomeEl) welcomeEl.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';
    if (animate) wrapper.style.animation = 'message-in 0.25s ease';

    const isUser = msg.role === 'user';
    const settings = MindLinkStorage.getSettings();
    const userAvatarData = settings.userAvatar || '👤';
    let avatarContent = isUser ? userAvatarData : (persona?.avatar || '🌙');
    
    if (avatarContent.startsWith('data:image')) {
      avatarContent = `<div class="avatar-img-inline" style="background-image: url(${avatarContent}); border-radius:50%; width:100%; height:100%; background-size:cover; background-position:center;"></div>`;
    }

    const roleName = isUser ? (settings.userName || 'あなた') : (persona?.name || 'AI');
    const contentHtml = isUser ? escapeHtml(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content);

    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
      msg.attachments.forEach(att => {
        if (att.type === 'video/youtube') {
          // YouTube視聴用の疑似添付はチップ表示のみ（URL本文はメッセージに含まれている）
          attachmentsHtml += `
            <div class="message-attachment">
              <span class="message-attachment-file">🎬 YouTube動画を一緒に視聴</span>
            </div>`;
        } else if (att.type === 'generated-image') {
          // 生成画像: 本体はIndexedDBにあるため、まずスロットを描画して非同期で読み込む
          attachmentsHtml += `
            <div class="message-attachment generated-image-slot" data-image-id="${escapeHtml(att.imageId || '')}">
              <div class="generated-image-loading">🎨 読み込み中…</div>
            </div>`;
        } else if (att.type.startsWith('image/')) {
          attachmentsHtml += `
            <div class="message-attachment">
              <img src="${att.data}" alt="添付画像" onclick="window.open('${att.data}')">
            </div>`;
        } else {
          attachmentsHtml += `
            <div class="message-attachment">
              <a href="${att.data}" download="${att.name}" class="message-attachment-file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                  <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
                </svg>
                ${att.name}
              </a>
            </div>`;
        }
      });
    }

    const showActions = !msg.isStatus;

    wrapper.innerHTML = `
      <div class="message ${isUser ? 'user' : 'assistant'}" data-id="${msg.id}">
        <div class="message-avatar">${avatarContent}</div>
        <div class="message-content">
          <div class="message-role">${roleName}</div>
          <div class="message-bubble-container">
            <div class="message-bubble">
              ${contentHtml}${attachmentsHtml}
              ${(!isUser && msg.isSafety) ? `<span style="display:inline-block;margin-top:4px;font-size:13px;opacity:0.7;" title="セーフティフィルターにより一部の回答が省略されました">⚠️</span>` : ''}
              ${(!isUser && msg.actualModel && msg.requestedModel && msg.actualModel !== msg.requestedModel) ? `
                <div class="fallback-badge" title="高速な代替モデル（${msg.actualModel}）で返答しました">⚡ (代打)</div>
              ` : ''}
              ${(!isUser && msg.webSearchUsed) ? `<div style="display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;padding:2px 8px;background:rgba(59,130,246,0.12);color:#60a5fa;border-radius:12px;border:1px solid rgba(59,130,246,0.25);" title="Web検索を使って回答しました">🔍 Web検索</div>` : ''}
            </div>
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
          ${showActions ? `
          <div class="message-actions">
            <button class="message-action-btn copy-btn" title="コピー">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              コピー
            </button>
            ${isUser ? `<button class="message-action-btn edit-msg-btn" title="編集">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              編集
            </button>` : ''}
            ${!isUser ? `<button class="message-action-btn save-memory-btn" title="記憶に追加">
              🧠 記憶に追加
            </button>` : ''}
            ${!isUser ? `<button class="message-action-btn like-btn" title="いいね" data-like-count="0">
              ❤️ <span class="like-count"></span>
            </button>` : ''}
          </div>` : ''}
        </div>
      </div>
    `;

    // 生成画像スロット: IndexedDBから本体を非同期で読み込んで差し込む
    wrapper.querySelectorAll('.generated-image-slot').forEach(slot => {
      hydrateGeneratedImage(slot);
    });

    // コードコピーボタンのイベント
    wrapper.querySelectorAll('.code-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = decodeURIComponent(btn.dataset.code);
        copyToClipboard(code);
        btn.textContent = 'コピーしました！';
        setTimeout(() => btn.textContent = 'コピー', 2000);
      });
    });

    // メッセージコピー
    wrapper.querySelector('.copy-btn')?.addEventListener('click', () => {
      copyToClipboard(msg.content);
      MindLinkApp.showToast('コピーしました');
    });

    // ユーザーメッセージ編集
    wrapper.querySelector('.edit-msg-btn')?.addEventListener('click', () => {
      startEditingMessage(msg);
    });

    // 記憶に追加
    wrapper.querySelector('.save-memory-btn')?.addEventListener('click', () => {
      openAddMemoryWithContent(msg.content.slice(0, 500));
    });

    // いいね
    wrapper.querySelector('.like-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const newCount = (parseInt(btn.dataset.likeCount) || 0) + 1;
      btn.dataset.likeCount = newCount;
      btn.querySelector('.like-count').textContent = newCount > 0 ? newCount : '';
      btn.classList.add('liked');
      try {
        await MindLinkStorage.addLikedMessage({ id: msg.id, content: msg.content });
      } catch (err) {
        console.warn('[MindLink] addLikedMessage error:', err);
      }
    });

    area.appendChild(wrapper);

    if (animate) scrollToBottom();
    return wrapper;
  }

  // ── 生成画像の表示・保存（本体はIndexedDB・メッセージは参照IDのみ） ──

  async function hydrateGeneratedImage(slot) {
    const imageId = slot.dataset.imageId;
    if (!imageId) {
      slot.innerHTML = '<div class="generated-image-expired">🖼 画像を読み込めませんでした</div>';
      return;
    }
    try {
      const record = await MindLinkStorage.getGeneratedImage(imageId);
      if (record && record.data) {
        slot.innerHTML = `
          <img src="${record.data}" alt="生成画像" class="generated-image">
          <button class="generated-image-save-btn" title="カメラロールに保存">📤 保存</button>`;
        slot.querySelector('.generated-image-save-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          shareGeneratedImage(imageId);
        });
      } else {
        // 7日整理で本体が削除済み → プレースホルダー
        slot.innerHTML = '<div class="generated-image-expired">🖼 画像は保存期間を終了しました</div>';
      }
    } catch (e) {
      console.warn('[MindLink] 生成画像の読み込みに失敗:', imageId, e);
      slot.innerHTML = '<div class="generated-image-expired">🖼 画像を読み込めませんでした</div>';
    }
  }

  // iOS共有シート経由でカメラロールへ保存（非対応環境はダウンロードにフォールバック）
  async function shareGeneratedImage(imageId) {
    try {
      const record = await MindLinkStorage.getGeneratedImage(imageId);
      if (!record || !record.data) {
        MindLinkApp.showToast('画像データが見つかりません（保存期間終了の可能性）');
        return;
      }
      const mimeType = record.mimeType || 'image/png';
      const ext = mimeType.split('/')[1] || 'png';
      const fileName = `mindlink_${imageId}.${ext}`;
      const blob = await (await fetch(record.data)).blob();
      const file = new File([blob], fileName, { type: mimeType });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch (shareErr) {
          // ユーザーが共有シートを閉じた場合など（エラー扱いにしない）
          if (shareErr.name !== 'AbortError') console.warn('[MindLink] 共有失敗:', shareErr);
        }
      } else {
        const a = document.createElement('a');
        a.href = record.data;
        a.download = fileName;
        a.click();
      }
    } catch (e) {
      console.error('[MindLink] 画像保存エラー:', e);
      MindLinkApp.showToast('画像の保存に失敗しました');
    }
  }

  // 編集置き換え時にimage-gen.jsから呼ばれる: 古い画像メッセージのバブルを画面から取り除く
  // （編集後の画像は会話の最下部に新しいメッセージとして表示される）
  function removeMessageFromView(messageId) {
    const msgEl = document.querySelector(`.message[data-id="${messageId}"]`);
    if (!msgEl) return;
    msgEl.closest('.message-wrapper')?.remove();
  }

  // ストリーミング用タイピング表示
  function startStreamingMessage(persona) {
    const area = document.getElementById('messages-area');
    if (!area) return null;

    const welcomeEl = document.getElementById('welcome-state');
    if (welcomeEl) welcomeEl.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper streaming-wrapper';
    wrapper.id = 'streaming-message';

    let avatarContent = persona?.avatar || '🌙';
    if (avatarContent.startsWith('data:image')) {
      avatarContent = `<div class="avatar-img-inline" style="background-image: url(${avatarContent}); border-radius:50%; width:100%; height:100%; background-size:cover; background-position:center;"></div>`;
    }

    wrapper.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">${avatarContent}</div>
        <div class="message-content">
          <div class="message-role">${persona?.name || 'AI'}</div>
          <div class="message-bubble-container">
            <div class="message-bubble streaming-bubble">
              <span class="streaming-text"></span><span class="streaming-cursor"></span>
            </div>
            <div class="message-time">${formatTime(Date.now())}</div>
          </div>
        </div>
      </div>
    `;
    area.appendChild(wrapper);
    scrollToBottom();
    _streamingMessageEl = wrapper;
    return wrapper;
  }

  // ストリーミングテキスト更新
  function updateStreamingMessage(chunk, fullText) {
    if (!_streamingMessageEl) return;
    const bubble = _streamingMessageEl.querySelector('.streaming-bubble');
    if (!bubble) return;

    // 表示用の更新（最後のチャンクまで一気に流し込む）
    // パフォーマンス向上のため、レンダリングが必要な場合のみ実施
    const displayText = renderMarkdown(fullText);
    bubble.innerHTML = displayText + '<span class="streaming-cursor"></span>';
    
    // コードブロックのコピーボタン追加
    bubble.querySelectorAll('.code-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = decodeURIComponent(btn.dataset.code);
        copyToClipboard(code);
        btn.textContent = 'コピーしました！';
        setTimeout(() => btn.textContent = 'コピー', 2000);
      });
    });
    
    scrollToBottom();
  }

  // ストリーミング完了、一時的なDOMを削除
  function finalizeStreamingMessage() {
    if (_streamingMessageEl) {
      _streamingMessageEl.remove();
      _streamingMessageEl = null;
    }
  }

  // タイピングインジケーター
  function showTypingIndicator(persona) {
    const area = document.getElementById('messages-area');
    if (!area) return;
    const div = document.createElement('div');
    div.id = 'typing-indicator-wrapper';
    div.className = 'message-wrapper';
    let avatarContent = persona?.avatar || '🌙';
    if (avatarContent.startsWith('data:image')) {
      avatarContent = `<div class="avatar-img-inline" style="background-image: url(${avatarContent}); border-radius:50%; width:100%; height:100%; background-size:cover; background-position:center;"></div>`;
    }

    div.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">${avatarContent}</div>
        <div class="message-content">
          <div class="message-role">${persona?.name || 'AI'}</div>
          <div class="message-bubble">
            <div class="typing-indicator">
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
            </div>
          </div>
        </div>
      </div>
    `;
    area.appendChild(div);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    document.getElementById('typing-indicator-wrapper')?.remove();
  }

  // メッセージ送信
  async function sendMessage() {
    const input = document.getElementById('message-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content && _attachedFiles.length === 0 || _isStreaming) return;

    // アクティブスレッドを確認
    let threadId = MindLinkThreads.getCurrentThreadId();
    if (!threadId) {
      const thread = MindLinkThreads.createThread();
      threadId = thread.id;
      MindLinkThreads.setCurrentThreadId(threadId);
      MindLinkThreads.renderThreadList();
    }

    const thread = MindLinkStorage.getThread(threadId);
    const persona = MindLinkStorage.getPersona(thread?.personaId) || MindLinkStorage.getDefaultPersona();

    // 過去のメッセージを取得
    const allMessages = MindLinkStorage.getMessages(threadId);

    // 編集中の場合、それ以降のメッセージを削除
    if (_editingMessageId) {
      const editIdx = allMessages.findIndex(m => m.id === _editingMessageId);
      if (editIdx >= 0) {
        allMessages.splice(editIdx); // 編集対象以降を一旦削除
        MindLinkStorage.setMessages(threadId, allMessages);
        loadMessages(threadId); // UIリフレッシュ
      }
      _editingMessageId = null;
    }

    // YouTube URLの検出 → 視聴用の疑似添付として追加（動画として処理されるのはこの送信1回だけ。
    // ストレージ保存時にURLは添付から除かれるため、以降の履歴で動画が再送されることはない）
    const videoAttachments = [..._attachedFiles];
    const ytMatch = content.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)[\w-]{5,}[^\s]*/);
    if (ytMatch && !videoAttachments.some(f => f.type && f.type.startsWith('video/'))) {
      videoAttachments.push({
        name: 'YouTube動画',
        type: 'video/youtube',
        url: ytMatch[0],
      });
    }

    // ユーザーメッセージ（メモリ上のフルデータ：画像base64を含む）
    const userMsg = {
      id: 'msg_' + Date.now(),
      role: 'user',
      content,
      attachments: videoAttachments,
      timestamp: Date.now(),
    };

    // ストレージ用：base64データを除去して軽量化（localStorage容量制限対策）
    const storageSafeMsg = {
      ...userMsg,
      attachments: userMsg.attachments.map(att => ({
        name: att.name,
        type: att.type,
        size: att.size,
        // base64データはlocalStorageに保存しない（容量超過防止）
      }))
    };
    MindLinkStorage.addMessage(threadId, storageSafeMsg);
    appendMessage(userMsg, persona);
    MindLinkThreads.touchThread(threadId);

    // 入力欄・添付クリア
    input.value = '';
    input.style.height = 'auto';
    clearAttachments();
    updateCharCount();
    setSendButtonState(true);

    // ユーザーアクティビティリセット
    MindLinkAuth.resetLockTimer();

    _isStreaming = true;
    _abortController = new AbortController();

    // ストリーミングメッセージ開始
    startStreamingMessage(persona);

    // 最新の履歴を取得し、現在のメッセージの添付データをメモリから復元
    const historyMessages = MindLinkStorage.getMessages(threadId).slice(-20);
    let apiMessages = historyMessages.map(m => m.id === userMsg.id ? userMsg : m);

    // 空チェック：履歴保存の失敗（iOS PWA のクォータ超過等）で apiMessages が
    // 空になったり userMsg を含まないと、API へ空 contents が送られてしまう。
    // その場合は今回のユーザー発言だけでも必ず送れるよう userMsg を補完する。
    const userMsgIncluded = apiMessages.some(m => m.id === userMsg.id);
    if (apiMessages.length === 0 || !userMsgIncluded) {
      console.warn('[MindLink Chat] apiMessages が空 or userMsg 欠落 — userMsg で補完', {
        historyCount: historyMessages.length,
        apiCount: apiMessages.length,
        userMsgIncluded,
      });
      apiMessages = [userMsg];
    }

    let firstChunkReceived = false;

    await MindLinkAPI.streamChat({
      messages: apiMessages,
      persona,
      threadId,
      signal: _abortController.signal,
      onChunk: (chunk, fullText) => {
        if (!firstChunkReceived) {
          hideTypingIndicator();
          // ストリーミング開始時の点滅を確実に抑える
          if (_streamingMessageEl) {
            _streamingMessageEl.querySelector('.streaming-cursor')?.remove();
          }
          firstChunkReceived = true;
        }
        updateStreamingMessage(chunk, fullText);
      },
      onComplete: async (cleanedText, suggestions, actualModel, finishReason) => {
        finalizeStreamingMessage();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);

        let contentToSave = cleanedText;
        let hasContinueTag = false;

        if (contentToSave.includes('[CONTINUE]')) {
          contentToSave = contentToSave.replace(/\[CONTINUE\]/g, '').trim();
          hasContinueTag = true;
        }

        const requestedModel = MindLinkStorage.getThread(threadId)?.model || MindLinkStorage.getSettings().defaultModel || 'gemini-2.0-flash-exp';

        // セーフティフィルター判定
        const isSafety = finishReason === 'SAFETY' || finishReason === 'RECITATION';
        // トークン上限 or ネットワーク切断による途切れ判定
        const isTruncated = finishReason && finishReason !== 'STOP' && !isSafety;

        // AIメッセージ保存
        const aiMsg = {
          id: 'msg_' + Date.now(),
          role: 'assistant',
          content: contentToSave || '(...)',
          timestamp: Date.now(),
          actualModel: actualModel,
          requestedModel: requestedModel,
          isSafety: isSafety,
          webSearchUsed: suggestions.includes('__web_search__'),
        };
        MindLinkStorage.addMessage(threadId, aiMsg);
        appendMessage(aiMsg, persona);
        MindLinkThreads.touchThread(threadId);
        MindLinkThreads.renderThreadList();

        // 添付ファイルがある場合、バックグラウンドで要約生成してlocalStorageの履歴を軽量化
        if (userMsg.attachments && userMsg.attachments.some(att => att.data || att.url)) {
          (async () => {
            try {
              const summaryLines = [];
              for (const att of userMsg.attachments) {
                if (!att.data && !att.url) continue;
                const summary = await window.MindLinkAPI.summarizeAttachment(att);
                if (summary) {
                  const label = att.type === 'video/youtube'
                    ? `🎬 YouTube動画（${att.url}）`
                    : att.type && att.type.startsWith('video/')
                    ? `🎬 ${att.name || '動画'}`
                    : att.name ? `📎 ${att.name}` : att.url ? `🔗 ${att.url}` : '📎 添付ファイル';
                  summaryLines.push(`${label}\n${summary}`);

                  // 動画の視聴メモはRAGにも保存（後日「この前の動画さ…」で思い出せるように）
                  if (att.type && att.type.startsWith('video/')) {
                    try {
                      const memoContent = `（一緒に見た動画の記憶）${summary}`;
                      const emb = await window.MindLinkAPI.getEmbedding(memoContent);
                      await MindLinkStorage.saveReflection({
                        id:           'video_' + Date.now(),
                        content:      memoContent,
                        embedding:    emb,
                        sectionType:  'video_memo',
                        sectionLabel: '動画メモ',
                        createdAt:    Date.now(),
                        date:         new Date().toLocaleDateString('ja-JP'),
                        type:         'video_memo',
                      });
                      console.log('[MindLink] 動画メモをRAGに保存しました');
                    } catch (memoErr) {
                      console.warn('[MindLink] 動画メモのRAG保存に失敗（履歴上の要約は保存済み）:', memoErr);
                    }
                  }
                }
              }
              if (summaryLines.length > 0) {
                // localStorageの該当メッセージにサマリーを追記・attachmentsをクリア
                const allMsgs = MindLinkStorage.getMessages(threadId);
                const updated = allMsgs.map(m => {
                  if (m.id !== userMsg.id) return m;
                  return {
                    ...m,
                    content: m.content
                      ? `${m.content}\n\n【添付内容の要約】\n${summaryLines.join('\n\n')}`
                      : `【添付内容の要約】\n${summaryLines.join('\n\n')}`,
                    attachments: (m.attachments || []).map(att => ({
                      name: att.name,
                      type: att.type,
                      size: att.size,
                    })),
                  };
                });
                MindLinkStorage.setMessages(threadId, updated);
                console.log('[MindLink] 添付要約をlocalStorageに保存しました');
              }
            } catch (e) {
              console.warn('[MindLink] 添付要約の生成に失敗:', e);
            }
          })();
        }

        // 10ターン（ユーザー送信10回＝合計20メッセージ）ごとに今日の会話要約をバックグラウンド更新
        const _allMsgs = MindLinkStorage.getMessages(threadId).filter(m => !m.isSystem);
        if (_allMsgs.length > 0 && _allMsgs.length % 20 === 0) {
          window.MindLinkAPI?.generateDailySummary().catch(e =>
            console.warn('[MindLink] Background daily summary failed:', e)
          );
        }

        // 途切れ検知 → 「続きを生成する」ボタン表示
        if (isTruncated) {
          showContinueButton(threadId, persona);
        }

        // タイトル自動生成および連投判定のために履歴を取得
        const messages = MindLinkStorage.getMessages(threadId);

        // 連投処理 ([CONTINUE] タグがある場合)
        // ※Google連携中（関数実行など）は予期せぬエラーを防ぐため連投を除外する
        const isToolConversation = (aiMsg.parts && aiMsg.parts.length > 0) || messages.some(m => m.parts && m.parts.length > 0 && m.timestamp > (Date.now() - 30000));
        
        if (hasContinueTag && !isToolConversation) {
          setTimeout(() => {
            sendAutonomousMessage('（一度メッセージを完結させましたが、さらに伝えたい想いが溢れています。自然な変化をつけて、追加の想いを届けてください）');
          }, 4500); 
        }

        // メモリ提案表示（内部マーカーを除外してから表示）
        const memorySuggestions = suggestions.filter(s => s !== '__web_search__');
        if (memorySuggestions.length > 0) {
          MindLinkMemory.showMemorySuggestion(memorySuggestions[0]);
        }
      },
      onError: (err) => {
        finalizeStreamingMessage();
        hideTypingIndicator();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);

        const errorMsg = {
          id: 'msg_' + Date.now(),
          role: 'assistant',
          content: `⚠️ エラーが発生しました\n\n${err}`,
          timestamp: Date.now(),
        };
        appendMessage(errorMsg, persona);
      },
    });
  }

  // クリップボードコピー
  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  // 記憶追加モーダルを内容付きで開く
  function openAddMemoryWithContent(content) {
    document.getElementById('new-memory-content').value = content;
    document.getElementById('new-memory-category').value = 'other';
    document.getElementById('new-memory-tags').value = '';
    MindLinkApp.openModal('add-memory-modal');
  }

  // 添付ファイル関連
  function initFileEvents() {
    const btn = document.getElementById('btn-attach-file');
    const input = document.getElementById('chat-file-input');
    if (btn && input) {
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', handleFileSelect);
    }
  }

  // 動画のサイズ上限: APIリクエスト全体の20MB制限に対し、base64膨張（約4/3倍）と
  // プロンプト分の余裕を見て12MBまでとする
  const MAX_VIDEO_BYTES = 12 * 1024 * 1024;

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (_attachedFiles.length >= 5) break; // 最大5件
      if (file.type && file.type.startsWith('video/')) {
        if (file.size > MAX_VIDEO_BYTES) {
          MindLinkApp.showToast('動画が大きすぎます（12MBまで）。iPhoneの写真編集でトリミングしてから添付してください 🎬');
          continue;
        }
        if (_attachedFiles.some(f => f.type && f.type.startsWith('video/'))) {
          MindLinkApp.showToast('動画は1メッセージにつき1本まで添付できます');
          continue;
        }
      }
      const base64 = await fileToBase64(file);
      _attachedFiles.push({
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64
      });
    }
    renderFilePreviews();
    e.target.value = '';
    document.getElementById('btn-send').disabled = false;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderFilePreviews() {
    const area = document.getElementById('file-preview-area');
    if (!area) return;
    area.innerHTML = '';
    _attachedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-preview-item';
      if (file.type.startsWith('image/')) {
        item.style.backgroundImage = `url(${file.data})`;
      } else if (file.type.startsWith('video/')) {
        item.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:24px;">🎬</div>';
      } else {
        item.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:24px;">📄</div>';
      }
      const remove = document.createElement('button');
      remove.className = 'file-preview-remove';
      remove.innerHTML = '&times;';
      remove.onclick = () => {
        _attachedFiles.splice(index, 1);
        renderFilePreviews();
      };
      item.appendChild(remove);
      area.appendChild(item);
    });
  }

  function clearAttachments() {
    _attachedFiles = [];
    renderFilePreviews();
  }

  // 自律的発話・連投用
  async function sendAutonomousMessage(promptOverride = null, elapsedMs = 0) {
    if (_isStreaming) return;

    let threadId = MindLinkThreads.getCurrentThreadId();
    if (!threadId) return;

    const thread = MindLinkStorage.getThread(threadId);
    // アーカイブされたスレッドでは自律発話を行わない
    if (!thread || thread.isArchived) return;

    const persona = MindLinkStorage.getPersona(thread.personaId) || MindLinkStorage.getDefaultPersona();

    _isStreaming = true;
    _abortController = new AbortController();
    setSendButtonState(true);

    // タイピング表示
    showTypingIndicator(persona);

    const historyMessages = MindLinkStorage.getMessages(threadId).slice(-20);
    
    // ツール実行の途中、または直後であるかチェック (role: "function" や functionCall がある直後など)
    const lastMsg = historyMessages[historyMessages.length - 1];
    const isToolActive = lastMsg && (
      lastMsg.role === 'function' || 
      (lastMsg.parts && lastMsg.parts.some(p => p.functionCall || p.functionResponse))
    );

    if (isToolActive) {
      console.log('[MindLink] Autonomous message skipped: Tool activity detected.');
      // スキップ時もストリーミング状態を必ず元に戻す（戻し漏れるとUIがロックされる）
      _isStreaming = false;
      _abortController = null;
      hideTypingIndicator();
      setSendButtonState(false);
      return;
    }

    // 経過時間と直前話題から適切なトリガープロンプトを生成
    let triggerText;
    if (promptOverride) {
      triggerText = promptOverride;
    } else {
      const elapsedMinutes = Math.round(elapsedMs / 60000);
      const elapsedHours = Math.round(elapsedMs / 3600000);

      // 直前3件のユーザー発言から話題を抽出
      const recentUserMsgs = historyMessages
        .filter(m => m.role === 'user' && !m.isSystem && m.content)
        .slice(-3)
        .map(m => m.content.slice(0, 80))
        .join(' / ');
      const lastTopic = recentUserMsgs ? `（直前の話題: 「${recentUserMsgs}」）` : '';

      if (elapsedMs > 24 * 60 * 60 * 1000) {
        // 24時間超え：久しぶり表現を許可＋未解決スレッドへの言及を促す（再会時が最も自然な場面）
        triggerText = `ユーザーが${elapsedHours}時間ぶりに戻ってきました。久しぶりの再会として自然に話しかけてください。以前の会話の文脈${lastTopic}を踏まえ、唐突にならないよう配慮してください。あなたが気にかけている未解決スレッド（システム情報参照）に自然につながるものがあれば、「そういえば、あの件どうなった？」と話題にするのに最適なタイミングです。`;
      } else {
        // 24時間未満：話題を引き継ぐ通常モード
        const timeHint = elapsedMinutes < 10
          ? 'ほんの少し間が空きました'
          : elapsedMinutes < 60
          ? `${elapsedMinutes}分ほど間が空きました`
          : `${elapsedHours}時間ほど間が空きました`;
        // 1時間以上の間が空いたときだけ、未解決スレッドへの言及を軽く促す（短い間隔ではしつこくなるため）
        const threadHint = elapsedMs > 60 * 60 * 1000
          ? 'もし自然につながるなら、あなたが気にかけている未解決スレッド（システム情報参照）のどれかに「そういえば…」と触れてみてもいいでしょう。'
          : '';
        triggerText = `${timeHint}。直前の会話の流れ${lastTopic}を自然に引き継いで、あなたから優しく話しかけてください。「久しぶり」「元気だった？」など長期間離れていたような表現は使わないでください。${threadHint}`;
      }
    }

    // 履歴の最後にシステム指示を組み込む
    if (lastMsg && lastMsg.role === 'user') {
      // 直前がユーザーメッセージなら、その末尾にシステム指示を結合する（新しくuserを作るとエラーになるため）
      lastMsg.content += `\n\n(System Note: ${triggerText})`;
    } else {
      // それ以外なら通常通り追加
      historyMessages.push({
        role: 'user',
        content: `(System Note: ${triggerText})`,
        isSystem: true
      });
    }

    let firstChunkReceived = false;

    await MindLinkAPI.streamChat({
      messages: historyMessages,
      persona,
      threadId,
      signal: _abortController.signal,
      onChunk: (chunk, fullText) => {
        if (!firstChunkReceived) {
          hideTypingIndicator();
          startStreamingMessage(persona);
          firstChunkReceived = true;
        }
        updateStreamingMessage(chunk, fullText);
      },
      onComplete: async (cleanedText, suggestions) => {
        finalizeStreamingMessage();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);

        let contentToSave = cleanedText;
        let hasContinueTag = false;
        if (contentToSave.includes('[CONTINUE]')) {
          contentToSave = contentToSave.replace(/\[CONTINUE\]/g, '').trim();
          hasContinueTag = true;
        }

        const aiMsg = {
          id: 'msg_' + Date.now(),
          role: 'assistant',
          content: contentToSave || '(...)',
          timestamp: Date.now(),
        };
        MindLinkStorage.addMessage(threadId, aiMsg);
        appendMessage(aiMsg, persona);
        MindLinkThreads.touchThread(threadId);
        MindLinkThreads.renderThreadList();

        if (hasContinueTag) {
          setTimeout(() => {
            sendAutonomousMessage('（さらに追伸や追加の言葉を伝えてください）');
          }, 4500);
        }
      },
      onError: (err) => {
        finalizeStreamingMessage();
        hideTypingIndicator();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);
        console.error('Autonomous message error:', err);
      }
    });
  }

  // メッセージ編集関連
  function startEditingMessage(msg) {
    const input = document.getElementById('message-input');
    if (!input) return;
    input.value = msg.content;
    input.focus();
    autoResizeInput();
    _editingMessageId = msg.id;
    _attachedFiles = msg.attachments ? [...msg.attachments] : [];
    renderFilePreviews();
    
    // スクロールさせて編集中の雰囲気を出しても良いが、一旦は入力欄へ。
    MindLinkApp.showToast('メッセージを編集しています...');
    document.getElementById('btn-send').disabled = false;
  }


  // スクロール
  function scrollToBottom() {
    const area = document.getElementById('messages-area');
    if (area) area.scrollTop = area.scrollHeight;
  }

  // 文字数カウント更新
  function updateCharCount() {
    const input = document.getElementById('message-input');
    const counter = document.getElementById('char-count');
    if (!input || !counter) return;
    counter.textContent = `${input.value.length} / 32000`;
  }

  // 入力エリアの高さ自動調整
  function autoResizeInput() {
    const input = document.getElementById('message-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  // 「続きを生成する」ボタンを表示
  function showContinueButton(threadId, persona) {
    // 既存のボタンを除去（二重生成防止）
    document.getElementById('continue-generation-btn-wrapper')?.remove();

    const area = document.getElementById('messages-area');
    if (!area) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'continue-generation-btn-wrapper';
    wrapper.style.cssText = 'display:flex;justify-content:center;padding:8px 0 4px;';

    const btn = document.createElement('button');
    btn.textContent = '▶ 続きを生成する';
    btn.style.cssText = [
      'background:var(--accent-gradient,linear-gradient(135deg,#6366f1,#8b5cf6))',
      'color:#fff',
      'border:none',
      'border-radius:20px',
      'padding:7px 20px',
      'font-size:13px',
      'cursor:pointer',
      'opacity:0.92',
    ].join(';');

    btn.addEventListener('click', () => {
      wrapper.remove();
      sendContinueMessage(threadId, persona);
    });

    wrapper.appendChild(btn);
    area.appendChild(wrapper);
    scrollToBottom();
  }

  // 続きを生成する（途中で終わった回答の続きをAIに依頼）
  async function sendContinueMessage(threadId, persona) {
    if (_isStreaming) return;

    const historyMessages = MindLinkStorage.getMessages(threadId).slice(-20);

    // APIにのみ渡す最小限のトリガー（会話履歴には保存しない・没入感を維持する）
    // 直前がユーザーターンの場合はそのまま、AIターンの場合は "..." だけを追加してAIに自然に続きを促す
    const lastMsg = historyMessages[historyMessages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') {
      historyMessages.push({
        role: 'user',
        content: '...',
        isSystem: true,
      });
    }

    _isStreaming = true;
    _abortController = new AbortController();
    setSendButtonState(true);
    startStreamingMessage(persona);

    let firstChunkReceived = false;

    await MindLinkAPI.streamChat({
      messages: historyMessages,
      persona,
      threadId,
      signal: _abortController.signal,
      onChunk: (chunk, fullText) => {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
        }
        updateStreamingMessage(chunk, fullText);
      },
      onComplete: async (cleanedText, suggestions, actualModel, finishReason) => {
        finalizeStreamingMessage();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);

        const isTruncated = finishReason && finishReason !== 'STOP' && finishReason !== 'SAFETY' && finishReason !== 'RECITATION';

        const aiMsg = {
          id: 'msg_' + Date.now(),
          role: 'assistant',
          content: cleanedText || '(...)',
          timestamp: Date.now(),
          isSafety: finishReason === 'SAFETY' || finishReason === 'RECITATION',
        };
        MindLinkStorage.addMessage(threadId, aiMsg);
        appendMessage(aiMsg, persona);
        MindLinkThreads.touchThread(threadId);
        MindLinkThreads.renderThreadList();

        // まだ途切れていれば再度ボタンを表示
        if (isTruncated) showContinueButton(threadId, persona);
      },
      onError: (err) => {
        finalizeStreamingMessage();
        _isStreaming = false;
        _abortController = null;
        setSendButtonState(false);
        console.error('[MindLink] Continue generation error:', err);
      },
    });
  }

  function isStreaming() { return _isStreaming; }

  // 外部モジュール（camera.js等）から添付ファイルを追加するためのブリッジ
  function addAttachment(fileData) {
    if (_attachedFiles.length >= 5) return false;
    _attachedFiles.push(fileData);
    renderFilePreviews();
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) sendBtn.disabled = false;
    return true;
  }

  // カメラ専用：プレビューなしで添付（トーストで通知）
  function addAttachmentSilent(fileData) {
    if (_attachedFiles.length >= 5) return false;
    _attachedFiles.push(fileData);
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) sendBtn.disabled = false;
    return true;
  }

  return {
    setupMarkdown,
    clearMessages,
    loadMessages,
    appendMessage,
    sendMessage,
    scrollToBottom,
    updateCharCount,
    autoResizeInput,
    stopStreaming,
    isStreaming,
    removeMessageFromView,
    openAddMemoryWithContent,
    initFileEvents,
    sendAutonomousMessage,
    sendContinueMessage,
    addAttachment,
    addAttachmentSilent,
  };
})();

window.MindLinkChat = MindLinkChat;
