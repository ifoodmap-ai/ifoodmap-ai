// 形象站 AI 對話 → 採購單草稿的「認領」(介面契約 SPEC §6、§7)。
//
// 只在一個地方做:使用者進到 /restaurant(RestaurantLayout)且有 session 時。三種路徑都會經過這裡:
//   ①註冊當下就拿到 session ②換裝置點確認信(RegisterCompletePage 建好餐廳後導進來)③原本就有帳號、改成登入。
//
// 交接碼的來源:user_metadata.ifm_handoff(註冊時寄放,跨裝置也在)或 localStorage(landing-handoff.ts)。
// 呼叫 RPC claim_landing_analysis(p_handoff, p_restaurant_id) —— p_restaurant_id 一律帶「目前畫面上那家店」
// (RestaurantRoute 實際在用的那筆 account;SPEC 修訂 2 R2),草稿才會建在使用者正在看的店,不會跑到他另一家店。
// 結果:
//   - ok:false, reason = no_restaurant → 兩邊都保留,下次(重新整理、下次登入)再試
//   - 其他結果(ok、invalid、expired_or_used…)→ 清掉 localStorage,metadata 有值就 updateUser 清成 null
//   - ok 且有 order_id → toast 說明 + 導到 /restaurant/purchase(帶 state.claimedOrderId,採購頁會重抓草稿)
//   - RPC 不存在、網路錯誤、回應看不懂 → 安靜失敗,兩邊都保留,不擋使用者
//
// 「每個 session 只跑一次」= 同一個網頁執行期(重新整理前)同一位使用者只打一次 RPC;
// 同時被呼叫(StrictMode 重跑 effect、Layout 重掛)會共用同一個進行中的 promise,不會重複打。

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  HANDOFF_METADATA_KEY,
  clearStoredHandoff,
  isValidHandoff,
  readStoredHandoff,
} from "@/lib/landing-handoff";

export const CLAIM_RPC = "claim_landing_analysis";
export const CLAIM_SUCCESS_TOAST = "已把你跟 AI 聊的需求建成採購單草稿，確認後就能送出";
export const CLAIM_REDIRECT_PATH = "/restaurant/purchase";

/** 導到採購頁時帶的 router state:採購頁看到它會重抓一次草稿清單 */
export interface ClaimedDraftLocationState {
  claimedOrderId: string;
}

/** RPC 結果(專案沒開 strictNullChecks,判別聯集收窄不可靠,用單一形狀) */
export interface ClaimResult {
  ok: boolean;
  /** ok 時:建出(或先前已建)的草稿 id;食材清單是空的就是 null */
  orderId: string | null;
  /** ok 時:這家店先前已經認領過同一筆 */
  already: boolean;
  /** 失敗原因:invalid / no_restaurant / expired_or_used(看不懂的原因記成 unknown) */
  reason: string | null;
}

export interface ClaimOutcome {
  /** 這次認領建出(或先前已建)的採購單草稿;沒有就是 null */
  claimedOrderId: string | null;
  /** toast 是否已經跳過(同一個結果只跳一次) */
  toastShown: boolean;
  /** 是否已經導去採購頁(同一個結果只導一次) */
  navigated: boolean;
}

/** RPC 回應(jsonb)→ 結果;看不懂的形狀回 null(當成錯誤處理:保留交接碼下次再試) */
export const parseClaimResult = (data: unknown): ClaimResult | null => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as { ok?: unknown; order_id?: unknown; already?: unknown; reason?: unknown };
  if (row.ok === true) {
    return {
      ok: true,
      orderId: typeof row.order_id === "string" && row.order_id ? row.order_id : null,
      already: row.already === true,
      reason: null,
    };
  }
  if (row.ok === false) {
    return {
      ok: false,
      orderId: null,
      already: false,
      reason: typeof row.reason === "string" && row.reason ? row.reason : "unknown",
    };
  }
  return null;
};

const attemptedUserIds = new Set<string>();
let inFlight: Promise<ClaimOutcome> | null = null;

/** 只給測試用:把「這個網頁執行期已經試過誰」歸零 */
export const resetLandingHandoffClaimForTests = (): void => {
  attemptedUserIds.clear();
  inFlight = null;
};

const callClaimRpc = async (handoff: string, restaurantId: string): Promise<ClaimResult | null> => {
  try {
    const { data, error } = await supabase.rpc(CLAIM_RPC, { p_handoff: handoff, p_restaurant_id: restaurantId });
    if (error) return null;
    return parseClaimResult(data);
  } catch {
    return null;
  }
};

const clearMetadataHandoff = async (): Promise<void> => {
  try {
    await supabase.auth.updateUser({ data: { [HANDOFF_METADATA_KEY]: null } });
  } catch {
    // 清不掉也沒關係:下次再送一次只會拿到 already / expired_or_used
  }
};

const runClaim = async (restaurantId: string): Promise<ClaimOutcome> => {
  const outcome: ClaimOutcome = { claimedOrderId: null, toastShown: false, navigated: false };
  // 不知道使用者正在看哪家店就不認領(交接碼留著):不帶店家,伺服器會挑「最近加入的那家」,可能不是畫面上這家
  if (!restaurantId) return outcome;
  try {
    const local = readStoredHandoff();
    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    if (!user?.id) return outcome;

    const metadataValue = (user.user_metadata as Record<string, unknown> | undefined)?.[HANDOFF_METADATA_KEY];
    const fromMetadata = isValidHandoff(metadataValue) ? metadataValue : null;
    if (!fromMetadata && !local) return outcome;

    if (attemptedUserIds.has(user.id)) return outcome;
    attemptedUserIds.add(user.id);

    // 兩邊不一樣(例如註冊後又聊了一段)就兩個都認領;一樣的只打一次
    const candidates = [...new Set([fromMetadata, local].filter((v): v is string => !!v))];
    let clearMetadata = false;
    for (const handoff of candidates) {
      const result = await callClaimRpc(handoff, restaurantId);
      if (!result) continue; // RPC 不存在 / 網路錯誤 → 保留,下次再試
      if (!result.ok && result.reason === "no_restaurant") continue; // 還沒有餐廳 → 保留,下次再試

      if (handoff === local) clearStoredHandoff();
      if (handoff === fromMetadata) clearMetadata = true;
      if (result.ok && result.orderId && !outcome.claimedOrderId) {
        outcome.claimedOrderId = result.orderId;
      }
    }

    if (clearMetadata) await clearMetadataHandoff();
  } catch {
    // 安靜失敗:認領失敗不能擋住使用者進後台
  }
  return outcome;
};

/** 認領一次(同時多次呼叫共用同一個 promise)。restaurantId = 目前畫面上那家店 */
export const claimLandingHandoff = (restaurantId: string): Promise<ClaimOutcome> => {
  if (inFlight) return inFlight;
  inFlight = runClaim(restaurantId).finally(() => {
    inFlight = null;
  });
  return inFlight;
};

/** 掛在 RestaurantLayout:進餐廳後台時認領形象站帶來的 AI 需求。restaurantId = useRestaurant().restaurant_id */
export const useLandingHandoffClaim = (restaurantId: string): void => {
  const navigate = useNavigate();
  // React Router 的 navigate 會隨網址換一個新的;用 ref 拿最新的,effect 只在掛上時跑(不是每次換頁都跑)
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let active = true;
    void claimLandingHandoff(restaurantId).then((outcome) => {
      if (!outcome.claimedOrderId) return;
      // toast 是全站的,元件不在了也照樣告訴使用者;導頁只在還停在餐廳後台時做
      if (!outcome.toastShown) {
        outcome.toastShown = true;
        toast.success(CLAIM_SUCCESS_TOAST);
      }
      if (active && !outcome.navigated) {
        outcome.navigated = true;
        const state: ClaimedDraftLocationState = { claimedOrderId: outcome.claimedOrderId };
        navigateRef.current(CLAIM_REDIRECT_PATH, { state });
      }
    });
    return () => {
      active = false;
    };
    // 只跟著「目前是哪家店」跑(換頁不重跑);同一位使用者這個網頁執行期只會真的打一次 RPC
  }, [restaurantId]);
};
