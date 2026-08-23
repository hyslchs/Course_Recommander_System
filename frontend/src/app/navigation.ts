/** The AI assistant page is kept in the tree but hidden until it is re-enabled. */
export const AI_ASSISTANT_VISIBLE = false;

export const navigationItems = [
  { to: "/recommend", label: "為你推薦" },
  ...(AI_ASSISTANT_VISIBLE ? [{ to: "/assistant", label: "AI 小幫手" }] : []),
  { to: "/explore", label: "探索課程" },
  { to: "/schedule", label: "我的課表" },
  { to: "/data", label: "資料管理" },
];
