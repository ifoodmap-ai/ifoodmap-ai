// 進 /restaurant 時認領形象站帶來的 AI 需求(SPEC §7)。
// 驗證:每一種 RPC 結果對應的行為(清不清、導不導、toast)、RPC 不存在或網路錯誤時安靜失敗、不會重複呼叫,
// 以及真的掛在 RestaurantLayout 上(進餐廳後台任何一頁都會認領、認領成功導去採購頁)。
//
// supabase 整個換成 spy(rpc / getSession / updateUser),不碰正式庫;fetch 換成一律失敗的假函式當保險。

import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";
import { HANDOFF_STORAGE_KEY, clearStoredHandoff, readStoredHandoff, saveHandoff } from "@/lib/landing-handoff";
import {
  CLAIM_REDIRECT_PATH,
  CLAIM_SUCCESS_TOAST,
  claimLandingHandoff,
  parseClaimResult,
  resetLandingHandoffClaimForTests,
  useLandingHandoffClaim,
} from "./use-landing-handoff-claim";
import RestaurantLayout from "@/pages/restaurant/RestaurantLayout";

const { getSession, rpc, updateUser, toast, shopRef } = vi.hoisted(() => ({
  getSession: vi.fn(),
  rpc: vi.fn(),
  updateUser: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  /** RestaurantRoute 給 RestaurantLayout 的那家店(多店測試會換掉) */
  shopRef: { current: "restaurant-1" },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession, updateUser, signOut: vi.fn() }, rpc },
}));
vi.mock("sonner", () => ({ toast }));

// 給「真的掛在 RestaurantLayout 上」那組測試用:身分、切換器、AI 泡泡都換成替身
vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: shopRef.current,
    branch_id: null,
    role: "owner",
    restaurant_name: "好味小館",
  }),
  canSeeCost: () => true,
  needsApproval: () => false,
}));
vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));
vi.mock("@/components/AIAssistantBubble", () => ({ default: () => null }));

const HANDOFF_A = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.q5Vh2kK8mX0bZr3Lw9TfYc1NpQe7JdUsHaGiOvRx4yA";
const HANDOFF_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6L";
const ORDER_ID = "0b6c3e2a-7d14-4f58-9a3b-2c1d0e9f8a7b";
/** 目前畫面上那家店(= RestaurantLayout 的 useRestaurant().restaurant_id,見上面的 mock) */
const SHOP = "restaurant-1";

const session = (userId = "user-1", metadata: Record<string, unknown> = {}) => ({
  data: { session: { access_token: "tok", user: { id: userId, user_metadata: metadata } } },
  error: null,
});

const rpcReturns = (data: unknown) => rpc.mockResolvedValue({ data, error: null });

let storage: Storage;
let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetLandingHandoffClaimForTests();
  shopRef.current = SHOP;
  getSession.mockReset();
  rpc.mockReset();
  updateUser.mockReset();
  updateUser.mockResolvedValue({ data: { user: {} }, error: null });
  toast.success.mockReset();
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  clearStoredHandoff();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  clearStoredHandoff();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("parseClaimResult(RPC 一律回 200 + jsonb,用 ok / reason 表達)", () => {
  it("ok", () => {
    expect(parseClaimResult({ ok: true, order_id: ORDER_ID, already: false })).toEqual({
      ok: true,
      orderId: ORDER_ID,
      already: false,
      reason: null,
    });
    expect(parseClaimResult({ ok: true, order_id: null, already: true })).toMatchObject({ ok: true, orderId: null, already: true });
  });

  it("失敗原因", () => {
    expect(parseClaimResult({ ok: false, reason: "no_restaurant" })).toMatchObject({ ok: false, reason: "no_restaurant" });
    expect(parseClaimResult({ ok: false })).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("看不懂的形狀 → null", () => {
    expect(parseClaimResult(null)).toBeNull();
    expect(parseClaimResult("ok")).toBeNull();
    expect(parseClaimResult([{ ok: true }])).toBeNull();
    expect(parseClaimResult({ status: "done" })).toBeNull();
  });
});

describe("claimLandingHandoff:每一種結果的處理", () => {
  it("沒有 session → 不呼叫 RPC", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    expect((await claimLandingHandoff(SHOP)).claimedOrderId).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(readStoredHandoff()).toBe(HANDOFF_A);
  });

  it("有 session 但 localStorage 與 metadata 都沒有交接碼 → 不呼叫 RPC", async () => {
    getSession.mockResolvedValue(session());
    await claimLandingHandoff(SHOP);
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("ok + order_id(來源 localStorage)→ 用 p_handoff 呼叫一次、清掉 localStorage;metadata 沒值就不打 updateUser", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    const outcome = await claimLandingHandoff(SHOP);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("claim_landing_analysis", { p_handoff: HANDOFF_A, p_restaurant_id: SHOP });
    expect(outcome.claimedOrderId).toBe(ORDER_ID);
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("ok + order_id(來源 user_metadata,換裝置開確認信)→ updateUser({ data: { ifm_handoff: null } })", async () => {
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A, pending_restaurant_name: "好味小館" }));
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    const outcome = await claimLandingHandoff(SHOP);

    expect(rpc).toHaveBeenCalledWith("claim_landing_analysis", { p_handoff: HANDOFF_A, p_restaurant_id: SHOP });
    expect(outcome.claimedOrderId).toBe(ORDER_ID);
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith({ data: { ifm_handoff: null } });
  });

  it("ok 但 order_id 是 null(對話沒有食材)→ 清掉,不導頁", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: true, order_id: null, already: false });

    expect((await claimLandingHandoff(SHOP)).claimedOrderId).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    expect(updateUser).toHaveBeenCalledWith({ data: { ifm_handoff: null } });
  });

  it("ok + already(同一家店先前已認領過)→ 清掉,照樣帶去那張草稿", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: true });

    expect((await claimLandingHandoff(SHOP)).claimedOrderId).toBe(ORDER_ID);
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it.each(["invalid", "expired_or_used", "something_new"])(
    "ok:false, reason=%s → 清掉 localStorage 與 metadata,不導頁",
    async (reason) => {
      saveHandoff(HANDOFF_A);
      getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
      rpcReturns({ ok: false, reason });

      expect((await claimLandingHandoff(SHOP)).claimedOrderId).toBeNull();
      expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
      expect(updateUser).toHaveBeenCalledWith({ data: { ifm_handoff: null } });
    },
  );

  it("ok:false, reason=no_restaurant → 兩邊都保留(下次再試),不清 metadata", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: false, reason: "no_restaurant" });

    expect((await claimLandingHandoff(SHOP)).claimedOrderId).toBeNull();
    expect(readStoredHandoff()).toBe(HANDOFF_A);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("RPC 不存在(PostgREST PGRST202)→ 安靜失敗、保留交接碼", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.claim_landing_analysis" },
    });

    await expect(claimLandingHandoff(SHOP)).resolves.toMatchObject({ claimedOrderId: null });
    expect(readStoredHandoff()).toBe(HANDOFF_A);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("網路錯誤(rpc 直接丟錯)→ 安靜失敗、保留交接碼", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(claimLandingHandoff(SHOP)).resolves.toMatchObject({ claimedOrderId: null });
    expect(readStoredHandoff()).toBe(HANDOFF_A);
  });

  it("回應看不懂 → 當成錯誤:保留交接碼", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns(null);

    await claimLandingHandoff(SHOP);
    expect(readStoredHandoff()).toBe(HANDOFF_A);
  });

  it("讀 session 失敗 → 安靜失敗,不呼叫 RPC", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockRejectedValue(new Error("lock"));

    await expect(claimLandingHandoff(SHOP)).resolves.toMatchObject({ claimedOrderId: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("updateUser 失敗也不影響(草稿已經建好)", async () => {
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });
    updateUser.mockRejectedValue(new Error("offline"));

    await expect(claimLandingHandoff(SHOP)).resolves.toMatchObject({ claimedOrderId: ORDER_ID });
  });

  it("metadata 與 localStorage 是同一個 → 只打一次,兩邊都清", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    await claimLandingHandoff(SHOP);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it("metadata 與 localStorage 不一樣(註冊後又聊了一段)→ 兩個都認領,各清各的", async () => {
    saveHandoff(HANDOFF_B);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpc.mockImplementation(async (_fn: string, args: { p_handoff: string }) =>
      args.p_handoff === HANDOFF_A
        ? { data: { ok: true, order_id: ORDER_ID, already: false }, error: null }
        : { data: { ok: false, reason: "no_restaurant" }, error: null },
    );

    const outcome = await claimLandingHandoff(SHOP);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(outcome.claimedOrderId).toBe(ORDER_ID);
    // A 認領成功 → metadata 清掉;B 是 no_restaurant → localStorage 留著
    expect(updateUser).toHaveBeenCalledWith({ data: { ifm_handoff: null } });
    expect(readStoredHandoff()).toBe(HANDOFF_B);
  });

  it("metadata 裡的值格式壞掉 → 不送出去", async () => {
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: "garbage" }));
    await claimLandingHandoff(SHOP);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("claimLandingHandoff:一律帶目前畫面上那家店(SPEC 修訂 2 R2)", () => {
  it("每一次 RPC 都帶 p_restaurant_id = 傳進來的店(metadata 與 localStorage 兩筆都是)", async () => {
    saveHandoff(HANDOFF_B);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: false, reason: "expired_or_used" });

    await claimLandingHandoff("shop-B");

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "claim_landing_analysis", { p_handoff: HANDOFF_A, p_restaurant_id: "shop-B" });
    expect(rpc).toHaveBeenNthCalledWith(2, "claim_landing_analysis", { p_handoff: HANDOFF_B, p_restaurant_id: "shop-B" });
  });

  it("不知道畫面上是哪家店(空字串)→ 不呼叫 RPC、交接碼留著(不讓伺服器自己挑店)", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());

    await expect(claimLandingHandoff("")).resolves.toMatchObject({ claimedOrderId: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(readStoredHandoff()).toBe(HANDOFF_A);
  });

  it("伺服器說呼叫者不是那家店的成員(no_restaurant)→ 保留交接碼,不清 metadata", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: false, reason: "no_restaurant" });

    await claimLandingHandoff("shop-not-mine");
    expect(readStoredHandoff()).toBe(HANDOFF_A);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("舊版 RPC(還只有 p_handoff 一個參數,PostgREST 找不到兩個參數的版本)→ 安靜失敗、保留", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.claim_landing_analysis(p_handoff, p_restaurant_id)" },
    });

    await expect(claimLandingHandoff(SHOP)).resolves.toMatchObject({ claimedOrderId: null });
    expect(readStoredHandoff()).toBe(HANDOFF_A);
  });
});

describe("claimLandingHandoff:不會重複呼叫", () => {
  it("同時呼叫兩次(StrictMode 重跑 effect、Layout 重掛)→ 共用同一個 promise,RPC 只打一次", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    // no_restaurant:交接碼會留著,第二次如果真的跑了就會再打 —— 用它驗證沒有重跑
    rpcReturns({ ok: false, reason: "no_restaurant" });

    const [a, b] = await Promise.all([claimLandingHandoff(SHOP), claimLandingHandoff(SHOP)]);
    expect(a).toBe(b);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("同一個網頁執行期、同一位使用者:跑完之後再進來(換頁、重掛)不再打;重新整理(重置)後才會再試", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: false, reason: "no_restaurant" });

    await claimLandingHandoff(SHOP);
    await claimLandingHandoff(SHOP);
    await claimLandingHandoff(SHOP);
    expect(rpc).toHaveBeenCalledTimes(1);

    resetLandingHandoffClaimForTests(); // = 重新整理頁面
    await claimLandingHandoff(SHOP);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("同一個網頁執行期換另一位使用者登入 → 那位使用者照樣會認領一次", async () => {
    saveHandoff(HANDOFF_A);
    rpcReturns({ ok: false, reason: "no_restaurant" });

    getSession.mockResolvedValue(session("user-1"));
    await claimLandingHandoff(SHOP);
    getSession.mockResolvedValue(session("user-2"));
    await claimLandingHandoff(SHOP);
    await claimLandingHandoff(SHOP);

    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

/** 用 hook 的最小元件 + 採購頁替身(印出收到的 router state) */
const Host = () => {
  useLandingHandoffClaim(SHOP);
  return <h1>總覽頁</h1>;
};
const PurchaseProbe = () => {
  const state = useLocation().state as { claimedOrderId?: string } | null;
  return <p data-testid="purchase">採購頁 {state?.claimedOrderId ?? "沒有 state"}</p>;
};

const renderHost = (strict = false) => {
  const tree = (
    <MemoryRouter initialEntries={["/restaurant"]}>
      <Routes>
        <Route path="/restaurant" element={<Host />} />
        <Route path={CLAIM_REDIRECT_PATH} element={<PurchaseProbe />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

describe("useLandingHandoffClaim:toast 與導頁", () => {
  it("ok + order_id → toast 指定文案、導到 /restaurant/purchase 並帶 claimedOrderId", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    renderHost();

    expect(await screen.findByTestId("purchase")).toHaveTextContent(`採購頁 ${ORDER_ID}`);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("已把你跟 AI 聊的需求建成採購單草稿，確認後就能送出");
    expect(CLAIM_SUCCESS_TOAST).toBe("已把你跟 AI 聊的需求建成採購單草稿，確認後就能送出");
  });

  it("StrictMode(effect 跑兩次)→ RPC 一次、toast 一次、導頁一次", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    renderHost(true);

    expect(await screen.findByTestId("purchase")).toHaveTextContent(ORDER_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no_restaurant", { ok: false, reason: "no_restaurant" }],
    ["invalid", { ok: false, reason: "invalid" }],
    ["expired_or_used", { ok: false, reason: "expired_or_used" }],
    ["ok 但沒有草稿", { ok: true, order_id: null, already: false }],
  ])("%s → 不 toast、不導頁,頁面照常", async (_label, result) => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns(result);

    renderHost();

    expect(screen.getByRole("heading", { name: "總覽頁" })).toBeInTheDocument();
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "總覽頁" })).toBeInTheDocument();
    expect(screen.queryByTestId("purchase")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("RPC 還沒部署 → 不擋使用者:頁面照常、不 toast、不導頁", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "function not found" } });

    renderHost();

    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "總覽頁" })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("掛在真的 RestaurantLayout 上", () => {
  const renderLayout = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/restaurant" element={<RestaurantLayout />}>
            <Route index element={<h1>營運總覽頁</h1>} />
            <Route path="settings" element={<h1>店家設定頁</h1>} />
            <Route path="purchase" element={<PurchaseProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it("進 /restaurant(註冊完成、確認信、登入都會到這)→ 認領成功就導到採購頁", async () => {
    getSession.mockResolvedValue(session("user-1", { ifm_handoff: HANDOFF_A }));
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    renderLayout("/restaurant");

    expect(await screen.findByTestId("purchase")).toHaveTextContent(ORDER_ID);
    expect(rpc).toHaveBeenCalledWith("claim_landing_analysis", { p_handoff: HANDOFF_A, p_restaurant_id: SHOP });
    expect(toast.success).toHaveBeenCalledWith(CLAIM_SUCCESS_TOAST);
  });

  it("從餐廳後台任何一頁進來都一樣(例如書籤 /restaurant/settings)", async () => {
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    renderLayout("/restaurant/settings");
    expect(screen.getByRole("heading", { name: "店家設定頁" })).toBeInTheDocument();
    expect(await screen.findByTestId("purchase")).toHaveTextContent(ORDER_ID);
  });

  it("多店的人:畫面上是 B 店 → 認領時帶 B 店(草稿建在他正在看的店),不是讓伺服器挑「最近加入的那家」", async () => {
    shopRef.current = "shop-B";
    saveHandoff(HANDOFF_A);
    getSession.mockResolvedValue(session());
    rpcReturns({ ok: true, order_id: ORDER_ID, already: false });

    renderLayout("/restaurant");

    expect(await screen.findByTestId("purchase")).toHaveTextContent(ORDER_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("claim_landing_analysis", { p_handoff: HANDOFF_A, p_restaurant_id: "shop-B" });
  });

  it("沒有交接碼 → 不打 RPC,版面照常", async () => {
    getSession.mockResolvedValue(session());
    renderLayout("/restaurant");

    expect(screen.getByRole("heading", { name: "營運總覽頁" })).toBeInTheDocument();
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(rpc).not.toHaveBeenCalled();
  });
});
