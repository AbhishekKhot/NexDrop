import { Link } from 'react-router-dom';

export default function Home() {
    return (
        <div>
            <div className="page-header">
                <h1>Secure File Transfer</h1>
                <p>
                    Send files directly to other devices — no server ever sees your data.
                    End-to-end encrypted with ECDH + AES-256-GCM.
                </p>
            </div>

            <div className="mode-grid">
                {/* LAN Card */}
                <Link to="/lan" className="mode-card">
                    <span className="mode-card-icon">📡</span>
                    <h2>LAN Transfer</h2>
                    <p>
                        Share files with devices on the same Wi-Fi or network. Uses mDNS
                        discovery so peers appear automatically — no configuration needed.
                    </p>
                    <span className="badge">Same Network</span>
                </Link>

                {/* Remote Card */}
                <Link to="/remote" className="mode-card">
                    <span className="mode-card-icon">🌐</span>
                    <h2>Remote Transfer</h2>
                    <p>
                        Share files with anyone on the internet via WebRTC DataChannels.
                        A lightweight signaling server relays only the connection handshake
                        — your file bytes stay P2P.
                    </p>
                    <span className="badge">Any Network</span>
                </Link>
            </div>
        </div>
    );
}
