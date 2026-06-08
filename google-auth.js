/**
 * MindLink - Crypto Module
 * Web Crypto API を使ったPIN暗号化・復号化
 */

const MindLinkCrypto = (() => {
  // SHA-256 ハッシュ（PIN保存用）
  async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // PBKDF2でAESキーを導出
  async function deriveKey(pin, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(salt),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ランダムソルト生成
  function generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ArrayBufferをBase64に変換
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return window.btoa(binary);
  }

  // Base64をArrayBufferに変換
  function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // テキストをAES-GCMで暗号化
  async function encrypt(text, pin, salt) {
    const key = await deriveKey(pin, salt);
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(text)
    );
    // iv + encrypted data をBase64で返す
    const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.byteLength);
    return arrayBufferToBase64(combined.buffer);
  }

  // AES-GCMで復号化
  async function decrypt(encryptedBase64, pin, salt) {
    try {
      const key = await deriveKey(pin, salt);
      const combined = new Uint8Array(base64ToArrayBuffer(encryptedBase64));
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      return null; // 復号失敗（PINが違うなど）
    }
  }

  return {
    sha256,
    generateSalt,
    encrypt,
    decrypt,
  };
})();

window.MindLinkCrypto = MindLinkCrypto;
