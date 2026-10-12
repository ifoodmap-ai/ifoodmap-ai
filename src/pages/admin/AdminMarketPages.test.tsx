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
  type AdminProductPage,
  DELIST_REASON_MAX,
  fetchAdminProducts,
  fetchAdminStores,
  fetchProductCounts,
  MarketStaleReviewError,
  MarketStoreGoneError,
  reviewProduct,
  setStoreEnabled,
} from "@/lib/market/admin";
import { LIMITS } from "@/lib/market/constants";
import { MarketDbError } from "@/lib/market/db";
import { publicImageUrl, thumbPathOf } from "@/lib/market/images";
import { CABBAGE, STORE_A, SUPPLIER_A } from "@/lib/market/testFixtures";
import type { MarketProductRow } from "@/lib/market/types";
import AdminMarketProductsPage from "./AdminMarketProductsPage";
import AdminMarketStoresPage from "./AdminMarketStoresPage";

const PENDING = { ...CABBAGE, review_status: "pending" as const, submitted_at: "2026-10-09T04:05:00Z", updated_at: "2026-10-09T04:05:00.1+00:00" };
/** fetchAdminProducts 回的一頁 */
const pageOf = (rows: MarketProductRow[], total = rows.length): AdminProductPage => ({ rows, total });

/** 查看視窗裡的審核檢查清單全部打勾(核准前一定要) */
const confirmChecklist = async (dialog: HTMLElement) => {
  const list = within(dialog).getByRole("group", { name: "審核檢查清單(每一項都確認才能核准)" });
  for (const box of within(list).getAllByRole("checkbox")) {
    if (!(box as HTMLInputElement).checked) await userEvent.click(box);
  }
};
/** 開著的查看視窗:檢查清單打勾、按「核准上架」 */
const approveInDialog = async () => {
  const dialog = await screen.findByRole("dialog");
  await confirmChecklist(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
};

beforeEach(() => {
  vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([PENDING]));
  vi.mocked(reviewProduct).mockResolvedValue(PENDING);
  vi.mocked(fetchAdminStores).mockResolvedValue([STORE_A]);
  vi.mocked(fetchProductCounts).mockResolvedValue(new Map([[STORE_A.supplier_id, { listed: 3, pending: 1 }]]));
  vi.mocked(setStoreEnabled).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("AdminMarketProductsPage", () => {
  it("預設看待審;查看顯示完整內容;核准送 approve", async () => {
    render(<AdminMarketProductsPage />);
    expect(fetchAdminProducts).toHaveBeenCalledWith("pending", { page: 0, search: "" });
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("宜蘭三星")).toBeInTheDocument();
    expect(within(dialog).getByText("沒有照片")).toBeInTheDocument();
    await confirmChecklist(dialog);
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
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([{ ...PENDING, review_status: "approved" }]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "標示不實");
    await userEvent.click(screen.getByRole("button", { name: "確定下架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(expect.objectContaining({ id: CABBAGE.id }), { kind: "delist", reason: "標示不實" }));
  });

  it("清單上沒有「核准」:核准只能在查看視窗裡做(看得到每張主圖和縮圖)", async () => {
    render(<AdminMarketProductsPage />);
    expect(await screen.findByRole("button", { name: "查看 有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退回 有機高麗菜" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "核准 有機高麗菜" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^核准/ })).toBeNull();
  });

  it("390 寬時品名欄至少 10rem:按鈕少了一顆之後,按鈕列要換到下一行,品名不會被擠成一兩個字一行", async () => {
    render(<AdminMarketProductsPage />);
    const name = await screen.findByText("有機高麗菜");
    expect(name.parentElement).toHaveClass("min-w-[10rem]", "flex-1");
  });

  it("供應商剛改過(樂觀鎖擋下)→ 顯示要重新整理,並重抓清單", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new MarketStaleReviewError());
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await approveInDialog();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品剛被供應商修改過,請重新整理後再審核" }),
    );
    expect(vi.mocked(fetchAdminProducts).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("在查看視窗裡被樂觀鎖擋下 → 視窗關掉(畫面上的內容已經過期),要重新查看新內容", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new MarketStaleReviewError());
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await approveInDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品剛被供應商修改過,請重新整理後再審核" });
  });

  it("下架原因的上限扣掉「(管理員下架)」前綴;退回是資料庫的 300 字", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (filter) => pageOf(filter === "approved" ? [{ ...PENDING, review_status: "approved" }] : [PENDING]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveAttribute("maxlength", String(LIMITS.rejectReason));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    expect(screen.getByLabelText("原因(必填)")).toHaveAttribute("maxlength", String(DELIST_REASON_MAX));
  });

  it("原因只有看不見的字元(零寬空白、WORD JOINER)→ 退回 / 下架都按不下去", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (filter) => pageOf(filter === "approved" ? [{ ...PENDING, review_status: "approved" }] : [PENDING]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "\u{200b}\u{2060}\u{3000}");
    expect(screen.getByRole("button", { name: "確定退回" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "\u{200b}\u{feff}");
    expect(screen.getByRole("button", { name: "確定下架" })).toBeDisabled();
    expect(reviewProduct).not.toHaveBeenCalled();
  });

  it("沒送出的原因不會帶到下一個商品(退回視窗每次都從空白開始)", async () => {
    const OTHER = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c2", name: "牛番茄" };
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([PENDING, OTHER]));
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

  it("清單載入失敗是英文錯誤(登入過期)→ 顯示中文,不出現英文原文", async () => {
    vi.mocked(fetchAdminProducts).mockRejectedValueOnce(new MarketDbError({ message: "JWT expired", code: "PGRST301" }));
    render(<AdminMarketProductsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("登入已過期,請重新登入後再試");
    expect(alert).not.toHaveTextContent("JWT");
  });

  it("審核失敗是認不得的錯誤 → toast 顯示中文備援與錯誤代碼(不顯示英文原文)", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new MarketDbError({ message: "canceling statement due to lock timeout", code: "55P03" }));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太暗");
    await userEvent.click(screen.getByRole("button", { name: "確定退回" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "審核沒有完成,請重新整理後再試(錯誤代碼 55P03)" }));
  });

  it("切換篩選時,比較慢回來的舊查詢不會蓋掉新的清單", async () => {
    let resolvePending: (page: AdminProductPage) => void = () => {};
    vi.mocked(fetchAdminProducts).mockImplementation((filter) =>
      filter === "pending"
        ? new Promise<AdminProductPage>((resolve) => {
            resolvePending = resolve;
          })
        : Promise.resolve(pageOf([{ ...PENDING, id: "a9300000-0000-4000-8000-0000000000c1", name: "已核准的商品", review_status: "approved" as const }])),
    );
    render(<AdminMarketProductsPage />);
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    expect(await screen.findByText("已核准的商品")).toBeInTheDocument();
    await act(async () => resolvePending(pageOf([PENDING])));
    expect(screen.queryByText("有機高麗菜")).toBeNull();
    expect(screen.getByText("已核准的商品")).toBeInTheDocument();
  });

  it("切換篩選時,比較慢回來的舊查詢「失敗」也不會蓋掉新的清單(不顯示錯誤)", async () => {
    let failPending: (e: unknown) => void = () => {};
    vi.mocked(fetchAdminProducts).mockImplementation((filter) =>
      filter === "pending"
        ? new Promise<AdminProductPage>((_resolve, reject) => {
            failPending = reject;
          })
        : Promise.resolve(pageOf([{ ...PENDING, id: "a9300000-0000-4000-8000-0000000000c6", name: "已核准的商品", review_status: "approved" as const }])),
    );
    render(<AdminMarketProductsPage />);
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    expect(await screen.findByText("已核准的商品")).toBeInTheDocument();
    await act(async () => failPending(new MarketDbError({ message: "TypeError: Failed to fetch", code: "", hint: "" })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("已核准的商品")).toBeInTheDocument();
  });

  it("審核成功後重抓清單(核准完的商品離開待審清單)", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValueOnce(pageOf([PENDING])).mockResolvedValue(pageOf([]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await approveInDialog();
    expect(await screen.findByText("沒有待審的商品")).toBeInTheDocument();
    expect(fetchAdminProducts).toHaveBeenCalledTimes(2);
  });

  it("核准還沒回來就切到別的篩選 → 核准完重抓的是「現在」的篩選,不會把清單換回待審", async () => {
    const APPROVED_ROW = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c3", name: "已核准的商品", review_status: "approved" as const };
    vi.mocked(fetchAdminProducts).mockImplementation(async (filter) => pageOf(filter === "approved" ? [APPROVED_ROW] : [PENDING]));
    let finishApprove: () => void = () => {};
    vi.mocked(reviewProduct).mockImplementation(
      () =>
        new Promise<MarketProductRow>((resolve) => {
          finishApprove = () => resolve(PENDING);
        }),
    );
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await approveInDialog();
    // 請求還在路上就關掉視窗、切篩選
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "已核准" }));
    expect(await screen.findByText("已核准的商品")).toBeInTheDocument();
    await act(async () => finishApprove());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已核准「有機高麗菜」"));
    const calls = vi.mocked(fetchAdminProducts).mock.calls;
    await waitFor(() => expect(calls[calls.length - 1]).toEqual(["approved", { page: 0, search: "" }]));
    expect(await screen.findByText("已核准的商品")).toBeInTheDocument();
    expect(screen.queryByText("有機高麗菜")).toBeNull();
    expect(screen.getByRole("button", { name: "已核准" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("AdminMarketProductsPage — 審核結果只作用在同一個商品", () => {
  const TOMATO = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c4", name: "牛番茄" };

  beforeEach(() => {
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([PENDING, TOMATO]));
  });

  /** 打開有機高麗菜按核准(請求不回來),關掉視窗 */
  const approveCabbageAndClose = async () => {
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    await approveInDialog();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };

  it("A 的核准還在送出時改看 B:A 回來的「照片沒上傳完成」不會顯示在 B 的視窗裡", async () => {
    let failA: (e: unknown) => void = () => {};
    vi.mocked(reviewProduct).mockImplementationOnce(
      () =>
        new Promise<MarketProductRow>((_resolve, reject) => {
          failA = reject;
        }),
    );
    await approveCabbageAndClose();
    await userEvent.click(screen.getByRole("button", { name: "查看 牛番茄" }));
    expect(within(await screen.findByRole("dialog")).getByRole("heading", { name: "牛番茄" })).toBeInTheDocument();
    await act(async () => failA(new MarketDbError({ message: "x", code: "22023", hint: "photos_not_uploaded" })));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品還有照片沒有上傳完成,無法核准" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "牛番茄" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await confirmChecklist(dialog);
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeEnabled();
  });

  it("A 核准成功時,開著的 B 退回視窗與打到一半的原因不受影響;A 送出中也不會擋住 B", async () => {
    let finishA: () => void = () => {};
    vi.mocked(reviewProduct).mockImplementationOnce(
      () =>
        new Promise<MarketProductRow>((resolve) => {
          finishA = () => resolve(PENDING);
        }),
    );
    await approveCabbageAndClose();
    await userEvent.click(screen.getByRole("button", { name: "退回 牛番茄" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太");
    expect(screen.getByRole("button", { name: "確定退回" })).toBeEnabled();
    await act(async () => finishA());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已核准「有機高麗菜」"));
    expect(screen.getByRole("dialog")).toHaveTextContent("退回「牛番茄」");
    expect(screen.getByLabelText("原因(必填)")).toHaveValue("照片太");
    expect(screen.getByRole("button", { name: "確定退回" })).toBeEnabled();
  });
});

describe("AdminMarketProductsPage — 分頁與搜尋(任何商品都找得到、下得了架)", () => {
  const productOn = (page: number, total: number) =>
    pageOf([{ ...PENDING, id: `a9300000-0000-4000-8000-${String(900 + page).padStart(12, "0")}`, name: `第 ${page + 1} 頁的商品` }], total);

  it("共 120 筆 → 第 1 / 3 頁;上一頁 / 下一頁抓對的頁,頭尾按不下去", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (_filter, opts) => productOn(opts?.page ?? 0, 120));
    render(<AdminMarketProductsPage />);
    const nav = await screen.findByRole("navigation", { name: "清單分頁" });
    expect(nav).toHaveTextContent("第 1 / 3 頁・共 120 筆");
    expect(within(nav).getByRole("button", { name: "上一頁" })).toBeDisabled();
    await userEvent.click(within(nav).getByRole("button", { name: "下一頁" }));
    expect(await screen.findByText("第 2 頁的商品")).toBeInTheDocument();
    expect(fetchAdminProducts).toHaveBeenLastCalledWith("pending", { page: 1, search: "" });
    await userEvent.click(screen.getByRole("button", { name: "下一頁" }));
    expect(await screen.findByText("第 3 頁的商品")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "清單分頁" })).toHaveTextContent("第 3 / 3 頁・共 120 筆");
    expect(screen.getByRole("button", { name: "下一頁" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "上一頁" }));
    expect(await screen.findByText("第 2 頁的商品")).toBeInTheDocument();
  });

  it("搜尋品名 → 從第 1 頁重抓;找不到時說明;清除搜尋回到全部", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (_filter, opts) =>
      opts?.search === "文旦" ? pageOf([{ ...PENDING, name: "老欉文旦" }]) : opts?.search ? pageOf([]) : productOn(opts?.page ?? 0, 120),
    );
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "下一頁" }));
    expect(await screen.findByText("第 2 頁的商品")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜尋品名" }), "文旦");
    await userEvent.click(screen.getByRole("button", { name: "搜尋" }));
    expect(await screen.findByText("老欉文旦")).toBeInTheDocument();
    expect(fetchAdminProducts).toHaveBeenLastCalledWith("pending", { page: 0, search: "文旦" });
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜尋品名" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜尋品名" }), "沒有這個{Enter}");
    expect(await screen.findByText("待審裡找不到品名含「沒有這個」的商品")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除搜尋" }));
    expect(await screen.findByText("第 1 頁的商品")).toBeInTheDocument();
    expect(fetchAdminProducts).toHaveBeenLastCalledWith("pending", { page: 0, search: "" });
    expect(screen.getByRole("searchbox", { name: "搜尋品名" })).toHaveValue("");
  });

  it("已核准超過一頁時,較舊的商品也找得到、下得了架", async () => {
    const OLD = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000d1", name: "去年的蜂蜜", review_status: "approved" as const };
    const NEWER = Array.from({ length: 50 }, (_, i) => ({
      ...PENDING,
      id: `a9300000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
      name: `新商品 ${i + 1}`,
      review_status: "approved" as const,
    }));
    vi.mocked(fetchAdminProducts).mockImplementation(async (filter, opts) => {
      if (filter !== "approved") return pageOf([]);
      if (opts?.search) return pageOf([OLD]);
      return opts?.page === 10 ? pageOf([OLD], 501) : pageOf(NEWER, 501);
    });
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "已核准" }));
    expect(await screen.findByRole("navigation", { name: "清單分頁" })).toHaveTextContent("第 1 / 11 頁・共 501 筆");
    expect(screen.queryByText("去年的蜂蜜")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜尋品名" }), "蜂蜜");
    await userEvent.click(screen.getByRole("button", { name: "搜尋" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 去年的蜂蜜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "標示不實");
    await userEvent.click(screen.getByRole("button", { name: "確定下架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(expect.objectContaining({ id: OLD.id }), { kind: "delist", reason: "標示不實" }));
  });

  it("換篩選回到第 1 頁", async () => {
    vi.mocked(fetchAdminProducts).mockImplementation(async (_filter, opts) => productOn(opts?.page ?? 0, 120));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "下一頁" }));
    expect(await screen.findByText("第 2 頁的商品")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(fetchAdminProducts).toHaveBeenLastCalledWith("all", { page: 0, search: "" }));
    expect(await screen.findByText("第 1 頁的商品")).toBeInTheDocument();
  });

  it("審核完這一頁空了(最後一頁只剩那一筆)→ 回到前一頁", async () => {
    let total = 51;
    vi.mocked(fetchAdminProducts).mockImplementation(async (_filter, opts) => {
      if ((opts?.page ?? 0) === 1) return total === 51 ? pageOf([{ ...PENDING, name: "最後一筆" }], 51) : pageOf([], total);
      return pageOf([PENDING], total);
    });
    vi.mocked(reviewProduct).mockImplementation(async () => {
      total = 50;
      return PENDING;
    });
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "下一頁" }));
    await userEvent.click(await screen.findByRole("button", { name: "退回 最後一筆" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太暗");
    await userEvent.click(screen.getByRole("button", { name: "確定退回" }));
    await waitFor(() => expect(fetchAdminProducts).toHaveBeenLastCalledWith("pending", { page: 0, search: "" }));
    expect(await screen.findByText("有機高麗菜")).toBeInTheDocument();
  });
});

describe("AdminMarketProductsPage — 每張照片的主圖和縮圖都要審(縮圖缺了要看得出來)", () => {
  const PHOTO_1 = `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-000000000001.jpg`;
  const PHOTO_2 = `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-000000000002.jpg`;
  const WITH_PHOTOS = { ...PENDING, photos: [PHOTO_1, PHOTO_2] };

  /** 打開查看視窗並把檢查清單打勾:這一組只看照片載入對核准的影響 */
  const openDetail = async () => {
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    await confirmChecklist(dialog);
    return dialog;
  };
  /** 視窗裡的圖都觸發 load(jsdom 不會自己載入圖片);except 是要留著的(之後觸發 error) */
  const loadEvery = (dialog: HTMLElement, except: string[] = []) =>
    within(dialog)
      .getAllByRole("img")
      .filter((img) => !except.includes(img.getAttribute("alt") ?? ""))
      .forEach((img) => fireEvent.load(img));

  beforeEach(() => {
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([WITH_PHOTOS]));
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

  it("查看視窗的圖整張顯示(object-contain),不裁切:照片邊角的內容也看得到", async () => {
    const dialog = await openDetail();
    const images = within(dialog).getAllByRole("img");
    expect(images).toHaveLength(4);
    images.forEach((img) => {
      expect(img).toHaveClass("object-contain");
      expect(img).not.toHaveClass("object-cover");
    });
  });

  it("照片還在載入 → 不能核准;視窗裡的照片立即載入(不延遲)", async () => {
    const dialog = await openDetail();
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
    expect(within(dialog).getByText("照片載入中,每張主圖和縮圖都載入完成才能核准")).toBeInTheDocument();
    const images = within(dialog).getAllByRole("img");
    expect(images).toHaveLength(4);
    images.forEach((img) => expect(img).toHaveAttribute("loading", "eager"));
    // 只載入一部分還是不行
    fireEvent.load(within(dialog).getByRole("img", { name: "第 1 張・主圖" }));
    fireEvent.load(within(dialog).getByRole("img", { name: "第 1 張・縮圖" }));
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "退回" })).toBeEnabled();
  });

  it("主圖讀不到 → 不能核准(其他檔都載入成功也一樣)", async () => {
    const dialog = await openDetail();
    loadEvery(dialog, ["第 2 張・主圖"]);
    fireEvent.error(within(dialog).getByRole("img", { name: "第 2 張・主圖" }));
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
    expect(within(dialog).getByText(/有 1 個檔讀不到,不能核准/)).toBeInTheDocument();
  });

  it("縮圖讀不到 → 不能核准(其他檔都載入成功也一樣)", async () => {
    const dialog = await openDetail();
    loadEvery(dialog, ["第 1 張・縮圖"]);
    // 紅框還在時按得下去的話:供應商這時才補傳(可能是另一張圖),再按一次就核准了一張審核者沒看過的縮圖
    fireEvent.error(within(dialog).getByRole("img", { name: "第 1 張・縮圖" }));
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
    expect(within(dialog).getByText(/有 1 個檔讀不到,不能核准/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "退回" })).toBeEnabled();
  });

  it("每張照片的主圖和縮圖都載入成功 → 才能核准", async () => {
    const dialog = await openDetail();
    loadEvery(dialog);
    const approve = within(dialog).getByRole("button", { name: "核准上架" });
    expect(approve).toBeEnabled();
    expect(within(dialog).queryByText(/照片載入中|個檔讀不到/)).toBeNull();
    await userEvent.click(approve);
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(WITH_PHOTOS, { kind: "approve" }));
  });

  it("讀不到之後關掉重開 = 每張圖重新載入;這次全部載入成功才能核准", async () => {
    const dialog = await openDetail();
    loadEvery(dialog, ["第 1 張・縮圖"]);
    fireEvent.error(within(dialog).getByRole("img", { name: "第 1 張・縮圖" }));
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "查看 有機高麗菜" }));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByRole("img", { name: "第 1 張・縮圖" })).toBeInTheDocument();
    expect(within(again).getByRole("button", { name: "核准上架" })).toBeDisabled();
    // 重開 = 檢查清單也從頭來
    await confirmChecklist(again);
    loadEvery(again);
    expect(within(again).getByRole("button", { name: "核准上架" })).toBeEnabled();
    expect(within(again).queryByText(/個檔讀不到/)).toBeNull();
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
    const missing = screen.getByRole("img", { name: "有機高麗菜 第 1 張・縮圖:讀不到" });
    expect(missing).toHaveTextContent("讀不到縮圖");
    // 64px 的框裡固定斷成「讀不到 / 縮圖」兩行(自動換行會斷成「讀不到縮 / 圖」)
    expect(missing.innerHTML).toBe("讀不到<br>縮圖");
    expect(document.querySelectorAll(`img[src="${publicImageUrl(PHOTO_1)}"]`)).toHaveLength(0);
  });

  it("核准時照片沒上傳完成(資料庫回 photos_not_uploaded)→ 提示訊息,查看視窗裡也看得到", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(
      new MarketDbError({ message: "照片還沒上傳完成(主圖或縮圖缺檔),不能核准:x_t.jpg", code: "22023", hint: "photos_not_uploaded" }),
    );
    const dialog = await openDetail();
    loadEvery(dialog);
    await confirmChecklist(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品還有照片沒有上傳完成,無法核准" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent("這個商品還有照片沒有上傳完成,無法核准");
    // 視窗留著:讀不到的那一格就在旁邊
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});

// 法規查證 M3、M8、S3、S4:醒目標示七日鑑賞期;審核檢查清單每一項都打勾才能核准;自動提醒酒類與違法字句。
describe("AdminMarketProductsPage — 七日鑑賞期標示與審核檢查清單", () => {
  const MILK = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c5", name: "鮮奶", withdrawal_exempt: true };

  it("查看視窗醒目標示「適用 / 不適用七日鑑賞期」;清單上不適用的商品有標記", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([PENDING, MILK]));
    render(<AdminMarketProductsPage />);
    const milkRow = (await screen.findByText("鮮奶")).closest("li") as HTMLElement;
    expect(within(milkRow).getByText("不適用七日鑑賞期")).toBeInTheDocument();
    const cabbageRow = screen.getByText("有機高麗菜").closest("li") as HTMLElement;
    expect(within(cabbageRow).queryByText("不適用七日鑑賞期")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "查看 鮮奶" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("不適用七日鑑賞期(店家勾選:消費者不能無理由退貨)")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "查看 有機高麗菜" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("適用七日鑑賞期(消費者收到隔天起 7 天內可以退貨)")).toBeInTheDocument();
  });

  it("審核檢查清單:每一項都打勾才能核准;不適用七日鑑賞期的多一項「確實是易腐或短效商品」", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([PENDING, MILK]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    let dialog = await screen.findByRole("dialog");
    let list = within(dialog).getByRole("group", { name: "審核檢查清單(每一項都確認才能核准)" });
    let boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.closest("label")?.textContent)).toEqual([
      "商品說明裡有食品資訊:成分、淨重或容量、食品添加物、製造或負責廠商的名稱、電話、地址、原產地、到貨時離有效日期至少幾天、食品業者登錄字號",
      "不是酒類(包括料理米酒、料理酒;菸酒管理法禁止網路販售)",
      "品名、說明、照片沒有違法字句:「恕不退換」「退貨運費自付」「圖片僅供參考」、醫療效能宣稱",
    ]);
    const approve = within(dialog).getByRole("button", { name: "核准上架" });
    expect(approve).toBeDisabled();
    expect(within(dialog).getByText("檢查清單每一項都確認後才能核准")).toBeInTheDocument();
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    expect(approve).toBeDisabled();
    await userEvent.click(boxes[2]);
    expect(approve).toBeEnabled();
    expect(within(dialog).queryByText("檢查清單每一項都確認後才能核准")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "查看 鮮奶" }));
    dialog = await screen.findByRole("dialog");
    list = within(dialog).getByRole("group", { name: "審核檢查清單(每一項都確認才能核准)" });
    boxes = within(list).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    expect(boxes[3].closest("label")).toHaveTextContent(
      "標示「不適用七日鑑賞期」的商品確實屬於易腐或短效商品(保存期限少於 7 天左右,或到貨時已接近到期)",
    );
    await confirmChecklist(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(MILK, { kind: "approve" }));
  });

  it("自動提醒:品名或說明有酒類、限制退貨、僅供參考的字句時列在查看視窗(只是提醒,檢查清單照樣要勾)", async () => {
    const COOKING_WINE = { ...PENDING, id: "a9300000-0000-4000-8000-0000000000c6", name: "料理米酒", description: "生鮮商品恕不退換" };
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([COOKING_WINE]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 料理米酒" }));
    const dialog = await screen.findByRole("dialog");
    const warnings = within(dialog).getByRole("list", { name: "自動偵測到要特別看的字句" });
    expect(within(warnings).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "提到「料理米酒」:酒類(包括料理米酒、料理酒)不能在網路販售",
      "有「恕不退換」:不能限制消費者的退貨權利",
    ]);
    expect(within(dialog).getByRole("button", { name: "核准上架" })).toBeDisabled();
  });

  it("沒有要特別看的字句:不顯示自動提醒;已核准的商品(不在待審)不顯示檢查清單", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValue(pageOf([{ ...PENDING, review_status: "approved" }]));
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("list", { name: "自動偵測到要特別看的字句" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "審核檢查清單(每一項都確認才能核准)" })).toBeNull();
    expect(within(dialog).getByText("適用七日鑑賞期(消費者收到隔天起 7 天內可以退貨)")).toBeInTheDocument();
  });
});

describe("AdminMarketStoresPage — 店家法定資訊(法規查證 M6)", () => {
  const FILLED = {
    ...STORE_A,
    legal_name: "市集測試 A 店有限公司",
    representative: "王小明",
    business_address: "臺北市測試路 1 號",
    service_email: "service-a@example.com",
    food_registration_no: "A-123456789-00000-0",
    liability_insurance: null,
  };

  it("顯示登記名稱、負責人、電話、營業所地址、客服 Email、登錄字號、產品責任險(沒填寫「未填」)", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([FILLED]);
    render(<AdminMarketStoresPage />);
    const row = (await screen.findByText("市集測試 A 店")).closest("li") as HTMLElement;
    const legal = within(row).getByRole("group", { name: "市集測試 A 店的法定資訊" });
    expect(legal).toHaveTextContent("登記名稱:市集測試 A 店有限公司");
    expect(legal).toHaveTextContent("負責人:王小明");
    expect(legal).toHaveTextContent("電話:02-2345-6789");
    expect(legal).toHaveTextContent("營業所地址:臺北市測試路 1 號");
    expect(legal).toHaveTextContent("客服 Email:service-a@example.com");
    expect(legal).toHaveTextContent("食品業者登錄字號:A-123456789-00000-0");
    expect(legal).toHaveTextContent("產品責任險:未填");
    expect(within(row).queryByText(/法定資訊沒填齊/)).toBeNull();
  });

  it("供應商電話只有零寬字元:顯示「—」,跟缺的項目一致(同資料庫的 market_visible)", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([{ ...FILLED, suppliers: { ...STORE_A.suppliers!, phone: "\u{200B}" } }]);
    render(<AdminMarketStoresPage />);
    const row = (await screen.findByText("市集測試 A 店")).closest("li") as HTMLElement;
    const legal = within(row).getByRole("group", { name: "市集測試 A 店的法定資訊" });
    expect(legal).toHaveTextContent("電話:—");
    expect(within(row).getByText("法定資訊沒填齊(缺:店家電話),消費者看不到這家店、也不能開放零售")).toBeInTheDocument();
  });

  it("缺法定資訊(含供應商電話)→ 標出缺哪幾項、不能開放零售;恢復時資料庫擋下顯示中文", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([{ ...STORE_A, is_enabled: false, disabled_reason: "資料待補", suppliers: { ...STORE_A.suppliers!, phone: null } }]);
    vi.mocked(setStoreEnabled).mockRejectedValue(new MarketDbError({ message: "x", code: "22023", hint: "store_disclosure_missing" }));
    render(<AdminMarketStoresPage />);
    const row = (await screen.findByText("市集測試 A 店")).closest("li") as HTMLElement;
    // market_store_is_open 也要求法定資訊:沒填齊的店消費者看不到、也不能下單
    expect(
      within(row).getByText("法定資訊沒填齊(缺:登記名稱、負責人、營業所地址、客服 Email、店家電話),消費者看不到這家店、也不能開放零售"),
    ).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "恢復 市集測試 A 店 的零售" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", {
        description: "開放零售前要填齊店家法定資訊:登記名稱、負責人、營業所地址、客服 Email,以及供應商資料的電話",
      }),
    );
  });
});

describe("AdminMarketStoresPage", () => {
  it("列出店家與商品數;停用要原因", async () => {
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("市集測試 A 店")).toBeInTheDocument();
    expect(screen.getByText(/上架 3・待審 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    expect(screen.getByRole("button", { name: "確定停用" })).toBeDisabled();
    expect(screen.getByLabelText("原因(必填)")).toHaveAttribute("maxlength", String(LIMITS.disabledReason));
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

  it("停用原因只有看不見的字元 → 按不下去", async () => {
    render(<AdminMarketStoresPage />);
    await userEvent.click(await screen.findByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "\u{200b}\u{2060}");
    expect(screen.getByRole("button", { name: "確定停用" })).toBeDisabled();
    expect(setStoreEnabled).not.toHaveBeenCalled();
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

  it("停用失敗是英文錯誤 → toast 顯示中文備援;一列都沒更新到 → 說明可能已被移除", async () => {
    vi.mocked(setStoreEnabled).mockRejectedValueOnce(
      new MarketDbError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }),
    );
    render(<AdminMarketStoresPage />);
    await userEvent.click(await screen.findByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "客訴處理中");
    await userEvent.click(screen.getByRole("button", { name: "確定停用" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "沒有更新成功,請重新整理後再試(錯誤代碼 PGRST116)" }));
    vi.mocked(setStoreEnabled).mockRejectedValueOnce(new MarketStoreGoneError());
    await userEvent.click(screen.getByRole("button", { name: "確定停用" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenLastCalledWith("處理失敗", { description: "沒有更新到這家店(可能已被移除或權限不足),請重新整理後再試" }),
    );
  });

  it("載入失敗是英文錯誤(登入過期)→ 顯示中文", async () => {
    vi.mocked(fetchAdminStores).mockRejectedValueOnce(new MarketDbError({ message: "JWT expired", code: "PGRST301" }));
    render(<AdminMarketStoresPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("登入已過期,請重新登入後再試");
    expect(alert).not.toHaveTextContent("JWT");
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
