import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantTeamPage from "./RestaurantTeamPage";

// 同時跑很多測試檔時 CPU 會被搶,逐字打字(預設每個字之間讓出一次 event loop)偶爾會超過 5 秒:
// 打字不延遲,逾時也放寬到 15 秒(單獨跑時整支不到 3 秒)。
vi.setConfig({ testTimeout: 15_000 });
const setupUser = () => userEvent.setup({ delay: null });

/* ------------------------------------------------------------------ */
/* mocks:不打任何真的 Supabase / Edge Function                         */
/* ------------------------------------------------------------------ */

type Role = "owner" | "manager" | "purchaser";

const h = vi.hoisted(() => {
  const state = {
    account: {
      id: "acc-owner",
      restaurant_id: "rest-1",
      branch_id: "br-2" as string | null,
      role: "owner" as Role,
      restaurant_name: "好味小館",
    },
    myUserId: "u-owner",
    branches: [] as unknown[],
    members: [] as unknown[],
    profiles: [] as unknown[],
    directory: [] as unknown[],
  };
  return {
    state,
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    rpc: vi.fn(),
    getSession: vi.fn(),
  };
});

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => h.state.account,
  canSeeCost: (role: Role) => role === "owner" || role === "manager",
}));

vi.mock("sonner", () => ({
  toast: { success: h.toastSuccess, error: h.toastError, info: vi.fn() },
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const result = () => {
      if (table === "restaurant_branches") return { data: h.state.branches, error: null };
      if (table === "restaurant_accounts") return { data: h.state.members, error: null };
      if (table === "profiles") return { data: h.state.profiles, error: null };
      return { data: [], error: null };
    };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => Promise.resolve(result());
    chain.in = () => Promise.resolve(result());
    chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    chain.insert = () => Promise.resolve({ error: null });
    return chain;
  };
  return {
    supabase: {
      auth: { getSession: h.getSession },
      from,
      rpc: h.rpc,
    },
  };
});

// Radix 在 jsdom 需要的幾個 API
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);
Element.prototype.releasePointerCapture = vi.fn();

/* ------------------------------------------------------------------ */
/* 測試資料                                                            */
/* ------------------------------------------------------------------ */

/** accepted_at = null 代表「邀請中」(還沒按接受) */
const member = (
  id: string,
  user_id: string,
  role: Role,
  branch_id: string | null = "br-2",
  accepted_at: string | null = "2026-09-01T02:05:00.000Z",
) => ({
  id,
  user_id,
  restaurant_id: "rest-1",
  branch_id,
  role,
  is_active: true,
  accepted_at,
  created_at: "2026-09-01T02:00:00.000Z",
});

const fetchMock = vi.fn();

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const setRole = (role: Role, userId = "u-owner") => {
  h.state.account = { ...h.state.account, role };
  h.state.myUserId = userId;
};

beforeEach(() => {
  h.state.account = {
    id: "acc-owner",
    restaurant_id: "rest-1",
    branch_id: "br-2",
    role: "owner",
    restaurant_name: "好味小館",
  };
  h.state.myUserId = "u-owner";
  h.state.branches = [
    { id: "br-1", restaurant_id: "rest-1", name: "總店", address: null, receiving_hours: null, is_active: true, created_at: "2026-08-01T00:00:00Z" },
    { id: "br-2", restaurant_id: "rest-1", name: "信義店", address: null, receiving_hours: null, is_active: true, created_at: "2026-08-02T00:00:00Z" },
    { id: "br-3", restaurant_id: "rest-1", name: "舊倉庫", address: null, receiving_hours: null, is_active: false, created_at: "2026-08-03T00:00:00Z" },
  ];
  h.state.members = [
    member("acc-owner", "u-owner", "owner"),
    member("acc-mgr", "u-mgr", "manager"),
    member("acc-pending", "u-pending", "purchaser", "br-1", null),
  ];
  h.state.profiles = [
    { user_id: "u-owner", display_name: "林老闆" },
    { user_id: "u-mgr", display_name: "張店長" },
    { user_id: "u-pending", display_name: "李採購" },
  ];
  // 老闆拿得到 email;u-pending 還沒接受邀請
  h.state.directory = [
    { user_id: "u-owner", email: "owner@example.com", invited_at: null, invite_pending: false },
    { user_id: "u-mgr", email: "mgr@example.com", invited_at: "2026-09-01T02:00:00Z", invite_pending: false },
    { user_id: "u-pending", email: "pending@example.com", invited_at: "2026-09-01T02:00:00Z", invite_pending: true },
  ];

  h.getSession.mockImplementation(async () => ({
    data: { session: { access_token: "tok-owner", user: { id: h.state.myUserId, email: "owner@example.com" } } },
    error: null,
  }));
  h.rpc.mockImplementation(async (fn: string) =>
    fn === "restaurant_member_directory"
      ? {
          data:
            h.state.account.role === "owner"
              ? h.state.directory
              : (h.state.directory as { email: string | null }[]).map((d) => ({ ...d, email: null })),
          error: null,
        }
      : { data: null, error: { message: "unknown rpc" } },
  );

  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-key");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const renderPage = async () => {
  render(<RestaurantTeamPage />);
  // 等成員列表載入完成
  await screen.findByText("張店長");
};

const openInviteDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /新增成員/ }));
  return screen.findByRole("dialog", { name: "新增成員" });
};

/** 找到某位成員那一列(名字所在的卡片) */
const memberRow = (name: string) => {
  const el = screen.getByText(name);
  const row = el.closest("div.rounded-md");
  if (!row) throw new Error(`找不到 ${name} 的列`);
  return row as HTMLElement;
};

/* ------------------------------------------------------------------ */

describe("RestaurantTeamPage — 新增成員", () => {
  it.each<Role>(["manager", "purchaser"])("非老闆(%s)看不到「新增成員」按鈕", async (role) => {
    setRole(role, role === "manager" ? "u-mgr" : "u-pending");
    await renderPage();

    expect(screen.queryByRole("button", { name: /新增成員/ })).not.toBeInTheDocument();
    expect(screen.getByText(/只有老闆可以新增成員/)).toBeInTheDocument();
  });

  it("老闆看得到「新增成員」按鈕,點擊區高度 ≥ 44px(h-11)", async () => {
    await renderPage();
    const btn = screen.getByRole("button", { name: /新增成員/ });
    expect(btn).toBeEnabled();
    expect(btn.className).toContain("h-11");
  });

  it("載入時,還沒接受邀請的成員標示「邀請中」;老闆看得到 email", async () => {
    await renderPage();

    const pendingRow = memberRow("李採購");
    expect(within(pendingRow).getByText("邀請中")).toBeInTheDocument();
    expect(within(pendingRow).getByText("pending@example.com")).toBeInTheDocument();
    expect(within(pendingRow).getByText(/邀請於/)).toBeInTheDocument();

    // 老闆看得到「連結過期怎麼辦」的說明
    expect(within(pendingRow).getByText(/忘記密碼/)).toBeInTheDocument();

    const mgrRow = memberRow("張店長");
    expect(within(mgrRow).queryByText("邀請中")).not.toBeInTheDocument();
    expect(within(mgrRow).queryByText(/忘記密碼/)).not.toBeInTheDocument();
    expect(h.rpc).toHaveBeenCalledWith("restaurant_member_directory", { p_restaurant: "rest-1" });
  });

  it("非老闆看得到「邀請中」,但看不到 email", async () => {
    setRole("manager", "u-mgr");
    await renderPage();

    const pendingRow = memberRow("李採購");
    expect(within(pendingRow).getByText("邀請中")).toBeInTheDocument();
    expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
    expect(within(pendingRow).queryByText(/忘記密碼/)).not.toBeInTheDocument();
  });

  it("開啟表單:角色預設「採購員」、分店預設老闆自己的分店,停用的分店不出現", async () => {
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    expect(within(dialog).getByRole("radio", { name: /採購員/ })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("radio", { name: /店長/ })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByRole("combobox", { name: "分店" })).toHaveTextContent("信義店");

    await user.click(within(dialog).getByRole("combobox", { name: "分店" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["全店(不限分店)", "總店", "信義店"]);
    // 手機點擊區 ≥ 44px
    for (const o of options) expect(o.className).toContain("min-h-11");
  });

  it("每位成員那一列都寫明「看得到什麼」:老闆看全部、店長看自己分店(含價格)、採購員只看品項與數量", async () => {
    await renderPage();
    expect(screen.getByTestId("visibility-acc-owner")).toHaveTextContent("看得到:所有分店的訂單、價格與報表");
    expect(screen.getByTestId("visibility-acc-mgr")).toHaveTextContent("看得到:「信義店」的訂單與價格;其他分店的看不到");
    expect(screen.getByTestId("visibility-acc-pending")).toHaveTextContent("看得到:「總店」的訂單,只看品項與數量,不顯示單價與金額");
  });

  it("沒指派分店(全店)的店長 / 採購員:說明看全部並提醒要指派", async () => {
    h.state.members = [
      member("acc-owner", "u-owner", "owner"),
      member("acc-mgr", "u-mgr", "manager", null),
      member("acc-pending", "u-pending", "purchaser", null),
    ];
    await renderPage();
    expect(screen.getByTestId("visibility-acc-mgr")).toHaveTextContent("所有分店的訂單與價格(還沒指派分店");
    expect(screen.getByTestId("visibility-acc-pending")).toHaveTextContent("建議指派分店");
  });

  it("新增成員的表單:選角色與分店時,即時說明這位成員看得到什麼", async () => {
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);
    // 預設:採購員 + 信義店
    expect(within(dialog).getByTestId("invite-visibility")).toHaveTextContent("「信義店」的訂單,只看品項與數量,不顯示單價與金額");
    await user.click(within(dialog).getByRole("radio", { name: /店長/ }));
    expect(within(dialog).getByTestId("invite-visibility")).toHaveTextContent("「信義店」的訂單與價格;其他分店的看不到");
    await user.click(within(dialog).getByRole("radio", { name: /老闆/ }));
    expect(within(dialog).getByTestId("invite-visibility")).toHaveTextContent("所有分店的訂單、價格與報表");
  });

  it("表單驗證:空白送出顯示錯誤,不會呼叫 Edge Function", async () => {
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    expect(within(dialog).getByText("請輸入 Email")).toBeInTheDocument();
    expect(within(dialog).getByText("請輸入姓名")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Email/)).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("表單驗證:Email 格式錯誤、姓名過長都擋在前端", async () => {
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText(/Email/), "not-an-email");
    // 51 個字用貼上的,不用一個字一個字打
    await user.click(within(dialog).getByLabelText(/姓名/));
    await user.paste("字".repeat(51));
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    expect(within(dialog).getByText("Email 格式不正確")).toBeInTheDocument();
    expect(within(dialog).getByText("姓名最多 50 個字")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    // 改正後錯誤訊息即消失
    await user.clear(within(dialog).getByLabelText(/Email/));
    await user.type(within(dialog).getByLabelText(/Email/), "ok@example.com");
    expect(within(dialog).queryByText("Email 格式不正確")).not.toBeInTheDocument();
  });

  it("送出成功:帶 token 呼叫 Edge Function,列表出現新成員並標「邀請中」", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          member: {
            id: "acc-new",
            user_id: "u-new",
            restaurant_id: "rest-1",
            branch_id: "br-2",
            role: "manager",
            is_active: true,
            accepted_at: null,
            created_at: "2026-09-28T07:00:00.000Z",
          },
          email: "new.staff@example.com",
          display_name: "陳新人",
          invite_pending: true,
        },
      }),
    );
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText(/Email/), "  New.Staff@Example.COM ");
    await user.type(within(dialog).getByLabelText(/姓名/), " 陳新人 ");
    await user.click(within(dialog).getByRole("radio", { name: /店長/ }));
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/invite-restaurant-member");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok-owner", apikey: "anon-key" });
    expect(JSON.parse(String(init.body))).toEqual({
      email: "new.staff@example.com",
      name: "陳新人",
      role: "manager",
      branch_id: "br-2",
      restaurant_id: "rest-1",
    });

    const newRow = memberRow("陳新人");
    expect(within(newRow).getByText("邀請中")).toBeInTheDocument();
    expect(within(newRow).getByText("new.staff@example.com")).toBeInTheDocument();
    expect(h.toastSuccess).toHaveBeenCalledWith(
      "已寄出邀請信給 陳新人",
      expect.objectContaining({ description: expect.stringContaining("new.staff@example.com") }),
    );
  });

  it("該店沒有分店時不顯示分店欄位,branch_id 送 null", async () => {
    h.state.branches = [];
    h.state.account = { ...h.state.account, branch_id: null };
    h.state.members = h.state.members.map((m) => ({ ...(m as object), branch_id: null }));
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          member: { ...member("acc-new", "u-new", "purchaser", null, null) },
          email: "a@example.com",
          display_name: "阿明",
          invite_pending: true,
        },
      }),
    );
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    expect(within(dialog).queryByRole("combobox", { name: "分店" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Email/), "a@example.com");
    await user.type(within(dialog).getByLabelText(/姓名/), "阿明");
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ role: "purchaser", branch_id: null });
  });

  it("伺服器回 409(Email 已有帳號):錯誤顯示在 Email 欄位下,對話框不關、列表不變", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: "EMAIL_TAKEN",
        message: "這個 Email 已經註冊過 iFoodmap 帳號,無法直接加入。請改用其他 Email,或聯絡平台客服協助",
        field: "email",
      }),
    );
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText(/Email/), "supplier@example.com");
    await user.type(within(dialog).getByLabelText(/姓名/), "王供應");
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    expect(await within(dialog).findByText(/已經註冊過 iFoodmap 帳號/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Email/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "新增成員" })).toBeInTheDocument();
    expect(screen.queryByText("王供應")).not.toBeInTheDocument();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("伺服器回 403 / 網路失敗:顯示清楚的一般錯誤訊息", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "NOT_OWNER", message: "只有老闆可以新增成員" }));
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);

    await user.type(within(dialog).getByLabelText(/Email/), "x@example.com");
    await user.type(within(dialog).getByLabelText(/姓名/), "小明");
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("只有老闆可以新增成員");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("連線失敗,請檢查網路後再試一次");
  });

  it("登入過期(沒有 session)時不呼叫 Edge Function", async () => {
    const user = setupUser();
    await renderPage();
    const dialog = await openInviteDialog(user);
    h.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    await user.type(within(dialog).getByLabelText(/Email/), "x@example.com");
    await user.type(within(dialog).getByLabelText(/姓名/), "小明");
    await user.click(within(dialog).getByRole("button", { name: /寄出邀請/ }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("登入已過期");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["回傳 error", () => h.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } })],
    ["直接丟例外", () => h.rpc.mockRejectedValue(new Error("network down"))],
  ])("email 查詢失敗(%s)時頁面照常運作:「邀請中」照樣依 accepted_at 標示,只是沒有 email", async (_label, arrange) => {
    arrange();
    await renderPage();

    const pendingRow = memberRow("李採購");
    expect(within(pendingRow).getByText("邀請中")).toBeInTheDocument();
    expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
    expect(within(memberRow("張店長")).queryByText("邀請中")).not.toBeInTheDocument();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("「邀請中」只看成員列的 accepted_at:已接受的人不標、還沒接受的人一定標", async () => {
    // directory 的舊判斷(有沒有點過信)跟 accepted_at 不一致時,以 accepted_at 為準
    h.state.directory = [
      { user_id: "u-owner", email: "owner@example.com", invited_at: null, invite_pending: false },
      { user_id: "u-mgr", email: "mgr@example.com", invited_at: "2026-09-01T02:00:00Z", invite_pending: true },
      { user_id: "u-pending", email: "pending@example.com", invited_at: "2026-09-01T02:00:00Z", invite_pending: false },
    ];
    await renderPage();

    expect(within(memberRow("張店長")).queryByText("邀請中")).not.toBeInTheDocument();
    const pendingRow = memberRow("李採購");
    expect(within(pendingRow).getByText("邀請中")).toBeInTheDocument();
    expect(within(pendingRow).getByText(/按「接受」才會加入/)).toBeInTheDocument();
  });
});
