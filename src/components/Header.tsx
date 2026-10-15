"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/", label: "Home" },
  { href: "/technology", label: "Technology" },
  { href: "/business", label: "Business" },
  { href: "/insights", label: "Insights" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact", cta: true },
];

export default function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <nav className="shell site-nav" aria-label="Primary navigation">
        <Link className="brand" href="/" aria-label="OurFaces home" onClick={() => setOpen(false)}>
          <img
            className="brand-logo"
            src="/assets/ourfaces-logo.png"
            alt="OurFaces — Import Export, LLC"
          />
        </Link>

        <button
          className="menu-btn"
          type="button"
          aria-expanded={open}
          aria-controls="primary-nav-links"
          onClick={() => setOpen((value) => !value)}
        >
          Menu
        </button>

        <div className={`nav-links${open ? " open" : ""}`} id="primary-nav-links">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`${link.cta ? "nav-cta " : ""}${active ? "active" : ""}`.trim()}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
