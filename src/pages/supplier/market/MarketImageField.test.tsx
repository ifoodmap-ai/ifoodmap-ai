// 單張圖片欄位(店家 logo、封面):上傳成功 / 上傳中 / 上傳失敗三種狀態,以及「移除」只是從表單拿掉路徑。
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import MarketImageField from "./MarketImageField";

const SUP = "a9200000-0000-4000-8000-00000000000a";
const OLD = `${SUP}/store/a9900000-0000-4000-8000-000000000001.jpg`;
const NEW = `${SUP}/store/a9900000-0000-4000-8000-000000000002.jpg`;
const photo = () => new File(["x"], "logo.png", { type: "image/png" });

type Upload = (supplierId: string, folder: string, file: File) => Promise<string>;

const Harness = ({
  upload,
  initial = null,
  onBusyChange,
}: {
  upload: Upload;
  initial?: string | null;
  onBusyChange?: (busy: boolean) => void;
}) => {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <MarketImageField
        label="店家 logo"
        hint="正方形最好看"
        supplierId={SUP}
        value={value}
        onChange={setValue}
        upload={upload}
        onBusyChange={onBusyChange}
      />
      <p data-testid="value">{value ?? "(空)"}</p>
    </>
  );
};

afterEach(cleanup);

describe("MarketImageField", () => {
  it("上傳成功:傳到 <供應商>/store/,表單拿到新路徑、顯示新圖", async () => {
    const upload = vi.fn<Upload>().mockResolvedValue(NEW);
    render(<Harness upload={upload} initial={OLD} />);
    const file = photo();
    await userEvent.upload(screen.getByLabelText("店家 logo"), file);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent(NEW));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(SUP, "store", file);
    expect(screen.getByAltText("目前的店家 logo").getAttribute("src")).toContain("a9900000-0000-4000-8000-000000000002.jpg");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("上傳中:顯示「上傳中…」、選檔欄位停用、不能移除;完成後恢復", async () => {
    let finish: (path: string) => void = () => {};
    const upload = vi.fn<Upload>(() => new Promise<string>((r) => (finish = r)));
    render(<Harness upload={upload} initial={OLD} />);
    const input = screen.getByLabelText("店家 logo");
    await userEvent.upload(input, photo());
    expect(screen.getByRole("status")).toHaveTextContent("上傳中…");
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "移除店家 logo" })).toBeNull();
    expect(screen.getByTestId("value")).toHaveTextContent(OLD);

    finish(NEW);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent(NEW));
    expect(screen.queryByRole("status")).toBeNull();
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "移除店家 logo" })).toBeInTheDocument();
  });

  it("上傳失敗:顯示原因,原本的圖留著(不會被清掉)", async () => {
    const upload = vi.fn<Upload>().mockRejectedValue(new Error("只收 JPG、PNG、WebP 照片"));
    render(<Harness upload={upload} initial={OLD} />);
    await userEvent.upload(screen.getByLabelText("店家 logo"), photo());
    expect(await screen.findByRole("alert")).toHaveTextContent("只收 JPG、PNG、WebP 照片");
    expect(screen.getByTestId("value")).toHaveTextContent(OLD);
    expect(screen.getByAltText("目前的店家 logo").getAttribute("src")).toContain("a9900000-0000-4000-8000-000000000001.jpg");
    expect(screen.getByLabelText("店家 logo")).toBeEnabled();
  });

  it("onBusyChange:開始上傳回報 true,成功或失敗結束都回報 false(店家設定頁靠它在上傳中停用儲存)", async () => {
    let finish: (path: string) => void = () => {};
    const onBusyChange = vi.fn();
    const upload = vi
      .fn<Upload>()
      .mockImplementationOnce(() => new Promise<string>((r) => (finish = r)))
      .mockRejectedValueOnce(new Error("只收 JPG、PNG、WebP 照片"));
    render(<Harness upload={upload} onBusyChange={onBusyChange} />);
    await userEvent.upload(screen.getByLabelText("店家 logo"), photo());
    expect(onBusyChange.mock.calls).toEqual([[true]]);
    finish(NEW);
    await waitFor(() => expect(onBusyChange.mock.calls).toEqual([[true], [false]]));

    await userEvent.upload(screen.getByLabelText("店家 logo"), photo());
    await screen.findByRole("alert");
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("移除:只是從表單拿掉路徑(不呼叫上傳、不刪檔),顯示「尚未上傳」", async () => {
    const upload = vi.fn<Upload>();
    render(<Harness upload={upload} initial={OLD} />);
    await userEvent.click(screen.getByRole("button", { name: "移除店家 logo" }));
    expect(screen.getByTestId("value")).toHaveTextContent("(空)");
    expect(screen.getByText("尚未上傳")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });
});
