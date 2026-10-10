// 管理後台零售市集兩頁:商品審核(待審清單、查看全部內容、核准、退回要原因、下架、被改過要重新整理)、零售店家(停用要原因、恢復)。
// 另外(勘誤:Task 27 注意事項):每張照片的主圖與 _t 縮圖都要審 —— 縮圖是另外上傳的檔、商品卡先顯示它;
// 審核頁不能用 MarketImage(縮圖讀不到會改顯示主圖),縮圖缺了要看得出來。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@/lib/market/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/admin")>()),
  fetchAdminProducts: vi.fn(),
  reviewProduct: vi.fn(),
  fetchAdminStores: vi.fn(),
  fetchProductCounts: vi.fn(),
  setStoreEnabled: vi.fn(),
}));

import {
  DELIST_REASON_MAX,
  fetchAdminProducts,
  fetchAdminStores,
  fetchProductCounts,
  reviewProduct,
  setStoreEnabled,
  StaleReviewError,
} from "@/lib/market/admin";
import { LIMITS } from "@/lib/market/constants";
import { MarketDbError } from "@/lib/market/db";
import { publicImageUrl, thumbPathOf } from "@/lib/market/images";
import { CABBAGE, STORE_A, SUPPLIER_A } from "@/lib/market/testFixtures";
import type { MarketProductRow } from "@/lib/market/types";
import AdminMarketProductsPage from "./AdminMarketProductsPage";
import AdminMarketStoresPage from "./AdminMarketStoresPage";

const PENDING = { ...CABBAGE, review_status: "pending" as const, submitted_at: "2026-10-09T04:05:00Z", updated_at: "2026-10-09T04:05:00.1+00:00" };

beforeEach(() => {
  vi.mocked(fetchAdminProducts).mockResolvedValue([PENDING]);
  vi.mocked(reviewProduct).mockResolvedValue(PENDING);
  vi.mocked(fetchAdminStores).mockResolvedValue([STORE_A]);
  vi.mocked(fetchProductCounts).mockResolvedValue(new Map([[STORE_A.supplier_id, { listed: 3, pending: 1 }]]));
  vi.mocked(setStoreEnabled).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("AdminMarketProductsPage", () => {
  it("預設看待審;查看顯示完整內容;核准送 approve", async () => {
    render(<AdminMarketProductsPage />);
    expect(fetchAdminProducts).toHaveBeenCalledWith("pending");
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("宜蘭三星")).toBeInTheDocument();
    expect(within(dialog).getByText("沒有照片")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(PENDING, { kind: "approve" }));
    expect(toastSuccess).toHaveBeenCalledWith("已核准「有機高麗菜」");
  });

  it("退回一定要填原因", async () => {
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    const confirm = await screen.findByRole("button", { name: "確定退回" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太暗");
    await userEvent.click(confirm);
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(PENDING, { kind: "reject", reason: "照片太暗" }));
  });

  it("已核准的可以下架(= 退回加原因)", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValue([{ ...PENDING, review_status: "approved" }]);
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "標示不實");
    await userEvent.click(screen.getByRole("button", { name: "確定下架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(expect.objectContaining({ id: CABBAGE.id }), { kind: "delist", reason: "標示不實" }));
  });

  it("供應商剛改過(樂觀鎖擋下)→ 顯示要重新整理,並重抓清單", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new StaleReviewError());
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "核准 有機高麗菜" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品剛被供應商修改過,請重新整理後再審核" }),
    );
    expect(vi.mocked(fetchAdminProducts).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("在查看視窗裡被樂觀鎖擋下 → 視窗關掉(畫面上的內容已經過期),要重新查看新內容", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new StaleReviewError());
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "核准上架" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品剛被供應商修改過,請重新整理後再審核" });
  });

  it("下架原因的上限扣掉「(管理員下架)」前綴;退回是資料庫的 300 字", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (filter) => (filter === "approved" ? [{ ...PENDING, review_status: "approved" }] : [PENDING]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveAttribute("maxlength", String(LIMITS.rejectReason));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveAttribute("maxlength", String(DELIST_REASON_MAX));
  });

  it("沒送出的原因不會帶到下一個商品(退回視窗每次都從空白開始)", async () => {
    const OTHER = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c2", name: "牛番茄" };
    vi.mocked(fetchAdminProducts).mockResolvedValue([PENDING, OTHER]);
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太暗");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "退回 牛番茄" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveValue("");
    expect(screen.getByRole("button", { name: "確定退回" })).toBeDisabled();
  });

  it("清單載入失敗 → 顯示錯誤與「重新載入」,不會說成「沒有待審的商品」", async () => {
    vi.mocked(fetchAdminProducts).mockRejectedValueOnce(new MarketDbError({ message: "TypeError: Failed to fetch", code: "", hint: "" }));
    render(<AdminMarketProductsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("連線失敗,請檢查網路後再試一次");
    expect(screen.queryByText("沒有待審的商品")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByRole("button", { name: "查看 有機高麗菜" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("切換篩選時,比較慢回來的舊查詢不會蓋掉新的清單", async () => {
    let resolvePending: (rows: MarketProductRow[]) => void = () => {};
    vi.mocked(fetchAdminProducts).mockImplementation((filter) =>
      filter === "pending"
        ? new Promise<MarketProductRow[]>((resolve) => {
            resolvePending = resolve;
          })
        : Promise.resolve([{ ...PENDING, id: "a9300000-0000-4000-8000-0000000000c1", name: "已核准的商品", review_status: "approved" as const }]),
    );
    render(<AdminMarketProductsPage />);
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    expect(await screen.findByText("已核准的商品")).toBeInTheDocument();
    await act(async () => resolvePending([PENDING]));
    expect(screen.queryByText("有機高麗菜")).toBeNull();
    expect(screen.getByText("已核准的商品")).toBeInTheDocument();
  });
});

describe("AdminMarketProductsPage — 每張照片的主圖和縮圖都要審(縮圖缺了要看得出來)", () => {
  const PHOTO_1 = `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-000000000001.jpg`;
  const PHOTO_2 = `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-000000000002.jpg`;
  const WITH_PHOTOS = { ...PENDING, photos: [PHOTO_1, PHOTO_2] };

  const openDetail = async () => {
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    return screen.findByRole("dialog");
  };

  beforeEach(() => {
    vi.mocked(fetchAdminProducts).mockResolvedValue([WITH_PHOTOS]);
  });

  it("查看:每張照片並排顯示主圖和縮圖(縮圖是另一個檔 <uuid>_t.jpg)", async () => {
    const dialog = await openDetail();
    expect(within(dialog).getByRole("img", { name: "第 1 張・主圖" })).toHaveAttribute("src", publicImageUrl(PHOTO_1));
    expect(within(dialog).getByRole("img", { name: "第 1 張・縮圖" })).toHaveAttribute("src", publicImageUrl(thumbPathOf(PHOTO_1)));
    expect(within(dialog).getByRole("img", { name: "第 2 張・主圖" })).toHaveAttribute("src", publicImageUrl(PHOTO_2));
    expect(within(dialog).getByRole("img", { name: "第 2 張・縮圖" })).toHaveAttribute("src", publicImageUrl(thumbPathOf(PHOTO_2)));
    expect(publicImageUrl(thumbPathOf(PHOTO_1))).toMatch(/0001_t\.jpg$/);
  });

  it("縮圖讀不到 → 那一格明白標出「讀不到縮圖」,不會偷偷改顯示主圖", async () => {
    const dialog = await openDetail();
    fireEvent.error(within(dialog).getByRole("img", { name: "第 1 張・縮圖" }));
    expect(within(dialog).getByRole("img", { name: "第 1 張・縮圖:讀不到" })).toHaveTextContent("讀不到縮圖");
    expect(within(dialog).queryByRole("img", { name: "第 1 張・縮圖" })).toBeNull();
    // 主圖只出現在主圖那一格(MarketImage 的退回會把縮圖那格換成主圖,兩格看起來一樣,審核者就看不出縮圖缺了)
    expect(dialog.querySelectorAll(`img[src="${publicImageUrl(PHOTO_1)}"]`)).toHaveLength(1);
    expect(within(dialog).getByRole("img", { name: "第 1 張・主圖" })).toHaveAttribute("src", publicImageUrl(PHOTO_1));
    // 其他照片不受影響
    expect(within(dialog).getByRole("img", { name: "第 2 張・縮圖" })).toHaveAttribute("src", publicImageUrl(thumbPathOf(PHOTO_2)));
  });

  it("主圖讀不到也一樣標出「讀不到主圖」", async () => {
    const dialog = await openDetail();
    fireEvent.error(within(dialog).getByRole("img", { name: "第 2 張・主圖" }));
    expect(within(dialog).getByRole("img", { name: "第 2 張・主圖:讀不到" })).toHaveTextContent("讀不到主圖");
    expect(within(dialog).getByRole("img", { name: "第 2 張・縮圖" })).toBeInTheDocument();
  });

  it("清單顯示第 1 張的縮圖;讀不到就標出「讀不到縮圖」,不退回主圖", async () => {
    render(<AdminMarketProductsPage />);
    const thumb = await screen.findByRole("img", { name: "有機高麗菜 第 1 張・縮圖" });
    expect(thumb).toHaveAttribute("src", publicImageUrl(thumbPathOf(PHOTO_1)));
    fireEvent.error(thumb);
    expect(screen.getByRole("img", { name: "有機高麗菜 第 1 張・縮圖:讀不到" })).toHaveTextContent("讀不到縮圖");
    expect(document.querySelectorAll(`img[src="${publicImageUrl(PHOTO_1)}"]`)).toHaveLength(0);
  });

  it("核准時照片沒上傳完成(資料庫回 photos_not_uploaded)→ 提示訊息,查看視窗裡也看得到", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(
      new MarketDbError({ message: "照片還沒上傳完成(主圖或縮圖缺檔),不能核准:x_t.jpg", code: "22023", hint: "photos_not_uploaded" }),
    );
    const dialog = await openDetail();
    await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品還有照片沒有上傳完成,無法核准" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent("這個商品還有照片沒有上傳完成,無法核准");
    // 視窗留著:讀不到的那一格就在旁邊
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});

describe("AdminMarketStoresPage", () => {
  it("列出店家與商品數;停用要原因", async () => {
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("市集測試 A 店")).toBeInTheDocument();
    expect(screen.getByText(/上架 3・待審 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    expect(screen.getByRole("button", { name: "確定停用" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("原因(必填)"), "客訴處理中");
    await userEvent.click(screen.getByRole("button", { name: "確定停用" }));
    await waitFor(() => expect(setStoreEnabled).toHaveBeenCalledWith(STORE_A.supplier_id, false, "客訴處理中"));
  });

  it("已停用的店顯示原因,可以恢復", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([{ ...STORE_A, is_enabled: false, disabled_reason: "客訴處理中" }]);
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("停用原因:客訴處理中")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢復 市集測試 A 店 的零售" }));
    await waitFor(() => expect(setStoreEnabled).toHaveBeenCalledWith(STORE_A.supplier_id, true, null));
  });

  it("沒送出的停用原因不會帶到下一家店", async () => {
    const STORE_C = { ...STORE_A, supplier_id: "a9200000-0000-4000-8000-00000000000c", suppliers: { name: "市集測試 C 店", phone: null } };
    vi.mocked(fetchAdminStores).mockResolvedValue([STORE_A, STORE_C]);
    render(<AdminMarketStoresPage />);
    await userEvent.click(await screen.findByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "客訴處理中");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "停用 市集測試 C 店 的零售" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveValue("");
    expect(screen.getByRole("button", { name: "確定停用" })).toBeDisabled();
  });

  it("供應商帳號停用中 → 標出來(零售開著,消費者也看不到這家店)", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([
      { ...STORE_A, suppliers: { name: "市集測試 A 店", phone: null, contact_email: null, is_active: false } },
    ]);
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("供應商帳號已停用,消費者看不到這家店")).toBeInTheDocument();
  });

  it("載入失敗 → 顯示錯誤與「重新載入」,不會說成「還沒有供應商開零售」", async () => {
    vi.mocked(fetchAdminStores).mockRejectedValueOnce(new MarketDbError({ message: "permission denied", code: "42501" }));
    render(<AdminMarketStoresPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("沒有權限做這個動作");
    expect(screen.queryByText("還沒有供應商開零售")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByText("市集測試 A 店")).toBeInTheDocument();
  });
});
