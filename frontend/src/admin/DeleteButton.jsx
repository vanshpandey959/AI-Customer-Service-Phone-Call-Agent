export default function DeleteButton({ onConfirm, label = "Delete", confirmText }) {
  function handleClick() {
    if (window.confirm(confirmText || "Are you sure you want to delete this? This cannot be undone.")) {
      onConfirm();
    }
  }

  return (
    <button
      onClick={handleClick}
      className="text-sm text-danger transition-colors hover:underline"
    >
      {label}
    </button>
  );
}
