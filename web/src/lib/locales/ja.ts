// web/src/lib/locales/ja.ts
//
// Japanese for the console, keyed on the English source string.
//
// See lib/i18n.ts for why the key is the English sentence rather than an
// invented identifier. The short version: a missing entry falls back to
// correct English instead of rendering a key, and the source stays readable
// as prose.
//
// PARTIAL, AND HONEST ABOUT IT
//
// The console holds roughly 726 user-visible strings across 30 files. This
// dictionary does not cover all of them yet, and the ones it misses render in
// English — which is the designed behaviour, not a bug, but it does mean a
// Japanese reader sees a mixed screen until this is finished.
//
// Order follows the interface rather than the alphabet: shell and navigation
// first, then the things every screen shares, then per-screen copy. Adding a
// string means finding where it belongs, which is a feature — an alphabetical
// list of 726 sentences is unreviewable.

export const ja: Record<string, string> = {
  // --- Shell and navigation -------------------------------------------------
  "Server": "サーバー",
  "Overview": "概要",
  "Applications": "応募",
  "Operations": "運用",
  "Forms": "フォーム",
  "Panels": "パネル",
  "Ban appeals": "BAN 異議申し立て",
  "Support": "サポート",
  "Tickets": "チケット",
  "Quick responses": "定型応答",
  "Verification": "認証",
  "Anti-raid": "荒らし対策",
  "Welcomer": "ウェルカム",
  "Role menus": "ロールメニュー",
  "Sticky messages": "固定メッセージ",
  "Giveaways": "ギブアウェイ",
  "Polls": "投票",
  "Staff": "スタッフ",
  "Billing": "請求",
  "Appeal queue": "異議申し立てキュー",
  "Feedback": "フィードバック",
  "Operator": "オペレーター",
  "More": "その他",
  "Engagement": "エンゲージメント",
  "Administration": "管理",

  // Nav hints — the one-line explanations under each entry.
  "Capacity, activity, and health": "処理量、稼働状況、健全性",
  "The review queue": "審査キュー",
  "Queued work and audit log": "待機中の処理と監査ログ",
  "Questions, gating, and the roles a decision applies":
    "質問、参加条件、審査結果で付与するロール",
  "The message people apply from": "応募の入口となるメッセージ",
  "DM banned members a form": "BAN されたメンバーにフォームを DM で送る",
  "Ticket types, support roles, transcripts": "チケットの種類、対応ロール、書き起こし",
  "Saved replies for staff": "スタッフ用の保存済み返信",
  "Staff access": "スタッフ権限",
  "Help & support": "ヘルプとサポート",

  // Remaining nav hints.
  "Screen new members before they can talk": "発言前に新規メンバーを確認します",
  "Join-velocity detection and lockdown": "参加速度の検知とロックダウン",
  "Join and leave messages, auto-roles": "参加・退出メッセージと自動ロール",
  "Self-assignable roles": "自分で取得できるロール",
  "Keep a message at the bottom of a channel": "チャンネルの一番下にメッセージを固定します",
  "Entries, weighting, and draws": "参加、重み付け、抽選",
  "Scheduled and live polls": "予約投票と進行中の投票",
  "Review rights without Administrator": "管理者権限なしで審査権限を付与",
  "Plan, caps, and renewal": "プラン、上限、更新",
  "Report a problem, check status, diagnostics": "不具合の報告、稼働状況、診断情報",

  // --- Shared controls ------------------------------------------------------
  "Save": "保存",
  "Saving…": "保存中…",
  "Saved": "保存しました",
  "Cancel": "キャンセル",
  "Delete": "削除",
  "Edit": "編集",
  "Create": "作成",
  "Post": "投稿",
  "Dismiss": "閉じる",
  "Close": "閉じる",
  "Send": "送信",
  "Sending…": "送信中…",
  "Not now": "あとで",
  "Loading…": "読み込み中…",
  "Retry": "再試行",
  "Back": "戻る",
  "Next": "次へ",
  "Add": "追加",
  "Remove": "削除",
  "Enabled": "有効",
  "Disabled": "無効",
  "Yes": "はい",
  "No": "いいえ",
  "Never": "なし",
  "Optional": "任意",
  "Required": "必須",
  "Label": "表示名",
  "Title": "タイトル",
  "Description": "説明",
  "Channel": "チャンネル",
  "Role": "ロール",
  "Status": "ステータス",
  "Actions": "操作",
  "Settings": "設定",
  "Sign out": "サインアウト",

  // --- Feedback sheet -------------------------------------------------------
  "How is Appealy working out?": "Appealy の使い心地はいかがですか？",
  "Tell us": "意見を送る",
  "Thank you": "ありがとうございます",
  "What do you use Appealy for?": "Appealy を何に使っていますか？",
  "What is the most annoying thing about it right now?":
    "いま一番わずらわしいところは何ですか？",
  "What did you expect to find and didn’t?": "あると思って見つからなかったものはありますか？",

  // --- Empty states ---------------------------------------------------------
  "No forms yet": "フォームがまだありません",
  "No panels yet": "パネルがまだありません",
  "No questions yet": "質問がまだありません",
  "Nothing attached": "何も紐づいていません",
  "No changes yet": "変更はまだありません",
  "Queue is clear": "キューは空です",
  "Nothing waiting.": "待機中の項目はありません。",
  "No answers yet": "回答はまだありません",

  // --- Status and errors ----------------------------------------------------
  "Heads up": "ご注意",
  "Couldn't load": "読み込めませんでした",
  "Couldn't save": "保存できませんでした",
  "Bot unreachable": "ボットに接続できません",
  "Check service status": "稼働状況を確認",
  "Something is broken": "不具合が起きている",
  "Getting help": "ヘルプ",
  "Setting it up": "セットアップ",
  "Start here": "ここから始める",
  "Read the walkthrough": "手順を読む",
  "Self-hosting": "セルフホスト",
};
