// 貼上訊息 / 拍手寫單:AI 辨識 → 核對 → 加入。parseOrder 換成假的,不打 ai。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiOrderDialog from "./AiOrderDialog";

const { parseOrder } = vi.hoisted(() => ({ parseOrder: vi.fn() }));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, parseOrder };
});

const onApply = vi.fn();
const onOpenChange = vi.fn();
const RESULT = {
  items: [
    { name: "高麗菜", quantity: 10, unit: "kg", source_text: "高麗菜 10公斤" },
    { name: "雞蛋", quantity: 0, unit: "箱", source_text: "雞蛋一些" },
    { name: "小白菜", quantity: 5, unit: "把", source_text: "小白菜5把" },
  ],
  unclear: ["那個綠色的"],
};

beforeEach(() => { parseOrder.mockReset(); onApply.mockReset(); onOpenChange.mockReset(); parseOrder.mockResolvedValue(RESULT); });
afterEach(() => cleanup());

const setup = () => {
  const user = userEvent.setup();
  render(<AiOrderDialog open onOpenChange={onOpenChange} supplierName="阿明蔬果" knownItems={["高麗菜", "雞蛋"]} isListed={(n) => n === "高麗菜"} onApply={onApply} />);
  return user;
};
const recognize = async (user: ReturnType<typeof userEvent.setup>, text = "高麗菜 10公斤\n雞蛋一些\n小白菜5把") => {
  await user.type(screen.getByLabelText("叫貨訊息"), text.replace(/\n/g, "{Enter}"));
  await user.click(screen.getByRole("button", { name: "AI 辨識" }));
  await screen.findByTestId("ai-order-rows");
};

describe("AiOrderDialog", () => {
  it("沒有內容時不能辨識;辨識時把文字與已知品名交給 AI", async () => {
    const user = setup();
    expect(screen.getByRole("button", { name: "AI 辨識" })).toBeDisabled();
    await recognize(user, "高麗菜 10公斤");
    expect(parseOrder).toHaveBeenCalledWith({ text: "高麗菜 10公斤", file: null, knownItems: ["高麗菜", "雞蛋"] });
  });

  it("結果逐項列出:標示已在清單 / 新增、原文;數量看不出來的留空;看不清楚的另外列出", async () => {
    const user = setup();
    await recognize(user);
    const rows = screen.getAllByTestId("ai-order-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("已在清單(更新數量)");
    expect(rows[0]).toHaveTextContent("原文:高麗菜 10公斤");
    expect(rows[2]).toHaveTextContent("新增品項");
    expect((screen.getByLabelText("高麗菜 數量") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("雞蛋 數量") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("ai-order-unclear")).toHaveTextContent("那個綠色的");
  });

  it("有勾選的品項沒填數量就不能加入;填了、或取消勾選就可以", async () => {
    const user = setup();
    await recognize(user);
    const add = () => screen.getByRole("button", { name: /加入叫貨清單/ });
    expect(add()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("有 1 項要勾選的品項還沒有填數量");
    await user.type(screen.getByLabelText("雞蛋 數量"), "2");
    expect(add()).toBeEnabled();
    await user.clear(screen.getByLabelText("雞蛋 數量"));
    await user.click(screen.getByLabelText("加入 雞蛋"));
    expect(add()).toBeEnabled();
    expect(add()).toHaveTextContent("(2 項)");
  });

  it("加入:只交出勾選的品項(品名、數量、單位可以改過),並關閉視窗;不會自動送出任何訂單", async () => {
    const user = setup();
    await recognize(user);
    await user.type(screen.getByLabelText("雞蛋 數量"), "3");
    await user.clear(screen.getByLabelText("小白菜 單位"));
    await user.type(screen.getByLabelText("小白菜 單位"), "包");
    await user.click(screen.getByLabelText("加入 高麗菜"));
    await user.click(screen.getByRole("button", { name: /加入叫貨清單/ }));
    expect(onApply).toHaveBeenCalledWith([
      { name: "雞蛋", quantity: "3", unit: "箱" },
      { name: "小白菜", quantity: "5", unit: "包" },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("辨識失敗:顯示白話原因,可以再試;沒辨識到品項也說明", async () => {
    const user = setup();
    parseOrder.mockRejectedValueOnce(new Error("AI 分析失敗"));
    await user.type(screen.getByLabelText("叫貨訊息"), "你好");
    await user.click(screen.getByRole("button", { name: "AI 辨識" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI 分析失敗");
    expect(screen.getByRole("button", { name: "AI 辨識" })).toBeEnabled();

    parseOrder.mockResolvedValueOnce({ items: [], unclear: [] });
    await user.click(screen.getByRole("button", { name: "AI 辨識" }));
    expect(await screen.findByTestId("ai-order-rows")).toHaveTextContent("沒有辨識到要訂的品項");
  });

  it("上傳的不是圖片 / 太大:當場擋下,不呼叫 AI", async () => {
    setup();
    const user = userEvent.setup({ applyAccept: false }); // 瀏覽器的 accept 只是建議,拖進來的檔案不一定是圖片
    const input = screen.getByLabelText("上傳手寫單照片") as HTMLInputElement;
    await user.upload(input, new File(["x"], "a.txt", { type: "text/plain" }));
    expect(screen.getByRole("alert")).toHaveTextContent("請選擇圖片檔");
    expect(screen.getByRole("button", { name: "AI 辨識" })).toBeDisabled();
    expect(parseOrder).not.toHaveBeenCalled();
  });

  it("傳照片:把檔案交給 AI(沒有文字也能辨識)", async () => {
    const user = setup();
    const photo = new File(["x"], "note.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText("上傳手寫單照片"), photo);
    await user.click(screen.getByRole("button", { name: "AI 辨識" }));
    await waitFor(() => expect(parseOrder).toHaveBeenCalledWith({ text: "", file: photo, knownItems: ["高麗菜", "雞蛋"] }));
    await screen.findByTestId("ai-order-rows");
    expect(within(screen.getByTestId("ai-order-rows")).getAllByTestId("ai-order-row")).toHaveLength(3);
  });
});
