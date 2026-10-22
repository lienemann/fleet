export type View = "board" | "inbox" | "grid";

// Keys follow the numbering in the design: 1 board, 2 inbox, 3 grid, 4 timeline, 5 flow, 6 history.
export const VIEWS: Array<{ id: View; key: string; label: string }> = [
  { id: "board", key: "1", label: "Board" },
  { id: "inbox", key: "2", label: "Inbox" },
  { id: "grid", key: "3", label: "Grid" },
];
