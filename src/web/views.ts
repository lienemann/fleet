export type View = "board" | "inbox" | "grid" | "timeline" | "flow" | "history";

/**
 * Views as numbered in the design (1 board … 6 history), each also reachable as
 * `g` + mnemonic: g b, g i, g g, g t, g f, g h.
 */
export const VIEWS: Array<{ id: View; key: string; mnemonic: string; label: string }> = [
  { id: "board", key: "1", mnemonic: "b", label: "Board" },
  { id: "inbox", key: "2", mnemonic: "i", label: "Inbox" },
  { id: "grid", key: "3", mnemonic: "g", label: "Grid" },
  { id: "timeline", key: "4", mnemonic: "t", label: "Timeline" },
  { id: "flow", key: "5", mnemonic: "f", label: "Flow" },
  { id: "history", key: "6", mnemonic: "h", label: "History" },
];
