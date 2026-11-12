// 餐廳端「這個身分看得到什麼」:同一張訂單,不同身分(老闆 / 店長 / 採購員)與不同分店看到不同內容。
// 實際的資料範圍由資料庫決定(20261110100000_restaurant_branch_scope.sql 的 can_see_branch_order),
// 價格只有老闆 / 店長看得到(RestaurantRoute 的 canSeeCost);這裡只負責「把規則講清楚」給「分店與成員」頁用,
// 兩邊的規則要一起改。

export type VisibilityRole = "owner" | "manager" | "purchaser";

/** 角色的一般說明(沒有指定分店):角色清單、邀請表單用 */
export const ROLE_VISIBILITY_HINT: Readonly<Record<VisibilityRole, string>> = {
  owner: "看得到所有分店的訂單、價格與報表,可管理成員與分店",
  manager: "看得到自己分店的完整訂單與價格,可採購與簽核(沒指派分店時看全部)",
  purchaser: "只看自己分店的品項與數量,看不到價格;叫貨要經簽核才會送出",
};

/**
 * 某個成員實際看得到什麼。branchName = 他被指派的分店名稱(null = 沒指派,全店)。
 * 老闆一律看全部,就算被指派了分店。
 */
export const visibilityText = (role: VisibilityRole, branchName: string | null): string => {
  if (role === "owner") return "所有分店的訂單、價格與報表";
  if (role === "manager") {
    return branchName
      ? `「${branchName}」的訂單與價格;其他分店的看不到`
      : "所有分店的訂單與價格(還沒指派分店;指派後只看那家分店)";
  }
  return branchName
    ? `「${branchName}」的訂單,只看品項與數量,不顯示單價與金額`
    : "所有分店的訂單,只看品項與數量,不顯示單價與金額(建議指派分店)";
};
