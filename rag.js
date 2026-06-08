/**
 * MindLink - Personas Module
 * ペルソナ管理
 */

const MindLinkPersonas = (() => {
  function generateId() {
    return 'persona_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // ペルソナ一覧描画
  function renderPersonaList() {
    const listEl = document.getElementById('persona-list');
    if (!listEl) return;

    const personas = MindLinkStorage.getPersonas();
    const activeId = MindLinkStorage.getActivePersonaId();
    listEl.innerHTML = '';

    personas.forEach(p => {
      const div = document.createElement('div');
      div.className = 'persona-item' + (p.id === activeId ? ' active-persona' : '');
      div.dataset.personaId = p.id;
        const avatarHtml = p.avatar && p.avatar.startsWith('data:image') 
          ? `<div class="persona-avatar avatar-img" style="background-image: url(${p.avatar}); border-radius:50%; width:40px; height:40px; background-size:cover; background-position:center;"></div>`
          : `<div class="persona-avatar">${p.avatar || '🌙'}</div>`;

      div.innerHTML = `
        ${avatarHtml}
        <div class="persona-body">
          <div class="persona-name">${escapeHtml(p.name)}</div>
          <div class="persona-desc">${escapeHtml(p.description || 'カスタム指示なし')}</div>
        </div>
        <div class="persona-actions">
          ${p.id === activeId ? '<span class="persona-active-badge">使用中</span>' : ''}
          <button class="btn-icon" data-edit="${p.id}" title="編集">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          ${!p.isDefault ? `<button class="btn-icon memory-delete-btn" data-del-persona="${p.id}" title="削除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
          </button>` : ''}
        </div>
      `;

      // ペルソナのクリックで選択
      div.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectPersona(p.id);
        renderPersonaList();
      });

      // 編集ボタン
      div.querySelector('[data-edit]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditPersonaModal(p.id);
      });

      // 削除ボタン
      div.querySelector('[data-del-persona]')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        MindLinkApp.showConfirm('ペルソナを削除', `「${p.name}」を削除しますか？`, () => {
          MindLinkStorage.deletePersona(p.id);
          if (MindLinkStorage.getActivePersonaId() === p.id) {
            const defaultPersona = MindLinkStorage.getDefaultPersona();
            selectPersona(defaultPersona?.id);
          }
          renderPersonaList();
          MindLinkApp.showToast('ペルソナを削除しました');
        });
      });

      listEl.appendChild(div);
    });
  }

  // ペルソナ選択
  function selectPersona(id) {
    MindLinkStorage.setActivePersonaId(id);
    const persona = MindLinkStorage.getPersona(id);
    const nameEl = document.getElementById('current-persona-name');
    if (nameEl && persona) {
      const avatarHtml = persona.avatar && persona.avatar.startsWith('data:image') 
        ? `<div class="avatar-img-inline" style="background-image: url(${persona.avatar}); border-radius:50%; width:24px; height:24px; background-size:cover; background-position:center; display:inline-block; vertical-align:middle; margin-right:6px;"></div>`
        : `<span style="margin-right:6px;">${persona.avatar || '🌙'}</span>`;
      nameEl.innerHTML = `${avatarHtml} <span style="vertical-align:middle">${escapeHtml(persona.name)}</span>`;
    }
  }

  // ペルソナ編集モーダルを開く
  function openEditPersonaModal(id) {
    const isNew = !id;
    const persona = id ? MindLinkStorage.getPersona(id) : null;

    document.getElementById('edit-persona-title').textContent = isNew ? '新しいペルソナ' : 'ペルソナを編集';
    document.getElementById('edit-persona-id').value = id || '';
    
    const avatar = persona?.avatar || '🌙';
    const pAvatarText = document.getElementById('persona-avatar');
    const pAvatarPreview = document.getElementById('persona-avatar-preview');
    
    if (avatar.startsWith('data:image')) {
      if (pAvatarText) pAvatarText.style.display = 'none';
      if (pAvatarPreview) {
        pAvatarPreview.style.display = 'block';
        pAvatarPreview.style.backgroundImage = `url(${avatar})`;
        pAvatarPreview.dataset.base64 = avatar;
      }
    } else {
      if (pAvatarText) {
        pAvatarText.style.display = 'block';
        pAvatarText.value = avatar;
      }
      if (pAvatarPreview) {
        pAvatarPreview.style.display = 'none';
        pAvatarPreview.dataset.base64 = '';
      }
    }

    document.getElementById('persona-name').value = persona?.name || '';
    document.getElementById('persona-description').value = persona?.description || '';
    document.getElementById('persona-system-prompt').value = persona?.systemPrompt || '';

    document.getElementById('persona-use-memory').checked = persona?.useMemory !== false;

    // アバタープリセットの選択状態更新
    document.querySelectorAll('.avatar-preset').forEach(btn => {
      btn.classList.toggle('selected', !avatar.startsWith('data:image') && btn.dataset.emoji === avatar);
    });

    MindLinkApp.openModal('edit-persona-modal');
  }

  // ペルソナ保存
  function savePersona() {
    const id = document.getElementById('edit-persona-id').value;
    const pAvatarPreview = document.getElementById('persona-avatar-preview');
    const pAvatarText = document.getElementById('persona-avatar');
    
    let avatar = '🌙';
    if (pAvatarPreview && pAvatarPreview.style.display === 'block' && pAvatarPreview.dataset.base64) {
      avatar = pAvatarPreview.dataset.base64;
    } else if (pAvatarText && pAvatarText.value.trim()) {
      avatar = pAvatarText.value.trim();
    }
    
    const name = document.getElementById('persona-name').value.trim();
    const description = document.getElementById('persona-description').value.trim();
    const systemPrompt = document.getElementById('persona-system-prompt').value.trim();
    const useMemory = document.getElementById('persona-use-memory').checked;

    if (!name) {
      MindLinkApp.showToast('名前を入力してください');
      return;
    }

    const existingPersona = id ? MindLinkStorage.getPersona(id) : null;
    const persona = {
      id: id || generateId(),
      name,
      description,
      avatar,
      systemPrompt,
      useMemory,
      isDefault: existingPersona?.isDefault || false,
      createdAt: existingPersona?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    MindLinkStorage.savePersona(persona);
    renderPersonaList();
    MindLinkApp.closeModal('edit-persona-modal');
    MindLinkApp.showToast('ペルソナを保存しました ✨');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return {
    renderPersonaList,
    selectPersona,
    openEditPersonaModal,
    savePersona,
  };
})();

window.MindLinkPersonas = MindLinkPersonas;
