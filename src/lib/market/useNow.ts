// 每分鐘更新一次的「現在」:自動取消的倒數與過期判斷用(供應商零售訂單頁、訂單查詢頁),頁面一直開著時跟著走。
// 用瀏覽器的時鐘,不另外抓伺服器時間(真正取消以資料庫的排程為準)。
import { useEffect, useState } from "react";

export const useNow = (intervalMs = 60_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};
