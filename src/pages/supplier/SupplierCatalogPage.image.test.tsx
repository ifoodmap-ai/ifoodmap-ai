// 商品目錄(批發商品):新增 / 編輯商品時可以上傳、更換、移除圖片;列表每列顯示縮圖。
// supabase 與圖片上傳換成記憶體假資料,零售市集的部分換成空殼(它們另有測試)。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierCatalogPage from "./SupplierCatalogPage";

const SUP = "10000000-0000-0000-0000-00000000000a";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const { state, toast, upload } = vi.hoisted(() => ({
  state: {
    supplies: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
    updates: [] as { values: Record<string, unknown>; filters: [string, unknown][] }[],
  },
  toast: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: (table: string) => {
      let mode: "select" | "insert" | "update" = "select";
      let values: Record<string, unknown> = {};
      const filters: [string, unknown][] = [];
      const result = () => {
        if (mode === "insert") { state.inserts.push(values); return { data: null, error: null }; }
        if (mode === "update") { state.updates.push({ values, filters }); return { data: null, error: null }; }
        if (table === "supplier_accounts") return { data: { supplier_id: SUP }, error: null };
        if (table === "supplies") return { data: state.supplies, error: null };
        return { data: [], error: null };
      };
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        order: () => b,
        insert: (v: Record<string, unknown>) => { mode = "insert"; values = v; return b; },
        update: (v: Record<string, unknown>) => { mode = "update"; values = v; return b; },
        delete: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(a, r),
      };
      return b;
    },
  },
}));
vi.mock("@/lib/supply-images", async (orig) => ({ ...(await orig<typeof import("@/lib/supply-images")>()), uploadSupplyImage: upload }));
vi.mock("./market/useSupplierMarketProducts", () => ({
  useSupplierMarketProducts: () => ({
    products: [], loading: false, error: null, hasStore: false, storeOpen: false, storeClosedReason: null,
    retry: vi.fn(), reload: vi.fn(), applySaved: vi.fn(),
  }),
}));
vi.mock("./market/MarketProductDialog", () => ({ default: () => null }));
vi.mock("./market/SupplierMarketProductsPanel", () => ({ default: () => null, statusText: () => "" }));

const ITEM = "40000000-0000-0000-0000-000000000001";

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.supplies = [
    { id: ITEM, name: "高麗菜", category: "蔬菜", sku: null, unit: "kg", pack_size: null, price: 45, currency: "TWD", description: null, is_available: true, image_path: `${SUP}/${ITEM}/${FILE}.jpg` },
    { id: "40000000-0000-0000-0000-000000000002", name: "洋蔥", category: "蔬菜", sku: null, unit: "kg", pack_size: null, price: 38, currency: "TWD", description: null, is_available: true, image_path: null },
  ];
  state.inserts = [];
  state.updates = [];
  toast.mockReset();
  upload.mockReset();
  upload.mockImplementation(async (supplierId: string, supplyId: string) => `${supplierId}/${supplyId}/${FILE}.jpg`);
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const renderPage = () => render(<MemoryRouter><SupplierCatalogPage /></MemoryRouter>);
const photo = () => new File([new Uint8Array([1, 2, 3])], "cabbage.jpg", { type: "image/jpeg" });

describe("SupplierCatalogPage — 商品圖片", () => {
  it("列表每列顯示縮圖:有圖片的是 _t 縮圖,沒有的是品名第一個字的佔位", async () => {
    renderPage();
    const row = (await screen.findByText("高麗菜")).closest("tr")!;
    expect(within(row).getByRole("img", { name: "高麗菜" }).getAttribute("src")).toContain(`/${SUP}/${ITEM}/${FILE}_t.jpg`);

    const other = screen.getByText("洋蔥").closest("tr")!;
    expect(within(other).queryByRole("img")).toBeNull();
    expect(other).toHaveTextContent("洋");
  });

  it("新增商品:先選圖片上傳到 <供應商>/<新商品 id>/,存檔時用同一個 id 與圖片路徑建立", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /新增商品/ }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByPlaceholderText("例:牛腱心"), "牛腱心");
    await user.upload(within(dialog).getByLabelText("選擇商品圖片"), photo());
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    const [supplierId, productId, file] = upload.mock.calls[0];
    expect(supplierId).toBe(SUP);
    expect(productId).toMatch(/^[0-9a-f-]{36}$/);
    expect(file.name).toBe("cabbage.jpg");
    expect(await within(dialog).findByRole("button", { name: "更換圖片" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(state.inserts).toHaveLength(1));
    expect(state.inserts[0]).toMatchObject({
      id: productId, supplier_id: SUP, name: "牛腱心", image_path: `${SUP}/${productId}/${FILE}.jpg`,
    });
  });

  it("新增商品不傳圖片也能存:image_path 是 null", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /新增商品/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("例:牛腱心"), "豬五花");
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.inserts).toHaveLength(1));
    expect(state.inserts[0]).toMatchObject({ name: "豬五花", image_path: null });
  });

  it("編輯:更換圖片用既有商品 id 上傳,存檔更新 image_path", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("高麗菜")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "編輯" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "更換圖片" })).toBeInTheDocument();

    await user.upload(within(dialog).getByLabelText("選擇商品圖片"), photo());
    await waitFor(() => expect(upload).toHaveBeenCalledWith(SUP, ITEM, expect.any(File)));
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0].filters).toContainEqual(["id", ITEM]);
    expect(state.updates[0].values).toMatchObject({ image_path: `${SUP}/${ITEM}/${FILE}.jpg` });
  });

  it("編輯:移除圖片存檔後 image_path 變成 null", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("高麗菜")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "編輯" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "移除圖片" }));
    expect(within(dialog).getByRole("button", { name: "上傳圖片" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0].values).toMatchObject({ image_path: null });
  });

  it("上傳失敗:顯示原因、不改圖片,仍可存檔其他欄位", async () => {
    upload.mockRejectedValueOnce(new Error("只收 JPG、PNG、WebP 照片"));
    const user = userEvent.setup();
    renderPage();
    const row = (await screen.findByText("洋蔥")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "編輯" }));
    const dialog = await screen.findByRole("dialog");

    await user.upload(within(dialog).getByLabelText("選擇商品圖片"), new File(["x"], "a.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "圖片上傳失敗", description: "只收 JPG、PNG、WebP 照片" })));
    expect(within(dialog).getByRole("button", { name: "上傳圖片" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0].values).toMatchObject({ image_path: null });
  });
});
