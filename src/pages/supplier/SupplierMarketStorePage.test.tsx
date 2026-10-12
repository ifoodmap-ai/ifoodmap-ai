// 供應商「店家設定」:讀既有設定、驗證錯誤顯示在欄位旁(aria-invalid)、儲存、被停用時顯示原因。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SupplierState = { supplierId: string | null; loading: boolean; error: string | null; reload: () => void };
const { toastError, toastSuccess, supplier } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  /** null = 預設(已登入的 A 店);個別測試換成讀不到供應商帳號的狀態 */
  supplier: { current: null as SupplierState | null },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/hooks/use-current-supplier", () => ({
  useCurrentSupplier: () =>
    supplier.current ?? { supplierId: "a9200000-0000-4000-8000-00000000000a", loading: false, error: null, reload: () => {} },
}));
vi.mock("@/lib/market/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/store")>()),
  fetchOwnStore: vi.fn(),
  saveStore: vi.fn(),
}));
vi.mock("@/lib/market/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/images")>()),
  uploadMarketImage: vi.fn(),
}));

import { uploadMarketImage } from "@/lib/market/images";
import { MarketDbError } from "@/lib/market/db";
import { fetchOwnStore, MarketPartialSaveError, MarketStaleError, saveStore } from "@/lib/market/store";
import { STORE_A as STORE_A_BASE } from "@/lib/market/testFixtures";
import type { MarketStoreRow } from "@/lib/market/types";
import SupplierMarketStorePage from "./SupplierMarketStorePage";

/** 法定資訊都填好的 A 店(testFixtures 的 STORE_A 沒有這些欄位:migration 20261012110000 才加) */
const STORE_A: MarketStoreRow = {
  ...STORE_A_BASE,
  legal_name: "市集測試 A 店有限公司",
  representative: "王小明",
  business_address: "臺北市測試路 1 號",
  service_email: "service-a@example.com",
};
/** 供應商資料的電話(suppliers.phone) */
const PHONE = "02-2345-6789";

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierMarketStorePage />
    </MemoryRouter>,
  );

/** 新店家:照畫面把四項法定資訊填好 */
const fillLegal = async () => {
  await userEvent.type(await screen.findByLabelText("登記名稱 *"), "新店家商行");
  await userEvent.type(screen.getByLabelText("負責人 *"), "林小華");
  await userEvent.type(screen.getByLabelText("營業所地址 *"), "新竹市測試路 3 號");
  await userEvent.type(screen.getByLabelText("客服 Email *"), "service@example.com");
};

beforeEach(() => {
  supplier.current = null;
  vi.mocked(fetchOwnStore).mockResolvedValue({ store: null, transferInfo: null, supplierPhone: PHONE });
  vi.mocked(saveStore).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("SupplierMarketStorePage", () => {
  it("還沒建店:沒選縣市就儲存 → 縣市欄位顯示錯誤,不會送出", async () => {
    renderPage();
    await fillLegal();
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
    await fillLegal();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.clear(screen.getByLabelText("固定運費(元)"));
    await userEvent.type(screen.getByLabelText("固定運費(元)"), "120");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveStore).mock.calls[0][1]).toMatchObject({
      deliveryCities: ["臺北市"],
      shippingFee: "120",
      acceptCod: true,
      legalName: "新店家商行",
      representative: "林小華",
      businessAddress: "新竹市測試路 3 號",
      serviceEmail: "service@example.com",
    });
    expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定");
  });

  it("已有設定就帶入;被平台停用時顯示原因", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({
      store: { ...STORE_A, is_enabled: false, disabled_reason: "客訴處理中" },
      transferInfo: "台灣銀行 004 帳號 123",
      supplierPhone: PHONE,
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
      .mockResolvedValueOnce({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
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
    expect(await screen.findByRole("alert")).toHaveTextContent("讀取店家設定失敗:請稍後再試");
    expect(document.querySelector("form")).toBeNull();
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("按「重新載入」重抓期間只顯示載入中,不會露出空白表單", async () => {
    let finish: (v: Awaited<ReturnType<typeof fetchOwnStore>>) => void = () => {};
    vi.mocked(fetchOwnStore)
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce(() => new Promise((r) => (finish = r)));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "重新載入" }));
    expect(fetchOwnStore).toHaveBeenCalledTimes(2);
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "儲存店家設定" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    finish({ store: STORE_A, transferInfo: null, supplierPhone: PHONE });
    expect(await screen.findByLabelText("新北市")).toBeChecked();
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

describe("SupplierMarketStorePage — 版面", () => {
  it("勾選框不會被換行的長文字壓小(390 寬時「銀行轉帳」那行會換行):每個勾選框都 shrink-0", async () => {
    renderPage();
    expect(await screen.findByLabelText(/銀行轉帳/)).toHaveClass("shrink-0");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(24); // 22 縣市 + 貨到付款 + 銀行轉帳
    boxes.forEach((box) => expect(box).toHaveClass("h-5", "w-5", "shrink-0"));
  });

  it("logo / 封面的選檔欄位可點範圍至少 44px 高(欄位本身與裡面的選檔按鈕都 min-h-11)", async () => {
    renderPage();
    for (const label of ["店家 logo", "店家封面"]) {
      const input = await screen.findByLabelText(label);
      expect(input).toHaveAttribute("type", "file");
      expect(input).toHaveClass("min-h-11", "file:min-h-11");
    }
  });
});

describe("SupplierMarketStorePage — 勾選框的錯誤標示", () => {
  it("沒選縣市:每個縣市勾選框都標 aria-invalid、指到錯誤訊息;沒出錯前不標", async () => {
    renderPage();
    const taipei = await screen.findByLabelText("臺北市");
    expect(taipei).not.toHaveAttribute("aria-invalid", "true");
    expect(taipei).not.toHaveAttribute("aria-describedby");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await screen.findByText("至少選一個配送縣市");
    for (const city of ["臺北市", "高雄市", "連江縣"]) {
      expect(screen.getByLabelText(city)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(city)).toHaveAttribute("aria-describedby", "store-deliveryCities-error");
    }
    // 付款方式沒出錯,不標
    expect(screen.getByLabelText("貨到付款")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("付款方式都沒勾:兩個付款勾選框都標 aria-invalid、指到錯誤訊息", async () => {
    renderPage();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.click(screen.getByLabelText("貨到付款"));
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await screen.findByText("至少接受一種付款方式");
    for (const label of ["貨到付款", /銀行轉帳/]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-describedby", "store-acceptCod-error");
    }
    expect(screen.getByLabelText("臺北市")).not.toHaveAttribute("aria-invalid", "true");
    expect(saveStore).not.toHaveBeenCalled();
  });
});

// 資料庫的 market_stores_guard 會把縣市照官方順序排好、介紹 / 退換貨說明去掉頭尾空白;
// 轉帳資訊由 market_store_transfer_touch 去掉頭尾空白。儲存成功後畫面要換成資料庫的值,下一次存的才不會跟資料庫不一致。
describe("SupplierMarketStorePage — 儲存成功後換成資料庫整理過的值", () => {
  it("縣市照官方順序、介紹去掉頭尾空白;再存一次送出的就是資料庫的值", async () => {
    vi.mocked(saveStore).mockResolvedValue({
      ...STORE_A,
      intro: "當日採收",
      return_policy: null,
      delivery_cities: ["臺北市", "新北市"],
      payment_methods: ["cod"],
    });
    renderPage();
    await fillLegal();
    await userEvent.click(await screen.findByLabelText("新北市"));
    await userEvent.click(screen.getByLabelText("臺北市"));
    await userEvent.type(screen.getByLabelText("店家介紹"), "  當日採收  ");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveStore).mock.calls[0][1]).toMatchObject({ deliveryCities: ["新北市", "臺北市"], intro: "  當日採收  " });

    await waitFor(() => expect(screen.getByLabelText("店家介紹")).toHaveValue("當日採收"));
    expect(screen.getByLabelText("固定運費(元)")).toHaveValue(String(STORE_A.shipping_fee));
    expect(screen.getByRole("link", { name: "看消費者看到的店家頁" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveStore).mock.calls[1][1]).toMatchObject({ deliveryCities: ["臺北市", "新北市"], intro: "當日採收" });
  });

  it("轉帳資訊存的是去掉頭尾空白的值,畫面也換成那個值", async () => {
    renderPage();
    await fillLegal();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    await userEvent.type(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)"), "  台灣銀行 004 帳號 123  ");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("台灣銀行 004 帳號 123"));
  });

  it("取消勾轉帳再存:轉帳資訊沒有存(資料庫還是舊的),再勾回來看到的是資料庫裡的值", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    vi.mocked(saveStore).mockResolvedValue({ ...STORE_A, payment_methods: ["cod"] });
    renderPage();
    const info = await screen.findByLabelText("轉帳資訊(銀行、分行、帳號、戶名)");
    await userEvent.clear(info);
    await userEvent.type(info, "改過但沒有存的帳號");
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText(/銀行轉帳/)).not.toBeChecked());
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("台灣銀行 004 帳號 123");
  });
});

// 審查重現的三種情況(review1922/race.log):上傳中按儲存、儲存中繼續編輯,資料會亂掉。
// 修法:照片上傳中儲存鈕停用並說明原因;儲存中用 <fieldset disabled> 鎖住所有欄位。
describe("SupplierMarketStorePage — 上傳、儲存同時發生", () => {
  const NEW_LOGO = "a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-0000000000ff.jpg";
  const jpg = () => new File(["x"], "a.jpg", { type: "image/jpeg" });
  const pendingUpload = () => {
    const ctl = { finish: (_p: string) => {} };
    vi.mocked(uploadMarketImage).mockImplementation(() => new Promise<string>((r) => (ctl.finish = r)));
    return ctl;
  };

  beforeEach(() => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
  });

  it("A. 上傳中按儲存、上傳先完成:儲存鈕停用並說明原因、按了不會送出;新 logo 不會被蓋回舊值,上傳完才存得進去", async () => {
    const upload = pendingUpload();
    vi.mocked(saveStore).mockImplementation(async (_s, f) => ({ ...STORE_A, logo_path: f.logoPath }));
    renderPage();
    await userEvent.upload(await screen.findByLabelText("店家 logo"), jpg());
    const save = screen.getByRole("button", { name: "儲存店家設定" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("照片上傳中,上傳完成才能儲存");
    await userEvent.click(save);
    expect(saveStore).not.toHaveBeenCalled();

    upload.finish(NEW_LOGO);
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.queryByText("照片上傳中,上傳完成才能儲存")).toBeNull();
    expect(screen.getByAltText("目前的店家 logo").getAttribute("src")).toContain("a9900000-0000-4000-8000-0000000000ff.jpg");
    await userEvent.click(save);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定"));
    expect(vi.mocked(saveStore).mock.calls[0][1].logoPath).toBe(NEW_LOGO);
    expect(screen.getByAltText("目前的店家 logo").getAttribute("src")).toContain("a9900000-0000-4000-8000-0000000000ff.jpg");
  });

  it("B. 上傳中按儲存、儲存原本會先回來:不會先跳「已儲存」再冒出資料庫沒有的新 logo", async () => {
    const upload = pendingUpload();
    vi.mocked(saveStore).mockResolvedValue({ ...STORE_A });
    renderPage();
    await userEvent.upload(await screen.findByLabelText("店家封面"), jpg());
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    upload.finish(NEW_LOGO.replace("ff.jpg", "fe.jpg"));
    expect(await screen.findByAltText("目前的店家封面")).toBeInTheDocument();
    expect(saveStore).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "儲存店家設定" })).toBeEnabled();
  });

  it("logo 跟封面同時上傳:先完成一張還是不能存,兩張都完成才能存", async () => {
    const finishes: Array<(p: string) => void> = [];
    vi.mocked(uploadMarketImage).mockImplementation(() => new Promise<string>((r) => finishes.push(r)));
    renderPage();
    await userEvent.upload(await screen.findByLabelText("店家 logo"), jpg());
    await userEvent.upload(screen.getByLabelText("店家封面"), jpg());
    const save = screen.getByRole("button", { name: "儲存店家設定" });
    expect(finishes).toHaveLength(2);
    finishes[0](NEW_LOGO);
    expect(await screen.findByAltText("目前的店家 logo")).toBeInTheDocument();
    expect(save).toBeDisabled();
    finishes[1](NEW_LOGO.replace("ff.jpg", "fe.jpg"));
    await waitFor(() => expect(save).toBeEnabled());
  });

  it("C. 儲存中不能繼續編輯:所有欄位鎖住(打字無效),存完才解鎖、換成資料庫的值", async () => {
    let finishSave: (r: MarketStoreRow) => void = () => {};
    vi.mocked(saveStore).mockImplementation(() => new Promise((r) => (finishSave = r)));
    renderPage();
    const intro = await screen.findByLabelText("店家介紹");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    expect(screen.getByRole("button", { name: "儲存中…" })).toBeDisabled();
    expect(intro).toBeDisabled();
    expect(screen.getByLabelText("臺北市")).toBeDisabled();
    expect(screen.getByLabelText("店家 logo")).toBeDisabled();
    expect(screen.getByLabelText("固定運費(元)")).toBeDisabled();
    await userEvent.type(intro, "補一句");
    expect(intro).toHaveValue(STORE_A.intro);

    finishSave({ ...STORE_A, intro: "資料庫裡的介紹" });
    await waitFor(() => expect(intro).toBeEnabled());
    expect(intro).toHaveValue("資料庫裡的介紹");
    expect(saveStore).toHaveBeenCalledTimes(1);
  });
});

// 兩個分頁、兩位同事同時改:更新時比對讀到的 updated_at(原字串),對不上就不覆寫。
describe("SupplierMarketStorePage — 不蓋掉別人的修改", () => {
  const READ_AT = "2026-10-10T07:00:00.123456+00:00";
  const SAVED_AT = "2026-10-10T07:05:00.654321+00:00";

  it("更新時把讀到的 updated_at 原字串與轉帳資訊交給 saveStore;存完下一次用資料庫回的新 updated_at", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: { ...STORE_A, updated_at: READ_AT }, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    vi.mocked(saveStore).mockResolvedValue({ ...STORE_A, updated_at: SAVED_AT });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定"));
    expect(vi.mocked(saveStore).mock.calls[0][2]).toEqual({ updatedAt: READ_AT, transferInfo: "台灣銀行 004 帳號 123" });

    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveStore).mock.calls[1][2]).toEqual({ updatedAt: SAVED_AT, transferInfo: "台灣銀行 004 帳號 123" });
  });

  it("還沒建店:saveStore 拿到 updatedAt null(第一次建立)", async () => {
    renderPage();
    await fillLegal();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveStore).mock.calls[0][2]).toEqual({ updatedAt: null, transferInfo: null });
  });

  it("資料已被其他人更新:顯示訊息與「重新載入」,表單保留剛改的(不覆寫);重新載入才換成資料庫的值", async () => {
    vi.mocked(fetchOwnStore)
      .mockResolvedValueOnce({ store: { ...STORE_A, updated_at: READ_AT }, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE })
      .mockResolvedValueOnce({ store: { ...STORE_A, intro: "同事改過的介紹", updated_at: SAVED_AT }, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    vi.mocked(saveStore).mockRejectedValue(new MarketStaleError());
    renderPage();
    const intro = await screen.findByLabelText("店家介紹");
    await userEvent.clear(intro);
    await userEvent.type(intro, "我改的介紹");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("資料已被其他人更新,請重新載入後再改");
    expect(intro).toHaveValue("我改的介紹");
    expect(toastSuccess).not.toHaveBeenCalled();

    await userEvent.click(within(alert).getByRole("button", { name: "重新載入" }));
    await waitFor(() => expect(screen.getByLabelText("店家介紹")).toHaveValue("同事改過的介紹"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchOwnStore).toHaveBeenCalledTimes(2);
  });
});

// 只存好一部分:訊息講清楚哪一部分存好,狀態跟資料庫一致(不會之後把舊帳號帶回表單)。
describe("SupplierMarketStorePage — 只存好一部分", () => {
  const READ_AT = "2026-10-10T07:00:00.123456+00:00";
  const SAVED_AT = "2026-10-10T07:05:00.654321+00:00";
  const checkFailed = () => new MarketDbError({ message: "check", code: "23514" });

  it("轉帳資訊存好、店家沒存到:訊息講清楚;之後存檔用資料庫裡的新轉帳資訊,取消勾轉帳再勾回來看到的也是新的", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: { ...STORE_A, payment_methods: ["cod"], updated_at: READ_AT }, transferInfo: null, supplierPhone: PHONE });
    vi.mocked(saveStore)
      .mockRejectedValueOnce(new MarketPartialSaveError("transfer", null, "新帳號 2222", checkFailed()))
      .mockResolvedValueOnce({ ...STORE_A, payment_methods: ["cod"], updated_at: SAVED_AT });
    renderPage();
    await userEvent.click(await screen.findByLabelText(/銀行轉帳/));
    await userEvent.type(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)"), "新帳號 2222");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("只存好一部分", {
        description: "轉帳資訊已儲存,但店家設定(配送、付款等)沒有存到:有欄位超過長度上限或格式不對,請檢查後再送出",
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();

    // 取消勾轉帳再存:這次 saveStore 拿到的是資料庫裡的新轉帳資訊;存完勾回來看到的也是它(不是原本的空白)
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveStore).mock.calls[1][2]).toEqual({ updatedAt: READ_AT, transferInfo: "新帳號 2222" });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定"));
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("新帳號 2222");
  });

  it("店家存好、轉帳資訊沒存到:訊息講清楚;店家換成資料庫的值、下次用新的 updated_at,轉帳資訊保留剛打的、資料庫的舊帳號記錄不變", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: { ...STORE_A, updated_at: READ_AT }, transferInfo: "舊帳號 1111", supplierPhone: PHONE });
    vi.mocked(saveStore)
      .mockRejectedValueOnce(
        new MarketPartialSaveError("store", { ...STORE_A, intro: "資料庫的介紹", updated_at: SAVED_AT }, null, checkFailed()),
      )
      .mockResolvedValueOnce({ ...STORE_A, updated_at: "2026-10-10T07:09:00.000001+00:00" });
    renderPage();
    const info = await screen.findByLabelText("轉帳資訊(銀行、分行、帳號、戶名)");
    await userEvent.clear(info);
    await userEvent.type(info, "新帳號 2222");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("只存好一部分", {
        description:
          "店家設定已儲存,但轉帳資訊沒有存到:有欄位超過長度上限或格式不對,請檢查後再送出。消費者看到的仍是原本的轉帳資訊,請再按一次儲存。",
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("店家介紹")).toHaveValue("資料庫的介紹"));
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("新帳號 2222");

    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveStore).mock.calls[1][2]).toEqual({ updatedAt: SAVED_AT, transferInfo: "舊帳號 1111" });
  });
});

// 錯誤原文(TypeError: Failed to fetch、PostgREST 英文訊息)不直接顯示:走 db.ts 的中文轉換,而且可以重試。
describe("SupplierMarketStorePage — 錯誤訊息轉中文、可以重試", () => {
  it("讀不到供應商帳號:顯示中文原因與「重新載入」,按了會重查(不顯示表單)", async () => {
    const reload = vi.fn();
    supplier.current = { supplierId: null, loading: false, error: "連線失敗,請檢查網路後再試一次", reload };
    renderPage();
    expect(screen.getByRole("heading", { name: "店家設定" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("連線失敗,請檢查網路後再試一次");
    expect(document.querySelector("form")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchOwnStore).not.toHaveBeenCalled();
  });

  it("讀取店家設定時資料庫回英文錯誤:顯示中文 + 錯誤代碼,不顯示原文", async () => {
    vi.mocked(fetchOwnStore).mockRejectedValue(new MarketDbError({ message: "JWT expired", code: "PGRST301" }));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("讀取店家設定失敗:請稍後再試(錯誤代碼 PGRST301)");
    expect(alert).not.toHaveTextContent("JWT");
  });

  it("儲存時資料庫回英文錯誤:toast 顯示中文 + 錯誤代碼,不顯示原文", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    vi.mocked(saveStore).mockRejectedValue(new MarketDbError({ message: "Could not find the 'x' column", code: "PGRST204" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "請稍後再試(錯誤代碼 PGRST204)" }));
  });
});

// 法規查證 M6、S4:店家法定資訊(登記名稱、負責人、營業所地址、客服 Email 必填;食品業者登錄字號、產品責任險選填)
// 加上供應商資料的電話,沒填齊就不能開放零售(資料庫擋成 store_disclosure_missing);退換貨說明的例句不能寫「24 小時內」。
describe("SupplierMarketStorePage — 店家法定資訊", () => {
  it("法定資訊一區在最上面:四項必填、兩項選填,maxLength 跟資料庫一樣;店家電話顯示供應商資料的電話(這頁改不了)", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: null, supplierPhone: PHONE });
    renderPage();
    expect(await screen.findByLabelText("登記名稱 *")).toHaveValue("市集測試 A 店有限公司");
    expect(screen.getByLabelText("登記名稱 *")).toHaveAttribute("maxLength", "100");
    expect(screen.getByLabelText("負責人 *")).toHaveAttribute("maxLength", "50");
    expect(screen.getByLabelText("營業所地址 *")).toHaveAttribute("maxLength", "200");
    expect(screen.getByLabelText("客服 Email *")).toHaveAttribute("maxLength", "254");
    expect(screen.getByLabelText("客服 Email *")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("食品業者登錄字號(選填)")).toHaveAttribute("maxLength", "40");
    expect(screen.getByLabelText("產品責任險(選填)")).toHaveAttribute("maxLength", "100");
    const phone = screen.getByText(PHONE);
    expect(phone.closest("[data-store-phone]")).toHaveTextContent("要改請聯絡 iFoodmap");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)[0]).toBe("店家法定資訊(消費者在店家頁看得到)");
    // 都填齊、有電話:不顯示「還缺」
    expect(screen.queryByRole("region", { name: "開放零售前還缺這些資料" })).toBeNull();
  });

  it("沒填齊:最上面列出還缺哪幾項(含供應商電話);存的時候四項沒填會擋並標出欄位;填好的就不再列", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A_BASE, transferInfo: null, supplierPhone: null });
    renderPage();
    const missing = await screen.findByRole("region", { name: "開放零售前還缺這些資料" });
    expect(missing).toHaveTextContent("還缺:登記名稱、負責人、營業所地址、客服 Email、店家電話");
    expect(missing).toHaveTextContent("店家電話來自你的供應商資料,這頁改不了,請聯絡 iFoodmap(ifoodmaptw@gmail.com)補上");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    expect(saveStore).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("有欄位需要修正", { description: "請填登記名稱(公司或商號登記的名稱)" });
    expect(screen.getByLabelText("登記名稱 *")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("客服 Email *")).toHaveAttribute("aria-describedby", expect.stringContaining("store-serviceEmail-error"));
    await userEvent.type(screen.getByLabelText("登記名稱 *"), "市集測試 A 店有限公司");
    await userEvent.type(screen.getByLabelText("負責人 *"), "王小明");
    expect(missing).toHaveTextContent("還缺:營業所地址、客服 Email、店家電話");
  });

  it("客服 Email 格式不對、地址太短:照資料庫的規則擋下,不會送出", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({
      store: { ...STORE_A, service_email: "not-an-email", business_address: "臺北1號" },
      transferInfo: null,
      supplierPhone: PHONE,
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    expect(await screen.findByText("客服 Email 格式不對")).toBeInTheDocument();
    expect(screen.getByText("營業所地址要 5–200 字")).toBeInTheDocument();
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("資料庫回 store_disclosure_missing(供應商電話只有空白):中文訊息列出缺哪一項,說明要請 iFoodmap 補", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: "\u{3000}" });
    vi.mocked(saveStore).mockRejectedValue(new MarketDbError({ message: "店家資料不完整", code: "22023", hint: "store_disclosure_missing" }));
    renderPage();
    expect(await screen.findByRole("region", { name: "開放零售前還缺這些資料" })).toHaveTextContent("還缺:店家電話");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("儲存失敗", {
        description: "開放零售前要填齊店家法定資訊,還缺:店家電話。店家電話來自你的供應商資料,這頁改不了,請聯絡 iFoodmap(ifoodmaptw@gmail.com)補上。",
      }),
    );
  });

  it("資料庫說缺、畫面上卻都填了(例如別的分頁剛改過):顯示資料庫那句的中文", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    vi.mocked(saveStore).mockRejectedValue(new MarketDbError({ message: "x", code: "22023", hint: "store_disclosure_missing" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("儲存失敗", {
        description: "開放零售前要填齊店家法定資訊:登記名稱、負責人、營業所地址、客服 Email,以及供應商資料的電話",
      }),
    );
  });

  it("退換貨說明的例句不再寫「24 小時內」;提醒不能寫限制消費者權益的字句,不適用七日鑑賞期要在商品上勾", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: null, supplierPhone: PHONE });
    renderPage();
    const policy = await screen.findByLabelText("退換貨說明");
    expect(policy).toHaveAttribute("placeholder", "例:商品有瑕疵或與訂購內容不符,請拍照聯絡我們,我們會盡快處理換貨或退款。");
    expect(policy.getAttribute("placeholder")).not.toMatch(/24 小時/);
    expect(policy).toHaveAccessibleDescription(
      "不能寫「恕不退換」「退貨運費自付」這類限制消費者權益的字句。不適用七日鑑賞期的商品,請在商品上逐項勾選。",
    );
  });
});

describe("SupplierMarketStorePage — 無障礙", () => {
  it("數字欄位出錯時,提示文字還在 aria-describedby 裡(跟錯誤訊息一起)", async () => {
    renderPage();
    const fee = await screen.findByLabelText("固定運費(元)");
    expect(fee).toHaveAccessibleDescription("0 = 免運費");
    await userEvent.clear(fee);
    await userEvent.type(fee, "abc");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await screen.findByText("運費要是 0 到 10,000 的整數");
    expect(fee).toHaveAttribute("aria-invalid", "true");
    expect(fee).toHaveAccessibleDescription("0 = 免運費 運費要是 0 到 10,000 的整數");
  });

  it("「看消費者看到的店家頁」連結的可點範圍至少 44px 高", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: PHONE });
    renderPage();
    expect(await screen.findByRole("link", { name: "看消費者看到的店家頁" })).toHaveClass("inline-flex", "min-h-11", "items-center");
  });

  it("載入中:有 role=status 與「載入中」文字(圖示本身對螢幕報讀隱藏)", async () => {
    vi.mocked(fetchOwnStore).mockImplementation(() => new Promise(() => {}));
    renderPage();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("載入中");
    expect(status.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
