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
