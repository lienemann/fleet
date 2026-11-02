/** Folds an inbox item to its header line, or unfolds it; folded, the item stays in the inbox. */
export function FoldToggle({ folded, onToggle }: { folded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="item-fold"
      aria-expanded={!folded}
      aria-label={folded ? "Unfold" : "Fold"}
      title={folded ? "Unfold" : "Fold to this line; it stays in the inbox"}
      onClick={onToggle}
    >
      {folded ? "▸" : "▾"}
    </button>
  );
}
