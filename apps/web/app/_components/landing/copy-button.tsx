type CopyButtonProps = {
  value: string;
  ariaLabel: string;
  label?: string;
};

export function CopyButton({ value, ariaLabel, label = "Copy" }: CopyButtonProps) {
  return (
    <button className="copy-button" data-copy={value} aria-label={ariaLabel} type="button">
      <span className="copy-button-icons" aria-hidden="true">
        <svg className="copy-button-icon copy-button-icon--copy" viewBox="0 0 24 24">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M 15 9 V 6 A 2 2 0 0 0 13 4 H 6 A 2 2 0 0 0 4 6 V 13 A 2 2 0 0 0 6 15 H 9" />
        </svg>
        <svg className="copy-button-icon copy-button-icon--check" viewBox="0 0 24 24">
          <path d="M 5 12.5 L 9.5 17 L 19 7.5" />
        </svg>
      </span>
      <span className="copy-button-label copy-button-label--idle">{label}</span>
      <span className="copy-button-label copy-button-label--copied">Copied</span>
      <span className="copy-button-label copy-button-label--error">⌘C</span>
    </button>
  );
}
