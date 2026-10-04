// web/src/lib/whatsNew.ts
//
// What's new in Appealy, for the "What's new" sheet (components/WhatsNewSheet.tsx).
//
// The newest release opens the sheet by itself for 48 hours after it goes out,
// once per browser. After that it's news nobody asked to be interrupted with,
// so it stays behind the "What's new" link and /dashboard/#whats-new instead.
//
// Seen-ness is per browser, like the feedback prompt (lib/feedback.ts) and for
// the same reason: a table and a route for a boolean isn't worth it, and the
// cost of being wrong is someone seeing the news twice on a second device.
//
// Newest first. Adding a release: put it at the top, with publishedAt set to
// when it goes out, since that's when the 48 hours start.

import { getLocale } from "./i18n";

type Text = { en: string; ja: string };

export interface ReleaseItem {
  title: Text;
  body: Text;
  /** A dashboard screen to open from the item, by its path segment. */
  view?: string;
  /** An element id on that screen to scroll to. */
  section?: string;
  action?: Text;
}

export interface Release {
  /** When it went out, as an ISO timestamp. */
  publishedAt: string;
  title: Text;
  items: ReleaseItem[];
}

export const RELEASES: Release[] = [
  {
    publishedAt: "2026-10-04T09:54:00Z",
    title: { en: "Moderation, your way", ja: "モデレーションを自分好みに" },
    items: [
      {
        title: { en: "Temporary bans, and bans with no appeal", ja: "期限付き BAN と、異議申し立てなしの BAN" },
        body: {
          en: "Add a length to ban for a while: ?ban @user 7d. Appealy unbans them when it ends. ?ban noappeal @user bans without sending the appeal button, for scammers and raiders.",
          ja: "長さを付けると期限付きの BAN になります（?ban @ユーザー 7d）。期限が来ると Appealy が BAN を解除します。?ban noappeal @ユーザー なら、異議申し立てボタンを送らずに BAN できます。スパムや荒らし向けです。",
        },
      },
      {
        title: { en: "Change the prefix, or limit who can use it", ja: "プレフィックスの変更と、使える人の制限" },
        body: {
          en: "The new Moderation page lets you swap ? for something else, limit the text commands to certain roles, or turn them off if another bot uses the same ones.",
          ja: "新しいモデレーションページで、? を別の記号に変えたり、テキストコマンドを使えるロールを限定したり、ほかのボットと重なる場合は無効にしたりできます。",
        },
        view: "moderation",
        action: { en: "Open Moderation", ja: "モデレーションを開く" },
      },
      {
        title: { en: "Tell us what you think, right from Discord", ja: "Discord から直接フィードバック" },
        body: {
          en: "After you accept or deny an application, Appealy may ask once, privately, for 30 seconds of feedback. Only you see it, and admins can turn it off in Help & support.",
          ja: "応募を承認または却下したあと、Appealy が一度だけ、あなたにだけ見える形で短いフィードバックをお願いすることがあります。管理者は「ヘルプとサポート」でオフにできます。",
        },
        view: "support",
        action: { en: "Open Help & support", ja: "ヘルプとサポートを開く" },
      },
    ],
  },
  {
    publishedAt: "2026-10-04T04:45:00Z",
    title: { en: "Moderation commands", ja: "モデレーションコマンド" },
    items: [
      {
        title: { en: "?ban, ?kick and ?mute are here", ja: "?ban、?kick、?mute が使えるように" },
        body: {
          en: "Type ?ban, ?unban, ?kick, ?mute and ?unmute in chat, or @Appealy ban, mute… Mutes take a length like 10m, 2h or 1d. Banned and timed-out members get your appeal button, if appeals are set up. /help lists them all.",
          ja: "チャットで ?ban、?unban、?kick、?mute、?unmute と入力するか、@Appealy ban のように使えます。?mute には 10m、2h、1d のように長さを指定できます。異議申し立てを設定していれば、BAN やタイムアウトされたメンバーに申し立てボタンが届きます。一覧は /help で確認できます。",
        },
        view: "appeals",
        action: { en: "Set up appeals", ja: "異議申し立てを設定" },
      },
      {
        title: { en: "Fixed: forms that wouldn't open", ja: "修正：開けなかったフォーム" },
        body: {
          en: "Some forms showed “Something went wrong” on /apply because of a question's length limits. They open now, with no changes needed on your side.",
          ja: "質問の文字数の設定によっては、/apply で「Something went wrong」と表示されて開けないフォームがありました。今は開けます。設定を変える必要はありません。",
        },
      },
    ],
  },
  {
    publishedAt: "2026-09-26T21:11:00Z",
    title: { en: "AutoMod, from any device", ja: "AutoMod をどの端末からでも" },
    items: [
      {
        title: { en: "Set up AutoMod from your phone", ja: "スマホから AutoMod を設定" },
        body: {
          en: "Discord's app can't change AutoMod rules on a phone. The new AutoMod page can: word lists, Discord's ready-made filters, spam, mention spam and blocked words in names.",
          ja: "Discord のアプリでは、スマホから AutoMod のルールを変更できません。新しい AutoMod ページならできます。ワードリスト、Discord が用意する定番の禁止ワード、スパム、メンションスパム、名前に含まれる禁止ワードまで設定できます。",
        },
        view: "automod",
        action: { en: "Open AutoMod", ja: "AutoMod を開く" },
      },
      {
        title: {
          en: "Catch disguised words without writing regex",
          ja: "正規表現を書かずに、ごまかした言葉も検出",
        },
        body: {
          en: "The regex generator catches “fr33 n1tr0”, “$cam” and “s.c.a.m”, as well as invite links, phone numbers and zalgo. Try any message to see what gets caught, then add a pattern to a word list or copy it.",
          ja: "正規表現ジェネレーターは「fr33 n1tr0」「$cam」「s.c.a.m」のような言い換えや、招待リンク、電話番号、Zalgo テキストを検出します。どんなメッセージが引っかかるか試してから、ワードリストに追加したり、コピーしたりできます。",
        },
        view: "automod",
        section: "regex-generator",
        action: { en: "Try the regex generator", ja: "正規表現ジェネレーターを試す" },
      },
      {
        title: { en: "Fixed: appeals for 1-hour timeouts", ja: "修正：1 時間のタイムアウトの異議申し立て" },
        body: {
          en: "A timeout exactly as long as your minimum now gets its appeal button. Before, a 1-hour timeout under the default 1-hour minimum got nothing.",
          ja: "設定した最短時間とちょうど同じ長さのタイムアウトにも、異議申し立てボタンが届くようになりました。これまでは、初期設定（1 時間）のまま 1 時間のタイムアウトをしても、何も送られていませんでした。",
        },
        view: "appeals",
        action: { en: "Open Appeals", ja: "異議申し立てを開く" },
      },
    ],
  },
  {
    publishedAt: "2026-09-26T14:15:00Z",
    title: { en: "More than ban appeals", ja: "BAN 以外も異議申し立て可能に" },
    items: [
      {
        title: {
          en: "Timeouts and restriction roles can be appealed",
          ja: "タイムアウトと制限ロールにも異議申し立て",
        },
        body: {
          en: "When someone is timed out or given one of your restriction roles, Appealy can DM them a way to appeal. Accepting it can lift the timeout or remove the role for you.",
          ja: "メンバーがタイムアウトされたり、制限ロールを付与されたりしたときに、Appealy が異議申し立ての方法を DM で送れます。承認すると、タイムアウトの解除やロールの削除も自動で行えます。",
        },
        view: "appeals",
        action: { en: "Open Appeals", ja: "異議申し立てを開く" },
      },
      {
        title: { en: "The full history of every application", ja: "すべての応募の履歴" },
        body: {
          en: "Open any application to see everything that happened to it, and who did it.",
          ja: "応募を開くと、その応募に起きたことと、誰が行ったかをすべて確認できます。",
        },
        view: "submissions",
        action: { en: "Open Applications", ja: "応募を開く" },
      },
    ],
  },
  {
    publishedAt: "2026-09-25T21:00:00Z",
    title: { en: "Appealy in Japanese", ja: "日本語に対応" },
    items: [
      {
        title: {
          en: "The dashboard, website and slash commands in Japanese",
          ja: "ダッシュボード、ウェブサイト、スラッシュコマンドが日本語に",
        },
        body: {
          en: "Switch with the 日本語 button in the menu. Anyone whose Discord is set to Japanese sees the commands in Japanese too.",
          ja: "メニューの「English」から英語に切り替えられます。Discord の言語が日本語の人には、コマンドも日本語で表示されます。",
        },
      },
      {
        title: { en: "A ban notice before any questions", ja: "質問より先に BAN の通知を" },
        body: {
          en: "A banned member now gets a short notice with an “Appeal this ban” button, instead of questions they never asked for. The form only starts if they press it.",
          ja: "BAN されたメンバーには、頼んでもいない質問ではなく、まず短い通知と「Appeal this ban」ボタンが届きます。フォームはボタンを押したときにだけ始まります。",
        },
      },
    ],
  },
];

/** How long a release opens the sheet by itself. */
export const WHATS_NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

const KEY = "appealy:whats-new-seen";

function latest(): Release | undefined {
  return RELEASES[0];
}

function seenId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Private mode, or site data blocked. Seeing the news again is harmless.
    return null;
  }
}

/** True when the newest release hasn't been seen in this browser. */
export function hasUnseenRelease(): boolean {
  const newest = latest();
  return Boolean(newest) && seenId() !== newest!.publishedAt;
}

/** True when the sheet should open by itself: unseen, and inside its 48 hours. */
export function shouldOpenWhatsNew(now = Date.now()): boolean {
  const newest = latest();
  if (!newest || !hasUnseenRelease()) return false;
  const age = now - Date.parse(newest.publishedAt);
  return age >= 0 && age < WHATS_NEW_WINDOW_MS;
}

export function markWhatsNewSeen(): void {
  const newest = latest();
  if (!newest) return;
  try {
    localStorage.setItem(KEY, newest.publishedAt);
  } catch {
    // The dismissal just doesn't outlive the session.
  }
}

/** A release's text in the console's language. */
export function local(text: Text): string {
  return getLocale() === "ja" ? text.ja : text.en;
}

export function releaseDate(release: Release): string {
  return new Intl.DateTimeFormat(getLocale() === "ja" ? "ja-JP" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(release.publishedAt));
}
