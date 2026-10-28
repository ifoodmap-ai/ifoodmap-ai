// 供應商「出貨彙總與揀貨單」:選配送日,看這天已接單的訂單每個品項要備多少,下載 CSV。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierPickListDialog from "./SupplierPickListDialog";
import type { PickOrder } from "@/lib/pick-list";

const ORDERS: PickOrder[] = [
  { id: "aaaaaaa1", status: "confirmed", restaurant_id: "r1", delivery_date: "2026-10-30", ingredient_list: [{ name: "高麗菜", quantity: "5", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }] },
  { id: "aaaaaaa2", status: "accepted", restaurant_id: "r2", delivery_date: "2026-10-30", ingredient_list: [{ name: "高麗菜", quantity: "3.5", unit: "kg" }] },
  { id: "aaaaaaa3", status: "dispatched", restaurant_id: "r2", delivery_date: "2026-10-30", ingredient_list: [{ name: "洋蔥", quantity: "9", unit: "kg" }] },
  { id: "aaaaaaa4", status: "confirmed", restaurant_id: "r1", delivery_date: null, ingredient_list: [{ name: "高麗菜", quantity: "1", unit: "kg" }] },
];
const NAMES = { r1: "好味小館", r2: "阿財麵店" };

let blobs: Blob[];
beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  blobs = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return "blob:t"; }, revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b, "utf-8"); });
const renderDialog = () => render(<SupplierPickListDialog open onOpenChange={() => {}} orders={ORDERS} customerNames={NAMES} />);
const pickDate = (d: string) => fireEvent.change(screen.getByLabelText("配送日"), { target: { value: d } });

describe("SupplierPickListDialog", () => {
  it("選配送日:彙總只算這天已接單的單;待接單的只提示張數;沒有配送日的單另外提示", async () => {
    renderDialog();
    pickDate("2026-10-30");

    expect(screen.getByTestId("pick-summary")).toHaveTextContent("共 2 張已接單的訂單");
    expect(screen.getByTestId("pick-summary")).toHaveTextContent("另有 1 張還沒接單");
    const rows = screen.getAllByTestId("pick-row").map((r) => r.textContent);
    // 品項、單位、總數量、客戶數
    expect(rows).toEqual(["高麗菜kg8.52", "雞蛋箱21"]);
    expect(screen.getByText(/另有 1 張進行中的訂單沒有配送日/)).toBeInTheDocument();
  });

  it("這天沒有訂單:顯示說明,下載鈕不能按", () => {
    renderDialog();
    pickDate("2026-12-25");
    expect(screen.getByText("這一天沒有要備貨的訂單")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下載出貨彙總/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /下載揀貨單/ })).toBeDisabled();
  });

  it("下載出貨彙總與揀貨單 CSV", async () => {
    const user = userEvent.setup();
    renderDialog();
    pickDate("2026-10-30");

    await user.click(screen.getByRole("button", { name: /下載出貨彙總/ }));
    const totals = (await text(blobs[0])).replace(/^\uFEFF/, "").split("\r\n");
    expect(totals[0]).toBe("品項,單位,總數量,客戶數,訂單數,備註");
    expect(totals).toContain("高麗菜,kg,8.5,2,2,");

    await user.click(screen.getByRole("button", { name: /下載揀貨單/ }));
    const lines = (await text(blobs[1])).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("客戶,訂單編號,品項,數量,單位");
    expect(lines).toContain("好味小館,#AAAAAAA1,高麗菜,5,kg");
    expect(lines).toContain("阿財麵店,#AAAAAAA2,高麗菜,3.5,kg");
    expect(within(document.body).queryByText("洋蔥")).toBeNull();
  });
});
