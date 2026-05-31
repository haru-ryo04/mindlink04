/**
 * MindLink - Configuration
 * 環境に応じて自動的に設定を切り替えます。
 */
const MindLinkConfig = {
  // Google OAuth のリダイレクトURI
  // window.location.origin を使うことで localhost / Vercel / 任意のドメインで自動的に正しいURLになります
  // Google Cloud Console には使用する全ドメインを登録してください
  get REDIRECT_URI() {
    return window.location.origin + '/';
  }
};
