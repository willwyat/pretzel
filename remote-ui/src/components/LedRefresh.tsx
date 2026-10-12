/**
 * Panel status LED that doubles as the panel's Refresh key: tap the lamp to
 * re-read the device. Keeps the header to LED + name, with no extra button.
 */
export function LedRefresh({
  ledClass,
  status,
  onRefresh,
  disabled,
  className = "",
}: {
  /** e.g. "pretzel-led--ok" */
  ledClass: string;
  /** Status in words (shown on hover, read by screen readers). */
  status: string;
  onRefresh: () => void;
  disabled?: boolean;
  /** Extra classes for the lamp itself (e.g. a top offset to sit on the title). */
  className?: string;
}) {
  return (
    <button
      type="button"
      className="pretzel-led-btn"
      onClick={onRefresh}
      disabled={disabled}
      title={`${status} · tap to refresh`}
      aria-label={`${status}. Refresh`}
    >
      <span className={`pretzel-led ${ledClass} ${className}`} aria-hidden />
    </button>
  );
}
