/**
 * 讀使用者選的 CSV 檔。台灣的 Excel「另存 CSV(逗號分隔)」預設是 Big5(ANSI),「CSV UTF-8」才是 UTF-8:
 * 先用嚴格的 UTF-8 解,失敗(有不合法的位元組)就改用 Big5,免得中文變亂碼。
 */
export const decodeCsv = (buf: ArrayBuffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("big5").decode(buf);
  }
};

export const readCsvFile = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(decodeCsv(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("讀不到檔案"));
    reader.readAsArrayBuffer(file);
  });
