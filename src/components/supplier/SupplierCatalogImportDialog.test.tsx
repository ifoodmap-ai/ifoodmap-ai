// 商品目錄批次匯入:選 CSV → 預覽 → 確定才寫入;有問題的列不匯入、寫入失敗要說已寫入多少。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierCatalogImportDialog from "./SupplierCatalogImportDialog";
import type { CatalogRow } from "@/lib/catalog-import";

const SUP = "10000000-0000-0000-0000-00000000000a";

const { state, toast } = vi.hoisted(() => ({
  state: { calls: [] as { table: string; op: string; values: unknown; opts?: unknown }[], failOn: null as string | null },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (values: unknown) => { state.calls.push({ table, op: "insert", values }); return { error: state.failOn === "insert" ? { message: "新增失敗" } : null }; },
      upsert: async (values: unknown, opts: unknown) => { state.calls.push({ table, op: "upsert", values, opts }); return { error: state.failOn === "upsert" ? { message: "更新失敗" } : null }; },
    }),
  },
}));

const row = (o: Partial<CatalogRow> & { id: string; name: string }): CatalogRow => ({
  category: null, sku: null, unit: null, pack_size: null, price: null, description: null, is_available: true, ...o,
});
const SUPPLIES = [row({ id: "a", name: "高麗菜", sku: "VEG-001", unit: "kg", price: 45, category: "蔬菜" })];
const H = "商品名稱,貨號,分類,單位,規格,定價,說明,上架\r\n";

const onApplied = vi.fn();
const onOpenChange = vi.fn();
beforeEach(() => { state.calls = []; state.failOn = null; toast.mockReset(); onApplied.mockReset(); onOpenChange.mockReset(); });
afterEach(() => cleanup());

const setup = async (csv: string) => {
  const user = userEvent.setup();
  render(<SupplierCatalogImportDialog open onOpenChange={onOpenChange} supplierId={SUP} supplies={SUPPLIES} onApplied={onApplied} />);
  await user.upload(screen.getByLabelText("選擇商品 CSV 檔案"), new File([csv], "商品.csv", { type: "text/csv" }));
  await screen.findByTestId("import-preview");
  return user;
};

describe("SupplierCatalogImportDialog", () => {
  it("選檔後先預覽:新增 / 更新幾個、更新的欄位前後對照、有問題的列;還沒寫入任何東西", async () => {
    await setup(`${H}高麗菜,VEG-001,,,,48,,\r\n芭樂,,水果,斤,,35,,\r\n壞資料,,,,,貴,,`);
    expect(screen.getByTestId("import-summary")).toHaveTextContent("新增 1 個、更新 1 個、有問題 1 列(不會匯入)");
    expect(screen.getByTestId("import-updates")).toHaveTextContent("高麗菜定價 45 → 48");
    expect(screen.getByTestId("import-creates")).toHaveTextContent("新增:芭樂");
    expect(screen.getByTestId("import-errors")).toHaveTextContent("第 4 列:「壞資料」的定價要是大於 0 的數字");
    expect(state.calls).toEqual([]);
    expect(screen.getByRole("button", { name: "確定匯入(2 個商品)" })).toBeEnabled();
  });

  it("確定匯入:新增用 insert(帶供應商與幣別)、更新用 upsert(帶完整的列,不會把沒提到的欄位洗掉);成功後重新讀目錄並關閉", async () => {
    const user = await setup(`${H}高麗菜,VEG-001,,,,48,,\r\n芭樂,,水果,斤,,35,,`);
    await user.click(screen.getByRole("button", { name: /確定匯入/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());

    expect(state.calls[0]).toMatchObject({ table: "supplies", op: "insert" });
    expect(state.calls[0].values).toEqual([
      expect.objectContaining({ name: "芭樂", category: "水果", unit: "斤", price: 35, supplier_id: SUP, currency: "TWD", is_available: true }),
    ]);
    expect(state.calls[1]).toMatchObject({ table: "supplies", op: "upsert", opts: { onConflict: "id" } });
    expect(state.calls[1].values).toEqual([
      { id: "a", supplier_id: SUP, name: "高麗菜", sku: "VEG-001", category: "蔬菜", unit: "kg", pack_size: null, price: 48, description: null, is_available: true },
    ]);
    expect(toast).toHaveBeenCalledWith({ title: "匯入完成:新增 1 個、更新 1 個商品" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("超過 200 個會分批寫入", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `商品${i}`).join("\r\n");
    const user = await setup(H + lines);
    await user.click(screen.getByRole("button", { name: /確定匯入/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(state.calls.map((c) => (c.values as unknown[]).length)).toEqual([200, 200, 50]);
  });

  it("寫入失敗:顯示原因與「已寫入多少」,不假裝成功,視窗留著;仍會重新讀目錄", async () => {
    state.failOn = "upsert";
    const user = await setup(`${H}高麗菜,VEG-001,,,,48,,\r\n芭樂,,,,,35,,`);
    await user.click(screen.getByRole("button", { name: /確定匯入/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "匯入中斷",
      description: expect.stringContaining("更新失敗(已寫入:新增 1 個、更新 0 個"),
      variant: "destructive",
    }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("整個檔案都有問題(或沒有變動):不能按確定匯入", async () => {
    await setup(`${H}高麗菜,VEG-001,蔬菜,kg,,45,,是`);
    expect(screen.getByTestId("import-summary")).toHaveTextContent("新增 0 個、更新 0 個、沒有變動 1 個");
    expect(screen.getByRole("button", { name: "確定匯入" })).toBeDisabled();
    cleanup();
    await setup("貨號,定價\r\nA,1");
    expect(screen.getByTestId("import-errors")).toHaveTextContent("找不到「商品名稱」欄");
    expect(screen.getByRole("button", { name: "確定匯入" })).toBeDisabled();
  });
});
