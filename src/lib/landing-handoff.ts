// 形象站 → 產品站的「AI 需求交接」(handoff,介面契約 SPEC §7)。
//
// 形象站的陌生訪客跟 AI 採購助手聊完、按「免費註冊」,會被帶到
//   https://app.ifoodmap.ai/register/restaurant#handoff=<encodeURIComponent(analysisId + "." + claimToken)>
// 交接碼放在 #片段:片段不會進 Referer、伺服器 log、分析工具。
//
// 這支只管「交接碼本身」:驗格式、從網址撈出來、存 localStorage(7 天)、讀、清。
//   - 註冊頁(RestaurantRegisterPage)讀到後立刻把片段從網址拿掉,signUp 時再放進 user_metadata.ifm_handoff
//     (跨裝置開確認信也帶得過去)
//   - 真正的認領只在一個地方做:進到 /restaurant 時(src/hooks/use-landing-handoff-claim.ts)
//
// 🔴 這支會被 tsconfig.registration.json 一起編譯(restaurant-registration.ts 有 import),不要 import "@/..."。

/** localStorage 的 key(值 = {v: 交接碼, at: 存入時間 epoch ms}) */
export const HANDOFF_STORAGE_KEY = "ifm:handoff";
/** signUp 時寄放在 user_metadata 的 key */
export const HANDOFF_METADATA_KEY = "ifm_handoff";
/** 網址片段裡的參數名 */
export const HANDOFF_HASH_PARAM = "handoff";
/** localStorage 裡的交接碼放多久(伺服器端 claim_landing_analysis 也只認 7 天內建立的分析) */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// claimToken = 32 bytes 隨機的 base64url(43 字、不補位)。只要求「長度合理」:32–128 字,
// 字元限 base64url,容許最多兩個 = 補位 —— 伺服器換長度也不會讓前端默默丟掉交接碼
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}={0,2}$/;
const UUID_LENGTH = 36;

/** 交接碼格式:`<uuid>.<base64url>` */
export const isValidHandoff = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.charAt(UUID_LENGTH) !== ".") return false;
  return (
    UUID_PATTERN.test(value.slice(0, UUID_LENGTH)) &&
    TOKEN_PATTERN.test(value.slice(UUID_LENGTH + 1))
  );
};

interface StoredHandoff {
  v: string;
  at: number;
}

// localStorage 不能用時(封鎖網站資料、某些內嵌瀏覽器)的備援:同一個網頁執行期內還找得到。
// persisted = 有沒有真的寫進 localStorage;寫失敗的才需要從記憶體讀。
let memory: { record: StoredHandoff; persisted: boolean } | null = null;

const getStorage = (): Storage | null => {
  try {
    const storage = typeof window === "undefined" ? null : window.localStorage;
    // Node 25 的全域 localStorage 沒帶 --localstorage-file 時是個沒有方法的空物件
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
};

const isFresh = (record: StoredHandoff, now: number): boolean =>
  Number.isFinite(record.at) && now - record.at <= HANDOFF_TTL_MS;

const asRecord = (value: unknown): StoredHandoff | null => {
  if (!value || typeof value !== "object") return null;
  const { v, at } = value as { v?: unknown; at?: unknown };
  if (!isValidHandoff(v) || typeof at !== "number") return null;
  return { v, at };
};

/** 存起來(覆蓋舊的;最新一段對話為準) */
export const saveHandoff = (value: string, now: number = Date.now()): void => {
  if (!isValidHandoff(value)) return;
  const record: StoredHandoff = { v: value, at: now };
  memory = { record, persisted: false };
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(record));
    memory.persisted = true;
  } catch {
    // 寫不進去(額度滿、被封鎖)就只留記憶體那份
  }
};

/** 清掉(localStorage 與記憶體備援都清) */
export const clearStoredHandoff = (): void => {
  memory = null;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    // 拿不掉也不影響使用者;伺服器端一碼只能認領一次
  }
};

/** 讀還有效的交接碼;沒有、格式壞掉或超過 7 天 → null(壞掉/過期的順手清掉) */
export const readStoredHandoff = (now: number = Date.now()): string | null => {
  const storage = getStorage();
  let raw: string | null = null;
  let storageReadable = false;
  if (storage) {
    try {
      raw = storage.getItem(HANDOFF_STORAGE_KEY);
      storageReadable = true;
    } catch {
      storageReadable = false;
    }
  }

  if (storageReadable && raw != null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const record = asRecord(parsed);
    if (!record || !isFresh(record, now)) {
      clearStoredHandoff();
      return null;
    }
    return record.v;
  }

  // localStorage 讀不到(或從來沒寫進去)→ 看記憶體備援
  if (memory && (!storageReadable || !memory.persisted)) {
    if (!isFresh(memory.record, now)) {
      memory = null;
      return null;
    }
    return memory.record.v;
  }
  return null;
};

/**
 * 註冊頁一進來呼叫:網址片段有 handoff 就撈出來。
 *   - 不管格式對不對,都立刻用 history.replaceState 把它從網址拿掉(片段裡其他參數保留)
 *   - 格式對才存起來;格式錯的丟掉,不會蓋掉之前存的有效交接碼
 * 回傳這次撈到的有效交接碼;片段裡沒有(或格式不對)回 null。
 */
export const captureHandoffFromUrl = (now: number = Date.now()): string | null => {
  if (typeof window === "undefined") return null;
  const { hash, pathname, search } = window.location;
  if (!hash || hash.length < 2) return null;

  const params = new URLSearchParams(hash.slice(1));
  if (!params.has(HANDOFF_HASH_PARAM)) return null;

  const value = (params.get(HANDOFF_HASH_PARAM) ?? "").trim();
  params.delete(HANDOFF_HASH_PARAM);
  const rest = params.toString();
  try {
    // 帶著原本的 history.state:React Router 把 key/idx 放在裡面,換掉會讓返回鍵判斷失準
    window.history.replaceState(window.history.state, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
  } catch {
    // replaceState 失敗(極少見)也不擋註冊
  }

  if (!isValidHandoff(value)) return null;
  saveHandoff(value, now);
  return value;
};
