export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="shell footer-row">
        <div>© {year} OurFaces Import &amp; Export, LLC</div>
        <div>Technology solutions • Business opportunities • Insights</div>
      </div>
    </footer>
  );
}
