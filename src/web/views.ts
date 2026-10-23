export type View = "board" | "inbox" | "grid" | "timeline" | "flow" | "history";

/**
 * Views as numbered in the design (1 board … 6 history), each also reachable as
 * `g` + mnemonic: g b, g i, g g, g t, g f, g h. The lede opens the view.
 */
export const VIEWS: Array<{
  id: View;
  key: string;
  mnemonic: string;
  label: string;
  lede: string;
}> = [
  {
    id: "board",
    key: "1",
    mnemonic: "b",
    label: "Board",
    lede: "Columns show whose turn it is. Cards move by themselves; the buttons are the moves you would drag.",
  },
  {
    id: "inbox",
    key: "2",
    mnemonic: "i",
    label: "Inbox",
    lede: "Everything waiting on you, oldest first, with Claude's explanation. Answer inline.",
  },
  {
    id: "grid",
    key: "3",
    mnemonic: "g",
    label: "Grid",
    lede: "Live sessions. Filter each tile to main or subagent output; enlarge any tile.",
  },
  {
    id: "timeline",
    key: "4",
    mnemonic: "t",
    label: "Timeline",
    lede: "One lane per agent. Orange stretches are time the agent waited on you.",
  },
  {
    id: "flow",
    key: "5",
    mnemonic: "f",
    label: "Flow",
    lede: "Dots are messages in flight, colored by sender. Click a link to filter the messages; click an agent to open it.",
  },
  {
    id: "history",
    key: "6",
    mnemonic: "h",
    label: "History",
    lede: "All workspaces in one graph. The op log is your list of checkpoints.",
  },
];
