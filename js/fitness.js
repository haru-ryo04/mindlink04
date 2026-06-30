/**
 * MindLink - Fitness Module
 * 筋トレ・運動記録機能（フロントエンドのみ・IndexedDB保存）
 *
 * - 日次記録（体重/体脂肪/BMI/カロリー/水分/睡眠）
 * - 筋トレ・有酸素記録（複数追加可・登録済みメニュー使い回し）
 * - 体重/体脂肪の自前SVG折れ線グラフ（30日/90日/全期間）
 * - 日別記録リスト（新しい順・タップで詳細展開）
 * - 保存時にペルソナ（アクティブペルソナのsystemPrompt）の一言を生成
 * - RAG連携：reflectionsへ embeddingなしで保存（夜の省察でベクトル化）
 */

const MindLinkFitness = (() => {

  const BODY_PARTS = ['胸', '背中', '肩', '腕', '脚', '体幹', 'その他'];
  const EMOJIS = ['⭐️', '❤️', '🎊', '💖', '💯', '💐'];

  // ── 状態 ──
  let activeTab    = 'record';   // 'record' | 'chart' | 'history' | 'menu'
  let weightMode   = 'recent';   // 'recent' | 'week' | 'month' | 'year'
  let fatMode      = 'recent';
  let draftWorkouts = [];        // 入力中の筋トレ行
  let draftCardios  = [];        // 入力中の有酸素行
  let editingDate   = null;      // 編集対象の日付（新規はその日の日付）
  let _menus        = [];        // 登録済みメニューのキャッシュ（記録タブの種目セレクト用）

  // ── ユーティリティ ──
  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function todayStr() { return fmt(new Date()); }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  function readNum(id) {
    const el = document.getElementById(id);
    return el ? num(el.value) : null;
  }
  function readStr(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function randomEmoji() {
    return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  }

  function calcBMI(weight, height) {
    if (!weight || !height) return null;
    const h = height / 100;
    return Math.round((weight / (h * h)) * 10) / 10;
  }

  // 連続記録日数（筋トレ or 有酸素がある日の連続日数）
  function calcStreak(logs) {
    const active = new Set(
      logs
        .filter(l => ((l.workouts && l.workouts.length) || 0) + ((l.cardios && l.cardios.length) || 0) > 0)
        .map(l => l.date)
    );
    let streak = 0;
    const d = new Date();
    if (!active.has(fmt(d))) d.setDate(d.getDate() - 1); // 今日未記録なら昨日から数える
    while (active.has(fmt(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // ── 初期化・配線（self-init） ──
  function init() {
    const btn = document.getElementById('btn-fitness');
    if (btn && !btn._fitnessWired) {
      btn._fitnessWired = true;
      btn.addEventListener('click', openFitness);
    }
  }

  async function openFitness() {
    // サイドバーを閉じる（他ボタンと同挙動）
    if (window.MindLinkApp && window.MindLinkApp.openModal) {
      window.MindLinkApp.openModal('fitness-modal');
    } else {
      document.getElementById('fitness-modal')?.classList.add('active');
    }
    activeTab = 'record';
    // 既存の当日記録を下書きに読み込む
    editingDate = todayStr();
    const existing = await MindLinkStorage.getFitnessLogByDate(editingDate);
    draftWorkouts = existing && existing.workouts ? JSON.parse(JSON.stringify(existing.workouts)) : [];
    draftCardios  = existing && existing.cardios  ? JSON.parse(JSON.stringify(existing.cardios))  : [];
    await renderAll(existing);
  }

  function closeFitness() {
    if (window.MindLinkApp && window.MindLinkApp.closeModal) {
      window.MindLinkApp.closeModal('fitness-modal');
    } else {
      document.getElementById('fitness-modal')?.classList.remove('active');
    }
  }

  // ── 全体描画（タブバー＋アクティブタブ） ──
  async function renderAll(prefillLog) {
    const body = document.getElementById('fitness-body');
    if (!body) return;

    const tabs = [
      { key: 'record',  label: '記録' },
      { key: 'chart',   label: 'グラフ' },
      { key: 'history', label: '履歴' },
      { key: 'menu',    label: 'メニュー' },
    ];

    body.innerHTML = `
      <div class="fitness-tabbar" style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">
        ${tabs.map(t => `
          <button class="fitness-tab" data-tab="${t.key}"
            style="flex:1;min-width:64px;padding:8px 6px;border-radius:8px;font-size:0.85rem;cursor:pointer;transition:background 0.15s,color 0.15s;">
            ${t.label}
          </button>`).join('')}
      </div>
      <div id="fitness-tab-content"></div>
    `;

    const tabButtons = body.querySelectorAll('.fitness-tab');
    // 現在地が一目で分かるよう、選択中タブを塗り＋太字、非選択は枠線のみに統一
    const applyTabStyles = () => {
      tabButtons.forEach(b => {
        const isActive = b.dataset.tab === activeTab;
        b.classList.toggle('active', isActive);
        b.style.background = isActive ? 'var(--color-primary,#6366f1)' : 'transparent';
        b.style.color = isActive ? '#fff' : 'inherit';
        b.style.fontWeight = isActive ? '700' : '400';
        b.style.border = isActive ? '1px solid var(--color-primary,#6366f1)' : '1px solid var(--color-border,#ddd)';
      });
    };
    applyTabStyles();

    tabButtons.forEach(b => {
      b.addEventListener('click', async () => {
        activeTab = b.dataset.tab;
        applyTabStyles();            // タブバーの見た目を即更新
        await renderTabContent();
      });
    });

    await renderTabContent(prefillLog);
  }

  async function renderTabContent(prefillLog) {
    const el = document.getElementById('fitness-tab-content');
    if (!el) return;
    if (activeTab === 'record')  return renderRecordTab(el, prefillLog);
    if (activeTab === 'chart')   return renderChartTab(el);
    if (activeTab === 'history') return renderHistoryTab(el);
    if (activeTab === 'menu')    return renderMenuTab(el);
  }

  // ── タブ：記録（基本情報＋日次記録＋筋トレ/有酸素） ──
  async function renderRecordTab(el, prefillLog) {
    const profile = MindLinkStorage.getFitnessProfile();
    const logs = await MindLinkStorage.getFitnessLogs();
    const existing = prefillLog || logs.find(l => l.date === editingDate) || null;
    const streak = calcStreak(logs);
    const menus = await MindLinkStorage.getFitnessMenus();
    _menus = menus; // 種目セレクト用にキャッシュ
    const hasWorkoutMenus = menus.some(m => m.type === 'workout');
    const hasCardioMenus = menus.some(m => m.type === 'cardio');

    const v = (k) => (existing && existing[k] != null ? existing[k] : '');

    el.innerHTML = `
      <div class="fitness-card">
        <div class="fitness-section-title">基本情報</div>
        <div class="fitness-row">
          <label>身長 (cm)</label>
          <input type="number" inputmode="decimal" id="fit-height" value="${profile.height != null ? profile.height : ''}" placeholder="例: 168">
          <button class="btn-secondary btn-sm" id="fit-save-height">保存</button>
        </div>
      </div>

      <div class="fitness-card">
        <div class="fitness-section-title">日次記録（${escapeHtml(editingDate)}）</div>
        <div class="fitness-grid">
          <div class="fitness-field"><label>体重 (kg)</label><input type="number" inputmode="decimal" id="fit-weight" value="${v('weight')}"></div>
          <div class="fitness-field"><label>体脂肪 (%)</label><input type="number" inputmode="decimal" id="fit-bodyFat" value="${v('bodyFat')}"></div>
          <div class="fitness-field"><label>BMI</label><input type="text" id="fit-bmi" value="${v('bmi')}" readonly placeholder="自動計算"></div>
          <div class="fitness-field"><label>必要カロリー (kcal)</label><input type="number" inputmode="numeric" id="fit-targetCalories" value="${v('targetCalories')}"></div>
          <div class="fitness-field"><label>摂取カロリー (kcal)</label><input type="number" inputmode="numeric" id="fit-intakeCalories" value="${v('intakeCalories')}"></div>
          <div class="fitness-field"><label>水分 (ml)</label><input type="number" inputmode="numeric" id="fit-water" value="${v('water')}"></div>
          <div class="fitness-field"><label>睡眠 (h)</label><input type="number" inputmode="decimal" id="fit-sleep" value="${v('sleep')}"></div>
          <div class="fitness-field"><label>連続記録日数</label><input type="text" value="${streak} 日" readonly></div>
        </div>
      </div>

      <div class="fitness-card">
        <div class="fitness-section-title">筋トレ</div>
        <div id="fit-workout-list"></div>
        ${hasWorkoutMenus
          ? `<button class="btn-secondary btn-sm" id="fit-add-workout">＋ 筋トレを追加</button>`
          : `<div class="fitness-empty">先に「メニュー」タブで筋トレ種目を登録してください</div>`}
      </div>

      <div class="fitness-card">
        <div class="fitness-section-title">有酸素</div>
        <div id="fit-cardio-list"></div>
        ${hasCardioMenus
          ? `<button class="btn-secondary btn-sm" id="fit-add-cardio">＋ 有酸素を追加</button>`
          : `<div class="fitness-empty">先に「メニュー」タブで有酸素種目を登録してください</div>`}
      </div>

      ${existing && existing.personaComment ? `
      <div class="fitness-card fitness-persona">
        <div class="fitness-persona-text">${escapeHtml(existing.personaComment)}</div>
        <div class="fitness-persona-emoji">${existing.personaEmoji || ''}</div>
      </div>` : ''}

      <div style="margin-top:8px;">
        <button class="btn-primary" id="fit-save-log" style="width:100%;">この日の記録を保存</button>
      </div>
    `;

    renderDraftWorkouts();
    renderDraftCardios();

    // BMI自動計算
    const recalcBMI = () => {
      const w = readNum('fit-weight');
      const h = readNum('fit-height');
      const bmi = calcBMI(w, h);
      const bmiEl = document.getElementById('fit-bmi');
      if (bmiEl) bmiEl.value = bmi != null ? bmi : '';
    };
    document.getElementById('fit-weight')?.addEventListener('input', recalcBMI);
    document.getElementById('fit-height')?.addEventListener('input', recalcBMI);
    recalcBMI();

    document.getElementById('fit-save-height')?.addEventListener('click', saveProfile);
    document.getElementById('fit-add-workout')?.addEventListener('click', () => {
      draftWorkouts.push({ menuId: '', name: '', bodyPart: '', sets: null, reps: null, weight: null, memo: '' });
      renderDraftWorkouts();
    });
    document.getElementById('fit-add-cardio')?.addEventListener('click', () => {
      draftCardios.push({ menuId: '', name: '', duration: null, steps: null, distance: null, memo: '' });
      renderDraftCardios();
    });
    document.getElementById('fit-save-log')?.addEventListener('click', saveLog);
  }

  function renderDraftWorkouts() {
    const list = document.getElementById('fit-workout-list');
    if (!list) return;
    const workoutMenus = _menus.filter(m => m.type === 'workout');
    list.innerHTML = draftWorkouts.map((w, i) => {
      // 選択中メニューの特定（menuId優先、なければ名前一致でフォールバック）
      const selectedId = (w.menuId && workoutMenus.some(m => m.id === w.menuId))
        ? w.menuId
        : (workoutMenus.find(m => m.name === w.name)?.id || '');
      // 登録一覧に無い過去種目（メニュー削除後など）への案内
      const orphanHint = (!selectedId && w.name)
        ? `<div style="font-size:0.75rem;color:#ef4444;margin-top:4px;">前回の種目「${escapeHtml(w.name)}」は登録一覧にありません。選び直してください。</div>`
        : '';
      return `
      <div class="fitness-subcard" data-i="${i}">
        <div class="fitness-grid">
          <div class="fitness-field" style="grid-column:1 / -1;">
            <label>種目</label>
            <select data-w="menu">
              <option value="">種目を選択</option>
              ${workoutMenus.map(m => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.name)}${m.bodyPart ? `（${escapeHtml(m.bodyPart)}）` : ''}</option>`).join('')}
            </select>
            ${orphanHint}
          </div>
          <div class="fitness-field"><label>回数</label><input type="number" inputmode="numeric" data-w="reps" value="${w.reps != null ? w.reps : ''}"></div>
          <div class="fitness-field"><label>セット</label><input type="number" inputmode="numeric" data-w="sets" value="${w.sets != null ? w.sets : ''}"></div>
          <div class="fitness-field"><label>重量 (kg)</label><input type="number" inputmode="decimal" data-w="weight" value="${w.weight != null ? w.weight : ''}"></div>
          <div class="fitness-field" style="grid-column:1 / -1;"><label>メモ</label><input type="text" data-w="memo" value="${escapeHtml(w.memo)}"></div>
        </div>
        <button class="fitness-remove-btn" data-remove-w="${i}">削除</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.fitness-subcard').forEach(card => {
      const i = Number(card.dataset.i);
      // 種目セレクト：選択で menuId / name / bodyPart を確定
      card.querySelector('select[data-w="menu"]')?.addEventListener('change', (e) => {
        const m = workoutMenus.find(x => x.id === e.target.value);
        if (m) {
          draftWorkouts[i].menuId = m.id;
          draftWorkouts[i].name = m.name;
          draftWorkouts[i].bodyPart = m.bodyPart || '';
        } else {
          draftWorkouts[i].menuId = '';
          draftWorkouts[i].name = '';
          draftWorkouts[i].bodyPart = '';
        }
      });
      // 回数・セット・重量・メモ（都度入力）
      card.querySelectorAll('input[data-w]').forEach(inp => {
        inp.addEventListener('input', () => {
          const key = inp.dataset.w;
          draftWorkouts[i][key] = (key === 'memo') ? inp.value : num(inp.value);
        });
      });
      card.querySelector('[data-remove-w]')?.addEventListener('click', () => {
        draftWorkouts.splice(i, 1);
        renderDraftWorkouts();
      });
    });
  }

  function renderDraftCardios() {
    const list = document.getElementById('fit-cardio-list');
    if (!list) return;
    const cardioMenus = _menus.filter(m => m.type === 'cardio');
    list.innerHTML = draftCardios.map((c, i) => {
      const selectedId = (c.menuId && cardioMenus.some(m => m.id === c.menuId))
        ? c.menuId
        : (cardioMenus.find(m => m.name === c.name)?.id || '');
      const orphanHint = (!selectedId && c.name)
        ? `<div style="font-size:0.75rem;color:#ef4444;margin-top:4px;">前回の種目「${escapeHtml(c.name)}」は登録一覧にありません。選び直してください。</div>`
        : '';
      return `
      <div class="fitness-subcard" data-i="${i}">
        <div class="fitness-grid">
          <div class="fitness-field" style="grid-column:1 / -1;">
            <label>種目</label>
            <select data-c="menu">
              <option value="">種目を選択</option>
              ${cardioMenus.map(m => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
            </select>
            ${orphanHint}
          </div>
          <div class="fitness-field"><label>時間 (分)</label><input type="number" inputmode="numeric" data-c="duration" value="${c.duration != null ? c.duration : ''}"></div>
          <div class="fitness-field"><label>歩数 (歩)</label><input type="number" inputmode="numeric" data-c="steps" value="${c.steps != null ? c.steps : ''}"></div>
          <div class="fitness-field"><label>キロ数 (km)</label><input type="number" inputmode="decimal" data-c="distance" value="${c.distance != null ? c.distance : ''}"></div>
          <div class="fitness-field" style="grid-column:1 / -1;"><label>メモ</label><input type="text" data-c="memo" value="${escapeHtml(c.memo)}"></div>
        </div>
        <button class="fitness-remove-btn" data-remove-c="${i}">削除</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.fitness-subcard').forEach(card => {
      const i = Number(card.dataset.i);
      // 種目セレクト：選択で menuId / name を確定
      card.querySelector('select[data-c="menu"]')?.addEventListener('change', (e) => {
        const m = cardioMenus.find(x => x.id === e.target.value);
        if (m) {
          draftCardios[i].menuId = m.id;
          draftCardios[i].name = m.name;
        } else {
          draftCardios[i].menuId = '';
          draftCardios[i].name = '';
        }
      });
      // 時間・歩数・キロ数・メモ（都度入力）
      card.querySelectorAll('input[data-c]').forEach(inp => {
        inp.addEventListener('input', () => {
          const key = inp.dataset.c;
          draftCardios[i][key] = (key === 'memo') ? inp.value : num(inp.value);
        });
      });
      card.querySelector('[data-remove-c]')?.addEventListener('click', () => {
        draftCardios.splice(i, 1);
        renderDraftCardios();
      });
    });
  }

  // ── プロフィール（身長） ──
  function saveProfile() {
    const h = readNum('fit-height');
    MindLinkStorage.setFitnessProfile({ height: h });
    if (window.MindLinkApp) window.MindLinkApp.showToast('身長を保存しました');
    const w = readNum('fit-weight');
    const bmi = calcBMI(w, h);
    const bmiEl = document.getElementById('fit-bmi');
    if (bmiEl) bmiEl.value = bmi != null ? bmi : '';
  }

  // ── 保存 ──
  async function saveLog() {
    const profile = MindLinkStorage.getFitnessProfile();
    const weight = readNum('fit-weight');
    const height = readNum('fit-height');

    // 入力済みの身長は都度プロフィールにも反映
    if (height != null && height !== profile.height) {
      MindLinkStorage.setFitnessProfile({ height });
    }

    const workouts = draftWorkouts
      .filter(w => w.name && w.name.trim())
      .map(w => ({ ...w, name: w.name.trim() }));
    const cardios = draftCardios
      .filter(c => c.name && c.name.trim())
      .map(c => ({ ...c, name: c.name.trim() }));

    const log = {
      date: editingDate,
      weight,
      bodyFat: readNum('fit-bodyFat'),
      bmi: calcBMI(weight, height),
      targetCalories: readNum('fit-targetCalories'),
      intakeCalories: readNum('fit-intakeCalories'),
      water: readNum('fit-water'),
      sleep: readNum('fit-sleep'),
      workouts,
      cardios,
    };

    // 当日の既存記録（編集判定用）と、直近の過去記録（比較用）
    const allLogs = await MindLinkStorage.getFitnessLogs();
    const existing = allLogs.find(l => l.date === editingDate) || null;
    const prev = allLogs
      .filter(l => l.date < editingDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;

    // 既にペルソナの一言があれば引き継ぐ（2回目以降の編集では再生成しない）
    const hasComment = !!(existing && existing.personaComment);
    if (hasComment) {
      log.personaComment = existing.personaComment;
      log.personaEmoji = existing.personaEmoji;
    }

    // まず記録を保存（API失敗でも記録は残す）
    await MindLinkStorage.saveFitnessLog(log);
    if (window.MindLinkApp) window.MindLinkApp.showToast('記録を保存しました 💪');

    // RAG用テキストを reflections に保存（毎回・即時ベクトル化）
    await saveFitnessReflection(log);

    // ペルソナの一言は「初回保存のみ」生成（コスト節約。2回目以降の編集では生成しない）
    if (!hasComment) {
      try {
        const comment = await generatePersonaComment(log, prev);
        if (comment) {
          log.personaComment = comment;
          log.personaEmoji = randomEmoji();
          await MindLinkStorage.saveFitnessLog(log);
        }
      } catch (e) {
        console.warn('[Fitness] persona comment failed:', e);
      }
    }

    // 再描画
    await renderAll(log);
  }

  // ── RAG連携：reflections へ embeddingなしで保存 ──
  function buildLogText(log) {
    const parts = [];
    if (log.weight != null) parts.push(`体重${log.weight}kg`);
    if (log.bodyFat != null) parts.push(`体脂肪${log.bodyFat}%`);
    if (log.bmi != null) parts.push(`BMI${log.bmi}`);
    if (log.intakeCalories != null) parts.push(`摂取${log.intakeCalories}kcal`);
    if (log.targetCalories != null) parts.push(`必要${log.targetCalories}kcal`);
    if (log.water != null) parts.push(`水分${log.water}ml`);
    if (log.sleep != null) parts.push(`睡眠${log.sleep}h`);

    let text = `【フィットネス記録 ${log.date}】` + (parts.length ? ' ' + parts.join('・') : '');
    if (log.workouts && log.workouts.length) {
      text += '\n筋トレ: ' + log.workouts.map(w => {
        let s = `${w.name}（${w.bodyPart || ''}）`;
        const detail = [];
        if (w.sets != null) detail.push(`${w.sets}セット`);
        if (w.reps != null) detail.push(`${w.reps}回`);
        if (w.weight != null) detail.push(`${w.weight}kg`);
        if (detail.length) s += detail.join('×');
        if (w.memo) s += `(${w.memo})`;
        return s;
      }).join('、');
    }
    if (log.cardios && log.cardios.length) {
      text += '\n有酸素: ' + log.cardios.map(c => {
        let s = c.name;
        const d = [];
        if (c.duration != null) d.push(`${c.duration}分`);
        if (c.steps != null) d.push(`${c.steps}歩`);
        if (c.distance != null) d.push(`${c.distance}km`);
        if (d.length) s += d.join('・');
        if (c.memo) s += `(${c.memo})`;
        return s;
      }).join('、');
    }
    return text;
  }

  async function saveFitnessReflection(log) {
    const content = buildLogText(log);
    const reflection = {
      id: 'fitness_refl_' + log.date,   // 日付ごとに1件・上書き
      content,
      sectionType: 'fitness_log',
      sectionLabel: 'フィットネス記録',
      type: 'fitness',
      date: log.date,
      createdAt: Date.now(),
    };
    // 即時ベクトル化（当日からRAGで参照可能に）。失敗時は夜の省察がフォールバックで再変換。
    try {
      if (window.MindLinkAPI && window.MindLinkAPI.getEmbedding) {
        reflection.embedding = await window.MindLinkAPI.getEmbedding(content);
      }
    } catch (e) {
      console.warn('[Fitness] immediate embedding failed (will retry at night):', e);
    }
    try {
      await MindLinkStorage.saveReflection(reflection);
    } catch (e) {
      console.warn('[Fitness] saveFitnessReflection failed:', e);
    }
  }

  // テキストを文末で自然に終わらせる（max超過時のみ、文末記号で切る）
  function trimToSentence(text, max) {
    const t = (text || '').trim();
    if (t.length <= max) return t;
    const slice = t.slice(0, max);
    // 上限内の最後の文末記号（。．！？…〜 や閉じ括弧）までで終える
    const m = slice.match(/[\s\S]*[。．！!？?…〜」』）)]/);
    if (m && m[0].trim().length >= 150) return m[0].trim();
    return slice.trim() + '…';
  }

  // ── ペルソナの一言 ──
  async function generatePersonaComment(current, prev) {
    if (!window.MindLinkAPI || !window.MindLinkAPI.getSummary) return '';
    const persona = MindLinkStorage.getPersona(MindLinkStorage.getActivePersonaId());
    const sys = (persona && persona.systemPrompt) ? persona.systemPrompt : '';

    let compare = '';
    if (prev) {
      const lines = [];
      if (current.weight != null && prev.weight != null) {
        const d = Math.round((current.weight - prev.weight) * 10) / 10;
        lines.push(`体重: 前回${prev.weight}kg → 今回${current.weight}kg（${d > 0 ? '+' : ''}${d}kg）`);
      }
      if (current.bodyFat != null && prev.bodyFat != null) {
        const d = Math.round((current.bodyFat - prev.bodyFat) * 10) / 10;
        lines.push(`体脂肪: 前回${prev.bodyFat}% → 今回${current.bodyFat}%（${d > 0 ? '+' : ''}${d}%）`);
      }
      if (lines.length) compare = `\n\n# 前回との比較\n${lines.join('\n')}`;
    }

    const logs = await MindLinkStorage.getFitnessLogs();
    const streak = calcStreak(logs);

    const prompt = `${sys}

# 役割
あなたは上記のキャラクターです。その人格・口調を必ず保ってください。
ユーザーが今日のフィットネス記録を保存しました。記録を見て、ねぎらいと励ましの「一言」を返してください。

# 今日の記録
${buildLogText(current)}
連続記録日数: ${streak}日${compare}

# 指示
- 200〜300文字程度。途中で切らず、必ず文を最後まで完結させる（文末は「。」「！」「？」などで終える）。
- キャラクターの口調・一人称を厳守。
- 体重や体脂肪が下がっていたら気づいて触れる。連続記録日数が伸びていたら褒める。
- 自然な話し言葉で、温かく。説明や前置きは不要。一言だけを出力。`;

    const text = await window.MindLinkAPI.getSummary(prompt, false);
    if (!text) return '';
    return trimToSentence(text, 300);
  }

  // ── タブ：グラフ ──
  async function renderChartTab(el) {
    const logs = await MindLinkStorage.getFitnessLogs();

    el.innerHTML = `
      <div class="fitness-card">
        <div class="fitness-section-title">体重 (kg)</div>
        ${modeButtons('weight', weightMode)}
        <div id="fit-chart-weight" style="margin-top:8px;"></div>
      </div>
      <div class="fitness-card">
        <div class="fitness-section-title">体脂肪 (%)</div>
        ${modeButtons('bodyFat', fatMode)}
        <div id="fit-chart-bodyFat" style="margin-top:8px;"></div>
      </div>
    `;

    drawChartInto('fit-chart-weight', aggregate(logs, 'weight', weightMode), '#6366f1', 2);
    drawChartInto('fit-chart-bodyFat', aggregate(logs, 'bodyFat', fatMode), '#10b981', 2);

    el.querySelectorAll('[data-mode]').forEach(b => {
      b.addEventListener('click', () => {
        const metric = b.dataset.metric;
        const mode = b.dataset.mode;
        if (metric === 'weight') weightMode = mode; else fatMode = mode;
        renderChartTab(el);
      });
    });
  }

  function modeButtons(metric, current) {
    const opts = [['recent', '最近'], ['week', '週'], ['month', '月'], ['year', '年']];
    return `<div class="fitness-range-buttons">${opts.map(([k, label]) => `
      <button data-metric="${metric}" data-mode="${k}"
        class="${k === current ? 'active' : ''}">${label}</button>`).join('')}</div>`;
  }

  // 期間モードに応じてデータを集計し [{label, value}]（古い順）を返す
  function aggregate(logs, metric, mode) {
    const valid = logs
      .filter(l => typeof l[metric] === 'number' && !isNaN(l[metric]))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (valid.length === 0) return [];

    // 最近：直近の個別記録（最大10件）／ラベル MM/DD
    if (mode === 'recent') {
      return valid.slice(-10).map(l => ({ label: l.date.slice(5).replace('-', '/'), value: l[metric] }));
    }

    // 週/月/年：期間ごとに平均
    const groups = new Map();
    for (const l of valid) {
      const [yy, mm] = l.date.split('-');
      let key, label;
      if (mode === 'week') {
        const dt = new Date(l.date + 'T00:00:00');
        const start = new Date(dt); start.setDate(dt.getDate() - dt.getDay()); // 日曜始まり
        const end = new Date(start); end.setDate(start.getDate() + 6);
        key = fmt(start);
        label = `${fmt(start).slice(5).replace('-', '/')}-${fmt(end).slice(5).replace('-', '/')}`;
      } else if (mode === 'month') {
        key = `${yy}-${mm}`;
        label = `${yy}/${mm}`;
      } else { // year
        key = yy;
        label = yy;
      }
      const g = groups.get(key) || { sum: 0, count: 0, key, label };
      g.sum += l[metric]; g.count++;
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(g => ({ label: g.label, value: Math.round((g.sum / g.count) * 10) / 10 }));
  }

  function drawChartInto(containerId, series, color, step) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!series || series.length === 0) {
      container.innerHTML = `<div class="fitness-empty">データがありません</div>`;
      return;
    }
    container.innerHTML = buildSvgAreaChart(series, color, step);
  }

  // 面塗り＋中空マーカー＋2単位グリッド＋横スクロール（Y軸ラベルは左に固定）
  function buildSvgAreaChart(series, color, step) {
    const H = 200;
    const padT = 14, padB = 30;
    const innerH = H - padT - padB;
    const Wy = 42; // 固定するY軸ラベル列の幅

    // 縦メモリを step（2）の倍数に丸める
    const values = series.map(s => s.value);
    let niceMin = Math.floor(Math.min(...values) / step) * step;
    let niceMax = Math.ceil(Math.max(...values) / step) * step;
    if (niceMin === niceMax) { niceMin -= step; niceMax += step; }
    const span = niceMax - niceMin;
    const y = (val) => padT + innerH - ((val - niceMin) / span) * innerH;

    const ticks = [];
    for (let v = niceMin; v <= niceMax + 1e-6; v += step) ticks.push(Math.round(v * 10) / 10);

    // 横スクロール用：点数に応じて横幅を確保
    const n = series.length;
    const perPoint = 70, padL = 12, padR = 16;
    const plotW = Math.max(300, padL + padR + (n <= 1 ? 0 : (n - 1) * perPoint));
    const innerW = plotW - padL - padR;
    const x = (i) => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
    const baseY = padT + innerH;

    const linePts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
    const gid = 'fitgrad_' + Math.random().toString(36).slice(2, 7);

    // 横グリッド線（2単位）
    const gridLines = ticks.map(t =>
      `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${(plotW - padR).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="currentColor" stroke-opacity="0.10"></line>`
    ).join('');

    // 各点の小目盛り
    const xTicks = series.map((s, i) =>
      `<line x1="${x(i).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${(baseY + 4).toFixed(1)}" stroke="currentColor" stroke-opacity="0.25"></line>`
    ).join('');

    // X軸ラベル（間引き：最大8個・最初と最後を含む）
    const maxLabels = 8;
    const stride = Math.max(1, Math.ceil(n / maxLabels));
    const xLabels = series.map((s, i) => {
      if (!(i % stride === 0 || i === n - 1)) return '';
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      return `<text x="${x(i).toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="currentColor" fill-opacity="0.6">${escapeHtml(s.label)}</text>`;
    }).join('');

    // 中空丸マーカー
    const dots = series.map((s, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="4" fill="#fff" stroke="${color}" stroke-width="2"></circle>`
    ).join('');

    // 固定Y軸ラベル（プロットと同じスケール）
    const yAxisSvg = `<svg width="${Wy}" height="${H}" viewBox="0 0 ${Wy} ${H}" style="flex:0 0 ${Wy}px;display:block;">
      ${ticks.map(t => `<text x="${Wy - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.6">${t}</text>`).join('')}
    </svg>`;

    // プロット本体（横スクロール）
    const plotSvg = `<svg width="${plotW}" height="${H}" viewBox="0 0 ${plotW} ${H}" style="display:block;">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"></stop>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
      </linearGradient></defs>
      ${gridLines}
      ${n > 1 ? `<polygon points="${padL.toFixed(1)},${baseY.toFixed(1)} ${linePts} ${x(n - 1).toFixed(1)},${baseY.toFixed(1)}" fill="url(#${gid})"></polygon>` : ''}
      <polyline points="${linePts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${xTicks}
      ${dots}
      ${xLabels}
    </svg>`;

    return `<div style="display:flex;align-items:flex-start;">
      ${yAxisSvg}
      <div style="flex:1;overflow-x:auto;-webkit-overflow-scrolling:touch;">${plotSvg}</div>
    </div>`;
  }

  // ── タブ：履歴（新しい順・タップで詳細展開） ──
  async function renderHistoryTab(el) {
    const logs = await MindLinkStorage.getFitnessLogs();
    logs.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新しい順

    if (logs.length === 0) {
      el.innerHTML = `<div class="fitness-empty">まだ記録がありません</div>`;
      return;
    }

    el.innerHTML = `<div class="fitness-history-list">${logs.map(log => {
      const summary = [];
      if (log.weight != null) summary.push(`${log.weight}kg`);
      if (log.bodyFat != null) summary.push(`${log.bodyFat}%`);
      const wc = ((log.workouts && log.workouts.length) || 0) + ((log.cardios && log.cardios.length) || 0);
      if (wc > 0) summary.push(`運動${wc}件`);
      return `
        <div class="fitness-acc-item" data-id="${log.id}" data-date="${log.date}">
          <div class="fitness-acc-header">
            <span class="fitness-acc-date">📅 ${escapeHtml(log.date)}</span>
            <span class="fitness-acc-summary">${escapeHtml(summary.join(' / '))}</span>
            <svg class="fitness-acc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
          <div class="fitness-acc-body">${buildDetailHtml(log)}</div>
        </div>`;
    }).join('')}</div>`;

    el.querySelectorAll('.fitness-acc-item').forEach(item => {
      item.querySelector('.fitness-acc-header').addEventListener('click', () => {
        item.classList.toggle('active');
      });
      item.querySelector('[data-edit-log]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        editingDate = item.dataset.date;
        const log = (await MindLinkStorage.getFitnessLogs()).find(l => l.id === item.dataset.id);
        draftWorkouts = log && log.workouts ? JSON.parse(JSON.stringify(log.workouts)) : [];
        draftCardios  = log && log.cardios  ? JSON.parse(JSON.stringify(log.cardios))  : [];
        activeTab = 'record';
        await renderAll(log);
      });
      item.querySelector('[data-del-log]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = item.dataset.id;
        const doDelete = async () => {
          await MindLinkStorage.deleteFitnessLog(id);
          await MindLinkStorage.deleteReflection('fitness_refl_' + item.dataset.date).catch(() => {});
          if (window.MindLinkApp) window.MindLinkApp.showToast('記録を削除しました');
          await renderHistoryTab(el);
        };
        if (window.MindLinkApp && window.MindLinkApp.showConfirm) {
          window.MindLinkApp.showConfirm('記録を削除', `${item.dataset.date} の記録を削除しますか？`, doDelete);
        } else if (confirm('削除しますか？')) {
          doDelete();
        }
      });
    });
  }

  function buildDetailHtml(log) {
    const rows = [];
    const add = (label, val, unit) => { if (val != null) rows.push(`<div><span>${label}</span><b>${val}${unit || ''}</b></div>`); };
    add('体重', log.weight, 'kg');
    add('体脂肪', log.bodyFat, '%');
    add('BMI', log.bmi, '');
    add('必要カロリー', log.targetCalories, 'kcal');
    add('摂取カロリー', log.intakeCalories, 'kcal');
    add('水分', log.water, 'ml');
    add('睡眠', log.sleep, 'h');

    let html = `<div class="fitness-detail-grid">${rows.join('')}</div>`;

    if (log.workouts && log.workouts.length) {
      html += `<div class="fitness-detail-title">筋トレ</div>` + log.workouts.map(w => {
        const d = [];
        if (w.reps != null) d.push(`${w.reps}回`);
        if (w.sets != null) d.push(`${w.sets}セット`);
        if (w.weight != null) d.push(`${w.weight}kg`);
        return `<div class="fitness-detail-line">・${escapeHtml(w.name)}（${escapeHtml(w.bodyPart || '')}）${escapeHtml(d.join('×'))}${w.memo ? ' ' + escapeHtml(w.memo) : ''}</div>`;
      }).join('');
    }
    if (log.cardios && log.cardios.length) {
      html += `<div class="fitness-detail-title">有酸素</div>` + log.cardios.map(c => {
        const d = [];
        if (c.duration != null) d.push(`${c.duration}分`);
        if (c.steps != null) d.push(`${c.steps}歩`);
        if (c.distance != null) d.push(`${c.distance}km`);
        return `<div class="fitness-detail-line">・${escapeHtml(c.name)}${d.length ? ' ' + escapeHtml(d.join('・')) : ''}${c.memo ? ' ' + escapeHtml(c.memo) : ''}</div>`;
      }).join('');
    }
    if (log.personaComment) {
      html += `<div class="fitness-detail-persona">${escapeHtml(log.personaComment)} ${log.personaEmoji || ''}</div>`;
    }
    html += `<div class="fitness-detail-actions">
      <button class="btn-secondary btn-sm" data-edit-log>編集</button>
      <button class="btn-secondary btn-sm fitness-del" data-del-log>削除</button>
    </div>`;
    return html;
  }

  // ── タブ：メニュー管理 ──
  async function renderMenuTab(el) {
    const menus = await MindLinkStorage.getFitnessMenus();
    const workouts = menus.filter(m => m.type === 'workout');
    const cardios = menus.filter(m => m.type === 'cardio');

    el.innerHTML = `
      <div class="fitness-card">
        <div class="fitness-section-title">メニューを追加</div>
        <div class="fitness-grid">
          <div class="fitness-field"><label>種別</label>
            <select id="fit-menu-type">
              <option value="workout">筋トレ</option>
              <option value="cardio">有酸素</option>
            </select>
          </div>
          <div class="fitness-field" id="fit-menu-bodypart-field"><label>部位</label>
            <select id="fit-menu-bodypart">${BODY_PARTS.map(p => `<option value="${p}">${p}</option>`).join('')}</select>
          </div>
          <div class="fitness-field" style="grid-column:1 / -1;"><label>メニュー名</label><input type="text" id="fit-menu-name" placeholder="例: ベンチプレス"></div>
        </div>
        <button class="btn-secondary btn-sm" id="fit-add-menu">＋ 登録</button>
      </div>

      <div class="fitness-card">
        <div class="fitness-section-title">登録済み（筋トレ）</div>
        ${workouts.length ? workouts.map(m => menuRow(m)).join('') : '<div class="fitness-empty">なし</div>'}
      </div>
      <div class="fitness-card">
        <div class="fitness-section-title">登録済み（有酸素）</div>
        ${cardios.length ? cardios.map(m => menuRow(m)).join('') : '<div class="fitness-empty">なし</div>'}
      </div>
    `;

    // 種別に応じて部位フィールドの表示/非表示を切り替え（有酸素は部位なし）
    const typeSel = document.getElementById('fit-menu-type');
    const bpField = document.getElementById('fit-menu-bodypart-field');
    const syncBodyPartVisibility = () => {
      if (bpField) bpField.style.display = (typeSel?.value === 'workout') ? '' : 'none';
    };
    typeSel?.addEventListener('change', syncBodyPartVisibility);
    syncBodyPartVisibility();

    document.getElementById('fit-add-menu')?.addEventListener('click', async () => {
      const type = readStr('fit-menu-type');
      const name = readStr('fit-menu-name');
      const bodyPart = type === 'workout' ? readStr('fit-menu-bodypart') : '';
      if (!name) { if (window.MindLinkApp) window.MindLinkApp.showToast('メニュー名を入力してください'); return; }
      await MindLinkStorage.saveFitnessMenu({ type, name, bodyPart });
      if (window.MindLinkApp) window.MindLinkApp.showToast('メニューを登録しました');
      await renderMenuTab(el);
    });

    el.querySelectorAll('[data-menu-id]').forEach(row => {
      const id = row.dataset.menuId;
      row.querySelector('[data-menu-rename]')?.addEventListener('click', async () => {
        const m = (await MindLinkStorage.getFitnessMenus()).find(x => x.id === id);
        if (!m) return;
        const nv = prompt('メニュー名を編集', m.name);
        if (nv && nv.trim()) {
          await MindLinkStorage.saveFitnessMenu({ ...m, name: nv.trim() });
          await renderMenuTab(el);
        }
      });
      row.querySelector('[data-menu-del]')?.addEventListener('click', async () => {
        await MindLinkStorage.deleteFitnessMenu(id);
        await renderMenuTab(el);
      });
    });
  }

  function menuRow(m) {
    return `<div class="fitness-menu-row" data-menu-id="${m.id}">
      <span>${escapeHtml(m.name)}${m.bodyPart ? `（${escapeHtml(m.bodyPart)}）` : ''}</span>
      <span class="fitness-menu-actions">
        <button class="btn-secondary btn-sm" data-menu-rename>編集</button>
        <button class="btn-secondary btn-sm" data-menu-del>削除</button>
      </span>
    </div>`;
  }

  return { init, openFitness };
})();

window.MindLinkFitness = MindLinkFitness;

// body末尾で読み込まれるため、即時に配線（btn-fitnessは既にDOMに存在）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => MindLinkFitness.init());
} else {
  MindLinkFitness.init();
}
