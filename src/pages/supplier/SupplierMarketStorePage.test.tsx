// 供應商「店家設定」:讀既有設定、驗證錯誤顯示在欄位旁(aria-invalid)、儲存、被停用時顯示原因。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/hooks/use-current-supplier", () => ({
  useCurrentSupplier: () => ({ supplierId: "a9200000-0000-4000-8000-00000000000a", loading: false, error: null }),
}));
vi.mock("@/lib/market/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/store")>()),
  fetchOwnStore: vi.fn(),
  saveStore: vi.fn(),
}));

import { fetchOwnStore, saveStore } from "@/lib/market/store";
import { STORE_A } from "@/lib/market/testFixtures";
import SupplierMarketStorePage from "./SupplierMarketStorePage";

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierMarketStorePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(fetchOwnStore).mockResolvedValue({ store: null, transferInfo: null });
  vi.mocked(saveStore).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("SupplierMarketStorePage", () => {
  it("還沒建店:沒選縣市就儲存 → 縣市欄位顯示錯誤,不會送出", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    expect(await screen.findByText("至少選一個配送縣市")).toBeInTheDocument();
    expect(saveStore).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("有欄位需要修正", { description: "至少選一個配送縣市" });
  });

  it("勾銀行轉帳就出現轉帳資訊欄位,沒填會被擋並標 aria-invalid", async () => {
    renderPage();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    const info = screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    expect(info).toHaveAttribute("aria-invalid", "true");
    expect(info).toHaveAttribute("aria-describedby", "store-transferInfo-error");
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("填好就儲存,送出的表單帶選的縣市與運費", async () => {
    renderPage();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.clear(screen.getByLabelText("固定運費(元)"));
    await userEvent.type(screen.getByLabelText("固定運費(元)"), "120");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveStore).mock.calls[0][1]).toMatchObject({ deliveryCities: ["臺北市"], shippingFee: "120", acceptCod: true });
    expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定");
  });

  it("已有設定就帶入;被平台停用時顯示原因", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({
      store: { ...STORE_A, is_enabled: false, disabled_reason: "客訴處理中" },
      transferInfo: "台灣銀行 004 帳號 123",
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("原因:客訴處理中");
    expect(screen.getByLabelText("新北市")).toBeChecked();
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("台灣銀行 004 帳號 123");
    expect(screen.getByRole("link", { name: "看消費者看到的店家頁" })).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
  });
});

// 讀取失敗跟「讀取成功但還沒建店」要分清楚:讀取失敗還顯示空白的新店家表單的話,
// 供應商一儲存,upsert 就把原本的介紹、退換貨說明、logo、封面蓋掉。
describe("SupplierMarketStorePage — 讀取狀態", () => {
  it("讀取失敗:不顯示表單、送不出儲存,顯示原因與「重新載入」;重新載入成功才帶入原本的設定", async () => {
    vi.mocked(fetchOwnStore)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123" });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("讀取店家設定失敗");
    expect(alert).toHaveTextContent("連線失敗,請檢查網路後再試一次");
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "儲存店家設定" })).toBeNull();
    expect(screen.queryByLabelText("臺北市")).toBeNull();
    expect(saveStore).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByLabelText("新北市")).toBeChecked();
    expect(screen.getByLabelText("店家介紹")).toHaveValue(STORE_A.intro);
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("台灣銀行 004 帳號 123");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchOwnStore).toHaveBeenCalledTimes(2);
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("重新載入又失敗:還是錯誤畫面,不會掉回空白表單", async () => {
    vi.mocked(fetchOwnStore).mockRejectedValue(new Error("boom"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "重新載入" }));
    await waitFor(() => expect(fetchOwnStore).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(document.querySelector("form")).toBeNull();
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("讀取成功但這家店還沒建:才顯示新店家表單(沒有錯誤、沒有店家頁連結、欄位是預設值)", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "儲存店家設定" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "重新載入" })).toBeNull();
    expect(screen.queryByRole("link", { name: "看消費者看到的店家頁" })).toBeNull();
    expect(screen.getByLabelText("臺北市")).not.toBeChecked();
    expect(screen.getByLabelText("固定運費(元)")).toHaveValue("0");
    expect(screen.getByLabelText("店家介紹")).toHaveValue("");
  });
});
