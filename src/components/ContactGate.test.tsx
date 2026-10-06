// ContactGate(寫 landing_leads 的聯絡表單)寫入失敗時的提示:
//   - LEAD_RATE_LIMITED(trigger raise,PostgREST 400 / P0001)→ 「今天留資料的次數太多了…」
//   - 其他錯誤(constraint、RLS、網路)→ 通用友善文案
//   兩種都不能露出 DB 錯誤原文或 constraint 名稱。
// 也確認「只留 LINE」照樣送得出去(後端把「至少一種聯絡方式」放寬成電話 / Email / LINE 三選一,SPEC 修訂 2 R3)。
// supabase 換成 spy,fetch 換成一律失敗的假函式當保險。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactGate, { LEAD_RATE_LIMITED_TEXT, LEAD_SUBMIT_FAILED_TEXT } from "./ContactGate";

const { insert, from, toast, track } = vi.hoisted(() => {
  const insert = vi.fn();
  return {
    insert,
    from: vi.fn(() => ({ insert })),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    track: vi.fn(),
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from } }));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("sonner", () => ({ toast }));

let fetchGuard: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn>;

beforeEach(() => {
  insert.mockReset();
  from.mockClear();
  toast.success.mockReset();
  toast.error.mockReset();
  track.mockReset();
  onDone = vi.fn();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const fillAndSubmit = async ({ line = "foodie888", phone = "" }: { line?: string; phone?: string } = {}) => {
  render(<ContactGate analysisId="an-1" names={["牛腱", "青蔥"]} onDone={onDone} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/店家\/公司名稱/), "好味小館");
  if (line) await user.type(screen.getByLabelText("LINE ID"), line);
  if (phone) await user.type(screen.getByLabelText("手機"), phone);
  await user.click(screen.getByRole("button", { name: "查看媒合供應商" }));
};

const allToastText = () => JSON.stringify([...toast.error.mock.calls, ...toast.success.mock.calls]);

describe("ContactGate:寫入失敗的提示不露出 DB 錯誤", () => {
  it("LEAD_RATE_LIMITED(400 / P0001)→「今天留資料的次數太多了，請明天再試，或直接聯絡我們」", async () => {
    insert.mockResolvedValue({
      error: { message: "LEAD_RATE_LIMITED", code: "P0001", details: null, hint: null },
    });

    await fillAndSubmit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(LEAD_RATE_LIMITED_TEXT));
    expect(LEAD_RATE_LIMITED_TEXT).toBe("今天留資料的次數太多了，請明天再試，或直接聯絡我們");
    expect(allToastText()).not.toMatch(/LEAD_RATE_LIMITED|P0001/);
    expect(onDone).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    // 可以再按一次
    expect(screen.getByRole("button", { name: "查看媒合供應商" })).toBeEnabled();
  });

  it.each([
    [
      "check constraint",
      { message: 'new row for relation "landing_leads" violates check constraint "landing_leads_contact_required"', code: "23514" },
    ],
    ["RLS", { message: 'new row violates row-level security policy for table "landing_leads"', code: "42501" }],
    ["欄位太長", { message: 'value too long for type character varying(254)', code: "22001" }],
  ])("其他錯誤(%s)→ 通用友善文案,不露出 constraint 名稱或原文", async (_label, error) => {
    insert.mockResolvedValue({ error });

    await fillAndSubmit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(LEAD_SUBMIT_FAILED_TEXT));
    expect(allToastText()).not.toMatch(/landing_leads|constraint|row-level|policy|varying|23514|42501|22001/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("網路斷線(insert 直接丟錯)→ 通用友善文案", async () => {
    insert.mockRejectedValue(new TypeError("Failed to fetch"));

    await fillAndSubmit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(LEAD_SUBMIT_FAILED_TEXT));
    expect(allToastText()).not.toContain("Failed to fetch");
  });
});

describe("ContactGate:原本的用法照舊", () => {
  it("只留 LINE(不留電話)照樣送得出去:電話送 null、LINE 送值,成功後 onDone", async () => {
    insert.mockResolvedValue({ error: null });

    await fillAndSubmit({ line: "foodie888", phone: "" });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(from).toHaveBeenCalledWith("landing_leads");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_name: "好味小館",
        contact_line: "foodie888",
        contact_phone: null,
        analysis_id: "an-1",
        items_text: "牛腱、青蔥",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("已收到您的聯絡方式,正在為您媒合供應商!");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("LINE 與電話都沒填 → 前端擋下,不寫資料庫", async () => {
    await fillAndSubmit({ line: "", phone: "" });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("請至少留下 LINE ID 或手機其中一項"));
    expect(insert).not.toHaveBeenCalled();
  });
});
