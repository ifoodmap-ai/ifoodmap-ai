// StoreLegalInfo:店家的法定資訊(店家頁、訂單查詢頁共用)。必填的五項沒有值就寫「未提供」(看得出缺),選填的兩項有填才顯示;
// 電話是 tel:、客服 Email 是 mailto:。
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import StoreLegalInfo from "./StoreLegalInfo";

afterEach(cleanup);

const FULL = {
  legalName: "青田有機農場有限公司",
  representative: "林青田",
  businessAddress: "宜蘭縣三星鄉測試路 1 號",
  phone: "03-989-1234",
  serviceEmail: "service@qingtian.example",
  foodRegistrationNo: "G-12345678-00000-1",
  liabilityInsurance: "富邦產物 產品責任險 保單 0123456789",
};
const rowsOf = () =>
  within(screen.getByRole("list", { name: "店家資訊" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("StoreLegalInfo", () => {
  it("七項都有:依序顯示登記名稱、負責人、營業所地址、電話、客服 Email、食品業者登錄字號、產品責任險", () => {
    render(<StoreLegalInfo info={FULL} />);
    expect(rowsOf()).toEqual([
      "登記名稱:青田有機農場有限公司",
      "負責人:林青田",
      "營業所地址:宜蘭縣三星鄉測試路 1 號",
      "電話:03-989-1234",
      "客服 Email:service@qingtian.example",
      "食品業者登錄字號:G-12345678-00000-1",
      "產品責任險:富邦產物 產品責任險 保單 0123456789",
    ]);
    expect(screen.getByRole("link", { name: "03-989-1234" })).toHaveAttribute("href", "tel:03-989-1234");
    expect(screen.getByRole("link", { name: "service@qingtian.example" })).toHaveAttribute("href", "mailto:service@qingtian.example");
  });

  it("選填的登錄字號、責任險沒填就不顯示;必填的沒填寫「未提供」(空白字也算沒填)", () => {
    render(<StoreLegalInfo info={{ ...FULL, representative: null, businessAddress: "  ", serviceEmail: undefined, foodRegistrationNo: null, liabilityInsurance: "" }} />);
    expect(rowsOf()).toEqual(["登記名稱:青田有機農場有限公司", "負責人:未提供", "營業所地址:未提供", "電話:03-989-1234", "客服 Email:未提供"]);
    expect(screen.queryByRole("link", { name: /@/ })).toBeNull();
  });
});
