/**
 * MindLink - Camera Module
 * iOSネイティブカメラ起動 + 画像リサイズ処理
 */

const MindLinkCamera = (() => {
  const MAX_SIZE = 1280;   // 長辺の最大ピクセル数
  const QUALITY  = 0.85;  // JPEG圧縮品質

  /**
   * DataURL形式の画像をリサイズ・圧縮して返す
   */
  function resizeImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        // 長辺がMAX_SIZEを超える場合のみ縮小
        if (width > MAX_SIZE || height > MAX_SIZE) {
          if (width >= height) {
            height = Math.round(height * MAX_SIZE / width);
            width  = MAX_SIZE;
          } else {
            width  = Math.round(width * MAX_SIZE / height);
            height = MAX_SIZE;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      };
      img.onerror = () => resolve(dataUrl); // リサイズ失敗時はそのまま返す
      img.src = dataUrl;
    });
  }

  /**
   * FileオブジェクトをDataURL化してリサイズ
   */
  function fileToResizedBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const resized = await resizeImage(e.target.result);
          resolve(resized);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * カメラ input の変更イベント処理
   */
  async function handleCameraCapture(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const resizedData = await fileToResizedBase64(file);
      const fileData = {
        name: file.name || `photo_${Date.now()}.jpg`,
        type: 'image/jpeg',
        data: resizedData,
        size: resizedData.length
      };

      // プレビューなしでサイレント添付
      const added = window.MindLinkChat?.addAttachmentSilent(fileData);
      if (added) {
        window.MindLinkApp?.showToast('📷 写真を添付しました');
      } else {
        window.MindLinkApp?.showToast('添付できるファイルは最大5件です');
      }
    } catch (err) {
      console.error('[MindLinkCamera] 画像処理エラー:', err);
      window.MindLinkApp?.showToast('画像の処理に失敗しました');
    }

    // 同じ画像を再選択できるよう input をリセット
    e.target.value = '';
  }

  /**
   * イベントリスナーの初期化
   */
  function init() {
    const btn   = document.getElementById('btn-camera');
    const input = document.getElementById('camera-input');
    if (!btn || !input) return;

    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', handleCameraCapture);

    console.log('[MindLinkCamera] Camera module initialized');
  }

  return { init };
})();

window.MindLinkCamera = MindLinkCamera;
