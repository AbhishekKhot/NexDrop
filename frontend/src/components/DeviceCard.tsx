import type { Peer } from '../types';

interface DeviceCardProps {
    peer: Peer;
    selected: boolean;
    onClick: () => void;
}

const DEVICE_EMOJIS: Record<string, string> = {
    desktop: '🖥️',
    laptop: '💻',
    mobile: '📱',
    tablet: '📟',
    server: '🖧',
};

function getEmoji(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile')) return DEVICE_EMOJIS.mobile;
    if (lower.includes('ipad') || lower.includes('tablet')) return DEVICE_EMOJIS.tablet;
    if (lower.includes('macbook') || lower.includes('laptop')) return DEVICE_EMOJIS.laptop;
    return DEVICE_EMOJIS.desktop;
}

export default function DeviceCard({ peer, selected, onClick }: DeviceCardProps) {
    return (
        <button
            id={`device-${peer.id}`}
            className="device-card"
            onClick={onClick}
            style={
                selected
                    ? { borderColor: 'var(--accent)', background: 'var(--bg-hover)', boxShadow: '0 0 20px var(--accent-glow)' }
                    : {}
            }
            title={peer.ip ? `${peer.ip}:${peer.port}` : peer.id}
        >
            <span className="device-status" style={{ background: peer.status === 'available' ? 'var(--green)' : 'var(--yellow)' }} />
            <div className="device-avatar">{getEmoji(peer.name)}</div>
            <div className="device-name">{peer.name}</div>
            <div className="device-meta">
                {peer.ip ? `${peer.ip}` : peer.mode === 'remote' ? 'Remote' : 'LAN'}
                {selected && (
                    <span style={{ color: 'var(--accent)', fontWeight: 700, display: 'block' }}>✓ Selected</span>
                )}
            </div>
        </button>
    );
}
