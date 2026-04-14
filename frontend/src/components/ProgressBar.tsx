interface ProgressBarProps {
    percent: number;
    label?: string;
}

export default function ProgressBar({ percent, label }: ProgressBarProps) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <div className="progress-bar-wrapper">
            {label && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    <span>{label}</span>
                    <span>{clamped}%</span>
                </div>
            )}
            <div className="progress-bar-track">
                <div className="progress-bar-fill" style={{ width: `${clamped}%` }} />
            </div>
        </div>
    );
}
