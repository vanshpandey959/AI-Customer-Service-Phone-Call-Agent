const STYLES = {
  complaint: "bg-danger-light text-danger",
  feedback: "bg-feedback-light text-feedback",
  normal: "bg-surface-soft text-text-muted",
  pending: "bg-warning-light text-warning",
  resolved: "bg-primary-light text-primary",
  active: "bg-primary-light text-primary",
  ended: "bg-surface-soft text-text-muted",
  phone: "bg-primary-light text-primary",
  web: "bg-surface-soft text-text-muted",
};

export default function Badge({ value }) {
  const style = STYLES[value] || STYLES.normal;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${style}`}>
      {value}
    </span>
  );
}
