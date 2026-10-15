export default function EarthVisual() {
  return (
    <div className="earth-stage" aria-hidden="true">
      <div className="earth-glow" />
      <div className="earth-sphere">
        <div className="earth-texture" />
        <div className="earth-shade" />
        <div className="earth-atmosphere" />
      </div>
      <div className="float-card float-card-tech">
        <strong><span className="dot" />Technology solutions</strong>
        <span>Practical technology for real-world needs.</span>
      </div>
      <div className="float-card float-card-business">
        <strong><span className="dot" />Business opportunities</strong>
        <span>Connecting ideas, capabilities, and opportunities.</span>
      </div>
    </div>
  );
}
