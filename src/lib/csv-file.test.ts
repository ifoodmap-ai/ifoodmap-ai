import { describe, expect, it } from "vitest";
import { decodeCsv, readCsvFile } from "./csv-file";

// 「中文,45」的 Big5 位元組(中 = A4A4、文 = A4E5)
const BIG5 = new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5, 0x2c, 0x34, 0x35]);

describe("讀 CSV 檔的編碼", () => {
  it("UTF-8(含 BOM)照常解(BOM 會被去掉)", () => {
    const utf8 = new TextEncoder().encode("\uFEFF高麗菜,45");
    expect(decodeCsv(utf8.buffer as ArrayBuffer)).toBe("高麗菜,45");
  });

  it("Excel 預設另存的 Big5 也讀得對", () => {
    expect(decodeCsv(BIG5.buffer as ArrayBuffer)).toBe("中文,45");
  });

  it("從 File 讀出來", async () => {
    expect(await readCsvFile(new File([BIG5], "a.csv"))).toBe("中文,45");
    expect(await readCsvFile(new File(["雞蛋,620"], "b.csv"))).toBe("雞蛋,620");
  });
});
